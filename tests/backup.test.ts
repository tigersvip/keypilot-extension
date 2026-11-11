import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { backupMergeSummary, initializeVaultFromBackup, mergeBackup, previewBackup, restoreBackup, validateBackup } from '../src/shared/backup';
import { backupStatus, prepareEncryptedBackup } from '../src/shared/backupStatus';
import { backupSettingsChanges, backupSettingsSnapshot, mergeBackupSettings } from '../src/shared/backupSettings';
import { backupCollections } from '../src/shared/backupInventory';
import { createEncryptedVault, unlockEncryptedVault, unlockEncryptedVaultWithRecoveryCode } from '../src/shared/crypto';
import { createEmptyVault } from '../src/shared/defaults';
import { clearVaultSessionCache, createVaultSession, deleteFillProfileFromVault, persistVaultSession, unlockVaultSession, upsertVaultSettings } from '../src/shared/vault';
import { getEncryptedVault, getRecoverySnapshots, VAULT_STORAGE_KEY } from '../src/shared/storage';
import { generateTotp } from '../src/shared/totp';
import { completeBackupFixture } from './fixtures/completeBackup';

const master = 'Synthetic-backup!42';
const incomingPassword = 'Synthetic-incoming!42';

test('profile defaults validate IDs and are removed when their profile is deleted',()=>{
  const vault=completeBackupFixture(),origin='https://backup.example.test';
  const deleted=deleteFillProfileFromVault(vault,'backup-profile');
  assert.equal(deleted.settings.siteLoginSettings![origin].defaultFillProfileId,undefined);
  assert.equal(deleted.settings.siteLoginSettings![origin].autoSubmit,false);
  assert.equal(vault.settings.siteLoginSettings![origin].defaultFillProfileId,'backup-profile');
  for(const value of ['',42,'x'.repeat(201),{}]){
    const invalid=structuredClone(vault);invalid.settings.siteLoginSettings![origin].defaultFillProfileId=value as string;
    assert.throws(()=>validateBackup(invalid),/网站登录设置/);
  }
});

test('profile defaults follow imported profiles for every backup conflict choice',()=>{
  const current=completeBackupFixture(),incoming=structuredClone(current),origin='https://backup.example.test',id='backup-profile';
  incoming.fillProfiles![0].title='Imported profile';
  for(const choice of ['both','current','incoming'] as const){
    const merged=mergeBackup(current,incoming,{siteRules:true},{[JSON.stringify(['fillProfiles',id])]:choice});
    const preferred=merged.fillProfiles!.find(item=>item.id===merged.settings.siteLoginSettings![origin].defaultFillProfileId)!;
    assert.equal(preferred.title,choice==='current'?'Synthetic profile':'Imported profile');
    assert.equal(preferred.id===id,choice!=='both');
  }
  assert.equal(mergeBackup(current,incoming,{preferences:true}).settings.siteLoginSettings![origin].defaultFillProfileId,id);
  incoming.fillProfiles=[];
  assert.equal(mergeBackup(current,incoming,{siteRules:true}).settings.siteLoginSettings![origin].defaultFillProfileId,undefined);
});

test('site preferences validate exact origins and restore with the site settings group',()=>{
  const current=createEmptyVault().settings,incoming={...current,siteLoginSettings:{'https://site.example.test':{fillEnabled:false,autoSubmit:false,defaultCredentialId:'login',totpAccountByCredential:{login:'otp'}}}};
  assert.equal(mergeBackupSettings(current,incoming,{preferences:true}).siteLoginSettings,undefined);
  assert.deepEqual(mergeBackupSettings(current,incoming,{siteRules:true}).siteLoginSettings,incoming.siteLoginSettings);
  for(const invalid of [{'*.example.test':{}},{'https://site.example.test/path':{}},{'https://site.example.test':{autoSubmit:'yes'}},{'https://site.example.test':{totpAccountByCredential:[]}}]){
    const vault=createEmptyVault();vault.settings.siteLoginSettings=invalid as any;assert.throws(()=>validateBackup(vault),/网站登录设置/);
  }
});

