import { parseTotpInput, validateTotpConfig, type TotpConfig } from './totp';
import type { TotpAccount } from './types';

export type TotpImportAccount = TotpConfig & { issuer: string; account: string };
export interface TotpImportResult {
  accounts: TotpImportAccount[];
  warnings: string[];
  batch?: { id: string; size: number; index: number };
}
export interface TotpImportSource { id: string; label: string; result: TotpImportResult }

const malformed = () => new Error('Google 迁移二维码内容不完整或已损坏，请重新导出。');
type ProtoValue = bigint | Uint8Array;

// A bounded reader for Google's MigrationPayload wire format. Unknown fields are skipped.
function protobuf(bytes: Uint8Array, byteFields: number[], integerFields: number[]): Map<number, ProtoValue[]> {
  const fields = new Map<number, ProtoValue[]>();
  let offset = 0;
  const varint = () => {
    let value = 0n;
    for (let i = 0; i < 10; i++) {
      if (offset >= bytes.length) throw malformed();
      const byte = bytes[offset++];
      if (i === 9 && byte > 1) throw malformed();
      value |= BigInt(byte & 127) << BigInt(i * 7);
      if (!(byte & 128)) return value;
    }
    throw malformed();
  };
  while (offset < bytes.length) {
    const tag = varint(), field = Number(tag >> 3n), wire = Number(tag & 7n);
    if (!field || field > 536870911) throw malformed();
    if ((byteFields.includes(field) && wire !== 2) || (integerFields.includes(field) && wire !== 0)) throw malformed();
    let value: ProtoValue;
    if (wire === 0) value = varint();
    else {
      const length = wire === 2 ? Number(varint()) : wire === 1 ? 8 : wire === 5 ? 4 : -1;
      if (!Number.isSafeInteger(length) || length < 0 || length > bytes.length - offset) throw malformed();
      value = bytes.subarray(offset, offset + length); offset += length;
      if (wire !== 2) continue;
    }
    const previous = fields.get(field) ?? [];
    if (previous.length >= 1000) throw malformed();
    previous.push(value); fields.set(field, previous);
  }
  return fields;
}
function single(fields: Map<number, ProtoValue[]>, field: number): ProtoValue | undefined {
  const values = fields.get(field);
  if (values && values.length !== 1) throw malformed();
  return values?.[0];
}
function integer(fields: Map<number, ProtoValue[]>, field: number, fallback = 0n): bigint {
  const value = single(fields, field);
  if (value === undefined) return fallback;
  if (typeof value !== 'bigint') throw malformed();
  return value;
}
function binary(fields: Map<number, ProtoValue[]>, field: number): Uint8Array {
  const value = single(fields, field);
  if (value === undefined) return new Uint8Array();
  if (!(value instanceof Uint8Array)) throw malformed();
  return value;
}
function utf8(bytes: Uint8Array): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim(); }
  catch { throw malformed(); }
}
function base32(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let value = 0, bits = 0, output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { bits -= 5; output += alphabet[(value >>> bits) & 31]; }
    value &= (1 << bits) - 1;
  }
  if (bits) output += alphabet[(value << (5 - bits)) & 31];
  return output;
}
export function validateImportAccount(input: TotpImportAccount): TotpImportAccount {
  const issuer = input.issuer.trim(), account = input.account.trim();
  if (!account || account.length > 200 || issuer.length > 200 || /[\u0000-\u001f\u007f]/.test(issuer + account)) {
    throw new Error('服务名称或账号无效，名称最多 200 个字符。');
  }
  return { ...validateTotpConfig(input), issuer, account };
}
export function totpFingerprint(item: TotpConfig): string {
  return `${item.secret.replace(/\s|=+$/g, '').toUpperCase()}:${item.algorithm}:${item.digits}:${item.period}`;
}

