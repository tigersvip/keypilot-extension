import { backupCollections } from './backupInventory';
import { mergeBackupSettings, stableBackupJson, type BackupSettingsSelection } from './backupSettings';
import { totpFingerprint } from './totpImport';
import { rememberPreviousPassword } from './credentialSecurity';
import type { Credential, TotpAccount, VaultPlain } from './types';

type Collection = typeof backupCollections[number]['key'];
type RecordItem = NonNullable<VaultPlain[Collection]>[number];
export type BackupConflictChoice = 'current' | 'incoming' | 'both';
export type BackupConflictChoices = Record<string, BackupConflictChoice>;
export interface BackupConflict { key:string;collection:Collection;label:string;incoming:string;current:string;choice:BackupConflictChoice }
function signature(key:Collection,item:RecordItem) {
  if(key==='totpAccounts')return `${'deletedAt' in item && item.deletedAt?'removed':'active'}:${totpFingerprint(item as TotpAccount)}`;
  return stableBackupJson(Object.fromEntries(Object.entries(item).filter(([name])=>!['id','createdAt','updatedAt','lastUsedAt'].includes(name))));
}
function identity(item:RecordItem) {
  return 'username' in item?`${item.domain.toLowerCase()}:${item.username}`:'secret' in item?`${item.deletedAt?'removed':'active'}:${item.issuer}:${item.account}`:undefined;
}
function describe(item:RecordItem):string {
  if('username' in item)return `${item.title} · ${item.username} · ${item.domain}`;
  if('secret' in item)return `${item.issuer} · ${item.account}`;
  if('item' in item)return item.item.title;
  return 'title' in item?item.title:item.name;
}

