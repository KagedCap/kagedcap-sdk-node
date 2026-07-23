export type Task =
  | 'ReCaptchaV3Task'
  | 'ReCaptchaV3TaskProxyLess'
  | 'ReCaptchaV3EnterpriseTask'
  | 'ReCaptchaV3EnterpriseTaskProxyLess'
  | 'ReCaptchaV2Task'
  | 'ReCaptchaV2TaskProxyLess';

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
  checkBalance(): Promise<Balance>;
}

export function deriveTask(enterprise: boolean, hasProxy: boolean): Task;
export const TASKS: Task[];
