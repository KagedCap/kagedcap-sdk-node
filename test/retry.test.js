'use strict';

/**
 * Covers the transient-failure retry policy (2026-10-20): what is retried, what is not, the
 * backoff floor and bounds, Retry-After, idempotency on the resent submit, the v1 synchronous
 * rules, and what the final error says when the deadline runs out. `fetch` is injected, so
 * nothing here touches the network — except the last test, which stands up a local
 * http.createServer on 127.0.0.1 and drives the SDK through Node's real fetch.
 *
 * Backoffs are shortened through the client's `retry` option so the suite stays fast; the SDK
 * floors every wait at 50ms, so FAST_RETRY makes each retry wait exactly 50ms.
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { KagedCapClient, KagedCapError, DEFAULT_RETRY } = require('..');

function abortError() {
  const err = new Error('This operation was aborted');
  err.name = 'AbortError';
  return err;
}

/**
 * A fetch stand-in that replays `responses` in order (the last one repeats) and records every
 * call with the time it arrived. A response without a `body` answers like Railway's edge: a bare
 * status with a non-JSON payload. `throws` makes the call fail at the transport instead;
 * `delayMs` answers that late; `stall` never answers. Every one of them honours the request's
 * own AbortSignal the way undici does, so the SDK's per-attempt timeout is exercised too.
 */
function stubFetch(responses) {
  const calls = [];
  const fn = (url, init) =>
    new Promise((resolve, reject) => {
      calls.push({ url, init, body: init.body ? JSON.parse(init.body) : undefined, at: Date.now() });
      const next = responses[Math.min(calls.length - 1, responses.length - 1)];
      const { status = 200, body, headers = {}, throws, delayMs = 0, stall = false } = typeof next === 'function' ? next(calls.length) : next;
      const signal = init.signal;
      if (signal && signal.aborted) return reject(abortError());
      let timer;
      const onAbort = () => {
        clearTimeout(timer);
        reject(abortError());
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      if (stall) return;
      timer = setTimeout(() => {
        if (signal) signal.removeEventListener('abort', onAbort);
        if (throws) return reject(throws);
        resolve({
          ok: status >= 200 && status < 300,
          status,
          headers: new Headers(headers),
          json: async () => {
            if (body === undefined) throw new SyntaxError('Unexpected token r in JSON');
            return body;
          },
        });
      }, delayMs);
    });
  fn.calls = calls;
  fn.gaps = () => calls.slice(1).map((c, i) => c.at - calls[i].at);
  return fn;
}

const ACCEPTED = { status: 202, body: { success: true, id: 'job-1', status: 'running' } };
const RUNNING = { status: 200, body: { success: false, id: 'job-1', status: 'running', token: null } };
const DONE = { status: 200, body: { success: true, id: 'job-1', status: 'done', token: 'tok-abc' } };
/** What the Railway edge sends when it sheds: a 429 and a text body, no envelope. */
const EDGE_429 = { status: 429 };
const API_429 = { status: 429, body: { success: false, error: 'rate_limited', message: 'slow down', request_id: 'req-429' } };
const API_503 = { status: 503, body: { success: false, error: 'no_capacity', message: 'no nodes', request_id: 'req-503' } };
const API_502 = { status: 502, body: { success: false, error: 'solve_failed', message: 'solver crashed', request_id: 'req-502' } };
const API_409 = { status: 409, body: { success: false, error: 'idempotency_conflict', message: 'a request with this key is in flight', request_id: 'req-409' } };
const SYNC_OK = { status: 200, body: { success: true, token: 'tok-sync', task: 'ReCaptchaV3TaskProxyLess', score: 0.9, verification: null } };

/** Every wait becomes exactly the 50ms floor, so timings below are predictable. */
const FAST_RETRY = { initialBackoffMs: 50, maxBackoffMs: 50 };
const MIN_BACKOFF_MS = 50;
const MIN_ATTEMPT_MS = 500;
/** No v1 resend starts later than this after the first attempt: the gateway's idempotency claim lives 120s. */
const V1_RETRY_WINDOW_MS = 100000;
/** Timer slop on a loaded CI box: a wait may land a few ms early, a call a few ms late. */
const SLOP = 10;

function client(fetch, opts) {
  return new KagedCapClient('key-123', Object.assign({ fetch, retry: FAST_RETRY }, opts));
}

const SOLVE = { sitekey: '6Lc-test', url: 'https://example.com', action: 'login', pollIntervalMs: 5 };
const SYNC_PARAMS = { sitekey: '6Lc-test', url: 'https://example.com', action: 'login' };

function isUuidV4(s) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(s);
}

function assertNoWaitBelowFloor(gaps) {
  for (const g of gaps) assert.ok(g >= MIN_BACKOFF_MS - SLOP, 'a retry waited only ' + g + 'ms, below the ' + MIN_BACKOFF_MS + 'ms floor (gaps: ' + gaps.join(',') + ')');
}

/**
 * The SDK reads wall time only through Date.now, so replacing it is the clock injection: a
 * 100s "wait" costs no time. Node's timers run on the monotonic clock and keep their real
 * durations, so nothing the SDK sleeps on is affected. Restore it in a finally.
 */