test('backup ID conflicts remap site defaults and authenticator selection to their own imported records',()=>{
  const current=completeBackupFixture(),incoming=structuredClone(current),cid=incoming.credentials[0].id,aid=incoming.totpAccounts![0].id;
  current.totpAccounts![0].credentialId=cid;incoming.totpAccounts![0].credentialId=cid;
  incoming.credentials[0].password='Changed-fixture!42';incoming.totpAccounts![0].secret='JBSWY3DPEHPK3PXP';
  incoming.settings.siteLoginSettings={'https://backup.example.test':{defaultCredentialId:cid,totpAccountByCredential:{[cid]:aid}}};
  const merged=mergeBackup(current,incoming,{siteRules:true});
  const imported=merged.credentials.find(item=>item.password==='Changed-fixture!42')!,totp=merged.totpAccounts!.find(item=>item.secret==='JBSWY3DPEHPK3PXP')!;
  assert.notEqual(imported.id,cid);assert.notEqual(totp.id,aid);assert.equal(totp.credentialId,imported.id);
  assert.deepEqual(merged.settings.siteLoginSettings!['https://backup.example.test'],{defaultCredentialId:imported.id,totpAccountByCredential:{[imported.id]:totp.id}});
});
test('automatic TOTP origins restore with site settings and reject broad or insecure destinations',()=>{
  const current=createEmptyVault().settings,incoming={...current,autoTotpOrigins:['https://backup.example.test:8443']};
  assert.deepEqual(mergeBackupSettings(current,incoming,{preferences:true}).autoTotpOrigins,[]);
  assert.deepEqual(mergeBackupSettings(current,incoming,{siteRules:true}).autoTotpOrigins,incoming.autoTotpOrigins);
  for(const invalid of [['http://example.test'],['https://example.test/path'],['*.example.test'],['https://a.test','https://a.test'],[4]]){
    const vault=createEmptyVault();vault.settings.autoTotpOrigins=invalid as string[];assert.throws(()=>validateBackup(vault),/自动填写动态验证码/);
  }
});
function area() {
  const data: Record<string, unknown> = {};
  return {
    async get(key: string) { return structuredClone({[key]:data[key]}); },
    async set(values: Record<string, unknown>) { Object.assign(data,structuredClone(values)); },
    async remove(key: string) { delete data[key]; }
  };
}
beforeEach(() => { Object.assign(globalThis,{chrome:{storage:{local:area(),session:area()}}}); });
async function backupFile(vault = completeBackupFixture(), password = incomingPassword) {
  const {encryptedVault} = await createEncryptedVault(password,vault);
  return new File([JSON.stringify(encryptedVault)],'synthetic-backup.json');
}

test('complete encrypted export restores all collections, 2FA parameters and settings on a fresh installation', async () => {
  const recoveryCode = 'KP-AAAA-BBBB-CCCC-DDDD-EEEE';
  const initial = await createVaultSession(master,recoveryCode);
  const source = {...completeBackupFixture(),saveInboxKeyPair:initial.vault.saveInboxKeyPair};
  const saved = await persistVaultSession(initial,source);
  const exported = await prepareEncryptedBackup(saved);
  assert.equal(backupStatus(exported.vault).due,false);
  const serialized = JSON.stringify(exported.encryptedVault);
  for (const secret of [source.totpAccounts![0].secret,source.credentials[0].password,source.fillProfiles![0].fields[1].value,source.settings.blacklist[0]]) assert.ok(!serialized.includes(secret));
  await clearVaultSessionCache();
  await chrome.storage.local.remove(VAULT_STORAGE_KEY);
  const preview = await previewBackup(new File([serialized],'complete.json'),master);
  assert.equal(await getEncryptedVault(),null);
  const restored = await initializeVaultFromBackup(preview);
  for (const {key} of backupCollections) assert.deepEqual(restored.vault[key],exported.vault[key],key);
  assert.deepEqual(restored.vault.settings,exported.vault.settings);
  assert.equal(await generateTotp(restored.vault.totpAccounts![0],59000),'94287082');
  assert.deepEqual((await unlockEncryptedVaultWithRecoveryCode(recoveryCode,restored.encryptedVault)).vault,restored.vault);
  await clearVaultSessionCache();
  assert.deepEqual((await unlockVaultSession(master)).vault,restored.vault);
});

