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
 */

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

/** Wait `ms`, cutting the wait short with an `aborted` error if the caller's signal fires. */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(abortedError());
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortedError());
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
   * @param {{ baseUrl?: string, timeoutMs?: number, fetch?: Function }} [opts]
   */
  constructor(apiKey, opts) {
    if (!apiKey) throw new Error('KagedCapClient: apiKey is required');
    opts = opts || {};
    this.apiKey = apiKey;
    this.baseUrl = (opts.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
    this.timeoutMs = opts.timeoutMs || 120000;
    this.fetch = opts.fetch || globalThis.fetch;
    if (!this.fetch) throw new Error('KagedCapClient: global fetch not found — use Node 18+ or pass opts.fetch');
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
    return this._submit(body, { signal: params.signal, timeoutMs: this.timeoutMs, idempotencyKey: params.idempotencyKey });
  }

  /**
   * Fetch a queued solve's current state from `/v2/solve/{id}`, returned as it came. Read
   * `status` (`running` | `done` | `failed`), not `success`. On `done`, the result fields are
   * present until the gateway clears them ~5 minutes later. An id the gateway doesn't have (or
   * that belongs to another account) throws `not_found`.
   * @param {string} id
   * @param {{ signal?: AbortSignal, timeoutMs?: number }} [opts]
   */
  async getSolve(id, opts) {
    opts = opts || {};
    return this._request('GET', '/v2/solve/' + id, undefined, { signal: opts.signal, timeoutMs: opts.timeoutMs });
  }

  /**
   * Solve a captcha through the legacy `/solve` endpoint, which holds the HTTP connection open
   * for the whole solve instead of polling.
   *
   * @deprecated Use `solve`, which submits to `/v2/solve` and polls for the result.
   */
  async solveDeprecated(params) {
    const task = params.task || deriveTask(!!params.enterprise, !!params.proxy, params.version);
    return this._request('POST', '/solve', solveBody(params, task));
  }

  /**
   * Start a Kasada session. Requires `proxy` (the token is IP-bound). Posts to the synchronous
   * `/solve` and resolves with that response directly — the full header set plus the `x_kpsdk_*`
   * values. Keep the result and pass it to `kasadaReload` to refresh the session later.
   * @param {{ proxy: string, site?: string, url?: string, signal?: AbortSignal }} params
   */
  async kasadaLogin(params) {
    params = params || {};
    return this._request('POST', '/solve', kasadaLoginBody(params), { signal: params.signal });
  }

  /**
   * Start a Kasada session through the synchronous `/solve`.
   * @deprecated Use `kasadaLogin` — it now posts to the same synchronous `/solve`; this alias stays for back-compat.
   */
  async kasadaLoginDeprecated(params) {
    params = params || {};
    return this._request('POST', '/solve', kasadaLoginBody(params));
  }

  /**
   * Refresh a Kasada session (no proxy needed). Pass the `kasadaLogin` result directly (its
   * kpsdk_st + x_kpsdk_* are resent for you) or explicit params. Posts to the synchronous `/solve`
   * and resolves with that response directly.
   * @param {object} session - a kasadaLogin result, or { kpsdk_st, hash, x_kpsdk_ct, x_kpsdk_v?, x_kpsdk_h? } (hash + x_kpsdk_ct required)
   * @param {{ signal?: AbortSignal }} [opts]
   */
  async kasadaReload(session, opts) {
    opts = opts || {};
    const p = toKasadaReloadParams(session);
    if (p.kpsdk_st == null) throw new KagedCapError(0, 'validation_error', 'kasadaReload: kpsdk_st is required — pass the kasadaLogin result or an explicit kpsdk_st');
    return this._request('POST', '/solve', kasadaReloadBody(p), { signal: opts.signal });
  }

  /**
   * Refresh a Kasada session through the synchronous `/solve`.
   * @deprecated Use `kasadaReload` — it now posts to the same synchronous `/solve`; this alias stays for back-compat.
   */
  async kasadaReloadDeprecated(session) {
    const p = toKasadaReloadParams(session);
    if (p.kpsdk_st == null) throw new KagedCapError(0, 'validation_error', 'kasadaReload: kpsdk_st is required — pass the kasadaLogin result or an explicit kpsdk_st');
    return this._request('POST', '/solve', kasadaReloadBody(p));
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
   * @param {{ url: string, proxy: string, action?: 'verify_phone'|'join_queue', phone_number?: string, queueId?: string, eventId?: string, userAgent?: string, deadlineMs?: number, pollIntervalMs?: number, signal?: AbortSignal }} params
   */
  async evaluate(params) {
    return this._solveAsync(evaluateBody(params), {
      deadlineMs: params.deadlineMs, pollIntervalMs: params.pollIntervalMs, signal: params.signal, resultKey: 'decision',
    });
  }

  /**
   * Evaluate through the legacy synchronous `/solve`.
   * @deprecated Use `evaluate`, which submits to `/v2/solve` and polls.
   */
  async evaluateDeprecated(params) {
    return this._request('POST', '/solve', evaluateBody(params));
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
    const deadlineAt = Date.now() + deadlineMs;
    const job = await this._submit(body, { signal, timeoutMs: Math.min(this.timeoutMs, deadlineMs), idempotencyKey: opts.idempotencyKey });
    const resultKey = opts.resultKey || 'token';

    for (;;) {
      const left = deadlineAt - Date.now();
      if (left <= 0) throw deadlineError(deadlineMs);
      await sleep(Math.min(pollIntervalMs, left), signal);

      // A poll always follows the wait, even one that landed exactly on the deadline: the budget
      // bounds how long we wait, and by now the answer may already be sitting there. That last
      // poll gets one interval to reply so it can't hang far past the caller's wall.
      const state = await this._request('GET', '/v2/solve/' + job.id, undefined, {
        signal,
        timeoutMs: Math.min(this.timeoutMs, Math.max(deadlineAt - Date.now(), pollIntervalMs)),
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

  async _submit(body, opts) {
    const job = await this._request('POST', '/v2/solve', body, opts);
    // 202 carries { success, id, status:'running' }; the id is the only part we can't do without.
    if (!job.id) throw new KagedCapError(0, 'invalid_response', '/v2/solve accepted the job but returned no id');
    return job;
  }

  /**
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
    try {
      const res = await this.fetch(this.baseUrl + path, {
        method,
        headers,
        body: body ? JSON.stringify(stripUndefined(body)) : undefined,
        signal: controller.signal,
      });
      let data = {};
      try {
        data = await res.json();
      } catch (_) {}
      // res.ok, not res.status === 200: /v2/solve accepts with a 202.
      if (!res.ok) {
        const err = new KagedCapError(res.status, data.error || 'error', data.message || 'HTTP ' + res.status);
        // Off the error envelope, so a failing call can be quoted to support verbatim.
        if (data.request_id) err.requestId = data.request_id;
        throw err;
      }
      return data;
    } catch (err) {
      if (err instanceof KagedCapError) throw err;
      if (err && err.name === 'AbortError') {
        if (signal && signal.aborted) throw abortedError();
        throw new KagedCapError(0, 'timeout', 'request timed out after ' + timeoutMs + 'ms');
      }
      throw new KagedCapError(0, 'network_error', err && err.message ? err.message : String(err));
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', abort);
    }
  }
}

module.exports = { KagedCapClient, KagedCapError, deriveTask, toKasadaReloadParams, TASKS, DEFAULT_USER_AGENT };