function fakeClock() {
  const realNow = Date.now;
  let offsetMs = 0;
  Date.now = () => realNow() + offsetMs;
  return {
    advance: (ms) => { offsetMs += ms; },
    restore: () => { Date.now = realNow; },
  };
}

test('defaults: retries on, 250ms doubling to 5s, Retry-After capped at 10s', () => {
  assert.deepEqual(DEFAULT_RETRY, { maxAttempts: Infinity, initialBackoffMs: 250, maxBackoffMs: 5000, maxRetryAfterMs: 10000 });
  assert.deepEqual(new KagedCapClient('k', { fetch: async () => {} }).retry, DEFAULT_RETRY);
  assert.equal(new KagedCapClient('k', { fetch: async () => {}, retry: false }).retry, null);
  assert.equal(new KagedCapClient('k', { fetch: async () => {}, retry: { enabled: false } }).retry, null);
});

test('a zero, negative or tiny backoff setting is floored, never a tight loop', () => {
  const policy = (retry) => new KagedCapClient('k', { fetch: async () => {}, retry }).retry;
  // 0 / negative / NaN mean "the default", not "no wait".
  assert.equal(policy({ initialBackoffMs: 0 }).initialBackoffMs, 250);
  assert.equal(policy({ initialBackoffMs: -5 }).initialBackoffMs, 250);
  assert.equal(policy({ initialBackoffMs: NaN }).initialBackoffMs, 250);
  assert.equal(policy({ initialBackoffMs: Infinity }).initialBackoffMs, 250);
  assert.equal(policy({ maxBackoffMs: 0 }).maxBackoffMs, 5000);
  assert.equal(policy({ maxRetryAfterMs: -1 }).maxRetryAfterMs, 10000);
  assert.equal(policy({ maxAttempts: 0 }).maxAttempts, Infinity);
  // A positive setting below the floor is raised to it; an initial above the cap is held to the cap.
  assert.equal(policy({ initialBackoffMs: 10 }).initialBackoffMs, MIN_BACKOFF_MS);
  assert.equal(policy({ maxBackoffMs: 10 }).maxBackoffMs, MIN_BACKOFF_MS);
  assert.equal(policy({ initialBackoffMs: 900, maxBackoffMs: 300 }).initialBackoffMs, 300);
});

test('submit 429 → 429 → 202 succeeds and every submit carries the same Idempotency-Key', async () => {
  const fetch = stubFetch([EDGE_429, API_429, ACCEPTED, DONE]);
  const res = await client(fetch).solve(SOLVE);

  assert.equal(res.token, 'tok-abc');
  const submits = fetch.calls.filter((c) => c.url === 'https://api.kagedcap.io/v2/solve');
  assert.equal(submits.length, 3);
  const keys = new Set(submits.map((c) => c.init.headers['Idempotency-Key']));
  assert.equal(keys.size, 1, 'the retried submit must replay the first attempt\'s key');
  assert.ok(isUuidV4([...keys][0]), 'the SDK-generated key is a UUIDv4');
  // The body is byte-identical too, or the gateway would answer idempotency_conflict.
  assert.deepEqual(submits[1].init.body, submits[0].init.body);
  assert.deepEqual(submits[2].init.body, submits[0].init.body);
  assertNoWaitBelowFloor(fetch.gaps().slice(0, 2));
});

test('a caller-supplied Idempotency-Key is the one replayed on the retried submit', async () => {
  const fetch = stubFetch([API_503, ACCEPTED, DONE]);
  await client(fetch).solve(Object.assign({}, SOLVE, { idempotencyKey: 'order-77' }));
  assert.equal(fetch.calls[0].init.headers['Idempotency-Key'], 'order-77');
  assert.equal(fetch.calls[1].init.headers['Idempotency-Key'], 'order-77');
});

test('poll 503 → 502 → 200 done succeeds', async () => {
  const fetch = stubFetch([ACCEPTED, API_503, API_502, DONE]);
  const res = await client(fetch).solve(SOLVE);

  assert.equal(res.token, 'tok-abc');
  assert.equal(fetch.calls.length, 4);
  for (const c of fetch.calls.slice(1)) assert.equal(c.url, 'https://api.kagedcap.io/v2/solve/job-1');
});

test('a transport failure on submit or poll is retried', async () => {
  const refused = new TypeError('fetch failed');
  refused.cause = new Error('connect ECONNREFUSED 127.0.0.1:443');
  const fetch = stubFetch([{ throws: refused }, ACCEPTED, { throws: new Error('read ECONNRESET') }, DONE]);
  const res = await client(fetch).solve(SOLVE);

  assert.equal(res.token, 'tok-abc');
  assert.equal(fetch.calls.length, 4);
});

test('poll 404 fails immediately as not_found', async () => {
  const fetch = stubFetch([ACCEPTED, { status: 404, body: { success: false, error: 'not_found', message: 'no such job' } }]);

  await assert.rejects(client(fetch).solve(SOLVE), (err) => {
    assert.equal(err.status, 404);
    assert.equal(err.code, 'not_found');
    return true;
  });
  assert.equal(fetch.calls.length, 2);
});

