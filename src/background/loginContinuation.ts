import { restoreCachedVaultSession } from '../shared/vault';
import { isVaultSessionActive } from '../shared/storage';
import { credentialMatchesUrl } from '../shared/domain';
import { generateTotp, totpSecondsRemaining } from '../shared/totp';
import type { TotpAccount } from '../shared/types';
import { preferredTotp, siteAllowsSubmit } from '../shared/loginSettings';

// Only identifiers and revisions persist across service-worker suspension. Never codes or secrets.
interface TotpJob { id:string; origin:string; credentialId:string; accountId:string; revision:string; sessionId:string; expiresAt:number }
async function revision(credential:{username:string;password:string;url:string},account:TotpAccount){
  // Including the high-entropy TOTP secret prevents this digest from being a password verifier.
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([credential.username,credential.password,credential.url,account.id,account.credentialId,account.secret,account.algorithm,account.digits,account.period,account.updatedAt])));
  return Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
}
const key=(tabId:number)=>`keypilot.autoTotp.${tabId}`;
const running=new Set<number>();
async function read(tabId:number):Promise<TotpJob|undefined>{return (await chrome.storage.session.get(key(tabId)))[key(tabId)];}
async function clear(tabId:number){await chrome.storage.session.remove(key(tabId));}

export async function authorizeLoginSubmit(message:any,sender:chrome.runtime.MessageSender){
  const session=await restoreCachedVaultSession();
  if(sender.id!==chrome.runtime.id || !sender.tab?.id || !sender.url || sender.url!==message.expectedUrl || !session?.sessionId || !await isVaultSessionActive(session.sessionId))return {ok:false};
  const credential=session.vault.credentials.find(item=>item.id===message.credentialId);
  if(!credential || !credentialMatchesUrl(credential,sender.url) || credential.username!==message.username || credential.password!==message.password ||
    (message.sessionId && message.sessionId!==session.sessionId) || !siteAllowsSubmit(session.vault.settings,sender.url))return {ok:false};
  const origin=new URL(sender.url).origin;
  const account=preferredTotp(session.vault,credential.id,origin);
  const allowed=origin.startsWith('https://') && new URL(credential.url).origin===origin && (session.vault.settings.autoTotpOrigins??[]).includes(origin);
  if(message.samePageTotpRevision && (!allowed || !account || await revision(credential,account)!==message.samePageTotpRevision))return {ok:false};
  if(message.prepareTotp){
    if(!allowed || !account)return {ok:false,reason:allowed?'请选择本账号的默认动态验证码。':'此网站未开启动态验证码自动填写。'};
    if(totpSecondsRemaining(account.period,Date.now())<=Math.min(5,account.period/2))return {ok:true,waiting:true,sessionId:session.sessionId};
    const now=Date.now(),code=await generateTotp(account,now);
    if(!await isVaultSessionActive(session.sessionId))return {ok:false};
    const latest=await restoreCachedVaultSession();
    const latestCredential=latest?.vault.credentials.find(item=>item.id===credential.id);
    const latestAccount=latest && preferredTotp(latest.vault,credential.id,origin);
    if(latest?.sessionId!==session.sessionId || !latestCredential || !latestAccount || !siteAllowsSubmit(latest.vault.settings,origin) || !latest.vault.settings.autoTotpOrigins?.includes(origin) || await revision(latestCredential,latestAccount)!==await revision(credential,account))return {ok:false};
    return {ok:true,code,revision:await revision(credential,account),expiresAt:(Math.floor(now/1000/account.period)+1)*account.period*1000,sessionId:session.sessionId};
  }
  if(typeof message.loginId==='string')await navigator.locks.request(key(sender.tab.id),async()=>{
    const previous=await read(sender.tab!.id!);if(previous && previous.id!==message.loginId)await clear(sender.tab!.id!);
  });
  if(message.armTotp && typeof message.loginId==='string'){
    if(allowed && account && !message.samePageTotpRevision){
      const tabId=sender.tab.id,sessionId=session.sessionId;
      await navigator.locks.request(key(tabId),async()=>{
        const previous=await read(tabId);
        if(previous?.id!==message.loginId){
          const job:TotpJob={id:message.loginId,origin,credentialId:credential.id,accountId:account.id,revision:await revision(credential,account),sessionId,expiresAt:Date.now()+120000};
          await chrome.storage.session.set({[key(tabId)]:job});
        }
      });
      void chrome.tabs.sendMessage(sender.tab.id,{type:'KEYPILOT_WATCH_LOGIN_TOTP'},{frameId:0}).catch(()=>undefined);
    }
  }
  return {ok:true,sessionId:session.sessionId};
}

