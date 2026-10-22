<p align="center"><img src="https://kagedcap.io/kc-logo.svg" width="260" alt="KagedCap"></p>

# KagedCap Node.js SDK

Solve reCAPTCHA (v3, v3 Enterprise, v2), Ticketmaster tmpt, Kasada, and Ticketmaster EPSF
evaluate with a single API key. Plain CommonJS, zero dependencies (uses Node's built-in `fetch`).

## Install

```bash
npm install kagedcap
```

Requires Node 18+.

## Quick start

```js
const { KagedCapClient } = require('kagedcap');

const kc = new KagedCapClient(process.env.KAGEDCAP_API_KEY);

(async () => {
  const { token } = await kc.solve({
    sitekey: '6LcvL3UrAAAAAO_9u8Seiuf-I6F_tP_jSS-zndXV',
    url: 'https://www.ticketmaster.com',
    action: 'Event',
    enterprise: true, // ProxyLess Enterprise
  });
  console.log(token);

  const bal = await kc.checkBalance();
  console.log('balance:', bal.display);
})();
```

## How `solve` works

`solve` submits the job to `POST /v2/solve`, then polls `GET /v2/solve/{id}` every 5s until the
job reports `done` or `failed`. It still blocks and still resolves with the token — the difference
is that no HTTP connection is held open for the length of the solve, so a slow solve can't be cut
short by a proxy or load balancer idling your connection out.

Two knobs, both per call:

```js
const { token, solve_ms } = await kc.solve({
  sitekey: '6Lc…',
  url: 'https://example.com',
  action: 'login',
  deadlineMs: 60000,    // whole budget: submit + every poll. Default 120000.
  pollIntervalMs: 2000, // gap between polls. Default 5000.
});
```

Past `deadlineMs` you get a `KagedCapError` with code `timeout`. `solve_ms` and `elapsed_ms` are
reported when the gateway has them and are absent or `null` otherwise — don't build on them.

Pass an `AbortSignal` to stop a solve early; it cuts an in-flight request and the wait between
polls (code `aborted`), and a retry backoff (code `canceled`):

```js
const ac = new AbortController();
setTimeout(() => ac.abort(), 10000);
await kc.solve({ sitekey: '6Lc…', url: 'https://example.com', signal: ac.signal });
```

`callback_url` (https, publicly resolvable) has the gateway POST the finished result to you as
well, and `idempotencyKey` is sent as `Idempotency-Key` — dedupe is durable and cross-shard, so a
resent submit returns the first job instead of buying a second solve:

```js
await kc.solve({
  sitekey: '6Lc…',
  url: 'https://example.com',
  callback_url: 'https://hooks.example.com/kagedcap',
  idempotencyKey: orderId,
});
```

The gateway clears a result's `token` about five minutes after the solve completes (a reCAPTCHA
token is dead in ~2 anyway). A poll that lands after that throws `result_expired` rather than
handing back an empty token — read the result promptly, or use `callback_url`.

### Retries

The edge in front of the API sheds requests with a bare `429` under load, and the API itself
answers `429` / `5xx` when it has no room. Since 0.2.2 the SDK treats those as transient and
retries them instead of failing the solve:

- **Retried on `/v2`:** HTTP `429`, `500`, `502`, `503`, `504`, and transport failures (connection
  refused or reset, DNS, a per-request timeout) — on the `/v2/solve` submit and on every
  `/v2/solve/{id}` poll, until `deadlineMs` runs out (`timeoutMs` for `submitSolve` / `getSolve`).
- **Retried on the synchronous `/solve`** (`solveDeprecated`, `kasadaLogin`, `kasadaReload`, the
  `*Deprecated` twins): only what never reached the gateway — a transport failure, or an
  edge-made `429` / `502` / `503` / `504` with no JSON envelope (a Railway or Cloudflare page) —
  and always under the same `Idempotency-Key`. A `429` / `5xx` that carries the gateway's JSON
  envelope is final there: the gateway claims the key before it answers and holds it for 120s, so
  a resend could only come back `409 idempotency_conflict`, and the honest outcome is the error
  you got. Should a resend still meet that `409`, you get the transient error that prompted it
  (with `attempts`), not the `409`. And no resend starts more than 100s after the call's first
  attempt went out — past that the gateway's claim may have lapsed and the resend would buy a
  second solve — so the call ends with the last real error, `attempts` and `elapsedMs` set, just
  as when the deadline runs out.