test('400 on submit fails immediately with no retry', async () => {
  const fetch = stubFetch([{ status: 400, body: { success: false, error: 'validation_error', message: 'sitekey required', request_id: 'req-400' } }]);

  await assert.rejects(client(fetch).solve(SOLVE), (err) => {
    assert.equal(err.status, 400);
    assert.equal(err.code, 'validation_error');
    assert.equal(err.requestId, 'req-400');
    assert.ok(isUuidV4(err.idempotencyKey), 'the error names the key the submit went out under');
    return true;
  });
  assert.equal(fetch.calls.length, 1);
});

test('every terminal code ends the call on the spot, whatever transient status carries it', async () => {
  const TERMINAL = [
    'validation_error', 'unauthorized', 'key_revoked', 'account_suspended', 'insufficient_funds',
    'key_spend_cap_reached', 'proxy_invalid', 'proxy_required', 'proxy_not_allowed', 'unsupported_task',
    'action_required', 'callback_url_invalid', 'not_found', 'idempotency_conflict', 'key_frozen',
    'subscription_quota_exhausted', 'subscription_past_due', 'host_not_allowed',
  ];
  for (const [i, code] of TERMINAL.entries()) {
    const status = [429, 500, 502, 503, 504][i % 5];
    // On the v2 submit…
    const v2 = stubFetch([{ status, body: { success: false, error: code, message: 'nope' } }, ACCEPTED, DONE]);
    await assert.rejects(client(v2).solve(SOLVE), (err) => err.code === code && err.status === status);
    assert.equal(v2.calls.length, 1, code + ' on ' + status + ' must not be retried on the submit');
    // …on the v2 poll…
    const poll = stubFetch([ACCEPTED, { status, body: { success: false, error: code, message: 'nope' } }, DONE]);
    await assert.rejects(client(poll).solve(SOLVE), (err) => err.code === code);
    assert.equal(poll.calls.length, 2, code + ' on ' + status + ' must not be retried on the poll');
    // …and on the synchronous v1 /solve.
    const v1 = stubFetch([{ status, body: { success: false, error: code, message: 'nope' } }, SYNC_OK]);
    await assert.rejects(client(v1).solveDeprecated(SYNC_PARAMS), (err) => err.code === code);
    assert.equal(v1.calls.length, 1, code + ' on ' + status + ' must not be retried on v1');
  }
});

test('a job that reports status failed is a verdict, not a retry', async () => {
  const fetch = stubFetch([ACCEPTED, { status: 200, body: { success: false, id: 'job-1', status: 'failed', error: 'solve_failed' } }]);
  await assert.rejects(client(fetch).solve(SOLVE), (err) => err.code === 'solve_failed');
  assert.equal(fetch.calls.length, 2);
});

test('constant 429: retried while the deadline has room, then the last real 429 is reported', async () => {
  const fetch = stubFetch([EDGE_429]);
  const deadlineMs = 700;
  const started = Date.now();

  await assert.rejects(client(fetch).solve(Object.assign({}, SOLVE, { deadlineMs })), (err) => {
    assert.ok(err instanceof KagedCapError);
    assert.equal(err.status, 429);
    assert.equal(err.code, 'error');
    assert.ok(err.attempts > 1, 'retried at least once, got ' + err.attempts);
    assert.equal(err.attempts, fetch.calls.length);
    assert.match(err.message, /429/);
    assert.match(err.message, new RegExp('gave up after ' + err.attempts + ' attempts over \\d+ms \\(last: HTTP 429 error\\)$'));
    assert.ok(err.elapsedMs >= 0 && err.elapsedMs < deadlineMs);
    assert.ok(isUuidV4(err.idempotencyKey));
    return true;
  });
  const elapsed = Date.now() - started;
  // No attempt starts inside the deadline's last 500ms, so the call gives up before the wall.
  assert.ok(elapsed >= 2 * (MIN_BACKOFF_MS - SLOP), 'kept trying for a while, stopped at ' + elapsed + 'ms');
  assert.ok(elapsed <= deadlineMs - MIN_ATTEMPT_MS + 3 * SLOP, 'stopped before the last 500ms of budget, at ' + elapsed + 'ms');
  assertNoWaitBelowFloor(fetch.gaps());
});

test('the final error keeps the last envelope\'s code, message and request id', async () => {
  const fetch = stubFetch([ACCEPTED, API_503]);
  await assert.rejects(client(fetch).solve(Object.assign({}, SOLVE, { deadlineMs: 700 })), (err) => {
    assert.equal(err.status, 503);
    assert.equal(err.code, 'no_capacity');
    assert.equal(err.requestId, 'req-503');
    assert.match(err.message, /^no nodes — gave up after \d+ attempts over \d+ms \(last: HTTP 503 no_capacity\)$/);
    return true;
  });
  assert.ok(fetch.calls.length > 2, 'the poll was retried, got ' + fetch.calls.length + ' calls');
});