function plan(current:VaultPlain,incoming:VaultPlain,selected:BackupSettingsSelection,choices:BackupConflictChoices,allocateIds:boolean) {
  const vault={...current,settings:mergeBackupSettings(current.settings,incoming.settings,selected)};
  const conflicts:BackupConflict[]=[];
  const credentialIds=new Map<string,string>();
  const totpIds=new Map<string,string>();
  const occupiedCredentialIds=new Set([...current.credentials.map(item=>item.id),...(current.deletedItems ?? []).flatMap(item=>item.kind==='credential'?[item.item.id]:[])]);
  function mapCredential(source:RecordItem,target:RecordItem) {
    if('secret' in source && 'secret' in target)totpIds.set(source.id,target.id);
    if('username' in source && 'username' in target)credentialIds.set(source.id,target.id);
    if('kind' in source && source.kind==='credential' && 'kind' in target && target.kind==='credential' && !credentialIds.has(source.item.id))credentialIds.set(source.item.id,target.item.id);
  }
  const acceptedTotp=new Set<string>();
  const acceptedReminders=new Set<string>();
  const summary=backupCollections.map(({key,label})=>{
    const values=new Map<string,RecordItem>((current[key] ?? []).map(item=>[item.id,item]));
    const fingerprints=new Map<string,string>(), identities=new Map<string,Set<string>>();
    function index(item:RecordItem) { fingerprints.set(signature(key,item),item.id);const logical=identity(item);if(logical){const ids=identities.get(logical) ?? new Set<string>();ids.add(item.id);identities.set(logical,ids);} }
    function removeIndex(item:RecordItem) { for(const [hash,id] of fingerprints)if(id===item.id)fingerprints.delete(hash);const logical=identity(item);if(logical)identities.get(logical)?.delete(item.id); }
    values.forEach(index);
    let added=0,duplicates=0,conflictCount=0;
    for(const item of incoming[key] ?? []) {
      const duplicateId=fingerprints.get(signature(key,item));
      if(duplicateId){duplicates++;mapCredential(item,values.get(duplicateId)!);continue;}
      const logical=identity(item), matchingId=logical?identities.get(logical)?.values().next().value:undefined;
      const target=values.get(item.id) ?? (matchingId?values.get(matchingId):undefined);
      const choiceKey=JSON.stringify([key,item.id]), choice=choices[choiceKey] ?? 'both';
      if(!['current','incoming','both'].includes(choice))throw new Error('备份冲突选项无效，请重新预览。');
      if(target){conflictCount++;conflicts.push({key:choiceKey,collection:key,label,incoming:describe(item),current:describe(target),choice});}
      if(target && choice==='current'){mapCredential(item,target);continue;}
      let id=target && choice==='incoming'?target.id:item.id;
      if(!(target && choice==='incoming') && (values.has(id) || key==='credentials' && occupiedCredentialIds.has(id))) {
        id=allocateIds?crypto.randomUUID():`backup-preview-${key}-${item.id}`;
        while(values.has(id))id+='-copy';
      }
      let next:RecordItem={...item,id};
      if('kind' in next && next.kind==='credential') {
        let nestedId=target && choice==='incoming' && 'kind' in target && target.kind==='credential'?target.item.id:next.item.id;
        if(!(target && choice==='incoming') && occupiedCredentialIds.has(nestedId)) {
          nestedId=allocateIds?crypto.randomUUID():`backup-preview-deleted-login-${next.id}`;
          while(occupiedCredentialIds.has(nestedId))nestedId+='-copy';
        }
        next={...next,item:{...next.item,id:nestedId}};
        occupiedCredentialIds.add(nestedId);
      }
      if(target && choice==='incoming') {
        removeIndex(target);
        if(key==='credentials' && allocateIds)next=rememberPreviousPassword(target as Credential,next as Credential);
      } else added++;
      values.set(id,next);index(next);
      fingerprints.set(signature(key,item),id);
      mapCredential(item,next);
      if(key==='credentials')occupiedCredentialIds.add(id);
      if(key==='totpAccounts')acceptedTotp.add(id);
      if(key==='reminders')acceptedReminders.add(id);
    }
    (vault as unknown as Record<string,unknown>)[key]=[...values.values()];
    return {key,label,added,duplicates,conflicts:conflictCount};
  });
  // Backup-side associations must follow the chosen/renamed credential, never an unrelated ID collision.
  vault.totpAccounts=vault.totpAccounts?.map(item=>acceptedTotp.has(item.id) && item.credentialId
    ? {...item,credentialId:credentialIds.get(item.credentialId)} : item);
  vault.reminders=vault.reminders?.map(item=>acceptedReminders.has(item.id) && item.credentialId
    ? {...item,credentialId:credentialIds.get(item.credentialId)} : item);
  if(selected.siteRules && vault.settings.siteLoginSettings){
    vault.settings.siteLoginSettings=Object.fromEntries(Object.entries(vault.settings.siteLoginSettings).map(([origin,rule])=>{
      const next={...rule};
      if(rule.defaultCredentialId){
        const id=credentialIds.get(rule.defaultCredentialId);
        if(id)next.defaultCredentialId=id;else delete next.defaultCredentialId;
      }
      if(rule.totpAccountByCredential)next.totpAccountByCredential=Object.fromEntries(Object.entries(rule.totpAccountByCredential).flatMap(([credentialId,accountId])=>{
        const cid=credentialIds.get(credentialId),aid=totpIds.get(accountId);
        return cid && aid && vault.totpAccounts?.some(item=>item.id===aid && !item.deletedAt && item.credentialId===cid)?[[cid,aid]]:[];
      }));
      return [origin,next];
    }));
  }
  return {vault,summary,conflicts};
}
export function backupMergeSummary(current:VaultPlain,incoming:VaultPlain,choices:BackupConflictChoices={}) {return plan(current,incoming,{},choices,false).summary;}
export function backupMergeConflicts(current:VaultPlain,incoming:VaultPlain,choices:BackupConflictChoices={}) {return plan(current,incoming,{},choices,false).conflicts;}
export function mergeBackup(current:VaultPlain,incoming:VaultPlain,selected:BackupSettingsSelection={},choices:BackupConflictChoices={}) {return plan(current,incoming,selected,choices,true).vault;}