- **Never retried:** `400`, `401`, `402`, `403`, `404`, `409`, `413`, `422`, a job that reports
  `status: 'failed'`, and any of these codes whatever status carries them: `validation_error`,
  `unauthorized`, `key_revoked`, `account_suspended`, `insufficient_funds`,
  `key_spend_cap_reached`, `proxy_invalid`, `proxy_required`, `proxy_not_allowed`,
  `unsupported_task`, `action_required`, `callback_url_invalid`, `not_found`,
  `idempotency_conflict`, `key_frozen`, `subscription_quota_exhausted`, `subscription_past_due`,
  `host_not_allowed`.
- **Backoff:** 250ms, doubling to a 5s cap, with full jitter — a random wait in `[50ms, backoff]`.
  A valid `Retry-After` header (delay-seconds, or an HTTP-date in 1970–9999) is honoured instead,
  clamped to `[50ms, 10s]`; `Retry-After: 0`, a past date or anything else malformed never makes
  the client wait less than 50ms. Setting `initialBackoffMs` / `maxBackoffMs` to 0 or a negative
  number means the default, not a zero wait. The poll interval between successful polls is
  unchanged.
- **Idempotency:** every request to `/v2/solve` and to `/solve` carries an `Idempotency-Key` —
  yours, or a UUIDv4 the SDK generates per call — and a resend replays the same key, so a resend
  after a `5xx` that may already have landed returns the original job rather than buying a second
  solve. A failed call exposes it as `err.idempotencyKey`.
- **When the deadline runs out** no retry is started with less than 500ms of budget left, and the
  `KagedCapError` keeps the last real response's `status`, `code`, `message` and `requestId` —
  never the cut-off of a trailing attempt the deadline interrupted — and adds `attempts` (every
  request the call sent: the submit, each poll, each retry) and `elapsedMs` (since the call
  started). The message says so:
  `HTTP 429 — gave up after 14 attempts over 119512ms (last: HTTP 429 error)`.
- **Cancelling:** an `AbortSignal` that fires during a retry backoff rejects with code
  `canceled`; one that fires mid-request or during a poll wait rejects with `aborted`, as before.

Tune or disable it per client:

```js
const kc = new KagedCapClient(key, { retry: false }); // first 429/5xx is the answer

const kc = new KagedCapClient(key, {
  retry: { maxAttempts: 5, initialBackoffMs: 500, maxBackoffMs: 8000, maxRetryAfterMs: 30000 },
});
```

`maxAttempts` bounds each request (the submit, or one poll) on its own; the deadline bounds the
call as a whole.

### The old synchronous call

`solveDeprecated` is the previous behaviour, unchanged: one `POST /solve` that holds the
connection open for the whole solve and returns `{ success, token, task, score, verification }`.
It still works and takes the same params minus the polling ones. New code should use `solve`.

```js
const { token, score } = await kc.solveDeprecated({ sitekey: '6Lc…', url: 'https://example.com', action: 'login' });
```

`evaluate` now submits to `/v2/solve` and polls too, exactly like `solve` (it takes optional
`deadlineMs` / `pollIntervalMs` / `signal`). `kasadaLogin` and `kasadaReload` are the exception:
they post to the synchronous `/solve` and resolve with the result directly — no submit, no poll.
Each of the three keeps a `*Deprecated` twin — `kasadaLoginDeprecated`, `kasadaReloadDeprecated`,
`evaluateDeprecated` — on the synchronous `/solve`. And `submitSolve` + `getSolve` expose the
submit and poll steps directly, for a callback-driven flow or your own loop.

### User agent

Solves without a `userAgent` are sent with `DEFAULT_USER_AGENT` — the same Chrome 151 Windows
desktop profile the solvers run, so the token embeds an identity the server agrees with. Pass
your own to match the browser your traffic actually presents:

```js
const { DEFAULT_USER_AGENT } = require('kagedcap');

await kc.solve({ sitekey: '6Lc…', url: 'https://example.com', action: 'login', userAgent: DEFAULT_USER_AGENT });
```

Kasada never takes a `userAgent` — its result carries the identity the harvester actually used.

## With a proxy

```js
await kc.solve({
  sitekey: '6Lc…',
  url: 'https://example.com/login',
  action: 'login',
  proxy: 'http://user:pass@1.2.3.4:8080', // or host:port:user:pass
});
```

Omit `proxy` for a ProxyLess solve. Set `enterprise: true` for Enterprise sitekeys,
or pass `task` explicitly.