test('with real latency the final error still carries the last 429, never a timeout', async () => {
  // A 20ms round trip is the shape the reviewer measured in production; three runs guard
  // against the timing landing well just once.
  for (let run = 0; run < 3; run++) {
    const fetch = stubFetch([Object.assign({ delayMs: 20 }, EDGE_429)]);
    await assert.rejects(client(fetch).solve(Object.assign({}, SOLVE, { deadlineMs: 800 })), (err) => {
      assert.equal(err.status, 429, 'run ' + run + ': ' + err.message);
      assert.equal(err.code, 'error');
      assert.ok(err.attempts >= 2, 'run ' + run + ' retried, got ' + err.attempts);
      return true;
    });
  }
});

test('an attempt the deadline cuts short is not what the error reports', async () => {
  // First a real 429 (20ms), then the edge goes silent: the retry is aborted by the deadline,
  // and the error must still say 429, with the cut-off noted.
  const fetch = stubFetch([Object.assign({ delayMs: 20 }, EDGE_429), { stall: true }]);
  const deadlineMs = 700;
  const started = Date.now();
  await assert.rejects(client(fetch).solve(Object.assign({}, SOLVE, { deadlineMs })), (err) => {
    assert.equal(err.status, 429);
    assert.equal(err.code, 'error');
    assert.equal(err.attempts, 2);
    assert.match(err.message, /\(last: HTTP 429 error; a final attempt was cut short by the deadline after \d+ms\)$/);
    return true;
  });
  assert.ok(Date.now() - started >= deadlineMs - SLOP, 'the stalled attempt was given the budget that was left');

  // With no real answer before it, a timed-out first attempt is reported as the timeout it was.
  const silent = stubFetch([{ stall: true }]);
  await assert.rejects(client(silent).getSolve('job-1', { timeoutMs: 100 }), (err) => {
    assert.equal(err.status, 0);
    assert.equal(err.code, 'timeout');
    assert.equal(err.attempts, 1);
    return true;
  });
});

test('attempts and elapsedMs cover the whole solve, not just the failing step', async () => {
  const pollIntervalMs = 20;
  const fetch = stubFetch([ACCEPTED, RUNNING, RUNNING, API_503]);
  const started = Date.now();
  await assert.rejects(
    client(fetch, { retry: Object.assign({}, FAST_RETRY, { maxAttempts: 2 }) }).solve(Object.assign({}, SOLVE, { pollIntervalMs })),
    (err) => {
      // 1 submit + 2 polls that said running + 2 attempts at the third poll.
      assert.equal(err.attempts, 5);
      assert.equal(fetch.calls.length, 5);
      assert.match(err.message, /gave up after 5 attempts/);
      assert.ok(err.elapsedMs >= 3 * pollIntervalMs - SLOP, 'elapsed spans the polls too, got ' + err.elapsedMs);
      assert.ok(err.elapsedMs <= Date.now() - started);
      return true;
    },
  );
});

test('Retry-After in seconds is honoured over the backoff', async () => {
  const fetch = stubFetch([ACCEPTED, Object.assign({}, API_503, { headers: { 'Retry-After': '2' } }), DONE]);
  const res = await client(fetch).solve(Object.assign({}, SOLVE, { deadlineMs: 10000 }));

  assert.equal(res.token, 'tok-abc');
  const gap = fetch.gaps()[1];
  assert.ok(gap >= 1900 && gap < 2600, 'waited ~2s before the retry, got ' + gap + 'ms');
});

test('Retry-After as an HTTP-date is honoured', async () => {
  const fetch = stubFetch([
    ACCEPTED,
    () => Object.assign({}, API_503, { headers: { 'Retry-After': new Date(Date.now() + 300).toUTCString() } }),
    DONE,
  ]);
  await client(fetch).solve(Object.assign({}, SOLVE, { deadlineMs: 10000 }));
  const gap = fetch.gaps()[1];
  // toUTCString carries whole seconds, so the date can round the 300ms down to "now" (then the
  // backoff floor applies) or up to a full second.
  assert.ok(gap >= MIN_BACKOFF_MS - SLOP && gap < 1500, 'waited no more than the date asked, got ' + gap + 'ms');
});

test('Retry-After is capped at maxRetryAfterMs', async () => {
  const fetch = stubFetch([ACCEPTED, Object.assign({}, API_503, { headers: { 'Retry-After': '60' } }), DONE]);
  await client(fetch, { retry: Object.assign({}, FAST_RETRY, { maxRetryAfterMs: 50 }) }).solve(SOLVE);
  const gap = fetch.gaps()[1];
  assert.ok(gap >= 40 && gap < 400, 'capped the 60s wait at 50ms, got ' + gap + 'ms');
});

