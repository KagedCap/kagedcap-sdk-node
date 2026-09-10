'use strict';

/**
 * Covers the v2 async solve against the live /v2/solve contract: submit, poll, and every way a
 * poll can end. `fetch` is injected, so nothing here touches the network.
 */

const test = require('node:test');
const assert = require('node:assert');
const { KagedCapClient, KagedCapError } = require('..');

/** A fetch stand-in that replays `responses` in order and records every call it was given. */
function stubFetch(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : undefined });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    const { status = 200, body = {} } = typeof next === 'function' ? next(calls.length) : next;
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  fn.calls = calls;
  return fn;
}

/** Rejects the way undici does when the request's own signal fires. */
function abortAwareFetch() {
  return (url, init) =>
    new Promise((_resolve, reject) => {
      const fail = () => {
        const err = new Error('This operation was aborted');
        err.name = 'AbortError';
        reject(err);
      };
      if (init.signal.aborted) return fail();
      init.signal.addEventListener('abort', fail, { once: true });
    });
}

const ACCEPTED = { status: 202, body: { success: true, id: 'job-1', status: 'running' } };
const RUNNING = { status: 200, body: { success: false, id: 'job-1', status: 'running', token: null, created_at: '2026-09-10T00:00:00Z' } };
const DONE = {
  status: 200,
  body: { success: true, id: 'job-1', status: 'done', token: 'tok-abc', solve_ms: 1840, elapsed_ms: 2100, created_at: '2026-09-10T00:00:00Z', completed_at: '2026-09-10T00:00:02Z' },
};

function client(fetch, opts) {
  return new KagedCapClient('key-123', Object.assign({ fetch }, opts));
}

const SOLVE = { sitekey: '6Lc-test', url: 'https://example.com', action: 'login', pollIntervalMs: 5 };

test('solve submits to /v2/solve and polls /v2/solve/{id} until done', async () => {
  const fetch = stubFetch([ACCEPTED, RUNNING, RUNNING, DONE]);
  const res = await client(fetch).solve(SOLVE);

  assert.equal(res.token, 'tok-abc');
  assert.equal(res.status, 'done');
  assert.equal(fetch.calls.length, 4);
  assert.equal(fetch.calls[0].url, 'https://api.kagedcap.io/v2/solve');
  assert.equal(fetch.calls[0].init.method, 'POST');
  assert.equal(fetch.calls[0].init.headers['x-api-key'], 'key-123');
  assert.equal(fetch.calls[1].url, 'https://api.kagedcap.io/v2/solve/job-1');
  assert.equal(fetch.calls[1].init.method, 'GET');
});

test('solve forwards the v1 body plus callback_url, and defaults the user agent', async () => {
  const fetch = stubFetch([ACCEPTED, DONE]);
  await client(fetch).solve(Object.assign({}, SOLVE, { enterprise: true, callback_url: 'https://hooks.example.com/kc' }));

  const body = fetch.calls[0].body;
  assert.equal(body.task, 'ReCaptchaV3EnterpriseTaskProxyLess');
  assert.equal(body.sitekey, '6Lc-test');
  assert.equal(body.url, 'https://example.com');
  assert.equal(body.action, 'login');
  assert.equal(body.callback_url, 'https://hooks.example.com/kc');
  assert.match(body.userAgent, /Chrome\/151/);
  // The polling knobs are the SDK's own; sending them would be a body the gateway never asked for.
  assert.ok(!('pollIntervalMs' in body) && !('deadlineMs' in body));
});

test('solve keys completion off status, not success', async () => {
  // A gateway that has flipped success but not yet status must not be read as finished, and a
  // 'done' whose success field lags must not be read as still running.
  const fetch = stubFetch([
    ACCEPTED,
    { status: 200, body: { success: true, id: 'job-1', status: 'running', token: null } },
    { status: 200, body: { success: false, id: 'job-1', status: 'done', token: 'tok-late' } },
  ]);
  const res = await client(fetch).solve(SOLVE);

  assert.equal(res.token, 'tok-late');
  assert.equal(fetch.calls.length, 3);
});

test('solve resolves without solve_ms or elapsed_ms', async () => {
  const fetch = stubFetch([ACCEPTED, { status: 200, body: { success: true, id: 'job-1', status: 'done', token: 'tok-abc', solve_ms: null } }]);
  const res = await client(fetch).solve(SOLVE);

  assert.equal(res.token, 'tok-abc');
  assert.equal(res.solve_ms, null);
  assert.equal(res.elapsed_ms, undefined);
});

test('solve throws result_expired when a done job has had its token cleared', async () => {
  const fetch = stubFetch([ACCEPTED, { status: 200, body: { success: true, id: 'job-1', status: 'done', token: null, completed_at: '2026-09-10T00:00:02Z' } }]);

  await assert.rejects(client(fetch).solve(SOLVE), (err) => {
    assert.ok(err instanceof KagedCapError);
    assert.equal(err.code, 'result_expired');
    return true;
  });
});

