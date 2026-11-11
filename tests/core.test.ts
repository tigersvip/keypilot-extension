import type { TotpAccount } from '../src/shared/types';
import { backupStatus } from '../src/shared/backupStatus';
import { backupSettingsSnapshot } from '../src/shared/backupSettings';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { credentialMatchesUrl, domainsMatch, extractDomain, normalizeUrl, getRegistrableDomain } from '../src/shared/domain';
import { createVaultSession, restoreCachedVaultSession, persistVaultSession, buildCredential, addCredentialToVault, updateCredentialInVault, upsertVaultSettings, clearVaultSessionCache, changeVaultMasterPassword, unlockVaultSession } from '../src/shared/vault';
import { getEncryptedVault, getUnlockedVaultCache, SESSION_STATE_KEY, UNLOCKED_SESSION_KEY, getRecoverySnapshots } from '../src/shared/storage';
import { unlockEncryptedVault } from '../src/shared/crypto';
import { previewBackup, restoreBackup } from '../src/shared/backup';
import { normalizeVault } from '../src/shared/vault';
import { FILL_FIELD_MAPPING_PRESETS, parseFillProfileImportFile } from '../src/shared/fillProfiles';
import type { FillProfile } from '../src/shared/types';
import { importTotpAccounts } from '../src/shared/totpImportStorage';
import { parseTotpImport } from '../src/shared/totpImport';
import { publicUri } from './fixtures/totpImport';
import { createPageUuid } from '../src/content/randomId';
const master='Test-only-password!42';
test('page UUID supports both native and HTTP crypto APIs',()=>{
 assert.equal(createPageUuid({randomUUID:()=> '00112233-4455-4677-8899-aabbccddeeff',getRandomValues:()=>{throw new Error('unexpected fallback');}}),'00112233-4455-4677-8899-aabbccddeeff');
 const getRandomValues=((bytes:Uint8Array)=>{bytes.set([0,17,34,51,68,85,102,119,136,153,170,187,204,221,238,255]);return bytes;}) as Crypto['getRandomValues'];
 assert.equal(createPageUuid({getRandomValues}),'00112233-4455-4677-8899-aabbccddeeff');
 const ids=Array.from({length:1000},()=>createPageUuid({getRandomValues:crypto.getRandomValues.bind(crypto)}));
 assert.equal(new Set(ids).size,ids.length);
 for(const id of ids)assert.match(id,/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
 assert.throws(()=>createPageUuid({getRandomValues:()=>{throw new Error('RNG unavailable');}}),/RNG unavailable/);
});
function area() {
  const data:Record<string,unknown>={};
  return {
    async get(key:string){return structuredClone({[key]:data[key]});},
    async set(values:Record<string,unknown>){Object.assign(data,structuredClone(values));},
    async remove(keys:string|string[]){for(const key of [].concat(keys as never))delete data[key];}
  };
}
beforeEach(()=>{Object.assign(globalThis,{chrome:{storage:{local:area(),session:area()}}});});
const add=(session:Awaited<ReturnType<typeof createVaultSession>>,title:string) => addCredentialToVault(session.vault,buildCredential({title,url:'https://example.com/login',username:title,password:'synthetic!Password'}));

test('TOTP batch import is encrypted, atomic, duplicate-safe under concurrency and blocked after locking',async()=>{
 const session=await createVaultSession(master);
 const account=parseTotpImport(publicUri).accounts[0];
 await persistVaultSession(session,add(session,'keep-latest'));
 const results=await Promise.all([importTotpAccounts(session,[account,account]),importTotpAccounts(session,[account])]);
 assert.equal(results.reduce((sum,result)=>sum+result.added,0),1);
 const saved=(await restoreCachedVaultSession())!;
 assert.equal(saved.vault.credentials.length,1);assert.equal(saved.vault.totpAccounts?.length,1);
 const stored=JSON.stringify(await getEncryptedVault());assert.ok(!stored.includes(account.secret));assert.ok(!stored.includes(account.account));
 await assert.rejects(importTotpAccounts(saved,[{...account,secret:'INVALID'},{...account,account:'second'}]));
 assert.equal(JSON.stringify(await getEncryptedVault()),stored);
 const preview=await previewBackup(new File([stored],'synthetic.json'),master);
 assert.equal(preview.vault.totpAccounts?.[0].secret,account.secret);
 await clearVaultSessionCache();
 await assert.rejects(importTotpAccounts(saved,[account]),/VAULT_LOCKED/);
 assert.equal(JSON.stringify(await getEncryptedVault()),stored);
});

const legacyProfile = (): FillProfile => ({id:'legacy-profile',title:'Synthetic profile',category:'identity',countryCode:'US',createdAt:1,updatedAt:1,fields:[
 {key:'dob',label:'出生日期',value:'1990-01-02',group:'personal',sensitivity:'private'},
 {key:'idNumber',label:'证件号码',value:'SYNTHETIC-ID',group:'sensitive',sensitivity:'secret'},
 {key:'vin',label:'VIN',value:'SYNTHETIC-VIN',group:'vehicle',sensitivity:'private'},
 {key:'cardNumber',label:'卡号',value:'4111111111111111',group:'payment',sensitivity:'secret'},
 {key:'cvv',label:'CVV',value:'123',group:'payment',sensitivity:'secret'},
 {key:'bankAccountNumber',label:'银行账号',value:'SYNTHETIC-BANK',group:'finance',sensitivity:'secret'}
]});

test('legacy profile migration keeps payment data private and respects later manual choices',async()=>{
 const session=await createVaultSession(master);
 const vault=normalizeVault({...session.vault,fillProfiles:[legacyProfile()],deletedItems:[{id:'deleted',kind:'fillProfile',deletedAt:2,item:legacyProfile()}]});
 assert.deepEqual(vault.fillProfiles![0].fields.map(field=>field.sensitivity),['normal','normal','normal','secret','secret','secret']);
 assert.equal((vault.deletedItems![0].item as FillProfile).fields[0].sensitivity,'normal');
 const saved=await persistVaultSession(session,vault);
 const manual=structuredClone(saved.vault);manual.fillProfiles![0].fields[0].sensitivity='private';
 await persistVaultSession(saved,manual);
 assert.equal((await restoreCachedVaultSession())!.vault.fillProfiles![0].fields[0].sensitivity,'private');
 await clearVaultSessionCache();
 assert.equal((await unlockVaultSession(master)).vault.fillProfiles![0].fields[0].sensitivity,'private');
});

test('CSV presets and old profile imports use ordinary dates and protected payment details',async()=>{
 const ordinary=['dob','dobMonth','dobDay','dobYear','ssn','idNumber','passportNumber','driverLicenseNumber','vin','policyNumber','ein'];
 for(const key of ordinary)assert.equal(FILL_FIELD_MAPPING_PRESETS.find(item=>item.key===key)?.sensitivity,'normal',key);
 const csv=new File(['DOB,SSN,Driver License,VIN,Policy Number,Card Number,CVV,Bank Account\n1990-01-02,synthetic,synthetic,synthetic,synthetic,4111111111111111,123,synthetic'],'synthetic.csv');
 const preview=await parseFillProfileImportFile(csv);
 assert.deepEqual(preview.headers.map(header=>header.sensitivity),['normal','normal','normal','normal','normal','secret','secret','secret']);
 const imported=await parseFillProfileImportFile(new File([JSON.stringify({profiles:[legacyProfile()]})],'synthetic.kpfill'));
 assert.deepEqual(imported.profiles[0].fields.slice(0,6).map(field=>field.sensitivity),['normal','normal','normal','secret','secret','secret']);
 assert.equal(imported.sensitiveFieldCount,3);
});

test('exact host matching separates private/public suffix tenants',()=>{
 for(const [a,b] of [['merchant.co.nz','other.co.nz'],['alice.blogspot.com','bob.blogspot.com'],['a.github.io','b.github.io'],['login.example.com','example.com'],['www.example.com','example.com']]) assert.equal(domainsMatch(a,b),false);
 assert.equal(domainsMatch('EXAMPLE.COM.','example.com'),true);
 assert.equal(getRegistrableDomain('a.b.co.nz'),'b.co.nz');
});

test('internal pages and non-web schemes never become website domains',()=>{
 for(const url of ['chrome://extensions/','edge://newtab/','chrome-extension://abcdef/popup.html','about:blank','file:///C:/test.html','javascript:alert(1)','data:text/plain,test']) {
  assert.equal(normalizeUrl(url),url);
  assert.equal(extractDomain(url),'');
  assert.equal(credentialMatchesUrl({domain:'chrome'},url),false);
 }
 assert.equal(extractDomain('localhost:4173/login'),'localhost');
 assert.equal(normalizeUrl('example.com:8443/login'),'https://example.com:8443/login');
 assert.equal(extractDomain('//example.com/path'),'example.com');
});
test('explicit wildcards cannot widen a public suffix or origin',()=>{
 const credential={domain:'example.com',matchUrl:'https://*.example.com/login/*'};
 assert.equal(credentialMatchesUrl(credential,'https://accounts.example.com/login/start'),true);
 for(const url of ['http://accounts.example.com/login/start','https://evil-example.com/login/start','https://accounts.example.com:444/login/start','https://accounts.example.com/loginevil/start'])assert.equal(credentialMatchesUrl(credential,url),false);
 assert.equal(credentialMatchesUrl({domain:'co.nz',matchUrl:'https://*.co.nz/*'},'https://other.co.nz/'),false);
 assert.equal(credentialMatchesUrl({domain:'blogspot.com',matchUrl:'https://*.blogspot.com/*'},'https://other.blogspot.com/'),false);
 assert.equal(credentialMatchesUrl({domain:'example.com',url:'https://example.com'},'http://example.com'),false);
});
test('stale settings page preserves newly added credentials',async()=>{
 const session=await createVaultSession(master), stale=(await restoreCachedVaultSession())!;
 await persistVaultSession(session,add(session,'new'));
 const merged=await persistVaultSession(stale,upsertVaultSettings(stale.vault,{autoSubmit:true}));
 assert.equal(merged.vault.credentials.length,1);assert.equal(merged.vault.settings.autoSubmit,true);
});
test('simultaneous additions both survive',async()=>{
 const session=await createVaultSession(master);
 await Promise.all([persistVaultSession(session,add(session,'one')),persistVaultSession(session,add(session,'two'))]);
 assert.equal((await restoreCachedVaultSession())!.vault.credentials.length,2);
});
test('conflicting edits fail without overwriting the first edit',async()=>{
 const initial=await createVaultSession(master);
 const session=await persistVaultSession(initial,add(initial,'one'));
 const item=session.vault.credentials[0];
 await persistVaultSession(session,updateCredentialInVault(session.vault,{...item,password:'first'}));
 await assert.rejects(persistVaultSession(session,updateCredentialInVault(session.vault,{...item,password:'second'})),/VAULT_WRITE_CONFLICT/);
 assert.equal((await restoreCachedVaultSession())!.vault.credentials[0].password,'first');
});
test('locked old page cannot save or resurrect its cache',async()=>{
 const session=await createVaultSession(master);
 await clearVaultSessionCache();
 await assert.rejects(persistVaultSession(session,add(session,'blocked')),/VAULT_LOCKED/);
 assert.equal(await getUnlockedVaultCache(),null);
});
test('expiry is enforced and passive reads do not extend it',async()=>{
 let session=await createVaultSession(master);
 session=await persistVaultSession(session,upsertVaultSettings(session.vault,{autoLockMinutes:1}));
 const first=(await chrome.storage.session.get(SESSION_STATE_KEY))[SESSION_STATE_KEY];
 await restoreCachedVaultSession();
 assert.deepEqual((await chrome.storage.session.get(SESSION_STATE_KEY))[SESSION_STATE_KEY],first);
 await chrome.storage.session.set({[SESSION_STATE_KEY]:{...first,expiresAt:Date.now()-1}});
 assert.equal(await restoreCachedVaultSession(),null);
 await assert.rejects(persistVaultSession(session,session.vault),/VAULT_LOCKED/);
});
test('high security uses worker memory, startup lock does not disable current session',async()=>{
 let session=await createVaultSession(master);
 session=await persistVaultSession(session,upsertVaultSettings(session.vault,{highSecurityMode:true,lockOnStartup:true}));
 assert.equal((await chrome.storage.session.get(UNLOCKED_SESSION_KEY))[UNLOCKED_SESSION_KEY],undefined);
 assert.ok(await restoreCachedVaultSession());
 await clearVaultSessionCache(); assert.equal(await restoreCachedVaultSession(),null);
});
test('master password change preserves latest data and invalidates old sessions',async()=>{
 const session=await createVaultSession(master);
 await persistVaultSession(session,add(session,'keep'));
 const changed=await changeVaultMasterPassword(session,master,'A-new-password!42');
 assert.equal(changed.vault.credentials.length,1);
 await assert.rejects(persistVaultSession(session,session.vault),/VAULT_LOCKED/);
 await clearVaultSessionCache();
 assert.equal((await unlockVaultSession('A-new-password!42')).vault.credentials.length,1);
});
test('backup preview never changes current data; merge keeps both and creates recovery point',async()=>{
 const initial=await createVaultSession(master);
 const old=await persistVaultSession(initial,add(initial,'backup'));
 const file=new File([JSON.stringify(old.encryptedVault)],'backup.json');
 const current=await persistVaultSession(old,add(old,'current'));
 const before=await getEncryptedVault();
 const preview=await previewBackup(file,master);
 assert.deepEqual(await getEncryptedVault(),before);
 const restored=await restoreBackup(preview,'merge',current);
 assert.equal(restored.vault.credentials.length,2);
 assert.equal((await getRecoverySnapshots())!.length,1);
 const rollback=await unlockEncryptedVault(master,(await getRecoverySnapshots())![0].vault);
 assert.equal(rollback.vault.credentials.length,2);
});
test('replace requires a fresh preview and invalidates previous sessions',async()=>{
 const initial=await createVaultSession(master);
 const file=new File([JSON.stringify(initial.encryptedVault)],'backup.json');
 const preview=await previewBackup(file,master);
 const updated=await persistVaultSession(initial,add(initial,'newer'));
 await assert.rejects(restoreBackup(preview,'replace',updated),/重新预览/);
 const fresh=await previewBackup(file,master);
 const replaced=await restoreBackup(fresh,'replace',updated);
 assert.equal(replaced.vault.credentials.length,0);
 await assert.rejects(persistVaultSession(updated,updated.vault),/VAULT_LOCKED/);
 assert.equal((await unlockEncryptedVault(master,(await getRecoverySnapshots())![0].vault)).vault.credentials.length,1);
});
test('invalid backup and wrong password do not modify storage',async()=>{
 const session=await createVaultSession(master);
 const before=await getEncryptedVault();
 await assert.rejects(previewBackup(new File(['{}'],'bad.json'),master));
 await assert.rejects(previewBackup(new File([JSON.stringify(session.encryptedVault)],'backup.json'),'wrong'));
 assert.deepEqual(await getEncryptedVault(),before);
});


test('backup reminders count additions, edits and removals and respect disabling',async()=>{
 const session=await createVaultSession(master);const now=Date.now();
 const original=buildCredential({title:'original',url:'https://example.test',username:'test',password:'synthetic'});
 original.updatedAt=now-10*86400000;
 const vault={...session.vault,credentials:[original],settings:{...session.vault.settings,backupExport:{requestedAt:now-8*86400000,recordIds:['credentials:'+original.id],settingsSnapshot:backupSettingsSnapshot(session.vault.settings)}}};
 assert.equal(backupStatus(vault,now).due,false);
 const added=buildCredential({title:'added',url:'https://example.test',username:'test2',password:'synthetic'});
 vault.credentials=[{...original,updatedAt:now},added];
 assert.equal(backupStatus(vault,now).added,1);assert.equal(backupStatus(vault,now).changed,1);assert.equal(backupStatus(vault,now).due,true);
 vault.credentials=[added];assert.equal(backupStatus(vault,now).removed,1);
 vault.settings.backupReminderEnabled=false;assert.equal(backupStatus(vault,now).due,false);
});


const totpFixture:TotpAccount={id:'totp-1',issuer:'Example',account:'synthetic@example.test',secret:'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',algorithm:'SHA1',digits:6,period:30,createdAt:1,updatedAt:1};
test('TOTP is encrypted at rest, survives concurrent saves, and round-trips through backups',async()=>{
 const initial=await createVaultSession(master);
 const saved=await persistVaultSession(initial,{...initial.vault,totpAccounts:[totpFixture]});
 const updated=await persistVaultSession(initial,add(initial,'parallel credential'));
 assert.deepEqual(updated.vault.totpAccounts,[totpFixture]);
 assert.ok(!JSON.stringify(await getEncryptedVault()).includes(totpFixture.secret));
 const file=new File([JSON.stringify(saved.encryptedVault)],'totp-backup.json');
 const preview=await previewBackup(file,master);
 assert.deepEqual(preview.vault.totpAccounts,[totpFixture]);
 const merged=await restoreBackup(preview,'merge',updated);
 assert.equal(merged.vault.totpAccounts?.length,1);
 const replaced=await restoreBackup(await previewBackup(file,master),'replace',merged);
 assert.deepEqual(replaced.vault.totpAccounts,[totpFixture]);
 const reopened=await unlockVaultSession(master);
 assert.deepEqual(reopened.vault.totpAccounts,[totpFixture]);
});
test('conflicting TOTP edits are rejected and locking prevents TOTP saves',async()=>{
 const initial=await createVaultSession(master);
 const saved=await persistVaultSession(initial,{...initial.vault,totpAccounts:[totpFixture]});
 await persistVaultSession(saved,{...saved.vault,totpAccounts:[{...totpFixture,account:'first'}]});
 await assert.rejects(persistVaultSession(saved,{...saved.vault,totpAccounts:[{...totpFixture,account:'second'}]}),/VAULT_WRITE_CONFLICT/);
 await clearVaultSessionCache();
 await assert.rejects(persistVaultSession(saved,saved.vault),/VAULT_LOCKED/);
});
