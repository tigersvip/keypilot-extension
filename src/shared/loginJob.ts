export const LOGIN_JOBS_KEY = 'keypilot.loginJobs';
export const LOGIN_WAIT_MS = 15 * 60 * 1000;
export type LoginJobPhase = 'loading' | 'certificate' | 'locked' | 'filling' | 'done' | 'failed' | 'cancelled' | 'expired';
export interface LoginJob {
  id: string;
  tabId: number;
  credentialId: string;
  vaultId: string;
  origin: string;
  autoSubmit: boolean;
  phase: LoginJobPhase;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  certificateError?: string;
  notified?: boolean;
  fillAttempts?: number;
  message?: string;
}
export type PublicLoginJob = Omit<LoginJob, 'credentialId' | 'vaultId'>;
export function loginJobActive(job: Pick<LoginJob, 'phase'>): boolean {
  return ['loading', 'certificate', 'locked', 'filling'].includes(job.phase);
}
export function sameLoginTarget(origin: string, url: string, allowUpgrade = false): boolean {
  try {
    const expected = new URL(origin), actual = new URL(url);
    if (!['http:', 'https:'].includes(expected.protocol) || actual.username || actual.password) return false;
    return expected.origin === actual.origin || (allowUpgrade && expected.protocol === 'http:' && actual.protocol === 'https:' && expected.hostname === actual.hostname && !expected.port && !actual.port);
  } catch { return false; }
}
export function isCertificateError(error: string): boolean {
  return /^net::ERR_CERT_[A-Z_]+$/.test(error) || error === 'net::ERR_SSL_PINNED_KEY_NOT_IN_CERT_CHAIN';
}
export function loginJobHeading(job: Pick<LoginJob, 'phase'>): string {
  return ({loading:'正在打开网站',certificate:'网站证书异常，自动登录已暂停',locked:'等待解锁密码库',filling:'正在继续填写',done:'本次填写已完成',failed:'本次自动登录已停止',cancelled:'本次登录已取消',expired:'本次登录等待已超时'})[job.phase];
}
