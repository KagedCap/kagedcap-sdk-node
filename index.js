'use strict';

/**
 * KagedCap Node.js SDK (CommonJS) — solve reCAPTCHA, Ticketmaster tmpt, Kasada, and evaluate.
 *
 *   const { KagedCapClient } = require('kagedcap');
 *   const kc = new KagedCapClient(process.env.KAGEDCAP_API_KEY);
 *   const { token } = await kc.solve({ sitekey, url, action, enterprise: true });
 *
 *   const login = await kc.kasadaLogin({ site: 'ticketmaster', proxy });
 *   const fresh = await kc.kasadaReload(login); // reuses login's kpsdk_st + x_kpsdk_*
 *
 *   const { token, decision } = await kc.evaluate({ url, proxy }); // Ticketmaster EPSF
 *
 * reCAPTCHA, tmpt and evaluate submit to `/v2/solve` and poll `/v2/solve/{id}` for the result, so
 * no connection is held open for a solve. Kasada is the exception: `kasadaLogin` / `kasadaReload`
 * post to the synchronous `/solve` and resolve with that response directly — no submit, no poll.
 * The *Deprecated methods also call the synchronous `/solve`. submitSolve + getSolve expose the
 * submit and poll steps for a callback-driven flow or your own loop.
 *
 * Transient failures (429, 500/502/503/504, transport errors) are retried with jittered backoff
 * until the call's deadline — see DEFAULT_RETRY and `retry` in the client options.
 */

const { randomUUID } = require('node:crypto');

const DEFAULT_BASE_URL = 'https://api.kagedcap.io';

/** Total budget a solve gets for its submit plus every poll, when the caller names none. */
const DEFAULT_DEADLINE_MS = 120000;

/**
 * Gap between polls of `/v2/solve/{id}` — the cadence the gateway is sized for. Overriding it per
 * call is fine; changing this default moves read volume for every caller at once.
 */
const DEFAULT_POLL_INTERVAL_MS = 5000;

/**
 * UA sent when a solve doesn't carry one. This is the exact Chrome 151 Windows desktop profile
 * the solver fleet runs, so the token embeds an identity the server already agrees with instead
 * of a blank one. Bump this single line when the fleet moves to a newer Chrome.
 */
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';

/**
 * Retry policy applied to every transient failure, on by default. 2026-10-20: Railway's edge in
 * front of the dedicated gateway and the poll service sheds 500k-800k submits an hour with a bare
 * 429 before the request reaches the API, and the API itself answers 429/5xx under load. Each of
 * those used to end the solve on the first response even though the same request would have
 * succeeded a second later. Exponential backoff with full jitter, capped, and bounded by the
 * caller's deadline; a Retry-After header wins over the backoff but is capped too.
 */
const DEFAULT_RETRY = Object.freeze({
  /** Attempts per request (the submit, or one poll), the first try included. Infinity = until the deadline runs out. */
  maxAttempts: Infinity,
  initialBackoffMs: 250,
  maxBackoffMs: 5000,
  /** Longest wait a Retry-After header can ask for. */
  maxRetryAfterMs: 10000,
});

/**
 * No retry ever waits less than this, whatever the policy or the Retry-After header says: a
 * `Retry-After: 0`, a past date or a zero backoff must not turn the client into a tight loop
 * against an edge that is already shedding.
 */
const MIN_BACKOFF_MS = 50;

/**
 * A retry is not started with less than this left on the deadline: it would be cut off before
 * the server could answer, and the error would then carry that cut-off instead of the last real
 * response. The call reports the last real response instead.
 */
const MIN_ATTEMPT_MS = 500;

/** Largest Retry-After the SDK will report on an error (as `retryAfterMs`); the wait is capped separately. */
const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * No retry of the synchronous v1 `/solve` starts more than this long after the call's first
 * attempt went out. The gateway holds the Idempotency-Key claim for 120s (SET NX EX 120) from
 * the moment the first attempt reached it: inside that window a resend is deduplicated (409
 * idempotency_conflict, handled in _requestWithRetry); past it the key is free again and the
 * resend would run, and bill, a fresh solve. 100s leaves a resend 20s to arrive before the claim
 * lapses. v2's dedupe is durable, so it has no such wall.
 */
const V1_RETRY_WINDOW_MS = 100000;

const V1_RETRY_WINDOW_NOTE = 'no v1 resend starts more than ' + V1_RETRY_WINDOW_MS + 'ms after the first attempt, or it would outlive the gateway\'s 120s idempotency claim and buy a second solve';

/** Statuses the edge or the gateway returns when the request itself was fine but the moment wasn't. */
const TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 504]);

/**
 * Statuses the edge in front of the API (Railway, Cloudflare) answers with on its own, as a bare
 * page without the gateway's JSON envelope. Those never reached the gateway, which is what makes
 * them safe to resend on the synchronous v1 `/solve` — see _solveSync.
 */
const EDGE_STATUSES = new Set([429, 502, 503, 504]);

