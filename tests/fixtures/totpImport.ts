// Synthetic keys only. The first is the public RFC 6238 SHA1 test vector.
export const publicSecret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
export const publicUri = `otpauth://totp/Example%3Asynthetic%40example.test?secret=${publicSecret}&issuer=Example`;

export function varint(input: number | bigint): Buffer {
  let value = BigInt.asUintN(64, BigInt(input));
  const bytes: number[] = [];
  do { bytes.push(Number(value & 127n) | (value > 127n ? 128 : 0)); value >>= 7n; } while (value);
  return Buffer.from(bytes);
}
export function numberField(field: number, value: number | bigint): Buffer {
  return Buffer.concat([varint(field * 8), varint(value)]);
}
export function byteField(field: number, value: Buffer | string): Buffer {
  const data = typeof value === 'string' ? Buffer.from(value) : value;
  return Buffer.concat([varint(field * 8 + 2), varint(data.length), data]);
}
export function googleEntry(input: { secret?: string; name?: string; issuer?: string; algorithm?: number; digits?: number; type?: number } = {}): Buffer {
  return Buffer.concat([
    byteField(1, input.secret ?? '12345678901234567890'), byteField(2, input.name ?? 'Example:synthetic@example.test'), byteField(3, input.issuer ?? 'Example'),
    numberField(4, input.algorithm ?? 1), numberField(5, input.digits ?? 1), numberField(6, input.type ?? 2)
  ]);
}
export function migrationUri(entries: Buffer[], batch: { id: number; index: number; size: number; version?: number | bigint } = { id: 42, index: 0, size: 1 }, extra = Buffer.alloc(0)): string {
  const data = Buffer.concat([...entries.map(entry => byteField(1, entry)), numberField(2, batch.version ?? 1), numberField(3, batch.size), numberField(4, batch.index), numberField(5, batch.id), extra]);
  return 'otpauth-migration://offline?data=' + encodeURIComponent(data.toString('base64'));
}
