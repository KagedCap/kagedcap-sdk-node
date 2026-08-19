'use strict';

/**
 * KagedCap Node.js SDK (CommonJS) — solve reCAPTCHA, Ticketmaster tmpt, and Kasada.
 *
 *   const { KagedCapClient } = require('kagedcap');
 *   const kc = new KagedCapClient(process.env.KAGEDCAP_API_KEY);
 *   const { token } = await kc.solve({ sitekey, url, action, enterprise: true });
 *
 *   const login = await kc.kasadaLogin({ site: 'ticketmaster', proxy });
 *   const fresh = await kc.kasadaReload(login); // reuses login's kpsdk_st + x_kpsdk_*
 */

const DEFAULT_BASE_URL = 'https://api.kagedcap.io';

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

function stripUndefined(obj) {
  const out = {};
  for (const k of Object.keys(obj)) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
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
   * Solve a captcha. Pass `enterprise` and (optionally) `proxy` to auto-select the
   * task, or set `task` explicitly.
   *
   * Omitting `userAgent` sends DEFAULT_USER_AGENT — a caller-supplied one always wins. Kasada
   * tasks are skipped: their identity comes from the harvester, and the gateway drops any UA
   * we send for that fleet.
   */
  async solve(params) {
    const task = params.task || deriveTask(!!params.enterprise, !!params.proxy, params.version);
    const isKasada = task === 'KasadaLogin' || task === 'KasadaReload';
    return this._request('POST', '/solve', {
      task,
      url: params.url,
      sitekey: params.sitekey,
      action: params.action,
      proxy: params.proxy,
      userAgent: params.userAgent || (isKasada ? undefined : DEFAULT_USER_AGENT),
      device: params.device,
      enhanced: params.enhanced,
      secretKey: params.secretKey,
    });
  }

  /**
   * Start a Kasada session. Requires `proxy` (the token is IP-bound). Returns the full
   * header set — keep it and pass it to `kasadaReload` to refresh the session later.
   * @param {{ proxy: string, site?: string, url?: string }} params
   */
  async kasadaLogin(params) {
    params = params || {};
    return this._request('POST', '/solve', {
      task: 'KasadaLogin',
      site: params.site,
      url: params.url,
      proxy: params.proxy,
    });
  }

  /**
   * Refresh a Kasada session (no proxy needed). Pass the `kasadaLogin` result directly (its
   * kpsdk_st + x_kpsdk_* are resent for you) or explicit params.
   * @param {object} session - a kasadaLogin result, or { kpsdk_st, hash, x_kpsdk_ct, x_kpsdk_v?, x_kpsdk_h? } (hash + x_kpsdk_ct required)
   */
  async kasadaReload(session) {
    const p = toKasadaReloadParams(session);
    if (p.kpsdk_st == null) throw new KagedCapError(0, 'validation_error', 'kasadaReload: kpsdk_st is required — pass the kasadaLogin result or an explicit kpsdk_st');
    return this._request('POST', '/solve', {
      task: 'KasadaReload',
      hash: p.hash,
      site: p.site,
      kpsdk_st: p.kpsdk_st,
      x_kpsdk_ct: p.x_kpsdk_ct,
      x_kpsdk_v: p.x_kpsdk_v,
      x_kpsdk_h: p.x_kpsdk_h,
    });
  }

  /** Current balance for the API key's account. */
  async checkBalance() {
    return this._request('GET', '/v1/balance');
  }

  async _request(method, path, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetch(this.baseUrl + path, {
        method,
        headers: { 'x-api-key': this.apiKey, 'content-type': 'application/json' },
        body: body ? JSON.stringify(stripUndefined(body)) : undefined,
        signal: controller.signal,
      });
      let data = {};
      try {
        data = await res.json();
      } catch (_) {}
      if (!res.ok) throw new KagedCapError(res.status, data.error || 'error', data.message || 'HTTP ' + res.status);
      return data;
    } catch (err) {
      if (err instanceof KagedCapError) throw err;
      if (err && err.name === 'AbortError') throw new KagedCapError(0, 'timeout', 'request timed out after ' + this.timeoutMs + 'ms');
      throw new KagedCapError(0, 'network_error', err && err.message ? err.message : String(err));
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = { KagedCapClient, KagedCapError, deriveTask, toKasadaReloadParams, TASKS, DEFAULT_USER_AGENT };
