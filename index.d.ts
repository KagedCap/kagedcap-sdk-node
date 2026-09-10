export type Task =
  | 'ReCaptchaV3Task'
  | 'ReCaptchaV3TaskProxyLess'
  | 'ReCaptchaV3EnterpriseTask'
  | 'ReCaptchaV3EnterpriseTaskProxyLess'
  | 'ReCaptchaV2Task'
  | 'ReCaptchaV2TaskProxyLess'
  | 'TicketmasterTmptTask'
  | 'KasadaLogin'
  | 'KasadaReload'
  | 'EvaluateTask';

/** Inputs to `solveDeprecated`, the legacy synchronous solve. */
export interface SolveDeprecatedParams {
  sitekey: string;
  url: string;
  /** reCAPTCHA action. Optional: omit it for a no-action solve. Ignored for v2. */
  action?: string;
  task?: Task;
  /** reCAPTCHA version: 'v3' (default) or 'v2' (invisible). Ignored if `task` is set. */
  version?: 'v2' | 'v3';
  enterprise?: boolean;
  proxy?: string;
  /** Browser UA the token embeds. Omit it and `DEFAULT_USER_AGENT` is sent instead. */
  userAgent?: string;
  device?: 'desktop' | 'mobile';
  enhanced?: boolean;
  secretKey?: string;
}

/** Inputs to `solve` — the same solve fields, plus the budget it polls within. */
export interface SolveParams extends SolveDeprecatedParams {
  /** Whole budget for the submit plus every poll. Defaults to 120000 (120s). */
  deadlineMs?: number;
  /** Gap between polls of `/v2/solve/{id}`. Defaults to 5000 (5s). */
  pollIntervalMs?: number;
  /** https URL, publicly resolvable — the gateway POSTs the finished solve to it as well. */
  callback_url?: string;
  /** Sent as `Idempotency-Key`: a resent submit returns the first job rather than a second solve. */
  idempotencyKey?: string;
  /** Cancels the solve mid-request or mid-wait with a `KagedCapError` coded `'aborted'`. */
  signal?: AbortSignal;
}

/**
 * A finished solve as `/v2/solve/{id}` reports it. `solve` resolves only on `status: 'done'` with
 * a token still attached, so `token` is a string here — a 'done' poll that arrives after the
 * gateway cleared it throws `result_expired` instead.
 */
export interface SolveResult {
  id: string;
  status: 'done';
  /** True alongside `status: 'done'`. `status` is the completion test; this only mirrors it. */
  success: boolean;
  token: string;
  /** Absent or null when the gateway didn't record it — never require it. */
  solve_ms?: number | null;
  /** Absent or null when the gateway didn't record it — never require it. */
  elapsed_ms?: number | null;
  created_at: string;
  completed_at?: string;
  /** Present only when the solve carried a `callback_url`. */
  callback?: { delivered: boolean; attempts: number };
}

/** Result of the legacy synchronous `/solve` call. */
export interface SolveDeprecatedResult {
  success: boolean;
  token: string;
  task: string;
  score: number | null;
  verification: unknown | null;
}

/** Inputs to start a Kasada session (KasadaLogin). */
export interface KasadaLoginParams {
  /** Proxy — required; the Kasada token is IP-bound. */
  proxy: string;
  /** Kasada site flow, e.g. 'ticketmaster'. Defaults server-side. */
  site?: string;
  /** Optional informational page URL. */
  url?: string;
}

/** Inputs to refresh a Kasada session (KasadaReload). */
export interface KasadaReloadParams {
  kpsdk_st: number;
  /** Session PoW hash (sessionHash) from the prior KasadaLogin — required; the cd seed embeds it. */
  hash?: string;
  /** Session token from the prior KasadaLogin — required; its leading chars seed the cd. */
  x_kpsdk_ct?: string;
  x_kpsdk_v?: string;
  x_kpsdk_h?: string;
  site?: string;
}

/** Kasada solve result — no `token`; replay `headers` and the `x_kpsdk_*` values. */
export interface KasadaResult {
  success: boolean;
  task: string;
  site: string;
  headers: Record<string, string>;
  x_kpsdk_ct: string;
  x_kpsdk_cd: string;
  x_kpsdk_v: string;
  x_kpsdk_h: string;
  kpsdk_st: number | null;
  /** Session PoW hash (sessionHash) — pass back to kasadaReload to refresh the cd. */
  hash: string;
  /** Kasada's trust verdict: true = high-trust token. */
  reload: boolean;
  user_agent: string;
}

/** Inputs for a Ticketmaster EPSF evaluate (EvaluateTask). */
export interface EvaluateParams {
  /** Ticketmaster page URL — its host picks the flow: `auth.*` → verify_phone, else join_queue. */
  url: string;
  /** Proxy — required; the verdict is IP-bound. */
  proxy: string;
  /** Overrides the host-based flow. Omit it to keep that default. */
  action?: 'verify_phone' | 'join_queue';
  /** verify_phone only. Include the country prefix, e.g. '+12025550123'. */
  phone_number?: string;
  /** join_queue only. */
  queueId?: string;
  /** join_queue only. */
  eventId?: string;
  /** Selects the solver's device profile, not just a header. Omit it and `DEFAULT_USER_AGENT` is sent. */
  userAgent?: string;
}

/** Evaluate result — `token` is the EPSF allow token to replay on the next APS step. */
export interface EvaluateResult {
  success: boolean;
  task: string;
  token: string;
  decision: 'allow' | 'challenge' | 'block';
}

export interface Balance {
  amount_micros: string;
  held_micros: string;
  available_micros: string;
  display: string;
}

export interface ClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export class KagedCapError extends Error {
  /** HTTP status, or 0 for a failure raised client-side (`timeout`, `aborted`, `result_expired`). */
  status: number;
  code: string;
  /** `request_id` off the gateway's error envelope, when it sent one. Quote it to support. */
  requestId?: string;
}

export class KagedCapClient {
  constructor(apiKey: string, opts?: ClientOptions);
  /** Submits to `/v2/solve` and polls `/v2/solve/{id}` until it finishes, within `deadlineMs`. */
  solve(params: SolveParams): Promise<SolveResult>;
  /** @deprecated Use `solve`. This calls the legacy synchronous `/solve` endpoint. */
  solveDeprecated(params: SolveDeprecatedParams): Promise<SolveDeprecatedResult>;
  kasadaLogin(params: KasadaLoginParams): Promise<KasadaResult>;
  kasadaReload(session: KasadaResult | KasadaReloadParams): Promise<KasadaResult>;
  evaluate(params: EvaluateParams): Promise<EvaluateResult>;
  checkBalance(): Promise<Balance>;
}

export function deriveTask(enterprise: boolean, hasProxy: boolean, version?: 'v2' | 'v3'): Task;
export function toKasadaReloadParams(session: KasadaResult | KasadaReloadParams): KasadaReloadParams;
export const TASKS: Task[];
/**
 * UA sent on reCAPTCHA, tmpt, and evaluate calls that omit `userAgent` — the Chrome 151 Windows
 * desktop profile the solver fleet runs. Never sent on Kasada tasks.
 */
export const DEFAULT_USER_AGENT: string;
