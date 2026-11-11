import test from 'node:test';
import assert from 'node:assert/strict';
import QRCode from 'qrcode';
import { buildTotpImportPreview, parseTotpImport } from '../src/shared/totpImport';
import { decodeQrPixels } from '../src/shared/qrImport';
import { generateTotp } from '../src/shared/totp';
import { byteField, googleEntry, migrationUri, numberField, publicSecret, publicUri } from './fixtures/totpImport';

test('Google migration preserves SHA algorithms, digits, UTF-8 names and byte secrets',async()=>{
 const uri=migrationUri([
  googleEntry(),
  googleEntry({secret:'12345678901234567890123456789012',name:'公司:中文账号',issuer:'公司',algorithm:2,digits:2}),
  googleEntry({secret:'1234567890123456789012345678901234567890123456789012345678901234',name:'SHA512:alice',issuer:'',algorithm:3,digits:2})
 ],{id:-123,index:0,size:1});
 const result=parseTotpImport(uri);
 assert.deepEqual(result.batch,{id:'-123',index:0,size:1});
 assert.equal(result.accounts[0].secret,publicSecret);
 assert.equal(result.accounts[0].account,'synthetic@example.test');
 assert.equal(result.accounts[1].account,'中文账号');
 assert.equal(result.accounts[2].issuer,'SHA512');
 assert.deepEqual(await Promise.all(result.accounts.map(item=>generateTotp(item,59000))),['287082','46119246','90693936']);
 assert.equal(result.warnings.length,0);
});

test('unspecified Google defaults work but unsupported HOTP/MD5 never become TOTP',()=>{
 const defaults=googleEntry({algorithm:0,digits:0,type:0});
 const result=parseTotpImport(migrationUri([defaults,googleEntry({type:1}),googleEntry({algorithm:4}),googleEntry({secret:''})]));
 assert.equal(result.accounts.length,1);assert.equal(result.warnings.length,3);
 assert.equal(result.accounts[0].algorithm,'SHA1');assert.equal(result.accounts[0].digits,6);
 assert.match(result.warnings[0],/HOTP/);
 assert.doesNotMatch(result.warnings.join(' '),/1234567890|GEZDG/);
});

test('compatible Google migration fields import regardless of the envelope version',async()=>{
 const entries=[googleEntry(),googleEntry({secret:'12345678901234567890123456789012',name:'公司:中文账号',issuer:'公司',algorithm:2,digits:2})];
 const expected=parseTotpImport(migrationUri(entries,{id:-123,index:1,size:2}));
 for(const version of [0,1,2,3,99,2147483647]){
  const parsed=parseTotpImport(migrationUri(entries,{id:-123,index:1,size:2,version},byteField(99,'optional metadata')));
  assert.deepEqual(parsed,expected);
  assert.deepEqual(await Promise.all(parsed.accounts.map(item=>generateTotp(item,59000))),['287082','46119246']);
 }
 const omitted='otpauth-migration://offline?data='+encodeURIComponent(byteField(1,googleEntry()).toString('base64'));
 assert.equal(parseTotpImport(omitted).accounts[0].secret,publicSecret);
});

test('newer migration versions still reject malformed headers and unsupported OTP parameters',()=>{
 for(const version of [-1,2147483648,4294967297,18446744073709551615n]){
  assert.throws(()=>parseTotpImport(migrationUri([googleEntry()],{id:1,index:0,size:1,version})),/不完整或已损坏/);
 }
 const result=parseTotpImport(migrationUri([googleEntry(),googleEntry({type:1}),googleEntry({type:9}),googleEntry({algorithm:4}),googleEntry({digits:9}),googleEntry({secret:''})],{id:1,index:0,size:1,version:3}));
 assert.equal(result.accounts.length,1);assert.equal(result.warnings.length,5);
 assert.doesNotMatch(result.warnings.join(' '),/1234567890|GEZDG/);
 assert.throws(()=>parseTotpImport(migrationUri([],{id:1,index:0,size:1,version:3})),/未包含可读取的账号.*版本 3/);
});

