import type { TotpAccount } from './types';

export type TotpConfig = Pick<TotpAccount, 'secret' | 'algorithm' | 'digits' | 'period'>;
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const hashes = { SHA1: 'SHA-1', SHA256: 'SHA-256', SHA512: 'SHA-512' } as const;

export function normalizeTotpSecret(input: string): string {
  const secret = input.replace(/\s/g, '').toUpperCase();
  if (!/^[A-Z2-7]+=*$/.test(secret) || secret.length > 1024) throw new Error('密钥必须是 Base32 字符（A–Z、2–7）。');
  const bare = secret.replace(/=+$/, '');
  const padding = secret.length - bare.length;
  const remainder = bare.length % 8;
  if (![0, 2, 4, 5, 7].includes(remainder) || (padding && (secret.length % 8 || padding !== (8 - remainder) % 8))) {
    throw new Error('密钥长度或末尾填充不正确。');
  }
  // Reject nonzero unused bits instead of silently accepting a mistyped key.
  const spare = (bare.length * 5) % 8;
  if (spare && (alphabet.indexOf(bare.at(-1)!) & ((1 << spare) - 1))) throw new Error('密钥末尾字符不完整，请重新复制。');
  if (Math.floor(bare.length * 5 / 8) < 10) throw new Error('密钥过短，请复制网站提供的完整密钥。');
  return bare;
}

function secretBytes(input: string): Uint8Array<ArrayBuffer> {
  const secret = normalizeTotpSecret(input);
  const output = new Uint8Array(new ArrayBuffer(Math.floor(secret.length * 5 / 8)));
  let bits = 0, value = 0, index = 0;
  for (const char of secret) {
    value = (value << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) { bits -= 8; output[index++] = (value >>> bits) & 255; }
    value &= (1 << bits) - 1;
  }
  return output;
}

export function validateTotpConfig(input: TotpConfig): TotpConfig {
  if (!Object.hasOwn(hashes, input.algorithm)) throw new Error('仅支持 SHA1、SHA256 和 SHA512。');
  if (input.digits !== 6 && input.digits !== 8) throw new Error('验证码位数必须为 6 或 8。');
  if (!Number.isInteger(input.period) || input.period < 1 || input.period > 86400) throw new Error('刷新周期必须是 1–86400 秒之间的整数。');
  return { ...input, secret: normalizeTotpSecret(input.secret) };
}

export function parseTotpInput(input: string): TotpConfig & { issuer: string; account: string } {
  const raw = input.trim();
  if (/^otpauth-migration:/i.test(raw)) throw new Error('这是 Google 迁移链接，请返回并选择“导入二维码”。');
  if (!/^otpauth:/i.test(raw)) return { secret: normalizeTotpSecret(raw), algorithm: 'SHA1', digits: 6, period: 30, issuer: '', account: '' };
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('身份验证器链接格式不正确。'); }
  if (url.protocol !== 'otpauth:' || url.hostname !== 'totp' || url.port || url.username || url.password || url.hash) {
    throw new Error('请使用 otpauth://totp/ 链接；暂不支持 HOTP。');
  }
  for (const name of ['secret', 'algorithm', 'digits', 'period', 'issuer']) {
    if (url.searchParams.getAll(name).length > 1) throw new Error('链接中存在重复参数，请重新复制。');
  }
  if (url.searchParams.has('encoder')) throw new Error('暂不支持 Steam 等专用验证码格式，请使用标准 TOTP。');
  let label: string;
  try { label = decodeURIComponent(url.pathname.slice(1)).trim(); } catch { throw new Error('账号名称编码不正确。'); }
  const separator = label.indexOf(':');
  const labelIssuer = separator >= 0 ? label.slice(0, separator).trim() : '';
  const account = (separator >= 0 ? label.slice(separator + 1) : label).trim();
  const issuer = url.searchParams.get('issuer')?.trim() || labelIssuer;
  if (!account || account.length > 200 || issuer.length > 200 || account.includes(':') || issuer.includes(':')) throw new Error('链接中的服务名称或账号不正确。');
  if (labelIssuer && issuer !== labelIssuer) throw new Error('链接中的服务名称不一致，请检查来源。');
  const integerParameter = (name: string, fallback: number) => {
    const value = url.searchParams.get(name);
    if (value === null) return fallback;
    if (!/^\d+$/.test(value)) throw new Error('验证码位数或刷新周期不正确。');
    return Number(value);
  };
  const config = validateTotpConfig({
    secret: url.searchParams.get('secret') ?? '',
    algorithm: (url.searchParams.get('algorithm') ?? 'SHA1').toUpperCase() as TotpAccount['algorithm'],
    digits: integerParameter('digits', 6) as 6 | 8,
    period: integerParameter('period', 30)
  });
  return { ...config, issuer, account };
}

// RFC 6238: use an eight-byte moving factor, including times beyond 2038.
export async function generateTotp(input: TotpConfig, now = Date.now()): Promise<string> {
  const config = validateTotpConfig(input);
  if (!Number.isFinite(now) || now < 0) throw new Error('系统时间无效。');
  const counter = BigInt(Math.floor(now / 1000 / config.period));
  const message = new ArrayBuffer(8);
  new DataView(message).setBigUint64(0, counter, false);
  const key = await crypto.subtle.importKey('raw', secretBytes(config.secret), { name: 'HMAC', hash: hashes[config.algorithm] }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, message));
  const offset = mac[mac.length - 1] & 15;
  const binary = ((mac[offset] & 127) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(binary % 10 ** config.digits).padStart(config.digits, '0');
}

export function totpSecondsRemaining(period: number, now = Date.now()): number {
  return period - Math.floor(now / 1000) % period;
}
