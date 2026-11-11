import test from 'node:test';
import assert from 'node:assert/strict';
import { generateTotp, normalizeTotpSecret, parseTotpInput, totpSecondsRemaining } from '../src/shared/totp';

function base32(ascii: string) {
  const bits = [...Buffer.from(ascii)].map(byte => byte.toString(2).padStart(8, '0')).join('');
  return (bits.match(/.{1,5}/g) ?? []).map(part => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[parseInt(part.padEnd(5, '0'), 2)]).join('');
}
const secret = base32('12345678901234567890');
const vectors = [
  [59, '94287082', '46119246', '90693936'],
  [1111111109, '07081804', '68084774', '25091201'],
  [1111111111, '14050471', '67062674', '99943326'],
  [1234567890, '89005924', '91819424', '93441116'],
  [2000000000, '69279037', '90698825', '38618901'],
  [20000000000, '65353130', '77737706', '47863826']
] as const;
for (const [time, ...expected] of vectors) test(`RFC 6238 SHA1/SHA256/SHA512 at ${time}`, async () => {
  const algorithms = ['SHA1', 'SHA256', 'SHA512'] as const;
  const seeds = ['12345678901234567890', '12345678901234567890123456789012', '1234567890123456789012345678901234567890123456789012345678901234'];
  for (let i = 0; i < algorithms.length; i++) {
    assert.equal(await generateTotp({secret:base32(seeds[i]),algorithm:algorithms[i],digits:8,period:30},time*1000), expected[i]);
  }
});
test('TOTP updates precisely at boundaries and supports six digits and custom periods',async()=>{
  const config={secret,algorithm:'SHA1' as const,digits:6 as const,period:30};
  assert.equal(await generateTotp(config,59999),'287082');
  assert.equal(await generateTotp(config,60000),'359152');
  assert.equal(await generateTotp({...config,period:60},60000),'287082');
  assert.equal(totpSecondsRemaining(30,59999),1);
  assert.equal(totpSecondsRemaining(30,60000),30);
});
test('setup links preserve parameters and validate issuer and input encoding',()=>{
  const input=parseTotpInput(`otpauth://totp/Example%3Aalice%40example.test?secret=${secret}&issuer=Example&algorithm=SHA256&digits=8&period=60`);
  assert.deepEqual(input,{issuer:'Example',account:'alice@example.test',secret,algorithm:'SHA256',digits:8,period:60});
  assert.equal(normalizeTotpSecret('jbsw y3dp ehpk 3pxp'),'JBSWY3DPEHPK3PXP');
  for(const invalid of [
    'not-a-secret', 'AAAA', 'JBSWY3DPEHPK3PX1',
    `otpauth://hotp/Example?secret=${secret}`,
    `otpauth://totp/Example:alice?secret=${secret}&issuer=Different`,
    `otpauth://totp/alice?secret=${secret}&secret=${secret}`,
    `otpauth://totp/alice?secret=${secret}&algorithm=MD5`,
    `otpauth://totp/alice?secret=${secret}&digits=7`,
    `otpauth://totp/alice?secret=${secret}&period=0`,
    `otpauth://totp/alice?secret=${secret}&period=1.5`,
    `otpauth://totp/%ZZ?secret=${secret}`
  ]) assert.throws(()=>parseTotpInput(invalid));
});
