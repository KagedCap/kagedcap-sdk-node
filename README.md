<p align="center"><img src="https://kagedcap.io/kc-logo.svg" width="260" alt="KagedCap"></p>

# KagedCap Node.js SDK

Solve reCAPTCHA v3 and v3 Enterprise tokens with a single API key. Plain CommonJS,
zero dependencies (uses Node's built-in `fetch`).

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

## Errors

Failures throw `KagedCapError` with `.status`, `.code`, `.message`. Common codes:
`unauthorized`, `insufficient_funds`, `solve_failed`, `solve_timeout`,
`proxy_required`, `proxy_not_allowed`, `validation_error`.

```js
const { KagedCapError } = require('kagedcap');
try {
  await kc.solve({ /* … */ });
} catch (e) {
  if (e instanceof KagedCapError && e.code === 'insufficient_funds') { /* top up */ }
}
```

Only successful solves are billed.