test('a Retry-After of 0, a past date or garbage never waits less than the floor', async () => {
  const past = new Date(Date.now() - 60000).toUTCString();
  const cases = [
    ['0', 0], // honest zero: exposed as 0, waited as the floor
    ['-5', undefined], // V8's Date.parse would read this as a date in 2001
    ['1.5', undefined], // …and this as Jan 5 2001
    ['2, 3', undefined], // two headers joined by Headers.get
    [past, undefined],
    ['soon', undefined],
  ];
  for (const [value, exposed] of cases) {
    const fetch = stubFetch([Object.assign({}, EDGE_429, { headers: { 'Retry-After': value } })]);
    await assert.rejects(client(fetch).solve(Object.assign({}, SOLVE, { deadlineMs: 700 })), (err) => {
      assert.equal(err.status, 429, value);
      assert.equal(err.retryAfterMs, exposed, 'Retry-After "' + value + '" exposed as ' + err.retryAfterMs);
      return true;
    });
    assert.ok(fetch.calls.length >= 2 && fetch.calls.length <= 8, 'Retry-After "' + value + '": ' + fetch.calls.length + ' calls in a 700ms budget');
    assertNoWaitBelowFloor(fetch.gaps());
  }
});

test('Retry-After is clamped before any arithmetic: 24h exposed, 10s waited, odd years ignored', async () => {
  const huge = stubFetch([ACCEPTED, Object.assign({}, API_503, { headers: { 'Retry-After': '9'.repeat(400) } }), DONE]);
  await client(huge, { retry: Object.assign({}, FAST_RETRY, { maxRetryAfterMs: 60 }) }).solve(SOLVE);
  assert.ok(huge.gaps()[1] >= 50 && huge.gaps()[1] < 400, 'waited maxRetryAfterMs, got ' + huge.gaps()[1] + 'ms');

  const exposed = stubFetch([Object.assign({}, API_503, { headers: { 'Retry-After': '999999999' } })]);
  await assert.rejects(client(exposed, { retry: Object.assign({}, FAST_RETRY, { maxAttempts: 1 }) }).solve(SOLVE), (err) => {
    assert.equal(err.retryAfterMs, 24 * 60 * 60 * 1000);
    return true;
  });

  for (const date of ['Sat, 01 Jan 1969 00:00:00 GMT', 'Mon, 01 Jan 10000 00:00:00 GMT', 'Tue, 20 Oct 2026 22:15:30 +0000', 'Tuesday, 20-Oct-26 22:15:30 GMT']) {
    const fetch = stubFetch([Object.assign({}, API_503, { headers: { 'Retry-After': date } })]);
    await assert.rejects(client(fetch, { retry: Object.assign({}, FAST_RETRY, { maxAttempts: 1 }) }).solve(SOLVE), (err) => {
      assert.equal(err.retryAfterMs, undefined, date);
      return true;
    });
  }

  const far = stubFetch([Object.assign({}, API_503, { headers: { 'Retry-After': 'Fri, 01 Jan 9999 00:00:00 GMT' } })]);
  await assert.rejects(client(far, { retry: Object.assign({}, FAST_RETRY, { maxAttempts: 1 }) }).solve(SOLVE), (err) => {
    assert.equal(err.retryAfterMs, 24 * 60 * 60 * 1000);
    return true;
  });
});

test('backoff stays within [50ms, cap], doubles no faster than the schedule, and is jittered', async () => {
  const initialBackoffMs = 60;
  const maxBackoffMs = 120;
  const fetch = stubFetch([ACCEPTED, API_503]);
  await assert.rejects(client(fetch, { retry: { initialBackoffMs, maxBackoffMs } }).solve(Object.assign({}, SOLVE, { deadlineMs: 2000 })));

  // gaps[0] is submit → first poll (the poll interval); the rest are the retry waits.
  const waits = fetch.gaps().slice(1);
  assert.ok(waits.length >= 8, 'enough retries to judge the distribution, got ' + waits.length);
  const tolerance = 30; // timer slop on a loaded CI box
  for (const w of waits) {
    assert.ok(w <= maxBackoffMs + tolerance, 'a wait of ' + w + 'ms ran past the ' + maxBackoffMs + 'ms cap');
    assert.ok(w >= MIN_BACKOFF_MS - SLOP, 'a wait of ' + w + 'ms went below the floor');
  }
  // Full jitter draws from [50, backoff]: the waits must not all collapse onto one value.
  const buckets = new Set(waits.map((w) => Math.round(w / 5)));
  assert.ok(buckets.size > 1, 'waits are jittered, got ' + waits.join(','));
  // The schedule still grows: after the first doubling the backoff sits at the cap, so no early
  // wait can exceed what the un-jittered doubling allows at that attempt.
  waits.forEach((w, i) => {
    const ceiling = Math.min(initialBackoffMs * 2 ** i, maxBackoffMs);
    assert.ok(w <= ceiling + tolerance, 'wait ' + i + ' of ' + w + 'ms exceeds its ' + ceiling + 'ms backoff');
  });
});

