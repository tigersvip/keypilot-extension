import { t } from './i18n';
import { useEffect, useRef, useState } from 'react';
import { Copy, Eye, EyeOff, FileInput } from 'lucide-react';
import { copyProtectedText } from './clipboard';
import { authorizeSensitiveAction, useSecretVisibility } from './sensitiveActions';
import { generateTotp, totpSecondsRemaining } from './totp';
import { assertVaultSession, restoreCachedVaultSession } from './vault';
import { credentialMatchesUrl } from './domain';
import type { TotpAccount } from './types';
import './credential-security.css';

const fillErrors: Record<string,string> = {
  VAULT_LOCKED:t("密码库已锁定或账号已更新，请重新打开后操作。"),
  OTP_NOT_LINKED:t("请先将验证码关联到登录账号。"),OTP_SITE_MISMATCH:t("此页面与绑定的登录网站不匹配。"),
  OTP_NOT_FOUND:t("未找到验证码输入框，请先打开网站的两步验证页面。"),
  OTP_AMBIGUOUS:t("找到多个验证码输入框，请在网页中点击需要填写的输入框后重试。"),
  OTP_NOT_EMPTY:t("输入框已有其他内容，请先清空后重试。"),
  OTP_EXPIRING:t("验证码即将过期，请等待下一组后再填写。"),OTP_EXPIRED:t("验证码已临近过期，请重试。")
};