## Kasada

`kasadaLogin` starts a session (requires a proxy — the token is IP-bound) and returns the
full header set. Keep that result and pass it to `kasadaReload` to refresh the session — the
SDK resends the session's `kpsdk_st`, `hash`, and `x_kpsdk_*` values for you (`hash` + `x_kpsdk_ct` are required).

Both run on the synchronous `POST /solve` endpoint: the call holds the connection open for the
solve and resolves with the result directly, so neither takes `deadlineMs` / `pollIntervalMs`
(there's nothing to poll). Pass an `AbortSignal` to cancel the in-flight request.

```js
const login = await kc.kasadaLogin({ site: 'ticketmaster', proxy: 'http://user:pass@1.2.3.4:8080' });
// Replay login.headers (user-agent + sec-ch-ua*) and login.x_kpsdk_* on your request.

const fresh = await kc.kasadaReload(login); // no proxy needed
console.log(fresh.x_kpsdk_cd);
```

Kasada results have **no `token`** — replay `headers` and the `x_kpsdk_*` values instead.

## Evaluate

`evaluate` runs a Ticketmaster EPSF check and returns the allow token to replay on the next APS
step, plus the `decision` behind it (`allow`, `challenge`, or `block`). `url` and `proxy` are
required — the host picks the flow, so `auth.*` evaluates verify_phone and any other Ticketmaster
host evaluates join_queue.

```js
const { token, decision } = await kc.evaluate({
  url: 'https://auth.ticketmaster.com/…',
  proxy: 'http://user:pass@1.2.3.4:8080',
  phone_number: '+12025550123', // verify_phone only, country prefix included
});
```

Pass `action: 'verify_phone' | 'join_queue'` only to override that host default — leaving it off
is what keeps it. For a join_queue evaluate, pass `queueId` / `eventId` instead of `phone_number`.

## Errors

Failures throw `KagedCapError` with `.status`, `.code`, `.message`, and `.requestId` when the
gateway sent one. Codes from the API, grouped by HTTP status:

- **400** `validation_error` (bad request shape), `proxy_invalid` (proxy malformed or disallowed —
  caught pre-flight, no solve attempted), `callback_url_invalid` (`callback_url` isn't a public
  https URL)
- **401** `unauthorized` (missing or invalid API key)
- **402** `insufficient_funds`, `key_spend_cap_reached`, `subscription_quota_exhausted`,
  `subscription_past_due`
- **403** `account_suspended`, `host_not_allowed` (the key's allowlist doesn't include the page host)
- **404** `not_found` (a `/v2` job id that's unknown, expired, or not yours)
- **409** `idempotency_conflict` (same `Idempotency-Key`, different body)
- **422** `proxy_unreachable` — the solve ran and your proxy didn't answer, so it isn't billed.
  (Was `502` before 2026-09-24.)
- **429** `concurrency_limit_exceeded`, `rate_limited`, `overloaded`, `key_frozen` (key auto-frozen
  after a burst of failed solves — usually bad proxies)
- **500** `internal_error`
- **502** `solve_failed` — the solve was attempted and failed; it isn't billed, and a blind retry
  usually fails the same way
- **503** `no_capacity`, `solver_unavailable` (a node was picked but couldn't be reached),
  `maintenance`, `proxyless_disabled`
- **504** `solve_timeout` — the solve ran past its deadline (not billed)

The SDK retries `429`, `500`, `502`, `503` and `504` on `/v2` for you (see [Retries](#retries));
on the synchronous `/solve` any of those that carries the gateway's envelope (`solve_failed`,
`no_capacity`, `rate_limited`, …) is the answer, as is `422` `proxy_unreachable` — fix the proxy
or the input first. A bare `429` / `502` / `503` / `504` with no envelope (the edge shed the
request; code `error`) is retried everywhere.

Raised by the SDK itself, with `.status` 0: `timeout` (the solve outran `deadlineMs`), `aborted`
(your `AbortSignal` fired mid-request or between polls), `canceled` (your `AbortSignal` fired
during a retry backoff), `result_expired` (the job finished but its token was already cleared),
and `network_error`.

```js
const { KagedCapError } = require('kagedcap');
try {
  await kc.solve({ /* … */ });
} catch (e) {
  if (e instanceof KagedCapError && e.code === 'insufficient_funds') { /* top up */ }
}
```

Only successful solves are billed.