test('initialBackoffMs: 0 is the default schedule, not a zero wait', async () => {
  const fetch = stubFetch([EDGE_429]);
  await assert.rejects(client(fetch, { retry: { initialBackoffMs: 0, maxBackoffMs: 0 } }).solve(Object.assign({}, SOLVE, { deadlineMs: 800 })));
  // Jittered over [50, 250], then [50, 500] until the last 500ms: a handful of calls, never a storm.
  assert.ok(fetch.calls.length >= 2 && fetch.calls.length <= 5, 'got ' + fetch.calls.length + ' calls');
  assert.ok(fetch.gaps()[0] <= 250 + SLOP, 'drew from the default 250ms schedule, got ' + fetch.gaps()[0] + 'ms');
  assertNoWaitBelowFloor(fetch.gaps());
});

test('retry: false fails on the first transient response', async () => {
  const fetch = stubFetch([API_429]);
  await assert.rejects(client(fetch, { retry: false }).solve(SOLVE), (err) => {
    assert.equal(err.status, 429);
    assert.equal(err.code, 'rate_limited');
    assert.equal(err.attempts, undefined);
    return true;
  });
  assert.equal(fetch.calls.length, 1);
});

test('maxAttempts bounds the attempts before the deadline does', async () => {
  const fetch = stubFetch([API_429]);
  await assert.rejects(client(fetch, { retry: Object.assign({}, FAST_RETRY, { maxAttempts: 3 }) }).solve(SOLVE), (err) => {
    assert.equal(err.attempts, 3);
    assert.match(err.message, /3 attempts/);
    return true;
  });
  assert.equal(fetch.calls.length, 3);
});

test('the caller\'s abort during a retry backoff rejects with canceled; during a poll wait it stays aborted', async () => {
  const fetch = stubFetch([Object.assign({}, API_429, { headers: { 'Retry-After': '5' } })]);
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 20);
  const started = Date.now();
  await assert.rejects(client(fetch).solve(Object.assign({}, SOLVE, { signal: ac.signal })), (err) => {
    assert.ok(err instanceof KagedCapError);
    assert.equal(err.code, 'canceled');
    assert.equal(err.status, 0);
    assert.ok(isUuidV4(err.idempotencyKey), 'the canceled error still names the submit\'s key');
    return true;
  });
  assert.ok(Date.now() - started < 1000);

  const polling = stubFetch([ACCEPTED, RUNNING]);
  const ac2 = new AbortController();
  setTimeout(() => ac2.abort(), 10);
  await assert.rejects(client(polling).solve(Object.assign({}, SOLVE, { pollIntervalMs: 5000, signal: ac2.signal })), (err) => err.code === 'aborted');
});

test('submitSolve and getSolve retry on their own', async () => {
  const sub = stubFetch([EDGE_429, { status: 202, body: { success: true, id: 'job-p', status: 'running' } }]);
  const ack = await client(sub).submitSolve(SOLVE);
  assert.equal(ack.id, 'job-p');
  assert.equal(sub.calls.length, 2);
  assert.equal(sub.calls[0].init.headers['Idempotency-Key'], sub.calls[1].init.headers['Idempotency-Key']);
  assert.ok(isUuidV4(sub.calls[0].init.headers['Idempotency-Key']));

  const get = stubFetch([API_503, { status: 200, body: { success: true, id: 'job-p', status: 'done', token: 'tok-p' } }]);
  const job = await client(get).getSolve('job-p');
  assert.equal(job.token, 'tok-p');
  assert.equal(get.calls.length, 2);
});

test('the synchronous /solve always carries an Idempotency-Key and resends what never reached the gateway', async () => {
  // No key given: the SDK generates one, and an edge-shed 429 (no envelope) is resent under it.
  const bare = stubFetch([EDGE_429, SYNC_OK]);
  const res = await client(bare).solveDeprecated(SYNC_PARAMS);
  assert.equal(res.token, 'tok-sync');
  assert.equal(bare.calls.length, 2);
  const generated = bare.calls[0].init.headers['Idempotency-Key'];
  assert.ok(isUuidV4(generated));
  assert.equal(bare.calls[1].init.headers['Idempotency-Key'], generated);

  // A caller's key is replayed as-is; a transport error and a bare edge 503 are both resent.
  const refused = new TypeError('fetch failed');
  refused.cause = new Error('connect ECONNRESET');
  const keyed = stubFetch([{ status: 503 }, { throws: refused }, SYNC_OK]);
  await client(keyed).solveDeprecated(Object.assign({}, SYNC_PARAMS, { idempotencyKey: 'order-77' }));
  assert.equal(keyed.calls.length, 3);
  for (const c of keyed.calls) assert.equal(c.init.headers['Idempotency-Key'], 'order-77');

  // A JSON body that is not an object is no envelope either.
  const nul = stubFetch([{ status: 502, body: null }, SYNC_OK]);
  await client(nul).solveDeprecated(SYNC_PARAMS);
  assert.equal(nul.calls.length, 2);

  // Kasada and the *Deprecated twins ride the same endpoint and the same rule, opts or not.
  const kasada = stubFetch([EDGE_429, { status: 200, body: { success: true, task: 'KasadaLogin', x_kpsdk_ct: 'ct' } }]);
  const login = await client(kasada).kasadaLogin({ proxy: 'http://u:p@1.2.3.4:8080', idempotencyKey: 'sess-1' });
  assert.equal(login.x_kpsdk_ct, 'ct');
  assert.equal(kasada.calls.length, 2);
  assert.equal(kasada.calls[1].init.headers['Idempotency-Key'], 'sess-1');

  const reload = stubFetch([{ status: 504 }, { status: 200, body: { success: true, task: 'KasadaReload', x_kpsdk_ct: 'ct2' } }]);
  await client(reload).kasadaReloadDeprecated({ kpsdk_st: 1, hash: 'h' });
  assert.equal(reload.calls.length, 2);
  assert.ok(isUuidV4(reload.calls[0].init.headers['Idempotency-Key']));
});

