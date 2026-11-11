import type { CaptchaSiteRule } from './captcha';
import { validCaptchaLength } from './captcha';

export const CAPTCHA_RULE_LIMIT=500;
export function captchaOrigin(url:string):string {
  const parsed=new URL(url);
  if(!['http:','https:'].includes(parsed.protocol))throw new Error('RULE_INVALID');
  return parsed.origin;
}
export function validCaptchaRule(value:unknown):value is CaptchaSiteRule {
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const rule=value as CaptchaSiteRule;
  return ['auto','digits','alnum'].includes(rule.mode)&&validCaptchaLength(rule.expectedLength)&&
    (rule.disabled===undefined||typeof rule.disabled==='boolean')&&Object.keys(rule).every(key=>key==='mode'||key==='expectedLength'||key==='disabled');
}
export function validateCaptchaRules(value:unknown):void {
  if(value===undefined)return;
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length>CAPTCHA_RULE_LIMIT)throw new Error('验证码网站规则格式不正确。');
  for(const [origin,rule] of Object.entries(value)){
    try{if(origin.length>2048||captchaOrigin(origin)!==origin||!validCaptchaRule(rule))throw new Error('RULE_INVALID');}
    catch{throw new Error('验证码网站规则格式不正确。');}
  }
}