export async function continueLoginTotp(sender:chrome.runtime.MessageSender){
  if(!sender.tab?.id)return {active:false};
  return navigator.locks.request(key(sender.tab.id),()=>continueUnlocked(sender));
}
async function continueUnlocked(sender:chrome.runtime.MessageSender){
  const tabId=sender.tab?.id;
  if(sender.id!==chrome.runtime.id || !tabId || sender.frameId!==0)return {active:false};
  if(running.has(tabId))return {active:true};
  running.add(tabId);
  try{
    const job=await read(tabId);
    if(!job)return {active:false};
    const current=async()=>{
      const session=await restoreCachedVaultSession();
      const tab=await chrome.tabs.get(tabId).catch(()=>null);
      const credential=session?.vault.credentials.find(item=>item.id===job.credentialId);
      const account=session && preferredTotp(session.vault,job.credentialId,job.origin);
      if(job.expiresAt<=Date.now() || !session || session.sessionId!==job.sessionId || !await isVaultSessionActive(job.sessionId) ||
        !siteAllowsSubmit(session.vault.settings,job.origin) || !(session.vault.settings.autoTotpOrigins??[]).includes(job.origin) ||
        !tab?.url || new URL(tab.url).origin!==job.origin || !credential || new URL(credential.url).origin!==job.origin ||
        !account || account.id!==job.accountId || await revision(credential,account)!==job.revision || (await read(tabId))?.id!==job.id)return null;
      return account;
    };
    const account=await current();
    if(!account){await clear(tabId);return {active:false,message:'自动填写已暂停：页面、账号设置或密码库状态已变化。',credentialId:job.credentialId,manual:true};}
    const frames=(await chrome.webNavigation.getAllFrames({tabId})??[]).filter(frame=>!frame.errorOccurred && new URL(frame.url).origin===job.origin);
    const matches:Array<{documentId:string;url:string;token:string}>=[];
    for(const frame of frames){
      const probe=await chrome.tabs.sendMessage(tabId,{type:'KEYPILOT_PROBE_TOTP',digits:account.digits,expectedUrl:frame.url,automatic:true},{documentId:frame.documentId}).catch(()=>null);
      if(probe?.count>1){await clear(tabId);return {active:false,message:'检测到多处动态验证码输入框，请选择目标页面手动填写。',credentialId:job.credentialId,manual:true};}
      if(probe?.count===1 && probe.token)matches.push({documentId:frame.documentId,url:frame.url,token:probe.token});
    }
    if(matches.length>1){await clear(tabId);return {active:false,message:'检测到多处动态验证码输入框，请选择目标页面手动填写。',credentialId:job.credentialId,manual:true};}
    if(!matches.length)return {active:true};
    // The content watcher asks again next second, without keeping the worker awake.
    if(totpSecondsRemaining(account.period,Date.now())<=Math.min(5,account.period/2))return {active:true,waiting:true,message:'动态验证码即将过期，正在等待下一组…',credentialId:job.credentialId};
    if(!await current()){await clear(tabId);return {active:false};}
    const now=Date.now(),code=await generateTotp(account,now);
    if(!await current()){await clear(tabId);return {active:false};}
    // Consume before dispatch: a navigation/worker restart must never replay the write.
    await clear(tabId);
    if(!await isVaultSessionActive(job.sessionId))return {active:false};
    const match=matches[0];
    const result=await chrome.tabs.sendMessage(tabId,{type:'KEYPILOT_FILL_TOTP_CODE',code,expectedUrl:match.url,expiresAt:(Math.floor(now/1000/account.period)+1)*account.period*1000,automatic:true,token:match.token},{documentId:match.documentId}).catch(()=>null);
    return {active:false,filled:Boolean(result?.ok),message:result?.ok?'已填写动态验证码，请在网站完成验证。':'动态验证码未自动填写，请检查输入框后手动处理。',credentialId:job.credentialId,manual:!result?.ok};
  }finally{running.delete(tabId);}
}

chrome.tabs.onRemoved.addListener(tabId=>{void clear(tabId);});
