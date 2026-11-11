import { useRef, useEffect, useState, memo } from 'react';
import { persistVaultSession, restoreCachedVaultSession } from './vault';
import { siteLoginSettings } from './loginSettings';
import type { Credential, UnlockedVaultSession, VaultSettings } from './types';

export const SiteLoginSettingsPanel=memo(function SiteLoginSettingsPanel({credential,session,onChange}:{credential:Credential;session:UnlockedVaultSession;onChange:(session:UnlockedVaultSession)=>void}){
  const [busy,setBusy]=useState(false),[message,setMessage]=useState('');
  const alive=useRef(true),saving=useRef(false);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  const origin=(()=>{try{const url=new URL(credential.url);return /^https?:$/.test(url.protocol)?url.origin:'';}catch{return '';}})();
  if(!origin)return null;
  const settings=session.vault.settings,rule=siteLoginSettings(settings,origin);
  const accounts=session.vault.totpAccounts?.filter(item=>!item.deletedAt && item.credentialId===credential.id)??[];
  const credentials=session.vault.credentials.filter(item=>{try{return new URL(item.url).origin===origin;}catch{return false;}});
  const chosen=rule.totpAccountByCredential?.[credential.id]??'';
  const autoTotp=settings.autoTotpOrigins?.includes(origin)??false;
  async function save(change:(settings:VaultSettings)=>VaultSettings){
    if(saving.current)return;saving.current=true;setBusy(true);setMessage('');
    try{
      const fresh=await restoreCachedVaultSession();
      if(!fresh || fresh.sessionId!==session.sessionId || fresh.vault.credentials.find(item=>item.id===credential.id)?.url!==credential.url)throw new Error('账号或密码库状态已变化，请重新打开。');
      const next=await persistVaultSession(fresh,{...fresh.vault,settings:change(fresh.vault.settings)});
      if(alive.current){onChange(next);setMessage('已保存网站偏好，实际状态见各项说明。');}
    }catch(error){if(alive.current)setMessage(error instanceof Error && !error.message.startsWith('VAULT_')?error.message:'保存失败，请解锁密码库后重试。');}
    finally{saving.current=false;if(alive.current)setBusy(false);}
  }
  function patch(change:Partial<typeof rule>){void save(current=>({...current,siteLoginSettings:{...current.siteLoginSettings,[origin]:{...siteLoginSettings(current,origin),...change}}}));}
  const fillEnabled=rule.fillEnabled!==false;
  const submitEnabled=rule.autoSubmit!==false;
  const captchaEnabled=!settings.captchaSiteRules?.[origin]?.disabled;
  const submitStatus=!submitEnabled?'此网站已关闭':!fillEnabled?'需先允许网页填写':!settings.autoSubmit?'总开关已关闭':'已开启';
  const captchaStatus=!captchaEnabled?'此网站已关闭':!settings.captchaAssistEnabled?'总开关已关闭':'已开启';
  const totpStatus=!accounts.length?'未关联验证码':!autoTotp?'此网站已关闭':!fillEnabled?'需先允许网页填写':!submitEnabled?'需先开启自动点击登录':!settings.autoSubmit?'总开关已关闭':(chosen?!accounts.some(item=>item.id===chosen):accounts.length>1)?'请选择默认验证码':'已开启';
  return <details className="kp-site-settings">
    <summary>此网站设置</summary>
    <p className="kp-site-origin">{origin}</p>
    <label className="kp-site-toggle"><span>允许网页填写账号密码<small>{fillEnabled?'已允许':'此网站已关闭'}</small></span><input aria-label="允许网页填写账号密码" type="checkbox" role="switch" checked={fillEnabled} disabled={busy} onChange={event=>patch({fillEnabled:event.target.checked})}/></label>
    <label className="kp-site-toggle"><span>一键登录时自动点击登录<small className={submitEnabled && submitStatus!=='已开启'?'is-blocked':''}>{submitStatus}</small></span><input aria-label="一键登录时自动点击登录" type="checkbox" role="switch" checked={submitEnabled} disabled={busy} onChange={event=>patch({autoSubmit:event.target.checked})}/></label>
    <label className="kp-site-toggle"><span>图片验证码识别<small className={captchaEnabled && captchaStatus!=='已开启'?'is-blocked':''}>{captchaStatus}</small></span><input aria-label="图片验证码识别" type="checkbox" role="switch" checked={captchaEnabled} disabled={busy} onChange={event=>{const enabled=event.target.checked;void save(current=>({...current,captchaSiteRules:{...current.captchaSiteRules,[origin]:{mode:'auto',...current.captchaSiteRules?.[origin],disabled:!enabled}}}));}}/></label>
    <label>网站首选账号<select aria-label="网站首选账号" disabled={busy} value={credentials.some(item=>item.id===rule.defaultCredentialId)?rule.defaultCredentialId:''} onChange={event=>{const id=event.target.value;void save(current=>{const next={...siteLoginSettings(current,origin)};if(id)next.defaultCredentialId=id;else delete next.defaultCredentialId;return {...current,siteLoginSettings:{...current.siteLoginSettings,[origin]:next}};});}}>
      <option value="">按原有顺序排列</option>{credentials.map(item=><option key={item.id} value={item.id}>{item.title} · {item.username}</option>)}
    </select></label>
    {origin.startsWith('https:') && <>
      <label className="kp-site-toggle"><span>一键登录后自动填写动态验证码<small className={autoTotp && totpStatus!=='已开启'?'is-blocked':''}>{totpStatus}</small></span><input aria-label="一键登录后自动填写动态验证码" type="checkbox" role="switch" checked={autoTotp} disabled={busy || (!autoTotp && !accounts.length)} onChange={event=>{const enabled=event.target.checked;void save(current=>({...current,autoTotpOrigins:enabled?[...new Set([...(current.autoTotpOrigins??[]),origin])]:(current.autoTotpOrigins??[]).filter(item=>item!==origin)}));}}/></label>
      {accounts.length===0 && <p>先在下方关联验证码，或<a href={chrome.runtime.getURL('vault.html#authenticator')} target="_blank" rel="noreferrer">添加身份验证器</a>。</p>}
      {(accounts.length>1 || chosen) && <label>本账号默认动态验证码<select aria-label="本账号默认动态验证码" value={accounts.some(item=>item.id===chosen)?chosen:''} disabled={busy} onChange={event=>{const id=event.target.value;void save(current=>{const next={...siteLoginSettings(current,origin)},map={...next.totpAccountByCredential};if(id)map[credential.id]=id;else delete map[credential.id];return {...current,siteLoginSettings:{...current.siteLoginSettings,[origin]:{...next,totpAccountByCredential:map}}};});}}>
        <option value="">仅关联一组时自动选择</option>{accounts.map(item=><option key={item.id} value={item.id}>{item.issuer} · {item.account}</option>)}
      </select></label>}
    </>}
    {(!settings.autoSubmit || !settings.captchaAssistEnabled) && <a className="kp-site-settings-link" href={chrome.runtime.getURL('options.html#autofill')} target="_blank" rel="noreferrer">打开自动填表设置，调整总开关 →</a>}
    <details className="kp-site-help"><summary>说明与重置</summary>
      <p>开关保存此网站偏好；下方状态显示能否生效。总开关关闭时，网站偏好不会覆盖它。仅影响上方地址，不影响其他子域名。</p>
      <p>首选账号会排在匹配列表最前；仍由你选择填写。动态验证码支持同页和下一步验证，临近过期时等待下一组；关联多组时需指定默认验证码。</p>
    <button type="button" disabled={busy} onClick={()=>void save(current=>{const sites={...current.siteLoginSettings},captchas={...current.captchaSiteRules};delete sites[origin];delete captchas[origin];return {...current,siteLoginSettings:sites,captchaSiteRules:captchas,autoTotpOrigins:(current.autoTotpOrigins??[]).filter(item=>item!==origin)};})}>恢复此网站默认设置</button>
    <p>恢复后保留账号、验证码关联和已绑定的登录表单；动态验证码自动填写关闭。</p>
    </details>
    {message && <p role="status">{message}</p>}
  </details>;
});
