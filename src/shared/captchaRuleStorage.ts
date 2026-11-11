import type { CaptchaSiteRule } from './captcha';
import { captchaOrigin, validCaptchaRule, CAPTCHA_RULE_LIMIT } from './captchaRules';
import { persistVaultSession } from './vault';
import type { UnlockedVaultSession } from './types';

export async function saveCaptchaRule(session:UnlockedVaultSession,url:string,rule:CaptchaSiteRule|null) {
  const origin=captchaOrigin(url),rules={...session.vault.settings.captchaSiteRules};
  if(rule===null)delete rules[origin];
  else{
    if(!validCaptchaRule(rule))throw new Error('RULE_INVALID');
    if(!Object.hasOwn(rules,origin)&&Object.keys(rules).length>=CAPTCHA_RULE_LIMIT)throw new Error('RULE_LIMIT');
    rules[origin]={mode:rule.mode,...(rule.expectedLength===undefined?{}:{expectedLength:rule.expectedLength}),...(rule.disabled===undefined?{}:{disabled:rule.disabled})};
  }
  return persistVaultSession(session,{...session.vault,settings:{...session.vault.settings,captchaSiteRules:rules}});
}