/**
 * Error codes that mean the request is wrong, whatever status carried them: resending the same
 * bytes can only produce the same answer, so these end the call on the spot.
 */
const TERMINAL_CODES = new Set([
  'validation_error',
  'unauthorized',
  'key_revoked',
  'account_suspended',
  'insufficient_funds',
  'key_spend_cap_reached',
  'proxy_invalid',
  'proxy_required',
  'proxy_not_allowed',
  'unsupported_task',
  'action_required',
  'callback_url_invalid',
  'not_found',
  'idempotency_conflict',
  'key_frozen',
  'subscription_quota_exhausted',
  'subscription_past_due',
  'host_not_allowed',
]);

const TASKS = [
  'ReCaptchaV3Task',
  'ReCaptchaV3TaskProxyLess',
  'ReCaptchaV3EnterpriseTask',
  'ReCaptchaV3EnterpriseTaskProxyLess',
  'ReCaptchaV2Task',
  'ReCaptchaV2TaskProxyLess',
  'TicketmasterTmptTask',
  'KasadaLogin',
  'KasadaReload',
  'EvaluateTask',
];

class KagedCapError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'KagedCapError';
    this.status = status;
    this.code = code;
  }
}

function deriveTask(enterprise, hasProxy, version) {
  const suffix = hasProxy ? 'Task' : 'TaskProxyLess';
  if (version === 'v2') return 'ReCaptchaV2' + suffix; // no enterprise variant for v2 yet
  const base = enterprise ? 'ReCaptchaV3Enterprise' : 'ReCaptchaV3';
  return base + suffix;
}

function isKasadaTask(task) {
  return typeof task === 'string' && task.startsWith('Kasada');
}

function isEvaluateTask(task) {
  return task === 'EvaluateTask';
}

function stripUndefined(obj) {
  const out = {};
  for (const k of Object.keys(obj)) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

/** The v1/v2 solve body — identical JSON, so solve/submitSolve/solveDeprecated stay in step. */
function solveBody(params, task) {
  const isKasada = isKasadaTask(task);
  return {
    task,
    url: params.url,
    sitekey: params.sitekey,
    action: params.action,
    proxy: params.proxy,
    userAgent: params.userAgent || (isKasada ? undefined : DEFAULT_USER_AGENT),
    device: params.device,
    enhanced: params.enhanced,
    secretKey: params.secretKey,
  };
}

function evaluateBody(params) {
  return {
    task: 'EvaluateTask',
    url: params.url,
    proxy: params.proxy,
    action: params.action,
    phone_number: params.phone_number,
    queueId: params.queueId,
    eventId: params.eventId,
    userAgent: params.userAgent || DEFAULT_USER_AGENT,
  };
}

function kasadaLoginBody(params) {
  return { task: 'KasadaLogin', site: params.site, url: params.url, proxy: params.proxy };
}

function kasadaReloadBody(p) {
  return {
    task: 'KasadaReload',
    hash: p.hash,
    site: p.site,
    kpsdk_st: p.kpsdk_st,
    x_kpsdk_ct: p.x_kpsdk_ct,
    x_kpsdk_v: p.x_kpsdk_v,
    x_kpsdk_h: p.x_kpsdk_h,
  };
}

function abortedError() {
  return new KagedCapError(0, 'aborted', 'request aborted by caller');
}

/** The caller's signal fired while the SDK was waiting to retry — `canceled`, not `aborted`, by SDK-wide convention. */
function canceledError() {
  return new KagedCapError(0, 'canceled', 'retry canceled by caller during backoff');
}

/** Attach the Idempotency-Key a request went out under to the error that ended it. */
function withKey(err, idempotencyKey) {
  if (idempotencyKey && err instanceof KagedCapError && err.idempotencyKey === undefined) err.idempotencyKey = idempotencyKey;
  return err;
}

/**
 * Wait `ms`, cutting the wait short if the caller's signal fires. `makeError` builds the
 * rejection: `aborted` for a poll wait, `canceled` for a retry backoff.
 */
function sleep(ms, signal, makeError) {
  makeError = makeError || abortedError;
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(makeError());
    const onAbort = () => {
      clearTimeout(timer);
      reject(makeError());
    };
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

function deadlineError(deadlineMs) {
  return new KagedCapError(0, 'timeout', 'solve deadline exceeded after ' + deadlineMs + 'ms');
}

/**
 * Turn the client's `retry` option into a full policy, or null when retries are switched off.
 * A zero, negative or non-numeric field falls back to its default, and the backoff fields are
 * floored at MIN_BACKOFF_MS, so no configuration can produce a wait of 0.
 */
function retryPolicy(opt) {
  if (opt === false) return null;
  const o = opt && typeof opt === 'object' ? opt : {};
  if (o.enabled === false) return null;
  const positive = (v, d) => (typeof v === 'number' && v > 0 ? v : d);
  const positiveMs = (v, d) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d);
  const maxBackoffMs = Math.max(MIN_BACKOFF_MS, positiveMs(o.maxBackoffMs, DEFAULT_RETRY.maxBackoffMs));
  return {
    maxAttempts: positive(o.maxAttempts, DEFAULT_RETRY.maxAttempts),
    initialBackoffMs: Math.min(maxBackoffMs, Math.max(MIN_BACKOFF_MS, positiveMs(o.initialBackoffMs, DEFAULT_RETRY.initialBackoffMs))),
    maxBackoffMs,
    maxRetryAfterMs: Math.max(MIN_BACKOFF_MS, positiveMs(o.maxRetryAfterMs, DEFAULT_RETRY.maxRetryAfterMs)),
  };
}

/**
 * Whether a failed request is worth sending again unchanged.
 *
 * `syncSolve` marks the v1 `POST /solve`. The gateway claims the request's Idempotency-Key
 * (SET NX, 120s) as its very first step and never releases it, so once a v1 request has reached
 * the gateway a same-key resend can only answer 409 idempotency_conflict: a 429/5xx that carries
 * the gateway's JSON envelope (an `error` field) is therefore final on v1. What is resent on v1
 * is what never got there — a transport error, or an edge-made bare 429/502/503/504 page, which
 * `_request` marks with the fallback code `error` because it had no envelope to read.
 *
 * On v2 the verdict arrives through the poll body (`status: 'failed'`, handled in _pollUntilDone
 * and never retried), and the gateway's dedupe returns the original job for a same-key resend,
 * so a 429/5xx on the submit or the poll is transient whatever code it carries, bar the terminal
 * ones.
 */
function isTransient(err, syncSolve) {
  if (!(err instanceof KagedCapError)) return false;
  // Status 0 is raised client-side: a dropped connection or a per-request timeout can be retried,
  // the caller's own abort cannot.
  if (err.status === 0) return err.code === 'network_error' || err.code === 'timeout';
  if (!TRANSIENT_STATUSES.has(err.status)) return false;
  if (TERMINAL_CODES.has(err.code)) return false;
  if (syncSolve) return err.code === 'error' && EDGE_STATUSES.has(err.status);
  return true;
}

/** RFC 7231 IMF-fixdate, the only HTTP-date form the edge and the gateway emit: `Tue, 20 Oct 2026 22:15:30 GMT`. */
const IMF_FIXDATE = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) \d{2}:\d{2}:\d{2} GMT$/;

