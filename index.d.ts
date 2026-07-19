export type Task =
  | 'ReCaptchaV3Task'
  | 'ReCaptchaV3TaskProxyLess'
  | 'ReCaptchaV3EnterpriseTask'
  | 'ReCaptchaV3EnterpriseTaskProxyLess';

export interface SolveParams {
  sitekey: string;
  url: string;
  action: string;
  task?: Task;
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
