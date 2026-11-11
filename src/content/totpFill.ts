import { showLoginFeedback, clearLoginFeedback } from './loginFeedback';
const otpWords = /(?:\b(?:otp|totp|2fa|mfa)\b|one.time|authenticator|verification.?code|security.?code|authentication.?code|验证码|动态码|验证代码)/i;
const excludedWords = /captcha|图形|图片|邮政|postal|credit|card.?number/i;
function inputsIn(root: Document | ShadowRoot): HTMLInputElement[] {
  return Array.from(root.querySelectorAll('input')).concat(Array.from(root.querySelectorAll('*')).flatMap(item=>item.shadowRoot ? inputsIn(item.shadowRoot) : []));
}
function label(input: HTMLInputElement) {
  return [input.name,input.id,input.placeholder,input.getAttribute('aria-label'),...(input.labels ? Array.from(input.labels).map(item=>item.textContent) : [])].join(' ');
}
function eligible(input: HTMLInputElement) {
  const style = getComputedStyle(input);
  return !input.disabled && !input.readOnly && ['text','tel','number','password'].includes(input.type) &&
    input.getClientRects().length>0 && style.visibility==='visible' && style.display!=='none' && style.opacity!=='0' && !excludedWords.test(label(input));
}
const authenticatorWords=/authenticator|authentication app|totp|身份验证器|验证器|动态口令|动态码/i;
const otherVerification=/\bsms\b|text message|sent.{0,30}(?:phone|email)|短信|手机验证码|电子邮件|邮箱|recovery code|backup code|恢复码|备用码/i;
function automaticContext(fields:HTMLInputElement[],allowPassword=false){
  const input=fields[0], container=input.closest('form,fieldset,[role=group]')??input.parentElement;
  const text=[...fields.map(label),container?.textContent?.slice(0,3000)].join(' ');
  // Generic one-time-code is also used for SMS/email. Require an authenticator cue.
  return authenticatorWords.test(text) && !otherVerification.test(text) &&
    (allowPassword || !inputsIn(document).some(item=>eligible(item) && item.type==='password' && !fields.includes(item)));
}
function groups(digits: number, automatic=false,allowPassword=false) {
  const inputs = inputsIn(document).filter(eligible), result: HTMLInputElement[][] = [];
  for (const input of inputs) {
    const explicit = input.autocomplete.split(/\s+/).includes('one-time-code') || otpWords.test(label(input));
    if (input.maxLength!==1 && explicit && (input.maxLength<0 || input.maxLength>=digits)) result.push([input]);
    if (input.maxLength!==1 || result.some(group=>group.includes(input))) continue;
    const container = input.closest('fieldset,[role=group]') ?? input.parentElement;
    if (!container) continue;
    const parts = inputs.filter(item=>container.contains(item) && item.maxLength===1 && item.type!=='password');
    const context = [container.getAttribute('aria-label'),container.querySelector('legend')?.textContent,container.previousElementSibling?.textContent, ...parts.map(label)].join(' ');
    if (parts.length===digits && (explicit || otpWords.test(context))) result.push(parts);
  }
  if(automatic)return result.filter(fields=>automaticContext(fields,allowPassword));
  const focused = result.filter(group=>group.includes(document.activeElement as HTMLInputElement));
  return focused.length===1 ? focused : result;
}
let automaticProbe:{token:string;fields:HTMLInputElement[]}|undefined;
export function hasVerificationFields(){return groups(6).length>0 || groups(8).length>0;}
export function samePageTotpFields(anchor:HTMLInputElement){
  if(!anchor.form)return [];
  const found=[...groups(6,true,true),...groups(8,true,true)].filter(fields=>fields.every(input=>input.form===anchor.form));
  const unique=found.filter((fields,index)=>found.findIndex(other=>other[0]===fields[0])===index);
  return unique.length===1?unique[0]:[];
}
export function writeSamePageTotp(fields:HTMLInputElement[],code:string,expiresAt:number,anchor:HTMLInputElement){
  const current=samePageTotpFields(anchor);
  if(!/^\d{6}(?:\d{2})?$/.test(code) || Date.now()>=expiresAt-1000 || current.length!==fields.length || fields.some((input,index)=>input!==current[index] || input.value || (fields.length===1 && input.maxLength>0 && input.maxLength<code.length)) || (fields.length!==1 && fields.length!==code.length))return false;
  const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!;
  for(const [index,input] of fields.entries()){
    if(!input.isConnected || !eligible(input))return false;
    setter.call(input,fields.length===1?code:code[index]);input.dispatchEvent(new Event('input',{bubbles:true,composed:true}));input.dispatchEvent(new Event('change',{bubbles:true,composed:true}));
  }
  return true;
}
let probeSequence=0;
export function clearTotpProbe(){automaticProbe=undefined;}
export function probeTotpFields(digits: number, expectedUrl: string, automatic=false) {
  if (location.href!==expectedUrl || ![6,8].includes(digits)) return {ok:false,count:0};
  const found=groups(digits,automatic);
  if(automatic)automaticProbe=found.length===1?{token:String(++probeSequence),fields:found[0]}:undefined;
  return {ok:true,count:found.length,token:automatic?automaticProbe?.token:undefined};
}
export function fillTotpFields(code: string, expectedUrl: string, expiresAt: number, automatic=false, token?:string) {
  if (location.href!==expectedUrl || !/^\d{6}(?:\d{2})?$/.test(code) || !Number.isFinite(expiresAt) || Date.now()>=expiresAt-1000) return {ok:false,error:'OTP_EXPIRED'};
  const candidates = groups(code.length,automatic);
  if (candidates.length!==1) return {ok:false,error:candidates.length?'OTP_AMBIGUOUS':'OTP_NOT_FOUND'};
  const fields = candidates[0], values = fields.length===1 ? [code] : code.split('');
  if(automatic && (!automaticProbe || token!==automaticProbe.token || fields.length!==automaticProbe.fields.length || fields.some((input,index)=>input!==automaticProbe!.fields[index])))return {ok:false,error:'OTP_CHANGED'};
  automaticProbe=undefined;
  if(automatic && fields.some(input=>input.value))return {ok:false,error:'OTP_NOT_EMPTY'};
  if (fields.some((input,index)=>input.value && input.value!==values[index])) return {ok:false,error:'OTP_NOT_EMPTY'};
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!;
  // Validate the entire group before any write. Do not submit the website's form.
  for(const [index,input] of fields.entries()){
    if(location.href!==expectedUrl || Date.now()>=expiresAt-1000 || !input.isConnected || !eligible(input))return {ok:false,error:'OTP_CHANGED'};
    setter.call(input,values[index]);input.dispatchEvent(new Event('input',{bubbles:true,composed:true}));input.dispatchEvent(new Event('change',{bubbles:true,composed:true}));
  }
  return {ok:true,filledCount:fields.length};
}

export function installLoginTotpWatcher(){
  if(window.top!==window)return;
  let timer:ReturnType<typeof setTimeout>|undefined,busy=false,until=0;
  const check=async()=>{
    if(busy)return;busy=true;
    try{
      const result=await chrome.runtime.sendMessage({type:'KEYPILOT_CONTINUE_LOGIN_TOTP'});
      if(result?.message)showLoginFeedback(result.message,result.credentialId,result.manual===true,1);
      if(result?.active && Date.now()<until)timer=setTimeout(()=>void check(),1000);
    }catch{/* An unloaded or locked extension leaves the code to the user. */}
    finally{busy=false;}
  };
  const start=()=>{clearTimeout(timer);until=Date.now()+120000;timer=setTimeout(()=>void check(),500);};
  chrome.runtime.onMessage.addListener(message=>{
    if(message?.type==='KEYPILOT_WATCH_LOGIN_TOTP')start();
    if(message?.type==='KEYPILOT_SESSION_LOCKED'){clearTimeout(timer);until=0;automaticProbe=undefined;clearLoginFeedback();}
    return false;
  });
  start();
}