/**
 * Retry-After as milliseconds, or undefined when absent, malformed, or already in the past.
 *
 * Only two shapes are read: delay-seconds (`\d+`) and an IMF-fixdate with a year in 1970-9999.
 * Anything else — a negative, a fraction, two headers joined by `Headers.get` (`2, 3`) — is
 * ignored rather than handed to Date.parse, which would read most of it as some date in 2001.
 * Both forms are clamped to MAX_RETRY_AFTER_MS before any arithmetic, so the value is never
 * negative, NaN or absurd.
 */
function parseRetryAfter(res) {
  const headers = res && res.headers;
  if (!headers || typeof headers.get !== 'function') return undefined;
  const raw = headers.get('retry-after');
  if (raw == null) return undefined;
  const value = String(raw).trim();
  if (/^\d+$/.test(value)) return Math.min(Number(value), MAX_RETRY_AFTER_MS / 1000) * 1000;
  const m = IMF_FIXDATE.exec(value);
  if (!m) return undefined;
  const year = Number(m[1]);
  if (year < 1970 || year > 9999) return undefined;
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return undefined;
  const delayMs = at - Date.now();
  if (delayMs <= 0) return undefined;
  return Math.min(delayMs, MAX_RETRY_AFTER_MS);
}

/**
 * How long to wait before the next attempt: the server's Retry-After when it sent one, else full
 * jitter over the current backoff — a random wait in [MIN_BACKOFF_MS, backoff] so a fleet of
 * clients shed at the same instant doesn't come back in lockstep. Either way the wait sits in
 * [MIN_BACKOFF_MS, cap]: a Retry-After of 0 cannot make the client spin, a Retry-After of an hour
 * cannot park it (maxRetryAfterMs).
 */
function retryDelayMs(err, backoffMs, policy) {
  if (typeof err.retryAfterMs === 'number') return Math.max(MIN_BACKOFF_MS, Math.min(err.retryAfterMs, policy.maxRetryAfterMs));
  const ceiling = Math.max(MIN_BACKOFF_MS, backoffMs);
  return MIN_BACKOFF_MS + Math.floor(Math.random() * (ceiling - MIN_BACKOFF_MS + 1));
}

function describeFailure(err) {
  return err.status ? 'HTTP ' + err.status + ' ' + err.code : err.code;
}