export function TotpAccountRow({item,now,requireVerification,onEdit,onRemove,linkedName}: {
  item:TotpAccount;now:number;requireVerification:boolean;onEdit?:()=>void;onRemove?:()=>void;linkedName?:string;
}) {
  const [visible,setVisible]=useSecretVisibility();
  const [generated,setGenerated]=useState<{step:number;value:string}>();
  const [message,setMessage]=useState(''), [busy,setBusy]=useState(false);
  const [exported,setExported]=useState<{uri:string;image:string}>();
  const [tabs,setTabs]=useState<chrome.tabs.Tab[]>();
  const [tabId,setTabId]=useState('');
  const exportDialog=useRef<HTMLDialogElement>(null), fillDialog=useRef<HTMLDialogElement>(null), alive=useRef(true);
  const allowed=!requireVerification || visible, step=Math.floor(now/1000/item.period), remaining=totpSecondsRemaining(item.period,now);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  useEffect(()=>{
    if (!allowed) {setGenerated(undefined);return;}
    let canceled=false;
    void generateTotp(item,step*item.period*1000).then(value=>{if(!canceled)setGenerated({step,value});}).catch(()=>{if(!canceled)setMessage(t("无法生成验证码，请检查配置。"));});
    return()=>{canceled=true;};
  },[allowed,step,item.secret,item.algorithm,item.digits,item.period]);
  useEffect(()=>{setMessage('');},[step]);
  useEffect(()=>{
    if (!exported) return;
    exportDialog.current?.showModal();
    const hide=()=>{if(document.hidden)setExported(undefined);};
    const timer=window.setTimeout(()=>setExported(undefined),30000);
    document.addEventListener('visibilitychange',hide);
    return()=>{clearTimeout(timer);document.removeEventListener('visibilitychange',hide);};
  },[exported]);
  useEffect(()=>{if(tabs)fillDialog.current?.showModal();},[tabs]);
  async function currentAccount() {
    const session=await restoreCachedVaultSession();
    const record=session?.vault.totpAccounts?.find(other=>other.id===item.id && !other.deletedAt);
    if (!session || !record) throw new Error('VAULT_LOCKED');
    return {session,record};
  }
  async function run(action:()=>Promise<void>) {
    if(busy)return;setBusy(true);setMessage('');
    try{await action();}catch(error){if(alive.current)setMessage(fillErrors[error instanceof Error?error.message:''] ?? (error instanceof Error && !/^[A-Z_]+$/.test(error.message)?error.message:t("操作失败，请刷新后重试。")));}
    finally{if(alive.current)setBusy(false);}
  }
  const code=allowed && generated?.step===step?generated.value:'';
  async function exportAccount() {
    if(!await authorizeSensitiveAction(true) || !alive.current)return;
    const {session,record}=await currentAccount();
    const {totpSetupUri,totpQrDataUrl}=await import('./totpExport');
    const uri=totpSetupUri(record), image=await totpQrDataUrl(uri);
    await assertVaultSession(session);
    if(alive.current)setExported({uri,image});
  }
  async function choosePage() {
    const {record,session}=await currentAccount();
    const credential=session.vault.credentials.find(value=>value.id===record.credentialId);
    if(!credential)throw new Error('OTP_NOT_LINKED');
    const available=(await chrome.tabs.query({currentWindow:true})).filter(tab=>tab.id && tab.url && credentialMatchesUrl(credential,tab.url) && !(new URL(credential.url).protocol==='https:' && new URL(tab.url).protocol!=='https:'));
    if(!available.length)throw new Error(t("请先打开绑定账号的网站，再进入验证码页面。"));
    if(alive.current){setTabs(available);setTabId(String(available.find(tab=>tab.active)?.id ?? available[0].id));}
  }
  async function fill() {
    if(!await authorizeSensitiveAction() || !alive.current)return;
    const {session}=await currentAccount();
    const response=await chrome.runtime.sendMessage({type:'KEYPILOT_FILL_TOTP',accountId:item.id,tabId:Number(tabId),sessionId:session.sessionId});
    if(!response?.ok)throw new Error(response?.error ?? 'OTP_NOT_FOUND');
    if(alive.current){setTabs(undefined);setMessage(t("验证码已填写。"));}
  }
  return <article className="kp-totp-row" aria-label={`${item.issuer} ${item.account}`}>
    <div className="kp-totp-name"><strong title={item.issuer || item.account}>{item.issuer || item.account}</strong>{item.issuer && <span title={item.account}>{item.account}</span>}{linkedName && <small>{t("关联：")}{linkedName}</small>}</div>
    <div className="kp-totp-code"><output aria-label={t("动态验证码")}>{allowed ? code ? code.replace(/(.{3,4})(?=.{3,4}$)/,'$1 ') : t("正在刷新…") : '••• •••'}</output><span className={remaining<=5?'expiring':''}>{remaining}{t(" 秒后刷新")}</span></div>
    <div className="kp-totp-actions">
      {requireVerification && <button type="button" aria-label={visible?t("隐藏验证码"):t("查看验证码")} onClick={()=>setVisible(!visible)}>{visible?<EyeOff size={18}/>:<Eye size={18}/>}</button>}
      <button type="button" aria-label={t("复制验证码")} disabled={busy} onClick={()=>void run(async()=>{if(await copyProtectedText(async()=>generateTotp((await currentAccount()).record)) && alive.current)setMessage(t("已复制验证码"));})}><Copy size={18}/></button>
      {item.credentialId && <button type="button" aria-label={t("填写验证码")} title={t("填写验证码")} disabled={busy} onClick={()=>void run(choosePage)}><FileInput size={18}/></button>}
      <details className="kp-totp-more"><summary aria-label={t("更多验证码操作")}>{t("更多")}</summary><div>
        {onEdit && <button type="button" aria-label={t("编辑身份验证器")} onClick={onEdit}>{t("编辑与关联")}</button>}
        <button type="button" disabled={busy} onClick={()=>void run(exportAccount)}>{t("导出二维码 / 链接")}</button>
        {onRemove && <button type="button" aria-label={t("移除身份验证器")} onClick={onRemove}>{t("移除")}</button>}
      </div></details>
    </div>
    {message && !tabs && <p role="status">{message}</p>}
    {exported && <dialog className="kp-security-dialog" ref={exportDialog} aria-label={t("导出身份验证器")} onCancel={()=>setExported(undefined)}>
      <h3>{t("导出身份验证器")}</h3><p>{item.issuer} · {item.account}</p><p>{t("二维码和设置链接包含 2FA 密钥，请只交给你自己的验证器。30 秒后自动关闭。")}</p>
      <img className="kp-totp-export-qr" src={exported.image} alt={t("身份验证器设置二维码")}/>
      <label>{t("标准设置链接")}<textarea readOnly value={exported.uri} rows={3}/></label>
      <p>{t("目标验证器需要支持该算法、位数和周期，导入后请核对验证码。")}</p>
      <footer><button type="button" onClick={()=>setExported(undefined)}>{t("关闭")}</button><button type="button" onClick={()=>void run(async()=>{if(await copyProtectedText(exported.uri))setMessage(t("已复制设置链接"));})}>{t("复制设置链接")}</button>
        <button type="button" onClick={()=>{const link=document.createElement('a');link.href=exported.image;link.download='keypilot-authenticator.png';link.click();}}>{t("下载二维码")}</button></footer>
      {message && <p role="status">{message}</p>}
    </dialog>}
    {tabs && <dialog className="kp-security-dialog" ref={fillDialog} aria-label={t("填写动态验证码")} onCancel={()=>setTabs(undefined)}>
      <h3>{t("填写动态验证码")}</h3><p>{item.issuer} · {item.account}</p>
      <label>{t("目标网页")}<select value={tabId} onChange={event=>setTabId(event.target.value)}>{tabs.map(tab=><option key={tab.id} value={tab.id}>{tab.title || tab.url} · {new URL(tab.url!).hostname}</option>)}</select></label>
      <p>{t("只填写验证码；插件不会点击提交按钮。")}</p>
      {message && <p role="status">{message}</p>}
      <footer><button type="button" disabled={busy} onClick={()=>setTabs(undefined)}>{t("取消")}</button><button type="button" className="primary" disabled={busy} onClick={()=>void run(fill)}>{t("填写到此页面")}</button></footer>
    </dialog>}
  </article>;
}
