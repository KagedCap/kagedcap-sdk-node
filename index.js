'use strict';

/**
 * KagedCap Node.js SDK (CommonJS) — solve reCAPTCHA v3 tokens with an API key.
 *
 *   const { KagedCapClient } = require('kagedcap');
 *   const kc = new KagedCapClient(process.env.KAGEDCAP_API_KEY);
 *   const { token } = await kc.solve({ sitekey, url, action, enterprise: true });
 */

const DEFAULT_BASE_URL = 'https://api.kagedcap.io';

const TASKS = [
  'ReCaptchaV3Task',
  'ReCaptchaV3TaskProxyLess',
  'ReCaptchaV3EnterpriseTask',
  'ReCaptchaV3EnterpriseTaskProxyLess',
];

class KagedCapError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'KagedCapError';
    this.status = status;
    this.code = code;
  }
}

function deriveTask(enterprise, hasProxy) {
  const base = enterprise ? 'ReCaptchaV3Enterprise' : 'ReCaptchaV3';
  return base + (hasProxy ? 'Task' : 'TaskProxyLess');
}

function stripUndefined(obj) {
  const out = {};
  for (const k of Object.keys(obj)) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
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
   */
  async solve(params) {
    const task = params.task || deriveTask(!!params.enterprise, !!params.proxy);
    return this._request('POST', '/solve', {
      task,
      url: params.url,
      sitekey: params.sitekey,
      action: params.action,
      proxy: params.proxy,
      userAgent: params.userAgent,
      device: params.device,
      enhanced: params.enhanced,
      secretKey: params.secretKey,
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

module.exports = { KagedCapClient, KagedCapError, deriveTask, TASKS };