/**
 * The error handed back once the deadline (or maxAttempts) is spent: the last real failure's
 * status, code, message and request id, plus how many requests the call sent in all and how long
 * it has been running (`tally`, shared across the submit and every poll of one solve). `note`
 * explains a last attempt that is not the one being reported — one the deadline cut short, or a
 * v1 resend that answered idempotency_conflict — or why no further attempt was made (the v1
 * retry window).
 */
function retriesExhausted(last, tally, note) {
  const attempts = tally.attempts;
  const elapsedMs = Date.now() - tally.startedAt;
  const err = new KagedCapError(
    last.status,
    last.code,
    last.message + ' — gave up after ' + attempts + ' attempt' + (attempts === 1 ? '' : 's') + ' over ' + elapsedMs + 'ms (last: ' + describeFailure(last) + (note ? '; ' + note : '') + ')',
  );
  err.attempts = attempts;
  err.elapsedMs = elapsedMs;
  if (last.requestId) err.requestId = last.requestId;
  if (last.idempotencyKey) err.idempotencyKey = last.idempotencyKey;
  if (typeof last.retryAfterMs === 'number') err.retryAfterMs = last.retryAfterMs;
  return err;
}

/** The running count every request of one call adds to, so the final error reports the whole call. */
function newTally() {
  return { startedAt: Date.now(), attempts: 0 };
}

/**
 * Normalize a KasadaLogin result (or explicit reload params) into reload inputs, carrying
 * the session's kpsdk_st + x_kpsdk_* forward so a login's headers flow into the reload.
 */
function toKasadaReloadParams(session) {
  if (session && 'x_kpsdk_cd' in session) {
    return { kpsdk_st: session.kpsdk_st, hash: session.hash, x_kpsdk_ct: session.x_kpsdk_ct, x_kpsdk_v: session.x_kpsdk_v, x_kpsdk_h: session.x_kpsdk_h, site: session.site };
  }
  return session || {};
}

