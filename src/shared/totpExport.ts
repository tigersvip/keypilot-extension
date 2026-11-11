import type { TotpAccount } from './types';
import { validateTotpConfig } from './totp';

export function totpSetupUri(account: TotpAccount): string {
  const config = validateTotpConfig(account);
  if (account.issuer.includes(':') || account.account.includes(':')) throw new Error('标准二维码的服务名称和账号不能包含冒号，请先编辑名称。');
  const label = account.issuer ? `${encodeURIComponent(account.issuer)}:${encodeURIComponent(account.account)}` : encodeURIComponent(account.account);
  const params = new URLSearchParams({secret:config.secret,algorithm:config.algorithm,digits:String(config.digits),period:String(config.period)});
  if (account.issuer) params.set('issuer',account.issuer);
  return `otpauth://totp/${label}?${params}`;
}

export async function totpQrDataUrl(uri: string): Promise<string> {
  const QRCode = await import('qrcode');
  return QRCode.toDataURL(uri,{width:320,margin:4,errorCorrectionLevel:'M'});
}