test('solve surfaces the error of a failed job', async () => {
  const fetch = stubFetch([ACCEPTED, { status: 200, body: { success: false, id: 'job-1', status: 'failed', token: null, error: 'solve_failed' } }]);

  await assert.rejects(client(fetch).solve(SOLVE), (err) => {
    assert.equal(err.code, 'solve_failed');
    assert.equal(err.status, 0);
    return true;
  });
});

test('solve gives up at the deadline with a timeout', async () => {
  const fetch = stubFetch([ACCEPTED, RUNNING]);
  const started = Date.now();

  await assert.rejects(client(fetch).solve(Object.assign({}, SOLVE, { deadlineMs: 40 })), (err) => {
    assert.equal(err.code, 'timeout');
    return true;
  });
  assert.ok(Date.now() - started < 1000, 'gave up near the deadline, not the client timeout');
});

test('solve still polls once when the wait lands on the deadline', async () => {
  // deadlineMs below one poll interval: the wait is clamped to the budget, and the answer that
  // may already be waiting is still read rather than thrown away as a timeout.
  const fetch = stubFetch([ACCEPTED, DONE]);
  const res = await client(fetch).solve(Object.assign({}, SOLVE, { deadlineMs: 20, pollIntervalMs: 5000 }));

  assert.equal(res.token, 'tok-abc');
  assert.equal(fetch.calls.length, 2);
});

test('solve aborts mid-wait when the caller signals', async () => {
  const fetch = stubFetch([ACCEPTED, RUNNING]);
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 10);

  await assert.rejects(client(fetch).solve(Object.assign({}, SOLVE, { pollIntervalMs: 5000, signal: ac.signal })), (err) => {
    assert.equal(err.code, 'aborted');
    return true;
  });
});

test('solve aborts mid-request when the caller signals', async () => {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 10);

  await assert.rejects(client(abortAwareFetch()).solve(Object.assign({}, SOLVE, { signal: ac.signal })), (err) => {
    assert.equal(err.code, 'aborted');
    return true;
  });
});

test('solve surfaces a submit error envelope with its request_id', async () => {
  const fetch = stubFetch([{ status: 402, body: { success: false, error: 'insufficient_funds', message: 'balance too low', request_id: 'req-9' } }]);

  await assert.rejects(client(fetch).solve(SOLVE), (err) => {
    assert.equal(err.status, 402);
    assert.equal(err.code, 'insufficient_funds');
    assert.equal(err.message, 'balance too low');
    assert.equal(err.requestId, 'req-9');
    return true;
  });
});

test('solve surfaces a 404 poll as not_found without retrying it', async () => {
  const fetch = stubFetch([ACCEPTED, { status: 404, body: { success: false, error: 'not_found', message: 'no such job', request_id: 'req-4' } }]);

  await assert.rejects(client(fetch).solve(SOLVE), (err) => {
    assert.equal(err.status, 404);
    assert.equal(err.code, 'not_found');
    return true;
  });
  assert.equal(fetch.calls.length, 2);
});

test('solve sends Idempotency-Key only when one is given', async () => {
  const withKey = stubFetch([ACCEPTED, DONE]);
  await client(withKey).solve(Object.assign({}, SOLVE, { idempotencyKey: 'order-77' }));
  assert.equal(withKey.calls[0].init.headers['Idempotency-Key'], 'order-77');
  // The poll is a plain read; replaying the submit's key on it would be meaningless.
  assert.equal(withKey.calls[1].init.headers['Idempotency-Key'], undefined);

  const without = stubFetch([ACCEPTED, DONE]);
  await client(without).solve(SOLVE);
  assert.equal(without.calls[0].init.headers['Idempotency-Key'], undefined);
});

test('solveDeprecated still posts a single synchronous /solve', async () => {
  const fetch = stubFetch([{ status: 200, body: { success: true, token: 'tok-sync', task: 'ReCaptchaV3TaskProxyLess', score: 0.9, verification: null } }]);
  const res = await client(fetch).solveDeprecated({ sitekey: '6Lc-test', url: 'https://example.com', action: 'login' });

  assert.equal(res.token, 'tok-sync');
  assert.equal(res.score, 0.9);
  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0].url, 'https://api.kagedcap.io/solve');
  assert.equal(fetch.calls[0].init.method, 'POST');
  assert.equal(fetch.calls[0].body.task, 'ReCaptchaV3TaskProxyLess');
});

test('kasada and evaluate stay on the synchronous /solve endpoint', async () => {
  const kasada = stubFetch([{ status: 200, body: { success: true, x_kpsdk_cd: 'cd', kpsdk_st: 1 } }]);
  await client(kasada).kasadaLogin({ site: 'ticketmaster', proxy: 'http://u:p@1.2.3.4:8080' });
  assert.equal(kasada.calls[0].url, 'https://api.kagedcap.io/solve');

  const evaluate = stubFetch([{ status: 200, body: { success: true, token: 'tok', decision: 'allow' } }]);
  await client(evaluate).evaluate({ url: 'https://auth.ticketmaster.com/x', proxy: 'http://u:p@1.2.3.4:8080' });
  assert.equal(evaluate.calls[0].url, 'https://api.kagedcap.io/solve');
});