test('a 429/5xx that carries the gateway envelope is final on the synchronous /solve', async () => {
  // The gateway claimed the key before answering, so a resend could only meet 409.
  for (const answer of [API_429, API_503, API_502, { status: 500, body: { success: false, error: 'internal_error', message: 'boom' } }, { status: 504, body: { success: false, error: 'solve_timeout', message: 'too slow' } }]) {
    const fetch = stubFetch([answer, SYNC_OK]);
    await assert.rejects(client(fetch).solveDeprecated(Object.assign({}, SYNC_PARAMS, { idempotencyKey: 'order-77' })), (err) => {
      assert.equal(err.status, answer.status);
      assert.equal(err.code, answer.body.error);
      assert.equal(err.idempotencyKey, 'order-77');
      assert.equal(err.attempts, undefined, 'no retry run to report');
      return true;
    });
    assert.equal(fetch.calls.length, 1, answer.body.error + ' must not be resent on v1');
  }
  // A bare 500 is not on the edge's list either: it may well have come from the gateway.
  const bare500 = stubFetch([{ status: 500 }, SYNC_OK]);
  await assert.rejects(client(bare500).solveDeprecated(SYNC_PARAMS), (err) => err.status === 500);
  assert.equal(bare500.calls.length, 1);
});

test('a v1 resend answered 409 idempotency_conflict surfaces the transient error that prompted it', async () => {
  const shed = stubFetch([EDGE_429, API_409]);
  await assert.rejects(client(shed).solveDeprecated(Object.assign({}, SYNC_PARAMS, { idempotencyKey: 'order-77' })), (err) => {
    assert.equal(err.status, 429);
    assert.equal(err.code, 'error');
    assert.equal(err.attempts, 2);
    assert.equal(err.idempotencyKey, 'order-77');
    assert.match(err.message, /gave up after 2 attempts over \d+ms \(last: HTTP 429 error; the resend answered 409 idempotency_conflict, so the first attempt had reached the gateway\)$/);
    return true;
  });
  assert.equal(shed.calls.length, 2);

  const dropped = stubFetch([{ throws: new Error('read ECONNRESET') }, API_409]);
  await assert.rejects(client(dropped).kasadaLogin({ proxy: 'http://u:p@1.2.3.4:8080' }), (err) => {
    assert.equal(err.status, 0);
    assert.equal(err.code, 'network_error');
    assert.equal(err.attempts, 2);
    assert.match(err.message, /idempotency_conflict/);
    return true;
  });

  // A 409 on the first attempt is the caller's own conflict and is reported as such.
  const first = stubFetch([API_409]);
  await assert.rejects(client(first).solveDeprecated(Object.assign({}, SYNC_PARAMS, { idempotencyKey: 'order-77' })), (err) => err.code === 'idempotency_conflict' && err.status === 409);
  assert.equal(first.calls.length, 1);
});

