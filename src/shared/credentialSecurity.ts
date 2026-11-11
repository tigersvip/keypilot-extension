import type { Credential, VaultPlain } from './types';

export const PASSWORD_HISTORY_LIMIT = 10;
export function rememberPreviousPassword(current: Credential, next: Credential): Credential {
  if (current.password === next.password || !current.password) return next;
  const history=[...(next.passwordHistory ?? []),...(current.passwordHistory ?? [])];
  return {...next,formFields:next.formFields?.map(field=>field.kind==='password'?{...field,value:next.password}:field),passwordHistory:[
    {id:crypto.randomUUID(),password:current.password,changedAt:Date.now()},
    ...history.filter((entry,index)=>history.findIndex(other=>other.id===entry.id)===index)
  ].slice(0,PASSWORD_HISTORY_LIMIT)};
}

export function capturePasswordChanges(current: VaultPlain, next: VaultPlain): VaultPlain {
  const previous = new Map(current.credentials.map(item=>[item.id,item]));
  return {...next,credentials:next.credentials.map(item=>{
    const old = previous.get(item.id);
    // updateCredentialInVault may already have captured this exact transition.
    if (!old || (item.passwordHistory?.[0]?.password === old.password && item.passwordHistory[0].id !== old.passwordHistory?.[0]?.id)) return item;
    return rememberPreviousPassword(old,item);
  })};
}

export function appendRecoveryCodes(credential: Credential, input: string): Credential {
  const lines = input.split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
  if (!lines.length) throw new Error('请每行输入一个网站恢复码。');
  if (lines.some(line=>line.length>256) || lines.length>100) throw new Error('一次最多添加 100 个恢复码，每个最多 256 个字符。');
  const codes = [...(credential.recoveryCodes ?? [])];
  for (const code of lines) if (!codes.some(item=>item.code===code)) codes.push({id:crypto.randomUUID(),code,createdAt:Date.now()});
  if (codes.length>100) throw new Error('每个账号最多保存 100 个恢复码。');
  return {...credential,recoveryCodes:codes,updatedAt:Date.now()};
}

export function vaultItemCount(vault: VaultPlain): number {
  return vault.credentials.length+(vault.totpAccounts?.filter(item=>!item.deletedAt).length ?? 0)+
    (vault.secureNotes?.length ?? 0)+(vault.identities?.length ?? 0)+(vault.fillProfiles?.length ?? 0)+(vault.reminders?.length ?? 0);
}
