<p align="center"><img src="https://kagedcap.io/kc-logo.svg" width="260" alt="KagedCap"></p>

# KagedCap Node.js SDK

Solve reCAPTCHA (v3, v3 Enterprise, v2), Ticketmaster tmpt, and Kasada with a single API
key. Plain CommonJS, zero dependencies (uses Node's built-in `fetch`).

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
  const { token, score } = await kc.solve({
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

```js
const login = await kc.kasadaLogin({ site: 'ticketmaster', proxy: 'http://user:pass@1.2.3.4:8080' });
// Replay login.headers (user-agent + sec-ch-ua*) and login.x_kpsdk_* on your request.

const fresh = await kc.kasadaReload(login); // no proxy needed
console.log(fresh.x_kpsdk_cd);
```

Kasada results have **no `token`** — replay `headers` and the `x_kpsdk_*` values instead.

## Errors

Failures throw `KagedCapError` with `.status`, `.code`, `.message`. Common codes:
`unauthorized`, `insufficient_funds`, `solve_failed`, `solve_timeout`,
`proxy_required`, `proxy_not_allowed`, `validation_error`, `concurrency_limit_exceeded`, `key_frozen`.

```js
const { KagedCapError } = require('kagedcap');
try {
  await kc.solve({ /* … */ });
} catch (e) {
  if (e instanceof KagedCapError && e.code === 'insufficient_funds') { /* top up */ }
}
```

Only successful solves are billed.