class KagedCapClient {
  /**
   * @param {string} apiKey
   * @param {{ baseUrl?: string, timeoutMs?: number, fetch?: Function, retry?: false | { enabled?: boolean, maxAttempts?: number, initialBackoffMs?: number, maxBackoffMs?: number, maxRetryAfterMs?: number } }} [opts] -
   * `retry` tunes the transient-failure policy (see DEFAULT_RETRY); `retry: false` turns it off.
   */
  constructor(apiKey, opts) {
    if (!apiKey) throw new Error('KagedCapClient: apiKey is required');
    opts = opts || {};
    this.apiKey = apiKey;
    this.baseUrl = (opts.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
    this.timeoutMs = opts.timeoutMs || 120000;
    this.fetch = opts.fetch || globalThis.fetch;
    if (!this.fetch) throw new Error('KagedCapClient: global fetch not found — use Node 18+ or pass opts.fetch');
    this.retry = retryPolicy(opts.retry);
  }

  /**
   * Solve a reCAPTCHA, tmpt, or evaluate captcha. Pass `enterprise` and (optionally) `proxy` to
   * auto-select the task, or set `task` explicitly. For Kasada use `kasadaLogin` / `kasadaReload`
   * — a Kasada result has no token for this method to resolve with, so a Kasada task is rejected.
   *
   * Submits the job to `/v2/solve` and polls `/v2/solve/{id}` every `pollIntervalMs` until it
   * finishes, so no connection is held open for the length of the solve. It still blocks and
   * still resolves with the result — only the transport underneath changed.
   *
   * `deadlineMs` (120s by default) is the whole budget, submit plus every poll: run past it and
   * you get a KagedCapError with code `timeout`. Pass `signal` to cut a solve short sooner. A
   * failed solve throws the same KagedCapError a failure has always thrown, and one whose result
   * the gateway has already cleared throws `result_expired`.
   *
   * `callback_url` (https, publicly resolvable) has the gateway POST the result to you as well,
   * and `idempotencyKey` makes a resent submit return the first job instead of buying a second.
   * Omit it and the SDK generates a UUIDv4 for this call, so its own retries of the submit can't
   * double-solve either; a failed call carries it as `err.idempotencyKey`.
   */
  async solve(params) {
    const task = params.task || deriveTask(!!params.enterprise, !!params.proxy, params.version);
    if (isKasadaTask(task)) {
      throw new KagedCapError(0, 'validation_error', 'solve() cannot carry a Kasada result (it has no token); use kasadaLogin() or kasadaReload()');
    }
    const body = { ...solveBody(params, task), callback_url: params.callback_url };
    return this._solveAsync(body, {
      deadlineMs: params.deadlineMs,
      pollIntervalMs: params.pollIntervalMs,
      signal: params.signal,
      idempotencyKey: params.idempotencyKey,
      // evaluate's "expired" test is the decision, not the token: a challenge verdict
      // legitimately carries an empty token.
      resultKey: isEvaluateTask(task) ? 'decision' : 'token',
    });
  }

  /**
   * Submit a reCAPTCHA, tmpt, or evaluate solve to `/v2/solve` and resolve with the job
   * acknowledgement (`{ success, id, status: 'running' }`) without waiting. Pair with `getSolve`
   * to run the wait yourself, or to not wait at all when a `callback_url` is doing the telling.
   * Kasada runs through `kasadaLogin` / `kasadaReload` (synchronous `/solve`), which take its own inputs.
   */
  async submitSolve(params) {
    const task = params.task || deriveTask(!!params.enterprise, !!params.proxy, params.version);
    if (isKasadaTask(task)) {
      throw new KagedCapError(0, 'validation_error', 'submitSolve() takes solve inputs; use kasadaLogin() or kasadaReload() for Kasada');
    }
    const body = { ...solveBody(params, task), callback_url: params.callback_url };
    // No solve deadline here, so the client timeout bounds the submit and every retry of it.
    const tally = newTally();
    return this._submit(body, {
      signal: params.signal,
      deadlineAt: tally.startedAt + this.timeoutMs,
      idempotencyKey: params.idempotencyKey || randomUUID(),
      tally,
    });
  }

  /**
   * Fetch a queued solve's current state from `/v2/solve/{id}`, returned as it came. Read
   * `status` (`running` | `done` | `failed`), not `success`. On `done`, the result fields are
   * present until the gateway clears them ~5 minutes later. An id the gateway doesn't have (or
   * that belongs to another account) throws `not_found`. A shed or failed read is retried within
   * `timeoutMs` (the client's by default), which bounds the call as a whole.
   * @param {string} id
   * @param {{ signal?: AbortSignal, timeoutMs?: number }} [opts]
   */
  async getSolve(id, opts) {
    opts = opts || {};
    const timeoutMs = opts.timeoutMs || this.timeoutMs;
    const tally = newTally();
    return this._requestWithRetry('GET', '/v2/solve/' + id, undefined, {
      signal: opts.signal,
      deadlineAt: tally.startedAt + timeoutMs,
      attemptTimeoutMs: timeoutMs,
      tally,
    });
  }

  /**
   * Solve a captcha through the legacy `/solve` endpoint, which holds the HTTP connection open
   * for the whole solve instead of polling.
   *
   * @deprecated Use `solve`, which submits to `/v2/solve` and polls for the result.
   */
  async solveDeprecated(params) {
    const task = params.task || deriveTask(!!params.enterprise, !!params.proxy, params.version);
    return this._solveSync(solveBody(params, task), { signal: params.signal, idempotencyKey: params.idempotencyKey });
  }

  /**
   * Start a Kasada session. Requires `proxy` (the token is IP-bound). Posts to the synchronous
   * `/solve` and resolves with that response directly — the full header set plus the `x_kpsdk_*`
   * values. Keep the result and pass it to `kasadaReload` to refresh the session later.
   * @param {{ proxy: string, site?: string, url?: string, signal?: AbortSignal, idempotencyKey?: string }} params
   */
  async kasadaLogin(params) {
    params = params || {};
    return this._solveSync(kasadaLoginBody(params), { signal: params.signal, idempotencyKey: params.idempotencyKey });
  }

  /**
   * Start a Kasada session through the synchronous `/solve`.
   * @deprecated Use `kasadaLogin` — it now posts to the same synchronous `/solve`; this alias stays for back-compat.
   */
  async kasadaLoginDeprecated(params) {
    params = params || {};
    return this._solveSync(kasadaLoginBody(params), { idempotencyKey: params.idempotencyKey });
  }

  /**
   * Refresh a Kasada session (no proxy needed). Pass the `kasadaLogin` result directly (its
   * kpsdk_st + x_kpsdk_* are resent for you) or explicit params. Posts to the synchronous `/solve`
   * and resolves with that response directly.
   * @param {object} session - a kasadaLogin result, or { kpsdk_st, hash, x_kpsdk_ct, x_kpsdk_v?, x_kpsdk_h? } (hash + x_kpsdk_ct required)
   * @param {{ signal?: AbortSignal, idempotencyKey?: string }} [opts]
   */
  async kasadaReload(session, opts) {
    opts = opts || {};
    const p = toKasadaReloadParams(session);
    if (p.kpsdk_st == null) throw new KagedCapError(0, 'validation_error', 'kasadaReload: kpsdk_st is required — pass the kasadaLogin result or an explicit kpsdk_st');
    return this._solveSync(kasadaReloadBody(p), { signal: opts.signal, idempotencyKey: opts.idempotencyKey });
  }

  /**
   * Refresh a Kasada session through the synchronous `/solve`.
   * @deprecated Use `kasadaReload` — it now posts to the same synchronous `/solve`; this alias stays for back-compat.
   */
  async kasadaReloadDeprecated(session) {
    const p = toKasadaReloadParams(session);
    if (p.kpsdk_st == null) throw new KagedCapError(0, 'validation_error', 'kasadaReload: kpsdk_st is required — pass the kasadaLogin result or an explicit kpsdk_st');
    return this._solveSync(kasadaReloadBody(p));
  }

  /**
   * Evaluate a Ticketmaster EPSF check. Requires `proxy` (the verdict is IP-bound) and the page
   * `url` — the host picks the flow: `auth.*` evaluates verify_phone, every other Ticketmaster
   * host evaluates join_queue. Submits to `/v2/solve` and polls. Returns the allow token plus
   * the `decision` (allow | challenge | block) behind it.
   *
   * `action` is left undefined unless named (sending it overrides the host default), as are the
   * flow-specific fields (`phone_number`, `queueId`, `eventId`). `userAgent` defaults to
   * DEFAULT_USER_AGENT and selects the solver's device profile, not just a header.
   * @param {{ url: string, proxy: string, action?: 'verify_phone'|'join_queue', phone_number?: string, queueId?: string, eventId?: string, userAgent?: string, deadlineMs?: number, pollIntervalMs?: number, signal?: AbortSignal, idempotencyKey?: string }} params
   */
  async evaluate(params) {
    return this._solveAsync(evaluateBody(params), {
      deadlineMs: params.deadlineMs, pollIntervalMs: params.pollIntervalMs, signal: params.signal, idempotencyKey: params.idempotencyKey, resultKey: 'decision',
    });
  }

  /**
   * Evaluate through the legacy synchronous `/solve`.
   * @deprecated Use `evaluate`, which submits to `/v2/solve` and polls.
   */
  async evaluateDeprecated(params) {
    return this._solveSync(evaluateBody(params), { signal: params.signal, idempotencyKey: params.idempotencyKey });
  }

  /** Current balance for the API key's account. */
  async checkBalance() {
    return this._request('GET', '/v1/balance');
  }

  /** Submit a prepared body to `/v2/solve` and poll until done. `resultKey` is the field whose
   * absence on a done job means the result was swept. */
  async _solveAsync(body, opts) {
    opts = opts || {};
    const signal = opts.signal;
    const pollIntervalMs = opts.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS;
    const deadlineMs = opts.deadlineMs || DEFAULT_DEADLINE_MS;
    // One tally for the whole solve: the error that ends it reports every request sent since
    // this instant — the submit, each poll, each retry — and the wall time over all of them.
    const tally = newTally();
    const deadlineAt = tally.startedAt + deadlineMs;
    // One key per solve call, reused on every retry of the submit: the gateway's dedupe returns
    // the original job for a duplicate, so a resend after a 5xx that may already have landed can
    // neither solve nor charge twice.
    const idempotencyKey = opts.idempotencyKey || randomUUID();
    const resultKey = opts.resultKey || 'token';

    try {
      return await this._pollUntilDone(body, { signal, pollIntervalMs, deadlineMs, deadlineAt, idempotencyKey, resultKey, tally });
    } catch (err) {
      // Whatever ended the solve, the key names the job the gateway may hold for it.
      throw withKey(err, idempotencyKey);
    }
  }

  async _pollUntilDone(body, o) {
    const { signal, pollIntervalMs, deadlineMs, deadlineAt, idempotencyKey, resultKey, tally } = o;
    const job = await this._submit(body, { signal, deadlineAt, idempotencyKey, tally });

    for (;;) {
      const left = deadlineAt - Date.now();
      if (left <= 0) throw deadlineError(deadlineMs);
      await sleep(Math.min(pollIntervalMs, left), signal);

      // A poll always follows the wait, even one that landed exactly on the deadline: the budget
      // bounds how long we wait, and by now the answer may already be sitting there. That last
      // poll gets one interval to reply so it can't hang far past the caller's wall. A shed or
      // failed poll is retried with backoff inside the same budget — the job is still running on
      // the gateway, so giving up on it would throw away a solve that was already paid for.
      const state = await this._requestWithRetry('GET', '/v2/solve/' + job.id, undefined, {
        signal,
        deadlineAt,
        minTimeoutMs: pollIntervalMs,
        tally,
      });

      // `status` is the completion test, not `success`: success only turns true once status is
      // 'done', so reading it instead would keep polling a job that has already failed.
      if (state.status === 'done') {
        // The gateway clears the result ~5 minutes after a solve completes (a reCAPTCHA token is
        // dead in ~2 anyway), so a 'done' poll can arrive with nothing to hand back. That's a
        // result the caller lost, not a successful empty one. resultKey is the per-fleet field
        // that proves the result is still there: token for reCAPTCHA/tmpt, decision for evaluate,
        // x_kpsdk_ct for Kasada.
        if (!state[resultKey]) {
          throw new KagedCapError(0, 'result_expired', 'solve ' + job.id + ' completed but its result has already been cleared — poll sooner or use callback_url');
        }
        return state;
      }
      if (state.status === 'failed') {
        const code = state.error || 'solve_failed';
        throw new KagedCapError(0, code, 'solve ' + job.id + ' failed: ' + code);
      }
      // 'running' — and any status a newer gateway invents — means keep polling until the deadline.
    }
  }

  /**
   * POST a prepared body to `/v2/solve`, retrying a shed or failed submit under the same
   * `idempotencyKey` until `deadlineAt`. The caller supplies the key — see _solveAsync for why.
   * @param {{ signal?: AbortSignal, deadlineAt: number, idempotencyKey: string, tally: { startedAt: number, attempts: number } }} opts
   */
  async _submit(body, opts) {
    const job = await this._requestWithRetry('POST', '/v2/solve', body, {
      signal: opts.signal,
      deadlineAt: opts.deadlineAt,
      idempotencyKey: opts.idempotencyKey,
      tally: opts.tally,
    });
    // 202 carries { success, id, status:'running' }; the id is the only part we can't do without.
    if (!job.id) throw new KagedCapError(0, 'invalid_response', '/v2/solve accepted the job but returned no id');
    return job;
  }

  /**
   * POST a prepared body to the synchronous v1 `/solve`, within the client timeout. Every call
   * carries an Idempotency-Key (the caller's, or a UUIDv4 for this call) and a resend replays it.
   *
   * The gateway claims that key with SET NX EX 120 as its first step and never releases it, so a
   * request that reached the gateway cannot be usefully resent: a same-key resend answers 409
   * idempotency_conflict, and a resend under a fresh key would run (and bill) the solve twice.
   * So a 429/5xx carrying the gateway's envelope is the answer, and only a response that never
   * got there is resent — a transport error, or an edge-made bare 429/502/503/504 (isTransient).
   * Should a resend still meet a 409, the caller gets the transient error that prompted it, not
   * the 409 (_requestWithRetry). And no resend starts more than V1_RETRY_WINDOW_MS after the
   * first attempt went out: past that the claim may have lapsed and the resend would buy a
   * second solve, so the call ends with the last real error instead.
   * @param {{ signal?: AbortSignal, idempotencyKey?: string }} [opts]
   */
  async _solveSync(body, opts) {
    opts = opts || {};
    const tally = newTally();
    return this._requestWithRetry('POST', '/solve', body, {
      signal: opts.signal,
      idempotencyKey: opts.idempotencyKey || randomUUID(),
      deadlineAt: tally.startedAt + this.timeoutMs,
      syncSolve: true,
      tally,
    });
  }

  /**
   * `_request` plus the retry policy: a transient failure (isTransient) is sent again after
   * retryDelayMs, until it succeeds, a terminal error arrives, `maxAttempts` is spent, or the
   * deadline is too close. Each attempt gets what the deadline has left (never more than
   * `attemptTimeoutMs`, the client timeout by default), floored at `minTimeoutMs` for the poll
   * that is allowed to land on the deadline.
   *
   * No retry starts with less than MIN_ATTEMPT_MS of budget: it would be cut off before the
   * server answered, and the error would then say "timeout" about a request that was never given
   * a chance. The error after the last attempt (retriesExhausted) therefore carries the last
   * real response — status, code, message, request id — never the cut-off of a trailing attempt,
   * plus the call's request count and elapsed time from `tally`.
   *
   * On v1 (`syncSolve`) a retry is also not started past V1_RETRY_WINDOW_MS from the first
   * attempt's send, for the same reporting: the last real response, attempts and elapsed time.
   *
   * @param {{ signal?: AbortSignal, idempotencyKey?: string, deadlineAt: number, attemptTimeoutMs?: number, minTimeoutMs?: number, syncSolve?: boolean, tally?: { startedAt: number, attempts: number } }} opts
   */
  async _requestWithRetry(method, path, body, opts) {
    const policy = this.retry;
    const attemptCapMs = opts.attemptTimeoutMs || this.timeoutMs;
    const tally = opts.tally || newTally();
    // The instant past which no v1 retry may start, from the first attempt's send (it goes out
    // in this same tick). Infinity on v2, which has no such wall.
    const retryWallAt = opts.syncSolve ? Date.now() + V1_RETRY_WINDOW_MS : Infinity;
    let backoffMs = policy ? policy.initialBackoffMs : 0;
    // Attempts of this one request — what maxAttempts bounds; tally.attempts spans the call.
    let sent = 0;
    // The last failure that says something about the server: a response, or a transport error
    // from an attempt that had its full timeout. Never one the deadline cut short.
    let lastReal;

    for (;;) {
      sent++;
      tally.attempts++;
      const timeoutMs = Math.min(attemptCapMs, Math.max(opts.deadlineAt - Date.now(), opts.minTimeoutMs || 1));
      try {
        return await this._request(method, path, body, { signal: opts.signal, timeoutMs, idempotencyKey: opts.idempotencyKey });
      } catch (err) {
        if (!policy) throw err;
        // A v1 resend that meets the gateway's in-flight guard only proves the first attempt got
        // through; the honest outcome is the transient error that prompted the resend.
        if (opts.syncSolve && lastReal && err.code === 'idempotency_conflict') {
          throw retriesExhausted(lastReal, tally, 'the resend answered 409 idempotency_conflict, so the first attempt had reached the gateway');
        }
        if (!isTransient(err, opts.syncSolve)) throw err;
        // An attempt whose timeout was the deadline's remainder rather than the per-request cap
        // was cut short by the deadline: it says nothing about the server, the last real one does.
        const cutByDeadline = err.status === 0 && err.code === 'timeout' && timeoutMs < attemptCapMs;
        if (cutByDeadline) {
          throw retriesExhausted(lastReal || err, tally, lastReal ? 'a final attempt was cut short by the deadline after ' + timeoutMs + 'ms' : undefined);
        }
        lastReal = err;
        if (sent >= policy.maxAttempts) throw retriesExhausted(err, tally);

        const waitMs = retryDelayMs(err, backoffMs, policy);
        backoffMs = Math.min(backoffMs * 2, policy.maxBackoffMs);
        // Not enough budget after the wait for a retry that could answer: report what we have.
        if (opts.deadlineAt - Date.now() - waitMs < MIN_ATTEMPT_MS) throw retriesExhausted(err, tally);
        // A v1 retry that would start past the window could outlive the gateway's idempotency claim.
        if (Date.now() + waitMs > retryWallAt) throw retriesExhausted(err, tally, V1_RETRY_WINDOW_NOTE);
        try {
          await sleep(waitMs, opts.signal, canceledError);
        } catch (e) {
          throw withKey(e, opts.idempotencyKey);
        }
        // The clock may have moved more than the timer said (a stalled event loop): check again.
        if (opts.deadlineAt - Date.now() < MIN_ATTEMPT_MS) throw retriesExhausted(err, tally);
        if (Date.now() > retryWallAt) throw retriesExhausted(err, tally, V1_RETRY_WINDOW_NOTE);
      }
    }
  }

  /**
   * One HTTP round trip, no retries. Errors carry `requestId`, `idempotencyKey` and `retryAfterMs`
   * (from the Retry-After header) when known, so the retry layer and the caller can read them.
   * @param {{ signal?: AbortSignal, timeoutMs?: number, idempotencyKey?: string }} [opts] -
   * `timeoutMs` narrows this one request to what a solve's deadline has left; `signal` is the
   * caller's own cancellation; `idempotencyKey` is sent as the Idempotency-Key header.
   */
  async _request(method, path, body, opts) {
    opts = opts || {};
    const timeoutMs = opts.timeoutMs || this.timeoutMs;
    const signal = opts.signal;
    const controller = new AbortController();
    const abort = () => controller.abort();
    const timer = setTimeout(abort, timeoutMs);
    if (signal) {
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    }
    const headers = { 'x-api-key': this.apiKey, 'content-type': 'application/json' };
    // The gateway's dedupe is durable and cross-shard, so a resent submit under the same key
    // returns the original job instead of buying a second solve.
    if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
    const annotate = (err) => withKey(err, opts.idempotencyKey);
    try {
      const res = await this.fetch(this.baseUrl + path, {
        method,
        headers,
        body: body ? JSON.stringify(stripUndefined(body)) : undefined,
        signal: controller.signal,
      });
      // A body that isn't a JSON object (an edge's HTML page, a bare `null`) reads as an empty envelope.
      let data = {};
      try {
        const parsed = await res.json();
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed;
      } catch (_) {}
      // res.ok, not res.status === 200: /v2/solve accepts with a 202.
      if (!res.ok) {
        // Railway's edge answers a shed request with a bare 429 and no JSON envelope, so `data`
        // is empty there: the code falls back to 'error' and the status alone tells the story.
        // isTransient leans on that fallback to tell an edge page from a gateway answer.
        const envelope = typeof data.error === 'string' && data.error !== '';
        const err = new KagedCapError(res.status, envelope ? data.error : 'error', data.message || 'HTTP ' + res.status);
        // Off the error envelope, so a failing call can be quoted to support verbatim.
        if (data.request_id) err.requestId = data.request_id;
        const retryAfterMs = parseRetryAfter(res);
        if (retryAfterMs !== undefined) err.retryAfterMs = retryAfterMs;
        throw err;
      }
      return data;
    } catch (err) {
      if (err instanceof KagedCapError) throw annotate(err);
      if (err && err.name === 'AbortError') {
        if (signal && signal.aborted) throw abortedError();
        throw annotate(new KagedCapError(0, 'timeout', 'request timed out after ' + timeoutMs + 'ms'));
      }
      // undici wraps the socket error as "fetch failed" with the real reason in `cause`.
      const reason = err && err.cause && err.cause.message ? err.message + ': ' + err.cause.message : err && err.message ? err.message : String(err);
      throw annotate(new KagedCapError(0, 'network_error', reason));
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', abort);
    }
  }
}

module.exports = { KagedCapClient, KagedCapError, deriveTask, toKasadaReloadParams, TASKS, DEFAULT_USER_AGENT, DEFAULT_RETRY };
