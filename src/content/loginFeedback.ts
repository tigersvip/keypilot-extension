import { t, htmlText } from './i18n';
import { UI_FONT } from '../shared/uiTypography';

let host:HTMLDivElement|undefined,root:ShadowRoot|undefined,dismissed=false,feedbackPriority=0;
export function clearLoginFeedback(){host?.remove();host=undefined;root=undefined;dismissed=true;}
export function beginLoginFeedback(){dismissed=false;feedbackPriority=0;}
export function showLoginFeedback(message:string,credentialId?:string,manual=false,priority=0){
  message=t(message);
  if(dismissed || priority<feedbackPriority)return;
  feedbackPriority=priority;
  if(!root || !host?.isConnected){
    host=document.createElement('div');host.id='keypilot-login-feedback';root=host.attachShadow({mode:'open'});
    root.innerHTML=`<style>:host{all:initial;position:fixed;right:16px;bottom:16px;z-index:2147483646;width:min(360px,calc(100vw - 32px));font:14px/1.5 ${UI_FONT};color:#182334}section{background:#fff;border:1px solid #cfdbed;border-radius:10px;box-shadow:0 5px 22px #142f5526;padding:12px 38px 12px 14px}strong{font-size:14px;color:#2155a0}p{margin:5px 0 0;overflow-wrap:anywhere}button{font:inherit;border:1px solid #cbd5e1;border-radius:5px;background:#f3f7ff;color:#17447c;padding:5px 9px;cursor:pointer;margin-top:8px}button:hover{background:#e2ecff}button:focus-visible{outline:2px solid #2563eb;outline-offset:2px}.close{position:absolute;right:8px;top:5px;border:0;background:none;font-size:20px;padding:0 6px}button[hidden]{display:none}</style><section><strong>${htmlText(t("KeyPilot · 登录进度"))}</strong><button class="close" type="button" aria-label="${htmlText(t("关闭登录进度"))}">×</button><p role="status" aria-live="polite"></p><button class="manual" type="button">${htmlText(t("打开账号与验证码"))}</button></section>`;
    root.querySelector('.close')!.addEventListener('click',clearLoginFeedback);document.documentElement.append(host);
  }
  const text=root.querySelector('p')!;
  if(text.textContent!==message)text.textContent=message;
  const action=root.querySelector<HTMLButtonElement>('.manual')!;action.hidden=!manual||!credentialId;
  action.onclick=()=>{if(credentialId)void chrome.runtime.sendMessage({type:'KEYPILOT_OPEN_LOGIN_SETTINGS',credentialId});};
}
