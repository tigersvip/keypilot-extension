import test,{beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import { appendRecoveryCodes,vaultItemCount } from '../src/shared/credentialSecurity';
import { createVaultSession,persistVaultSession,updateCredentialInVault,buildCredential,clearVaultSessionCache,deleteCredentialFromVault,restoreDeletedItemToVault } from '../src/shared/vault';
import { createEmptyVault } from '../src/shared/defaults';
import { backupMergeConflicts,backupMergeSummary,mergeBackup,previewBackup,initializeVaultFromBackup,validateBackup } from '../src/shared/backup';
import { totpSetupUri,totpQrDataUrl } from '../src/shared/totpExport';
import { parseTotpInput,generateTotp } from '../src/shared/totp';
import { prepareEncryptedBackup } from '../src/shared/backupStatus';
import { VAULT_STORAGE_KEY,getEncryptedVault } from '../src/shared/storage';
import { completeBackupFixture } from './fixtures/completeBackup';
import { exportKeyPilotCredentialsJson } from '../src/shared/csvExport';

const master='Synthetic-security!42';
function area(){const data:Record<string,unknown>={};return {async get(key:string){return structuredClone({[key]:data[key]});},async set(values:Record<string,unknown>){Object.assign(data,structuredClone(values));},async remove(key:string){delete data[key];}};}
beforeEach(()=>Object.assign(globalThis,{chrome:{storage:{local:area(),session:area()}}}));

test('password history records edits and direct imports, keeps 10 and preserves concurrent unrelated data',async()=>{
  let session=await createVaultSession(master);
  const credential=buildCredential({title:'History',url:'https://example.test',username:'synthetic',password:'original-password'});
  credential.formFields=[{label:'Password',kind:'password',value:credential.password}];
  session=await persistVaultSession(session,{...session.vault,credentials:[credential]});
  for(let i=0;i<12;i++)session=await persistVaultSession(session,updateCredentialInVault(session.vault,{...session.vault.credentials[0],password:`changed-${i}`}));
  const history=session.vault.credentials[0].passwordHistory!;
  assert.equal(history.length,10);assert.equal(history[0].password,'changed-10');assert.equal(history[9].password,'changed-1');
  const stale=session;
  session=await persistVaultSession(session,{...session.vault,credentials:[{...session.vault.credentials[0],password:'imported-password'}]});
  assert.equal(session.vault.credentials[0].passwordHistory![0].password,'changed-11');
  assert.equal(session.vault.credentials[0].formFields![0].value,'imported-password');
  const withNote=await persistVaultSession(stale,{...stale.vault,credentials:[{...stale.vault.credentials[0],notes:'Concurrent note'}]});
  assert.equal(withNote.vault.credentials[0].password,'imported-password');assert.equal(withNote.vault.credentials[0].passwordHistory![0].password,'changed-11');
  await assert.rejects(persistVaultSession(stale,updateCredentialInVault(stale.vault,{...stale.vault.credentials[0],password:'competing-password'})),/VAULT_WRITE_CONFLICT/);
});

test('Chrome property reordering does not create history or recovery-code write conflicts',async()=>{
  let session=await createVaultSession(master);
  const credential=appendRecoveryCodes(buildCredential({title:'History',url:'https://example.test',username:'synthetic',password:'current-password'}),'ONE\nTWO');
  credential.passwordHistory=[{id:'history',password:'older-password',changedAt:1}];
  session=await persistVaultSession(session,{...session.vault,credentials:[credential]});
  const reordered=JSON.parse(JSON.stringify(session.vault,(_key,value)=>value && typeof value==='object' && !Array.isArray(value)?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))):value));
  const changed=updateCredentialInVault(reordered,{...reordered.credentials[0],password:'older-password',recoveryCodes:reordered.credentials[0].recoveryCodes.map((code:any)=>({...code,usedAt:2}))});
  session=await persistVaultSession({...session,vault:reordered},changed);
  assert.equal(session.vault.credentials[0].password,'older-password');
  assert.equal(session.vault.credentials[0].passwordHistory![0].password,'current-password');
  assert.ok(session.vault.credentials[0].recoveryCodes!.every(code=>code.usedAt===2));
  const plain=exportKeyPilotCredentialsJson(session.vault.credentials);
  assert.ok(!plain.includes('passwordHistory') && !plain.includes('recoveryCodes'));
});

test('recovery codes deduplicate and keep used states, histories and links through complete encrypted restoration',async()=>{
  const first=await createVaultSession(master);const source=completeBackupFixture();
  source.credentials[0]=appendRecoveryCodes(source.credentials[0],'BACKUP-ONE\nBACKUP-TWO\nBACKUP-ONE');
  source.credentials[0].recoveryCodes![0].usedAt=123;
  source.credentials[0].passwordHistory=[{id:'history-1',password:'Previous-only!42',changedAt:1}];
  source.totpAccounts![0].credentialId=source.credentials[0].id;
  assert.equal(source.credentials[0].recoveryCodes!.length,2);
  assert.throws(()=>appendRecoveryCodes(source.credentials[0],'x'.repeat(257)));
  const session=await persistVaultSession(first,{...source,saveInboxKeyPair:first.vault.saveInboxKeyPair});
  const backup=await prepareEncryptedBackup(session),serialized=JSON.stringify(backup.encryptedVault);
  for(const secret of ['BACKUP-ONE','BACKUP-TWO','Previous-only!42',source.totpAccounts![0].secret])assert.ok(!serialized.includes(secret));
  await clearVaultSessionCache();await chrome.storage.local.remove(VAULT_STORAGE_KEY);
  const restored=await initializeVaultFromBackup(await previewBackup(new File([serialized],'test.json'),master));
  assert.deepEqual(restored.vault.credentials,backup.vault.credentials);assert.deepEqual(restored.vault.totpAccounts,backup.vault.totpAccounts);
  assert.equal(vaultItemCount(restored.vault),5);
  assert.equal(vaultItemCount({...restored.vault,totpAccounts:restored.vault.totpAccounts!.map(item=>({...item,deletedAt:1}))}),4);
});

