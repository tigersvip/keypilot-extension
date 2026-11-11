import { ensureOffscreenDocument } from './offscreen';
import { restoreCachedVaultSession } from '../shared/vault';
import { isVaultSessionActive } from '../shared/storage';
import { CAPTCHA_MAX_DATA, validCaptchaCrop, validCaptchaLength, type CaptchaResult } from '../shared/captcha';
import { captchaOrigin, validCaptchaRule } from '../shared/captchaRules';
import { saveCaptchaRule } from '../shared/captchaRuleStorage';

let busy=false;
async function enabled(url?:string) {const settings=(await restoreCachedVaultSession())?.vault.settings;return Boolean(settings?.captchaAssistEnabled&&(!url||!settings.captchaSiteRules?.[captchaOrigin(url)]?.disabled));}
function websiteSender(sender: chrome.runtime.MessageSender) {
  return sender.id===chrome.runtime.id && typeof sender.tab?.id==='number' && Boolean(sender.url?.match(/^https?:\/\//));
}
export function setupCaptcha() {
  chrome.runtime.onMessage.addListener((message,sender,respond)=>{
    if(message?.type==='KEYPILOT_CAPTCHA_POLICY'){
      if(!websiteSender(sender)){respond({ok:false});return false;}
      void restoreCachedVaultSession().then(session=>{
        const rule=session?.vault.settings.captchaSiteRules?.[captchaOrigin(sender.url!)];
        const value=Boolean(session?.vault.settings.captchaAssistEnabled&&!rule?.disabled);
        respond({ok:true,enabled:value,rule,sessionId:session?.sessionId});
      }).catch(()=>respond({ok:false,enabled:false}));return true;
    }
    if(message?.type==='KEYPILOT_CAPTCHA_SAVE_RULE'){
      if(!websiteSender(sender)){respond({ok:false,error:'STALE_PAGE'});return false;}
      void (async()=>{
        const session=await restoreCachedVaultSession();
        if(!session?.sessionId)throw new Error('VAULT_LOCKED');
        if(!session.vault.settings.captchaAssistEnabled)throw new Error('DISABLED');
        if(message.rule!==null&&!validCaptchaRule(message.rule))throw new Error('RULE_INVALID');
        const frame=await chrome.webNavigation.getFrame({tabId:sender.tab!.id!,frameId:sender.frameId??0});
        if(!frame||frame.errorOccurred||frame.documentId!==sender.documentId||frame.url!==message.expectedUrl)throw new Error('STALE_PAGE');
        // Scope is derived from the sending frame, never a page-supplied host.
        const next=await saveCaptchaRule(session,frame.url,message.rule);
        return {ok:true,rule:next.vault.settings.captchaSiteRules?.[captchaOrigin(frame.url)]};
      })().catch(error=>({ok:false,error:error instanceof Error?error.message:'RULE_SAVE_FAILED'})).then(respond);
      return true;
    }
    if(!['KEYPILOT_CAPTCHA_RECOGNIZE','KEYPILOT_CAPTCHA_CAPTURE'].includes(message?.type))return false;
    if(!websiteSender(sender)){respond({ok:false,error:'STALE_PAGE'});return false;}
    if(busy){respond({ok:false,error:'BUSY'});return false;}
    busy=true;
    void (async():Promise<CaptchaResult & {image?:string}>=>{
      const session=await restoreCachedVaultSession();
      if(!session?.sessionId)throw new Error('VAULT_LOCKED');
      if(!session.vault.settings.captchaAssistEnabled)throw new Error('DISABLED');
      if(!validCaptchaLength(message.expectedLength))throw new Error('RULE_INVALID');
      const tabId=sender.tab!.id!,frameId=sender.frameId??0;
      const frame=await chrome.webNavigation.getFrame({tabId,frameId});
      if(!frame||frame.errorOccurred||frame.documentId!==sender.documentId||frame.url!==message.expectedUrl)throw new Error('STALE_PAGE');
      if(session.vault.settings.captchaSiteRules?.[captchaOrigin(frame.url)]?.disabled)throw new Error('DISABLED');
      let image:string=message.image;
      const capture=message.type==='KEYPILOT_CAPTCHA_CAPTURE';
      if(capture){
        if(frameId!==0||!validCaptchaCrop(message.crop))throw new Error('CAPTURE_UNAVAILABLE');
        const tab=await chrome.tabs.get(tabId),active=(await chrome.tabs.query({active:true,windowId:tab.windowId}))[0];
        if(active?.id!==tabId)throw new Error('CAPTURE_UNAVAILABLE');
        // Use the displayed pixels, never re-fetch a URL that may generate a new code.
        image=await chrome.tabs.captureVisibleTab(tab.windowId,{format:'png'});
        if((await chrome.tabs.query({active:true,windowId:tab.windowId}))[0]?.id!==tabId)throw new Error('STALE_PAGE');
      }else if(typeof image!=='string'||image.length>CAPTCHA_MAX_DATA||!/^data:image\/png;base64,/.test(image))throw new Error('IMAGE_INVALID');
      await ensureOffscreenDocument();
      const result:CaptchaResult & {image?:string}=await chrome.runtime.sendMessage({target:capture?'keypilot-captcha-crop':'keypilot-captcha-ocr',image,crop:capture?message.crop:undefined,mode:'auto',expectedLength:message.expectedLength,arithmeticHint:message.arithmeticHint===true});
      const current=await chrome.webNavigation.getFrame({tabId,frameId}).catch(()=>null);
      if(!current||current.documentId!==frame.documentId||current.url!==frame.url)throw new Error('STALE_PAGE');
      if(!await isVaultSessionActive(session.sessionId))throw new Error('VAULT_LOCKED');
      if(!await enabled(frame.url))throw new Error('DISABLED');
      return result ?? {ok:false,error:'OCR_FAILED'};
    })().catch(error=>({ok:false,error:error instanceof Error?error.message:'OCR_FAILED'})).then(respond).finally(()=>{busy=false;});
    return true;
  });
  let timer:ReturnType<typeof setTimeout>|undefined;
  chrome.storage.onChanged.addListener((changes,area)=>{
    if(!((area==='session'&&changes['keypilot.sessionState'])||(area==='local'&&changes['keypilot.encryptedVault'])))return;
    clearTimeout(timer);timer=setTimeout(()=>{
      void (async()=>{
        const value=await enabled();
        for(const tab of await chrome.tabs.query({}))if(tab.id&&tab.url?.match(/^https?:\/\//)){
          void chrome.tabs.sendMessage(tab.id,{type:'KEYPILOT_CAPTCHA_POLICY_CHANGED',enabled:value}).catch(()=>undefined);
        }
      })().catch(()=>undefined);
    },150);
  });
}