test('malformed migration messages, duplicate parameters and unsupported URIs fail safely',()=>{
 const payload=(bytes:Buffer)=>'otpauth-migration://offline?data='+encodeURIComponent(bytes.toString('base64'));
 for(const input of [
  '123456','https://example.test/qr','otpauth-migration://offline?data=!!!!',
  migrationUri([googleEntry()])+'&data=AAAA',
  migrationUri([googleEntry()],{id:1,index:2,size:2}),
  migrationUri([googleEntry()],{id:1,index:0,size:101}),
  migrationUri([googleEntry()],undefined,numberField(2,1)),
  payload(Buffer.from([10,100,1])),payload(Buffer.from([0])),payload(Buffer.from([0x80])),
  payload(Buffer.concat([byteField(1,googleEntry()),byteField(2,'1')])),
  payload(Buffer.concat([byteField(1,googleEntry()),numberField(2,-1)])),
  publicUri.replace('totp/','hotp/'),publicUri+'&digits=5',publicUri+'&encoder=steam'
  ])assert.throws(()=>parseTotpImport(input));
 const duplicateSecret=parseTotpImport(migrationUri([Buffer.concat([googleEntry(),byteField(1,'duplicate')])]));
 assert.equal(duplicateSecret.accounts.length,0);assert.equal(duplicateSecret.warnings.length,1);
 const withUnknown=migrationUri([googleEntry()],undefined,byteField(99,'ignored'));
 assert.equal(parseTotpImport(withUnknown).accounts.length,1);
 assert.equal(parseTotpImport(publicUri).accounts[0].secret,publicSecret);
});

test('multipart previews track distinct QR indices and deduplicate by code configuration',()=>{
 const one=parseTotpImport(migrationUri([googleEntry()],{id:8,index:0,size:2}));
 const two=parseTotpImport(migrationUri([googleEntry({name:'Other:alice',issuer:'Other'}),googleEntry({algorithm:2})],{id:8,index:1,size:2}));
 const sources=[{id:'one',label:'first',result:one},{id:'again',label:'again',result:one}];
 assert.deepEqual(buildTotpImportPreview(sources,[]).batches,[{size:2,read:1}]);
 const preview=buildTotpImportPreview([...sources,{id:'two',label:'second',result:two}],[]);
 assert.deepEqual(preview.batches,[{size:2,read:2}]);
 assert.deepEqual(preview.rows.map(row=>row.duplicate),['','重复账号','重复账号','']);
 const existing={...one.accounts[0],id:'existing',createdAt:1,updatedAt:1};
 assert.equal(buildTotpImportPreview(sources,[existing]).rows[0].duplicate,'已存在');
 assert.equal(buildTotpImportPreview(sources,[{...existing,secret:existing.secret.toLowerCase()}]).rows[0].duplicate,'已存在');
 assert.equal(buildTotpImportPreview(sources,[{...existing,deletedAt:2}]).rows[0].duplicate,'');
});

function pixels(uris: string[], invert=false): ImageData {
 const codes=uris.map(uri=>QRCode.create(uri,{errorCorrectionLevel:'M'}));
 const scale=5, size=Math.max(...codes.map(code=>code.modules.size))+8;
 const width=size*scale*codes.length,height=size*scale;
 const data=new Uint8ClampedArray(width*height*4);data.fill(invert?0:255);
 for(let p=3;p<data.length;p+=4)data[p]=255;
 codes.forEach((code,index)=>{
  for(let y=0;y<code.modules.size;y++)for(let x=0;x<code.modules.size;x++)if(code.modules.get(y,x)){
   for(let dy=0;dy<scale;dy++)for(let dx=0;dx<scale;dx++){
    const offset=(((y+4)*scale+dy)*width+(index*size+x+4)*scale+dx)*4;
    data[offset]=data[offset+1]=data[offset+2]=invert?255:0;
   }
  }
 });
 return {data,width,height,colorSpace:'srgb'} as ImageData;
}
test('local QR decoder reads multiple codes and inverted Google migration images',()=>{
 const google=migrationUri([googleEntry()]);
 assert.deepEqual(new Set(decodeQrPixels(pixels([publicUri,google]))),new Set([publicUri,google]));
 assert.deepEqual(decodeQrPixels(pixels([google],true)),[google]);
});