test('fresh restore rejects invalid inputs and cannot overwrite a vault created while previewing', async () => {
  const file = await backupFile();
  await assert.rejects(previewBackup(file,'wrong-password'));
  await assert.rejects(previewBackup(new File(['{}'],'bad.json'),incomingPassword));
  assert.equal(await getEncryptedVault(),null);
  const preview = await previewBackup(file,incomingPassword);
  const results = await Promise.allSettled([initializeVaultFromBackup(preview),initializeVaultFromBackup(preview)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length,1);
  const before = await getEncryptedVault();
  await assert.rejects(initializeVaultFromBackup(preview),/已存在密码库/);
  assert.deepEqual(await getEncryptedVault(),before);
});

test('old backups restore without 2FA or reminder fields and malformed settings never write', async () => {
  const vault = createEmptyVault(); delete vault.totpAccounts;
  const preview = await previewBackup(await backupFile(vault),incomingPassword);
  const restored = await initializeVaultFromBackup(preview);
  assert.deepEqual(restored.vault.totpAccounts,[]);
  assert.ok(restored.vault.saveInboxKeyPair?.privateKey);
  const before = await getEncryptedVault();
  vault.settings.blacklist = null as never;
  await assert.rejects(previewBackup(await backupFile(vault),incomingPassword));
  assert.deepEqual(await getEncryptedVault(),before);
});

test('merge preview and restore agree on credential conflicts, renamed 2FA duplicates and different parameters', () => {
  const current = completeBackupFixture(), incoming = structuredClone(current);
  incoming.credentials = [{...incoming.credentials[0],password:'Changed-only!42'}, {...incoming.credentials[0],id:'same-content-other-id'}];
  const original = current.totpAccounts![0];
  incoming.totpAccounts = [
    {...original,id:'renamed',issuer:'New label',account:'new-label'},
    {...original,id:'algorithm',algorithm:'SHA256'}, {...original,id:'digits',digits:6},
    {...original,id:'period',period:60}, {...original,id:'removed',deletedAt:2}
  ];
  const counts = backupMergeSummary(current,incoming);
  assert.deepEqual(counts.find(row=>row.key==='credentials'),{key:'credentials',label:'登录账号',added:1,duplicates:1,conflicts:1});
  assert.deepEqual(counts.find(row=>row.key==='totpAccounts'),{key:'totpAccounts',label:'身份验证器（2FA）',added:4,duplicates:1,conflicts:3}); // Removed and active entries are separate groups.
  const merged = mergeBackup(current,incoming);
  assert.equal(merged.credentials.length,2); assert.notEqual(merged.credentials[0].id,merged.credentials[1].id);
  assert.equal(merged.credentials[0].password,current.credentials[0].password);
  assert.equal(merged.totpAccounts!.length,5); assert.deepEqual(merged.totpAccounts![0],original);
});

test('merge preserves current settings by default and only restores selected configuration groups', () => {
  const current = createEmptyVault().settings, incoming = completeBackupFixture().settings;
  current.backupExport = {requestedAt:1,recordIds:[],settingsSnapshot:backupSettingsSnapshot(current)};
  incoming.backupExport = {requestedAt:2,recordIds:['incoming']};
  assert.deepEqual(mergeBackupSettings(current,incoming,{}),current);
  const selected = mergeBackupSettings(current,incoming,{blacklists:true,fillMappings:true});
  assert.equal(selected.autoFill,current.autoFill);
  assert.deepEqual(selected.siteRules,current.siteRules);
  for (const key of ['blacklist','inlineBlacklist','inlineSilentRules','fillImportMappingTemplates','fillImportBatches'] as const) assert.deepEqual(selected[key],incoming[key]);
  assert.deepEqual(selected.backupExport,current.backupExport);
  const all = mergeBackupSettings(current,incoming,{preferences:true,blacklists:true,siteRules:true,fillMappings:true});
  assert.equal(backupSettingsSnapshot(all),backupSettingsSnapshot(incoming));
  assert.deepEqual(all.backupExport,current.backupExport);
  assert.ok(backupSettingsChanges(current,incoming).every(group=>group.changed>0));
});

test('merge requires a fresh preview, uses latest saved data and refuses writes after locking', async () => {
  const initial = await createVaultSession(master), file = await backupFile();
  const preview = await previewBackup(file,incomingPassword,initial);
  const changed = await persistVaultSession(initial,upsertVaultSettings(initial.vault,{clearClipboardSeconds:60}));
  await assert.rejects(restoreBackup(preview,'merge',changed),/重新预览/);
  const fresh = await previewBackup(file,incomingPassword,initial);
  assert.equal(fresh.currentVault?.settings.clearClipboardSeconds,60);
  const merged = await restoreBackup(fresh,'merge',initial,{blacklists:true});
  assert.equal(merged.vault.settings.clearClipboardSeconds,60);
  assert.deepEqual(merged.vault.settings.blacklist,['blocked.example.test']);
  assert.equal((await getRecoverySnapshots())!.length,1);
  assert.equal((await unlockEncryptedVault(master,merged.encryptedVault)).vault.credentials.length,1);
  await assert.rejects(unlockEncryptedVault(incomingPassword,merged.encryptedVault));
  const lockedPreview = await previewBackup(file,incomingPassword,merged);
  await clearVaultSessionCache();
  await assert.rejects(restoreBackup(lockedPreview,'merge',merged),/VAULT_LOCKED/);
});

test('replacement restores the backup password and all settings with a usable rollback', async () => {
  const current = await createVaultSession(master), file = await backupFile();
  const preview = await previewBackup(file,incomingPassword,current);
  const replaced = await restoreBackup(preview,'replace',current);
  assert.deepEqual(replaced.vault.settings,completeBackupFixture().settings);
  assert.equal((await unlockEncryptedVault(incomingPassword,replaced.encryptedVault)).vault.totpAccounts!.length,1);
  await assert.rejects(unlockEncryptedVault(master,replaced.encryptedVault));
  assert.deepEqual((await unlockEncryptedVault(master,(await getRecoverySnapshots())![0].vault)).vault,current.vault);
});

test('settings-only changes trigger reminders; export bookkeeping and object key order do not', async () => {
  const initial = await createVaultSession(master);
  assert.equal(backupStatus(initial.vault).due,false);
  const custom = await persistVaultSession(initial,upsertVaultSettings(initial.vault,{blacklist:['example.test']}));
  assert.equal(backupStatus(custom.vault).due,true);
  const exported = await prepareEncryptedBackup(initial); // Deliberately stale caller; read the latest encrypted data.
  assert.deepEqual(exported.vault.settings.blacklist,['example.test']);
  assert.equal(backupStatus(exported.vault).due,false);
  const reordered = {...exported.vault,settings:Object.fromEntries(Object.entries(exported.vault.settings).reverse()) as typeof exported.vault.settings};
  assert.equal(backupStatus(reordered).due,false);
  for (const patch of [{autoFill:false},{siteRules:completeBackupFixture().settings.siteRules},{fillImportMappingTemplates:completeBackupFixture().settings.fillImportMappingTemplates},{fillImportBatches:completeBackupFixture().settings.fillImportBatches}]) {
    const changed = upsertVaultSettings(exported.vault,patch);
    assert.equal(backupStatus(changed).settingsChanged,true);
    assert.equal(backupStatus(changed).due,true);
    assert.equal(backupStatus(upsertVaultSettings(changed,{backupReminderEnabled:false})).due,false);
  }
  const legacy = structuredClone(exported.vault); delete legacy.settings.backupExport!.settingsSnapshot;
  assert.equal(backupStatus(legacy).settingsUntracked,true); assert.equal(backupStatus(legacy).due,true);
  await clearVaultSessionCache();
  await assert.rejects(prepareEncryptedBackup(exported),/VAULT_LOCKED/);
});
