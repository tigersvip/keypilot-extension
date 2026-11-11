import { t, getLanguage } from './i18n';
import { SiteLoginSettingsPanel } from './SiteLoginSettingsPanel';
import { useRef, useEffect, useState } from 'react';
import { TotpAccountRow } from './TotpAccountRow';
import { useTotpClock } from './useTotpClock';
import { authorizeSensitiveAction, useSecretVisibility } from './sensitiveActions';
import { appendRecoveryCodes } from './credentialSecurity';
import { persistVaultSession, restoreCachedVaultSession, updateCredentialInVault } from './vault';
import { copyProtectedText } from './clipboard';
import type { Credential, UnlockedVaultSession } from './types';
import './authenticator.css';
import './credential-security.css';

export function CredentialSecurityPanel({credential,session,onChange}: {credential:Credential;session:UnlockedVaultSession;onChange:(value:UnlockedVaultSession)=>void}) {
  const now=useTotpClock(), alive=useRef(true);
  const [message,setMessage]=useState(''),[busy,setBusy]=useState(false),[link,setLink]=useState(''),[draft,setDraft]=useState(''),[adding,setAdding]=useState(false);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  const associated=(session.vault.totpAccounts ?? []).filter(item=>!item.deletedAt && item.credentialId===credential.id);
  const available=(session.vault.totpAccounts ?? []).filter(item=>!item.deletedAt && !item.credentialId);
  async function current() {
    const fresh=await restoreCachedVaultSession();
    const record=fresh?.vault.credentials.find(item=>item.id===credential.id);
    if(!fresh || !record || fresh.sessionId!==session.sessionId)throw new Error(t("密码库已锁定或账号已移除，请刷新后重试。"));
    return {fresh,record};
  }
  async function run(action:()=>Promise<void>) {
    if(busy)return;setBusy(true);setMessage('');
    try{await action();}catch(error){if(alive.current)setMessage(error instanceof Error && !/VAULT_/.test(error.message)?error.message:t("保存失败，密码库可能已锁定或记录已被修改。"));}
    finally{if(alive.current)setBusy(false);}
  }
  async function update(transform:(record:Credential)=>Credential) {
    if(!await authorizeSensitiveAction() || !alive.current)return false;
    const {fresh,record}=await current();
    const next=await persistVaultSession(fresh,updateCredentialInVault(fresh.vault,transform(record)));
    if(alive.current){onChange(next);setMessage(t("已保存。"));}return true;
  }
  async function bind(accountId:string,remove=false) {
    if(!await authorizeSensitiveAction() || !alive.current)return;
    const {fresh}=await current();
    const account=fresh.vault.totpAccounts?.find(item=>item.id===accountId && !item.deletedAt);
    if(!account || (account.credentialId && account.credentialId!==credential.id))throw new Error(t("此验证码已关联其他账号，请在身份验证器中编辑关联。"));
    const next=await persistVaultSession(fresh,{...fresh.vault,totpAccounts:fresh.vault.totpAccounts!.map(item=>item.id===accountId?{...item,credentialId:remove?undefined:credential.id,updatedAt:Date.now()}:item)});
    if(alive.current){onChange(next);setLink('');setMessage(remove?t("已解除关联，验证码仍保留在身份验证器中。"):t("验证码已关联。"));}
  }
  async function copyValue(kind:'history'|'recovery',id:string) {
    if(await copyProtectedText(async()=>{
      const {record}=await current();
      const value=kind==='history'?record.passwordHistory?.find(item=>item.id===id)?.password:record.recoveryCodes?.find(item=>item.id===id)?.code;
      if(!value)throw new Error(t("记录已更新，请重新打开。"));return value;
    }) && alive.current)setMessage(t("已复制。"));
  }
  return <section className="kp-credential-security" aria-label={t("账号验证与恢复")}>
    <h3>{t("动态验证码")}</h3>
    {associated.map(item=><TotpAccountRow key={item.id} item={item} now={now} requireVerification={session.vault.settings.requireMasterPasswordForReveal}/>)}
    {!associated.length && <p>{t("尚未关联验证码。可在身份验证器中添加，或关联已有验证码。")}</p>}
    {(associated.length > 0 || available.length > 0) && <details className="kp-totp-association" open={associated.length === 0 ? true : undefined}>
      <summary>{t("管理验证码关联")}</summary>
      {associated.map(item=><div className="kp-association-row" key={item.id}><span>{item.issuer || item.account}</span><button className="kp-security-subtle" type="button" disabled={busy} onClick={()=>void run(()=>bind(item.id,true))}>{t("解除关联")}</button></div>)}
      {available.length>0 && <div className="kp-security-link"><label>{t("选择已有验证码")}<select value={link} onChange={event=>setLink(event.target.value)}><option value="">{t("请选择")}</option>{available.map(item=><option key={item.id} value={item.id}>{item.issuer} · {item.account}</option>)}</select></label><button type="button" disabled={!link || busy} onClick={()=>void run(()=>bind(link))}>{t("关联验证码")}</button></div>}
    </details>}
    <SiteLoginSettingsPanel credential={credential} session={session} onChange={onChange}/>
    <details><summary>{t("密码历史（")}{credential.passwordHistory?.length ?? 0}）</summary><p>{t("保留最近 10 次旧密码。恢复仅修改密码库记录，网站密码需在网站修改。")}</p>
      {(credential.passwordHistory ?? []).map(item=><SecretRecord key={item.id} value={item.password} label={new Date(item.changedAt).toLocaleString(getLanguage())} onCopy={()=>void run(()=>copyValue('history',item.id))} actions={<button type="button" disabled={busy} onClick={()=>void run(async()=>{
        if(!window.confirm(t("将这条旧密码恢复为本账号保存的密码？当前密码会进入历史，网站密码不会改变。")))return;
        await update(record=>{const old=record.passwordHistory?.find(entry=>entry.id===item.id);if(!old)throw new Error(t("历史记录已更新，请重试。"));return {...record,password:old.password};});
      })}>{t("恢复此密码")}</button>}/>)}
      {!credential.passwordHistory?.length && <p>{t("修改密码后会自动保留旧密码。")}</p>}
    </details>
    <details><summary>{t("网站恢复码（")}{credential.recoveryCodes?.filter(item=>!item.usedAt).length ?? 0}{t(" 个未使用）")}</summary><p>{t("保存网站提供的一次性备用码；与 KeyPilot 主密码恢复码分开管理。")}</p>
      {(credential.recoveryCodes ?? []).map(item=><SecretRecord key={item.id} value={item.code} label={item.usedAt?t("已使用"):t("未使用")} onCopy={()=>void run(()=>copyValue('recovery',item.id))} actions={<>
        <button type="button" disabled={busy} onClick={()=>void run(async()=>{await update(record=>({...record,recoveryCodes:record.recoveryCodes?.map(code=>code.id===item.id?{...code,usedAt:code.usedAt?undefined:Date.now()}:code)}));})}>{item.usedAt?t("标记未使用"):t("标记已使用")}</button>
        <button type="button" disabled={busy} onClick={()=>void run(async()=>{if(window.confirm(t("删除这条网站恢复码？")))await update(record=>({...record,recoveryCodes:record.recoveryCodes?.filter(code=>code.id!==item.id)}));})}>{t("删除恢复码")}</button>
      </>}/>)}
      {adding ? <div className="kp-recovery-editor"><label>{t("网站恢复码，每行一个")}<textarea value={draft} maxLength={25700} rows={5} spellCheck={false} autoComplete="off" onChange={event=>setDraft(event.target.value)}/></label><div className="kp-security-actions"><button type="button" disabled={busy} onClick={()=>{setAdding(false);setDraft('');}}>{t("取消")}</button><button type="button" disabled={busy || !draft.trim()} onClick={()=>void run(async()=>{if(await update(record=>appendRecoveryCodes(record,draft)) && alive.current){setDraft('');setAdding(false);}})}>{t("保存恢复码")}</button></div></div>
        : <button type="button" disabled={busy} onClick={()=>void run(async()=>{if(await authorizeSensitiveAction() && alive.current)setAdding(true);})}>{t("添加网站恢复码")}</button>}
    </details>
    {message && <p role="status">{message}</p>}
  </section>;
}

function SecretRecord({value,label,onCopy,actions}: {value:string;label:string;onCopy:()=>void;actions:React.ReactNode}) {
  const [visible,setVisible]=useSecretVisibility();
  return <div className="kp-secret-record"><span>{label}</span><output>{visible?value:'••••••••'}</output><div className="kp-security-actions"><button type="button" aria-label={visible?t("隐藏此记录"):t("查看此记录")} onClick={()=>setVisible(!visible)}>{visible?t("隐藏"):t("查看")}</button><button type="button" onClick={onCopy}>{t("复制")}</button>{actions}</div></div>;
}