test('no v1 resend starts more than 100s after the first attempt: the gateway\'s idempotency claim would lapse', async () => {
  const clock = fakeClock();
  // performance.now() is the real, monotonic clock: it proves the fake one did the waiting.
  const startedReal = performance.now();
  try {
    // The edge sheds the first attempt, and by the time the SDK reads that answer the first
    // attempt is 100s+ old (a slow transport, a stalled process): the claim lapses at 120s, so
    // a resend would run a second solve. The call ends with the 429, reported as the deadline
    // path reports it — attempts and elapsedMs, and the 429's own status and code.
    const late = stubFetch([() => { clock.advance(V1_RETRY_WINDOW_MS + 1); return EDGE_429; }, SYNC_OK]);
    await assert.rejects(client(late).solveDeprecated(Object.assign({}, SYNC_PARAMS, { idempotencyKey: 'order-77' })), (err) => {
      assert.ok(err instanceof KagedCapError);
      assert.equal(err.status, 429);
      assert.equal(err.code, 'error');
      assert.equal(err.attempts, 1);
      assert.ok(err.elapsedMs > V1_RETRY_WINDOW_MS, 'elapsed spans the window, got ' + err.elapsedMs);
      assert.equal(err.idempotencyKey, 'order-77');
      assert.match(err.message, /^HTTP 429 — gave up after 1 attempt over \d+ms \(last: HTTP 429 error; no v1 resend starts more than 100000ms after the first attempt, or it would outlive the gateway's 120s idempotency claim and buy a second solve\)$/);
      return true;
    });
    assert.equal(late.calls.length, 1, 'the 429 must not be resent');

    // Same for a transport error, on Kasada's /solve: the key may already be claimed.
    const dropped = stubFetch([() => { clock.advance(V1_RETRY_WINDOW_MS + 1); return { throws: new Error('read ECONNRESET') }; }, SYNC_OK]);
    await assert.rejects(client(dropped).kasadaLogin({ proxy: 'http://u:p@1.2.3.4:8080' }), (err) => {
      assert.equal(err.status, 0);
      assert.equal(err.code, 'network_error');
      assert.equal(err.attempts, 1);
      assert.match(err.message, /idempotency claim/);
      return true;
    });
    assert.equal(dropped.calls.length, 1);

    // Inside the window the resend still goes out, under the same key.
    const inTime = stubFetch([() => { clock.advance(V1_RETRY_WINDOW_MS - 1000); return EDGE_429; }, SYNC_OK]);
    const res = await client(inTime).solveDeprecated(Object.assign({}, SYNC_PARAMS, { idempotencyKey: 'order-78' }));
    assert.equal(res.token, 'tok-sync');
    assert.equal(inTime.calls.length, 2);
    assert.equal(inTime.calls[1].init.headers['Idempotency-Key'], 'order-78');

    // v2 has no such wall: its dedupe is durable, so the submit is resent while the deadline has room.
    const v2 = stubFetch([() => { clock.advance(V1_RETRY_WINDOW_MS + 1); return EDGE_429; }, ACCEPTED, DONE]);
    const job = await client(v2).solve(SOLVE);
    assert.equal(job.token, 'tok-abc');
    assert.equal(v2.calls.length, 3);
  } finally {
    clock.restore();
  }
  assert.ok(performance.now() - startedReal < 2000, 'the window was crossed on the fake clock, not by waiting');
});

test('a 502 solve_failed on the synchronous /solve is the verdict for that attempt, not a retry', async () => {
  const fetch = stubFetch([API_502, SYNC_OK]);
  await assert.rejects(
    client(fetch).solveDeprecated({ sitekey: '6Lc-test', url: 'https://example.com', idempotencyKey: 'order-77' }),
    (err) => {
      assert.equal(err.status, 502);
      assert.equal(err.code, 'solve_failed');
      assert.equal(err.idempotencyKey, 'order-77');
      return true;
    },
  );
  assert.equal(fetch.calls.length, 1);

  // On v2 the same 502 on the submit only says the request didn't get through: the verdict comes
  // from the poll body, so it is retried.
  const v2 = stubFetch([API_502, ACCEPTED, DONE]);
  const res = await client(v2).solve(SOLVE);
  assert.equal(res.token, 'tok-abc');
  assert.equal(v2.calls.length, 3);
});

test('against a real local HTTP server: submit 429 → 429 → 202 over Node\'s own fetch', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, key: req.headers['idempotency-key'], body: raw, at: Date.now() });
      const submits = seen.filter((r) => r.method === 'POST').length;
      if (req.method === 'POST' && submits === 1) {
        // Railway-style shed: a text page, no envelope, and a Retry-After that asks for no wait.
        res.writeHead(429, { 'content-type': 'text/html', 'retry-after': '0' });
        return res.end('<html><body>Too Many Requests</body></html>');
      }
      if (req.method === 'POST' && submits === 2) {
        // Two Retry-After lines: fetch's Headers.get joins them into "1, 2", which must be ignored.
        res.setHeader('Retry-After', ['1', '2']);
        res.writeHead(429, { 'content-type': 'text/plain' });
        return res.end('rate limited');
      }
      if (req.method === 'POST') {
        res.writeHead(202, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ success: true, id: 'job-http', status: 'running' }));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: true, id: 'job-http', status: 'done', token: 'tok-http' }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const baseUrl = 'http://127.0.0.1:' + server.address().port;
    const kc = new KagedCapClient('key-123', { baseUrl, retry: FAST_RETRY });
    const started = Date.now();
    const res = await kc.solve(SOLVE);

    assert.equal(res.token, 'tok-http');
    const submits = seen.filter((r) => r.method === 'POST' && r.url === '/v2/solve');
    assert.equal(submits.length, 3);
    assert.equal(new Set(submits.map((r) => r.key)).size, 1, 'the same Idempotency-Key on every submit');
    assert.ok(isUuidV4(submits[0].key));
    assert.equal(submits[1].body, submits[0].body);
    assert.equal(submits[2].body, submits[0].body);
    // Retry-After: 0 waited the floor; the joined "1, 2" fell back to the backoff (50ms here),
    // not to a 2001 date, and not to a 1-2s wait either.
    const gaps = submits.slice(1).map((r, i) => r.at - submits[i].at);
    assertNoWaitBelowFloor(gaps);
    assert.ok(gaps[1] < 900, 'the joined Retry-After was ignored, waited ' + gaps[1] + 'ms');
    assert.equal(seen.filter((r) => r.method === 'GET').length, 1);
    assert.equal(seen.find((r) => r.method === 'GET').url, '/v2/solve/job-http');
    assert.ok(Date.now() - started < 2000);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
