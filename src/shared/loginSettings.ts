import type { VaultPlain, VaultSettings } from './types';

export function siteLoginSettings(settings:VaultSettings,url:string) {
  try{return settings.siteLoginSettings?.[new URL(url).origin]??{};}catch{return {};}
}
export function siteAllowsSubmit(settings:VaultSettings,url:string) {
  const site=siteLoginSettings(settings,url);
  return settings.autoSubmit && site.autoSubmit!==false && site.fillEnabled!==false;
}
export function preferredTotp(vault:VaultPlain,credentialId:string,origin:string) {
  const accounts=vault.totpAccounts?.filter(item=>!item.deletedAt && item.credentialId===credentialId)??[];
  const id=siteLoginSettings(vault.settings,origin).totpAccountByCredential?.[credentialId];
  return id ? accounts.find(item=>item.id===id) : accounts.length===1?accounts[0]:undefined;
}
export function validateSiteLoginSettings(value:unknown):void {
  if(value===undefined)return;
  const object=(item:unknown):item is Record<string,unknown>=>Boolean(item && typeof item==='object' && !Array.isArray(item));
  const id=(item:unknown)=>typeof item==='string' && item.length>0 && item.length<=200;
  if(!object(value) || Object.keys(value).length>500)throw new Error('网站登录设置格式不正确。');
  for(const [origin,rule] of Object.entries(value)){
    let validOrigin=false;
    try{const url=new URL(origin);validOrigin=['https:','http:'].includes(url.protocol)&&url.origin===origin&&origin.length<=2048;}catch{}
    if(!validOrigin || !object(rule) || Object.entries(rule).some(([key,item])=>{
      if(key==='fillEnabled'||key==='autoSubmit')return typeof item!=='boolean';
      if(key==='defaultCredentialId'||key==='defaultFillProfileId')return !id(item);
      if(key==='totpAccountByCredential')return !object(item)||Object.keys(item).length>500||Object.entries(item).some(([key,value])=>!id(key)||!id(value));
      return true;
    }))throw new Error('网站登录设置格式不正确。');
  }
}

export function validateAutoTotpOrigins(value:unknown):asserts value is string[]|undefined {
  if(value===undefined)return;
  if(!Array.isArray(value) || value.length>500 || new Set(value).size!==value.length || value.some(origin=>{
    try{const url=new URL(origin);return typeof origin!=='string' || url.protocol!=='https:' || url.origin!==origin || Boolean(url.username || url.password);}
    catch{return true;}
  }))throw new Error('自动填写动态验证码的网站设置无效，请使用完整 HTTPS 来源地址。');
}