test('backup conflicts offer keep, replace and both without mislinking imported 2FA after ID changes',()=>{
  const incoming=completeBackupFixture();incoming.totpAccounts![0].credentialId=incoming.credentials[0].id;
  incoming.credentials[0].passwordHistory=[{id:'backup-history',password:'Backup-old-password',changedAt:1}];
  const current=structuredClone(incoming);current.totpAccounts=[];current.credentials[0].password='Current-password';
  const conflict=backupMergeConflicts(current,incoming)[0];
  const kept=mergeBackup(current,incoming,{}, {[conflict.key]:'current'});
  assert.equal(kept.credentials.length,1);assert.equal(kept.credentials[0].password,'Current-password');assert.equal(kept.totpAccounts![0].credentialId,kept.credentials[0].id);
  const replaced=mergeBackup(current,incoming,{}, {[conflict.key]:'incoming'});
  assert.equal(replaced.credentials.length,1);assert.equal(replaced.credentials[0].password,incoming.credentials[0].password);assert.equal(replaced.credentials[0].passwordHistory![0].password,'Current-password');
  assert.equal(replaced.credentials[0].passwordHistory![1].password,'Backup-old-password');
  assert.equal(backupMergeSummary(current,incoming,{[conflict.key]:'incoming'})[0].added,0);
  const both=mergeBackup(current,incoming);
  assert.equal(both.credentials.length,2);assert.notEqual(both.credentials[1].id,current.credentials[0].id);assert.equal(both.totpAccounts![0].credentialId,both.credentials[1].id);
  const remapped=structuredClone(current);remapped.credentials[0]={...incoming.credentials[0],id:'different-current-id'};
  assert.equal(mergeBackup(remapped,incoming).totpAccounts![0].credentialId,'different-current-id');
  const orphan=completeBackupFixture();orphan.totpAccounts![0].credentialId=current.credentials[0].id;orphan.credentials=[];
  assert.equal(mergeBackup(current,orphan).totpAccounts![0].credentialId,undefined);
});

test('standard 2FA export preserves algorithm, digits, period and Unicode labels and creates a local PNG',async()=>{
  for(const algorithm of ['SHA1','SHA256','SHA512'] as const){
    const item={...completeBackupFixture().totpAccounts![0],issuer:'测试 & Example',account:'name+test@example.test',algorithm,digits:8 as const,period:60};
    const uri=totpSetupUri(item),parsed=parseTotpInput(uri);
    assert.equal(parsed.issuer,item.issuer);assert.equal(parsed.account,item.account);assert.equal(parsed.period,60);assert.equal(parsed.algorithm,algorithm);
    assert.equal(await generateTotp(parsed,59000),await generateTotp(item,59000));
    assert.match(await totpQrDataUrl(uri),/^data:image\/png;base64,/);
  }
});

test('merged 2FA follows a trashed login through collisions and later restoration',()=>{
  const source=completeBackupFixture();source.deletedItems=[];source.totpAccounts![0].credentialId=source.credentials[0].id;
  const incoming=deleteCredentialFromVault(source,source.credentials[0].id);
  const current=createEmptyVault();current.credentials=[{...source.credentials[0],password:'Unrelated-current'}];
  const merged=mergeBackup(current,incoming),trash=merged.deletedItems![0];
  assert.equal(trash.kind,'credential');if(trash.kind!=='credential')return;
  assert.notEqual(trash.item.id,current.credentials[0].id);assert.equal(merged.totpAccounts![0].credentialId,trash.item.id);
  const restored=restoreDeletedItemToVault(merged,trash.id);
  assert.equal(restored.credentials.find(item=>item.id===restored.totpAccounts![0].credentialId)!.password,source.credentials[0].password);
});

test('malformed history, recovery code and binding fields are rejected before backup restore',async()=>{
  const vault=completeBackupFixture();vault.credentials[0].recoveryCodes=[{id:'bad',code:'',createdAt:1}];assert.throws(()=>validateBackup(vault));
  delete vault.credentials[0].recoveryCodes;vault.credentials[0].passwordHistory=[{id:'bad',password:4 as never,changedAt:1}];assert.throws(()=>validateBackup(vault));
  delete vault.credentials[0].passwordHistory;vault.totpAccounts![0].credentialId=42 as never;assert.throws(()=>validateBackup(vault));assert.equal(await getEncryptedVault(),null);
});