function parseMigration(raw: string): TotpImportResult {
  let url: URL;
  try { url = new URL(raw); } catch { throw malformed(); }
  if (url.protocol !== 'otpauth-migration:' || url.hostname !== 'offline' || !['', '/'].includes(url.pathname) || url.port || url.username || url.password || url.hash || url.searchParams.getAll('data').length !== 1) throw malformed();
  // URLSearchParams turns unescaped '+' into spaces; both Google encodings occur in exports.
  const data = url.searchParams.get('data')!.replace(/ /g, '+').replace(/-/g, '+').replace(/_/g, '/');
  if (!data || data.length > 90000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data) || data.length % 4 === 1) throw malformed();
  let bytes: Uint8Array;
  try { bytes = Uint8Array.from(atob(data), char => char.charCodeAt(0)); } catch { throw malformed(); }
  if (bytes.length > 65536) throw malformed();
  const fields = protobuf(bytes, [1], [2, 3, 4, 5]);
  const version = integer(fields, 2);
  // Accept compatible protobuf fields across envelope versions, as Aegis does.
  // Validate the int32 metadata here and the actual OTP parameters below.
  if (version > 2147483647n) throw malformed();
  const size = Number(integer(fields, 3) || 1n), index = Number(integer(fields, 4));
  const id = BigInt.asIntN(32, integer(fields, 5)).toString();
  if (!Number.isInteger(size) || size < 1 || size > 100 || !Number.isInteger(index) || index < 0 || index >= size) throw malformed();
  const parameters = fields.get(1) ?? [];
  if (!parameters.length) throw new Error(`此 Google 迁移二维码未包含可读取的账号（格式版本 ${version}），请重新导出账号二维码。`);
  const accounts: TotpImportAccount[] = [], warnings: string[] = [];
  for (const [position, value] of parameters.entries()) {
    if (!(value instanceof Uint8Array)) throw malformed();
    const entry = protobuf(value, [1, 2, 3], [4, 5, 6, 7]);
    const type = integer(entry, 6), algorithmValue = integer(entry, 4), digitsValue = integer(entry, 5);
    if (type === 1n) { warnings.push(`第 ${position + 1} 个账号使用 HOTP 计数器验证码，暂不支持，已跳过。`); continue; }
    if (type !== 0n && type !== 2n) { warnings.push(`第 ${position + 1} 个账号的验证码类型不受支持，已跳过。`); continue; }
    if (algorithmValue < 0n || algorithmValue > 3n || digitsValue < 0n || digitsValue > 2n) {
      warnings.push(`第 ${position + 1} 个账号的算法或位数不受支持，已跳过。`); continue;
    }
    let account = utf8(binary(entry, 2)), issuer = utf8(binary(entry, 3));
    const separator = account.indexOf(':');
    if (separator >= 0 && (!issuer || account.slice(0, separator).trim() === issuer)) {
      issuer ||= account.slice(0, separator).trim(); account = account.slice(separator + 1).trim();
    }
    try {
      accounts.push(validateImportAccount({ account, issuer, secret: base32(binary(entry, 1)),
        algorithm: (['SHA1', 'SHA1', 'SHA256', 'SHA512'] as const)[Number(algorithmValue)],
        digits: digitsValue === 2n ? 8 : 6, period: 30 }));
    } catch { warnings.push(`第 ${position + 1} 个账号的密钥或名称不完整，已跳过，请检查原验证器。`); }
  }
  return { accounts, warnings, batch: { id, size, index } };
}

export function parseTotpImport(input: string): TotpImportResult {
  const raw = input.trim();
  if (raw.length > 100000) throw new Error('导入内容过长，请分批导入。');
  if (/^otpauth-migration:/i.test(raw)) return parseMigration(raw);
  if (/^otpauth:/i.test(raw)) return { accounts: [validateImportAccount(parseTotpInput(raw))], warnings: [] };
  if (/^\d{6,8}$/.test(raw)) throw new Error('这是临时验证码，不能用于导入。请使用导出的二维码或设置密钥。');
  throw new Error('未识别到验证器链接。请使用 Google 迁移二维码或 otpauth 链接；纯密钥请使用“添加验证码”。');
}

export function buildTotpImportPreview(sources: TotpImportSource[], existing: TotpAccount[]) {
  const known = new Set(existing.filter(item => !item.deletedAt).map(totpFingerprint));
  const seen = new Set<string>();
  const batches = new Map<string, { size: number; indices: Set<number> }>();
  const rows = sources.flatMap(source => {
    const batch = source.result.batch;
    if (batch && batch.size > 1) {
      const key = `${batch.id}:${batch.size}`;
      const progress = batches.get(key) ?? { size: batch.size, indices: new Set<number>() };
      progress.indices.add(batch.index); batches.set(key, progress);
    }
    return source.result.accounts.map((account, index) => {
      const key = totpFingerprint(account);
      const duplicate = known.has(key) ? '已存在' : seen.has(key) ? '重复账号' : '';
      seen.add(key);
      return { id: `${source.id}:${index}`, account, duplicate, source: source.label };
    });
  });
  return { rows, batches: [...batches.values()].map(batch => ({ size: batch.size, read: batch.indices.size })) };
}
