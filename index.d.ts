export type Task =
  | 'ReCaptchaV3Task'
  | 'ReCaptchaV3TaskProxyLess'
  | 'ReCaptchaV3EnterpriseTask'
  | 'ReCaptchaV3EnterpriseTaskProxyLess'
  | 'ReCaptchaV2Task'
  | 'ReCaptchaV2TaskProxyLess'
  | 'TicketmasterTmptTask'
  | 'KasadaLogin'
  | 'KasadaReload';

export interface SolveParams {
  sitekey: string;
  url: string;
  /** reCAPTCHA action — required for v3, ignored for v2. */
  action?: string;
  task?: Task;
  /** reCAPTCHA version: 'v3' (default) or 'v2' (invisible). Ignored if `task` is set. */
  version?: 'v2' | 'v3';
  enterprise?: boolean;
  proxy?: string;
  userAgent?: string;
  device?: 'desktop' | 'mobile';
  enhanced?: boolean;
  secretKey?: string;
}

export interface SolveResult {
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
  user_agent: string;
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
  status: number;
  code: string;
}

export class KagedCapClient {
  constructor(apiKey: string, opts?: ClientOptions);
  solve(params: SolveParams): Promise<SolveResult>;
  kasadaLogin(params: KasadaLoginParams): Promise<KasadaResult>;
  kasadaReload(session: KasadaResult | KasadaReloadParams): Promise<KasadaResult>;
  checkBalance(): Promise<Balance>;
}

export function deriveTask(enterprise: boolean, hasProxy: boolean): Task;
export function toKasadaReloadParams(session: KasadaResult | KasadaReloadParams): KasadaReloadParams;
export const TASKS: Task[];
