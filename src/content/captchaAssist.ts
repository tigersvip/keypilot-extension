import { t, htmlText, initContentLanguage } from './i18n';
import { UI_FONT, MONO_FONT } from '../shared/uiTypography';
import type { CaptchaResult, CaptchaSiteRule,CaptchaCandidate } from '../shared/captcha';
import {findCaptchaTarget,captchaVisible as visible,captchaRoots,arithmeticHint,type CodeImage,type CaptchaTarget as Target} from './captchaTarget';
function imageData(image:CodeImage){
  if(image instanceof HTMLCanvasElement)return image.toDataURL('image/png');
  if(!image.complete||!image.naturalWidth)throw new Error('IMAGE_CHANGED');
  const canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;
  if(canvas.width>1800||canvas.height>600)throw new Error('IMAGE_INVALID');
  canvas.getContext('2d')!.drawImage(image,0,0);return canvas.toDataURL('image/png');
}
function fingerprint(image:CodeImage){try{return imageData(image);}catch{return image instanceof HTMLImageElement?image.currentSrc:'';}}
const errors:Record<string,string>={
  ARITHMETIC_UNCLEAR:t("算式尚未识别清楚，或结果需要约定舍入方式，请核对原图后手动输入。"),LENGTH_MISMATCH:t("识别结果与指定的位数不一致，请核对网站规则或手动输入。"),RULE_INVALID:t("验证码规则无效，请选择 2–10 位或自动分离。"),RULE_LIMIT:t("已达到 500 个网站规则，请在设置中删除不再使用的规则。"),RULE_SAVE_FAILED:t("网站规则保存失败，请重试。"),VAULT_WRITE_CONFLICT:t("规则已在其他页面更新，请重新打开后再修改。"),
  DISABLED:t("请先在设置 → 自动填表中开启本地验证码识别。"),VAULT_LOCKED:t("请先解锁 KeyPilot 密码库。"),BUSY:t("正在识别另一张图片，请稍后再试。"),STALE_PAGE:t("网页已变化，请重新识别。"),IMAGE_CHANGED:t("验证码图片已刷新，请重新识别。"),CAPTURE_UNAVAILABLE:t("请将验证码完整显示在当前标签页后重试。这张图片暂时无法读取。"),IMAGE_INVALID:t("图片尺寸或格式不适合识别，请手动输入。"),OCR_TIMEOUT:t("识别超时，请重试或手动输入。"),NO_RESULT:t("未得到清晰的字符结果，请手动输入或刷新验证码后重试。"),OCR_FAILED:t("本地识别未完成，请重试或手动输入。")
};
type LoginCaptchaResult = {ok:false;message:string}|{ok:true;isCurrent:()=>boolean;authorize:()=>Promise<boolean>};
let loginFill:((input:HTMLInputElement,guard:()=>boolean)=>Promise<LoginCaptchaResult>)|undefined;
type ResumeLogin = (current:()=>boolean)=>Promise<{submitted:boolean;captchaMessage?:string}>;
let offerContinuation:((input:HTMLInputElement,guard:()=>boolean,resume:ResumeLogin,dispose:()=>void,reveal:boolean)=>boolean)|undefined;
export function offerCaptchaLoginContinuation(input:HTMLInputElement,guard:()=>boolean,resume:ResumeLogin,dispose:()=>void,reveal=true){
  return offerContinuation?.(input,guard,resume,dispose,reveal)??false;
}
// Only the explicit credential-login flow invokes this; manual OCR still requires confirmation.
export async function fillCaptchaForLogin(input:HTMLInputElement,guard:()=>boolean):Promise<LoginCaptchaResult>{
  await initContentLanguage();
  if (!guard()) return {ok:false,message:t("网页已变化，请重新识别。")};
  if (!loginFill) installCaptchaAssist();
  return loginFill?loginFill(input,guard):{ok:false,message:t("验证码识别尚未就绪，请稍后重试。")};
}
export function installCaptchaAssist(){
  if(document.getElementById('keypilot-captcha-root'))return;
  const host=document.createElement('div');host.id='keypilot-captcha-root';host.style.cssText=`all:initial;position:fixed;z-index:2147483647;display:none;font:15px/1.5 ${UI_FONT};color:#24354b`;
  const root=host.attachShadow({mode:'open'});document.documentElement.append(host);
  root.innerHTML=`<style>
    :host{font:15px/1.5 ${UI_FONT};color:#24354b}*{box-sizing:border-box}button,input,select{font:inherit}button{cursor:pointer;min-height:36px;padding:6px 12px;border:1px solid #cbd7e5;border-radius:6px;background:#fff;color:#24354b}button:hover{background:#eff5ff;color:#174fba}button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid #2563eb;outline-offset:2px}button:disabled{cursor:default;opacity:.55}button.primary{background:#2563eb;border-color:#2563eb;color:#fff}button.primary:hover{background:#1d4ed8}#kp-captcha-trigger{font-size:13px;box-shadow:0 2px 8px #23344b18}.panel{width:330px;max-width:calc(100vw - 24px);padding:16px;border:1px solid #d8e0ec;border-radius:10px;background:#fff;box-shadow:0 6px 24px #172b4d26}.head{display:flex;align-items:center;justify-content:space-between;gap:8px}.head strong{font-weight:600}.head button{min-height:30px;padding:1px 8px;border:0}p{margin:9px 0;color:#607087;font-size:13px}.preview{display:flex;align-items:center;justify-content:center;padding:10px;background:#f5f7fa;border-radius:6px;min-height:56px;margin:12px 0}.preview img{max-width:100%;max-height:100px;object-fit:contain}label{display:block;font-size:13px;margin:10px 0 5px}select,input{width:100%;height:38px;border:1px solid #cbd7e5;border-radius:6px;background:white;color:#24354b;padding:6px 9px}#kp-captcha-result{font:20px/1.4 ${MONO_FONT};letter-spacing:2px}.choices{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}.choices button{font:15px ${MONO_FONT};min-height:30px}.actions{display:flex;gap:8px;margin-top:14px}.actions button{flex:1}#kp-captcha-status{color:#475569;overflow-wrap:anywhere}#kp-captcha-status.error{color:#a33a24}[hidden]{display:none!important}
  </style><button id="kp-captcha-trigger" type="button">${htmlText(t("识别验证码"))}</button>
  <section class="panel" role="dialog" aria-label="${htmlText(t("本地验证码识别"))}" hidden>
    <div class="head"><strong>${htmlText(t("验证码识别"))}</strong><button type="button" id="kp-captcha-close" aria-label="${htmlText(t("关闭验证码识别"))}">×</button></div>
    <div class="preview"><img id="kp-captcha-preview" alt="${htmlText(t("待识别的验证码图片"))}"></div>
    <p id="kp-captcha-expression" aria-label="${htmlText(t("识别算式"))}" hidden></p>
    <div id="kp-captcha-answer" hidden><div class="answer-label"><label for="kp-captcha-result">${htmlText(t("识别结果（可修改）"))}</label><span>${htmlText(t("回车填写"))}</span></div><div class="answer-row"><input id="kp-captcha-result" autocomplete="off" spellcheck="false" maxlength="10"><button id="kp-captcha-apply" class="primary" type="button" title="${htmlText(t("确认填写（Enter）"))}" disabled>${htmlText(t("确认填写"))}</button></div><div class="choices" aria-label="${htmlText(t("识别候选"))}"></div></div>
    <p id="kp-captcha-status" role="status" aria-live="polite"></p>
    <div class="actions"><button id="kp-captcha-recognize" type="button">${htmlText(t("开始识别"))}</button><details class="rule-settings"><summary>${htmlText(t("网站位数提示（可选）"))}</summary>
    <div><label for="kp-captcha-length">${htmlText(t("已知位数"))}</label><select id="kp-captcha-length"><option value="">${htmlText(t("自动判断"))}</option>${Array.from({length:9},(_,i)=>`<option value="${i+2}">${i+2}${htmlText(t(" 位"))}</option>`).join('')}</select></div>
    <div class="rule-actions"><button id="kp-captcha-save-rule" type="button">${htmlText(t("记住此网站规则"))}</button><button id="kp-captcha-clear-rule" type="button" hidden>${htmlText(t("清除规则"))}</button><button id="kp-captcha-disable-site" type="button">${htmlText(t("此网站不再提示"))}</button></div><p id="kp-captcha-rule-status" aria-live="polite"></p>
    </details></div>
  </section>`;
  const trigger=root.querySelector<HTMLButtonElement>('#kp-captcha-trigger')!,panel=root.querySelector<HTMLElement>('.panel')!,status=root.querySelector<HTMLElement>('#kp-captcha-status')!;
  const answer=root.querySelector<HTMLElement>('#kp-captcha-answer')!,result=root.querySelector<HTMLInputElement>('#kp-captcha-result')!,apply=root.querySelector<HTMLButtonElement>('#kp-captcha-apply')!,recognize=root.querySelector<HTMLButtonElement>('#kp-captcha-recognize')!,preview=root.querySelector<HTMLImageElement>('#kp-captcha-preview')!;
  const length=root.querySelector<HTMLSelectElement>('#kp-captcha-length')!,saveRule=root.querySelector<HTMLButtonElement>('#kp-captcha-save-rule')!,clearRule=root.querySelector<HTMLButtonElement>('#kp-captcha-clear-rule')!,ruleStatus=root.querySelector<HTMLElement>('#kp-captcha-rule-status')!;
  const expression=root.querySelector<HTMLElement>('#kp-captcha-expression')!;
  const disableSite=root.querySelector<HTMLButtonElement>('#kp-captcha-disable-site')!;
  const extraStyle=document.createElement('style');extraStyle.textContent=`
    .panel{padding:12px}.preview{height:60px;min-height:0;padding:4px;margin:6px 0 8px}.preview img{max-height:52px}
    .answer-label{display:flex;align-items:center;justify-content:space-between;gap:6px;margin-bottom:5px}.answer-label label{margin:0}.answer-label span{font-size:12px;color:#607087}
    .answer-row{display:flex;gap:8px}.answer-row input{flex:1;min-width:0}.answer-row button{flex:none;white-space:nowrap;padding:6px 10px;height:38px}
    .choices{gap:5px;margin-top:6px}.choices button{padding:4px 8px}.choices button[aria-pressed=true]{background:#edf3ff;border-color:#2563eb;color:#174fba}
    .actions{align-items:center;flex-wrap:wrap;margin-top:8px}.actions>button{flex:none;font-size:13px;min-height:30px;padding:3px 8px}
    .rule-settings{flex:1;font-size:13px}.rule-settings summary{cursor:pointer;color:#607087;text-align:right;padding:4px 0}.rule-settings[open]{flex-basis:100%}.rule-settings[open] summary{text-align:left}
    .rule-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}.rule-actions button{font-size:13px;padding:4px 8px;min-height:30px}#kp-captcha-rule-status{font-size:12px;overflow-wrap:anywhere}
  `;root.append(extraStyle);
  let enabled=false,target:Target|null=null,open=false,pending=false,generation=0,revision=0,expectedRevision=0,expectedImage='',expectedValue='',expectedUrl='';
  let observer:MutationObserver|undefined,refresh:ReturnType<typeof setTimeout>|undefined,loadImage:CodeImage|null=null;
  let observedRoots=new Set<Document|ShadowRoot>();
  let siteRule:CaptchaSiteRule|undefined,savingRule=false,policyRequest=0;
  let arithmetic=false,resultCandidates:CaptchaCandidate[]=[];
  const automaticValues=new WeakMap<HTMLInputElement,string>();
  let continuation:{input:HTMLInputElement;guard:()=>boolean;resume:ResumeLogin;dispose:()=>void;timer:ReturnType<typeof setTimeout>}|undefined;
  function clearContinuation(){
    if(continuation){clearTimeout(continuation.timer);continuation.dispose();continuation=undefined;}
    apply.textContent=t("确认填写");apply.title=t("确认填写（Enter）");trigger.textContent=t("识别验证码");
    root.querySelector('.answer-label span')!.textContent=t("回车填写");
  }
  offerContinuation=(input,guard,resume,dispose,reveal)=>{
    if(!enabled || !guard() || target?.input!==input || (reveal && !open))return false;
    clearContinuation();
    continuation={input,guard,resume,dispose,timer:setTimeout(clearContinuation,120000)};
    apply.textContent=t("继续登录");apply.title=t("填写并继续登录（Enter）");trigger.textContent=t("修正验证码");
    root.querySelector('.answer-label span')!.textContent=t("回车继续登录");
    if(reveal && open){answer.hidden=false;result.placeholder=t("手动输入验证码");apply.disabled=!valid();position();}
    return true;
  };
  const ruleKey=(rule:CaptchaSiteRule|undefined)=>rule?`${rule.mode}:${rule.expectedLength??''}:${Boolean(rule.disabled)}`:'';
  function currentRule():CaptchaSiteRule{return {mode:'auto',...(length.value?{expectedLength:Number(length.value)}:{})};}
  function ruleControls(){
    saveRule.disabled=savingRule||pending;clearRule.disabled=savingRule||pending;disableSite.disabled=savingRule;
    clearRule.hidden=!siteRule;
    ruleStatus.textContent=siteRule?t("已记住 {0}：自动识别 · {1}。", [location.host, siteRule.expectedLength?`${siteRule.expectedLength} 位`:'自动判断位数']):t("无需设置即可识别。固定长度的网站可以记住位数，不保存图片或答案。");
  }
  function selectRule(){length.value=siteRule?.expectedLength?.toString()??'';ruleControls();}
  function message(text:string,error=false){status.textContent=t(text);status.classList.toggle('error',error);}
  function valid(){return arithmetic?result.value.length<=10&&/^-?\d+(?:\.\d+)?$/.test(result.value):(!length.value||result.value.length===Number(length.value))&&/^[!-~]{2,10}$/.test(result.value);}
  function reset(){generation++;pending=false;expectedImage='';expectedValue='';expectedUrl='';arithmetic=false;resultCandidates=[];expression.hidden=true;expression.textContent='';answer.hidden=true;result.value='';apply.disabled=true;recognize.disabled=false;recognize.textContent=t("开始识别");root.querySelector('.choices')!.replaceChildren();ruleControls();}
  function close(preserveContinuation=false){if(!preserveContinuation)clearContinuation();reset();open=false;panel.hidden=true;trigger.hidden=false;preview.removeAttribute('src');position();}
  function imageChanged(){revision++;if(open){reset();preview.removeAttribute('src');preview.alt=t("验证码已刷新，请重新识别");message(t("验证码图片已变化，请重新识别。"),true);}}
  function position(){
    if(!enabled||!target?.input.isConnected||!target.image.isConnected||!visible(target.input)){host.style.display='none';return;}
    const box=target.input.getBoundingClientRect();
    if(box.bottom<0||box.top>innerHeight||box.right<0||box.left>innerWidth){host.style.display='none';return;}
    host.style.display='block';const width=open?Math.min(330,innerWidth-24):116,height=open?panel.getBoundingClientRect().height:36;
    host.style.left=`${Math.max(8,Math.min(box.right-width,innerWidth-width-12))}px`;
    const below=box.bottom+6;host.style.top=`${Math.max(8,Math.min(below+height<=innerHeight?below:box.top-height-6,innerHeight-height-8))}px`;
    if(open){panel.style.maxHeight=`${Math.max(160,innerHeight-16)}px`;panel.style.overflowY='auto';}
  }
  function setTarget(next:Target|null){
    if(target?.input===next?.input&&target?.image===next?.image){position();return;}
    loadImage?.removeEventListener('load',imageChanged);target=next;loadImage=next?.image??null;loadImage?.addEventListener('load',imageChanged);revision++;close();
  }
  function scan(){
    if(!enabled)return;
    const roots=captchaRoots();
    // Refresh the observed-root set so removed components are not retained.
    if(roots.length!==observedRoots.size||roots.some(root=>!observedRoots.has(root))){
      observer?.disconnect();observedRoots=new Set(roots);
      for(const item of roots)observer?.observe(item,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['src','srcset','width','height','autocomplete','placeholder','type','disabled','readonly','name','id','class','style','hidden','inert','aria-hidden','aria-label','aria-labelledby','aria-describedby','aria-controls','alt','title']});
    }
    if(open&&target?.input.isConnected){
      const current=findCaptchaTarget(target.input);
      if(current?.image===target.image){position();return;}
      setTarget(current);return;
    }
    let focused:Element|null=document.activeElement;
    while(focused?.shadowRoot?.activeElement)focused=focused.shadowRoot.activeElement;
    if(focused instanceof HTMLInputElement&&!root.contains(focused)){setTarget(findCaptchaTarget(focused));return;}
    const candidates=roots.flatMap(root=>Array.from(root.querySelectorAll<HTMLInputElement>('input')).slice(0,300)).slice(0,300).map(findCaptchaTarget).filter((value):value is Target=>Boolean(value));
    setTarget(candidates.length===1?candidates[0]:null);
  }
  function setEnabled(value:boolean){
    enabled=value;
    if(!enabled){setTarget(null);close();host.style.display='none';observer?.disconnect();observedRoots.clear();clearTimeout(refresh);return;}
    observer??=new MutationObserver(records=>{
      if(records.every(record=>host.contains(record.target)||record.target===host))return;
      if(target&&records.some(record=>record.target===target!.image))imageChanged();
      clearTimeout(refresh);refresh=setTimeout(scan,250);
    });
    scan();
  }
  function acceptPolicy(state:{ok?:boolean;enabled?:boolean;rule?:CaptchaSiteRule}){
    const changed=ruleKey(siteRule)!==ruleKey(state.rule);siteRule=state.rule;
    setEnabled(Boolean(state.ok&&state.enabled));
    if(changed&&open){reset();selectRule();message(t("网站规则已更新，请重新识别。"));position();}
    ruleControls();
  }
  async function policy(){const request=++policyRequest;try{const state=await chrome.runtime.sendMessage({type:'KEYPILOT_CAPTCHA_POLICY'});if(request===policyRequest)acceptPolicy(state??{});}catch{if(request===policyRequest)setEnabled(false);}}
  async function storeRule(clear=false,disable=false){
    if(savingRule||pending)return;savingRule=true;ruleControls();
    const url=location.href,draft=clear?null:{...currentRule(),...(disable?{disabled:true}:{})};
    try{
      const response=await chrome.runtime.sendMessage({type:'KEYPILOT_CAPTCHA_SAVE_RULE',rule:draft,expectedUrl:url});
      if(!response?.ok)throw new Error(response?.error??'RULE_SAVE_FAILED');
      if(location.href!==url||!enabled)return;
      siteRule=response.rule;if(disable){setEnabled(false);return;}reset();selectRule();
      message(clear?t("已清除此网站规则，请重新识别。"):t("网站规则已保存，之后会自动使用。请重新识别。"));
    }catch(error){if(open)message(errors[error instanceof Error?error.message:'RULE_SAVE_FAILED']??errors.RULE_SAVE_FAILED,true);}
    finally{savingRule=false;ruleControls();position();}
  }
  async function run(automatic=false){
    if(!target||pending)return;
    if(findCaptchaTarget(target.input)?.image!==target.image){setTarget(findCaptchaTarget(target.input));return;}
    reset();pending=true;ruleControls();recognize.disabled=true;recognize.textContent=t("识别中…");message(t("正在本机自动识别并复核，首次使用可能需要几秒。"));
    const request=++generation,current=target;expectedRevision=revision;expectedValue=current.input.value;expectedUrl=location.href;
    try{
      let image:string|undefined;
      try{image=imageData(current.image);preview.src=image;preview.alt=t("待识别的验证码图片");expectedImage=image;}
      catch(error){
        if(error instanceof Error&&error.message==='IMAGE_INVALID')throw error;
        // A tainted canvas can repaint without a load event; we cannot verify
        // that a screenshot result still belongs to the current drawing.
        if(current.image instanceof HTMLCanvasElement)throw new Error('CAPTURE_UNAVAILABLE');
        const rect=current.image.getBoundingClientRect();
        if(window.top!==window||rect.left<0||rect.top<0||rect.right>innerWidth||rect.bottom>innerHeight)throw new Error('CAPTURE_UNAVAILABLE');
        const crop={x:rect.left,y:rect.top,width:rect.width,height:rect.height,viewportWidth:innerWidth,viewportHeight:innerHeight};
        expectedImage=fingerprint(current.image);
        // Hide our panel for the capture so it cannot cover the code underneath.
        host.style.visibility='hidden';
        try{
          await new Promise<void>(resolve=>{const fallback=setTimeout(resolve,200);requestAnimationFrame(()=>requestAnimationFrame(()=>{clearTimeout(fallback);resolve();}));});
          if(request!==generation||!open)return;
          if(document.hidden)throw new Error('CAPTURE_UNAVAILABLE');
          const captured=await chrome.runtime.sendMessage({type:'KEYPILOT_CAPTCHA_CAPTURE',crop,expectedUrl});
          if(!captured?.ok)throw new Error(captured?.error??'CAPTURE_UNAVAILABLE');
          const now=current.image.getBoundingClientRect();
          if(Math.abs(now.left-rect.left)>1||Math.abs(now.top-rect.top)>1||Math.abs(now.width-rect.width)>1||Math.abs(now.height-rect.height)>1)throw new Error('IMAGE_CHANGED');
          image=captured.image;preview.src=captured.image;preview.alt=t("待识别的验证码图片");
        }finally{host.style.visibility='visible';}
      }
      if(request!==generation||!open)return;
      const hint=arithmeticHint.test([current.input.placeholder,current.input.getAttribute('aria-label'),...Array.from(current.input.labels??[]).map(item=>item.textContent),current.image.getAttribute('alt'),current.image.getAttribute('title')].join(' '));
      const response:CaptchaResult=await chrome.runtime.sendMessage({type:'KEYPILOT_CAPTCHA_RECOGNIZE',image,mode:'auto',expectedLength:length.value?Number(length.value):undefined,arithmeticHint:hint,expectedUrl});
      if(request!==generation||!open||target!==current)return;
      if(revision!==expectedRevision||location.href!==expectedUrl||!current.image.isConnected||fingerprint(current.image)!==expectedImage)throw new Error('IMAGE_CHANGED');
      if(!response?.ok||!response.candidates?.length){
        message([errors[response?.error??'OCR_FAILED']??errors.OCR_FAILED,response?.reason].filter(Boolean).join(' '),true);return;
      }
      arithmetic=response.arithmetic===true;resultCandidates=response.candidates;
      answer.hidden=automatic;result.value=response.candidates[0].text;result.placeholder='';apply.disabled=!valid();recognize.textContent=t("重新识别");updateSelection();
      for(const candidate of arithmetic&&response.candidates.length===1?[]:response.candidates){
        const button=document.createElement('button');button.type='button';button.textContent=candidate.text;button.setAttribute('aria-label',t("选择候选 {0}", [candidate.text]));
        button.setAttribute('aria-pressed',String(candidate.text===result.value));
        button.onclick=()=>{result.value=candidate.text;updateSelection();apply.disabled=!valid();message(arithmetic?t("已选择计算结果，请核对算式后确认填写。"):t("已选择候选，请核对大小写和符号后确认填写。"));};root.querySelector('.choices')!.append(button);
      }
      message(automatic?t("已识别，正在填写并继续登录…"):arithmetic?(response.uncertain?t("已自动计算；读数有分歧，请核对算式。"):t("已自动计算，核对算式后即可填写。")):response.uncertain?t("已选首选结果；存在分歧，请核对原图。"):t("已选首选结果，核对后即可填写。"),!automatic&&Boolean(response.uncertain));
      if(!automatic){result.focus();result.select();}
      return valid();
    }catch(error){if(request===generation)message(errors[error instanceof Error?error.message:'OCR_FAILED']??errors.OCR_FAILED,true);}
    finally{if(request===generation){pending=false;if(!automatic){answer.hidden=false;result.placeholder=t("手动输入验证码");}recognize.disabled=false;if(recognize.textContent==='识别中…')recognize.textContent=t("开始识别");ruleControls();position();}}
  }
  loginFill=async(input,guard)=>{
    const stopped=t("一键登录已暂停：页面、验证码或输入内容已变化，请核对后重试。");
    try{
      const state=await chrome.runtime.sendMessage({type:'KEYPILOT_CAPTCHA_POLICY'});
      if(!guard())return {ok:false,message:stopped};
      acceptPolicy(state??{});
      if(!state?.enabled)return {ok:false,message:state?.rule?.disabled?t("此网站已关闭验证码识别，请手动填写后登录。"):errors.DISABLED};
      if(open||pending)return {ok:false,message:t("验证码面板正在使用，请先完成或关闭当前识别。")};
      const current=findCaptchaTarget(input);
      if(!current)return {ok:false,message:t("无法确定验证码图片，请手动填写后登录。")};
      setTarget(current);open=true;trigger.hidden=true;panel.hidden=false;reset();selectRule();position();
      // Preserve a code the user already entered; do not replace it with OCR.
      const existing=automaticValues.get(input)===input.value?'':input.value;
      if(existing){
        expectedRevision=revision;expectedImage=fingerprint(current.image);expectedUrl=location.href;expectedValue=existing;
        result.value=existing;
      }else if(!await run(true))return {ok:false,message:open&&guard()?status.textContent||stopped:stopped};
      const request=generation,image=expectedImage,url=expectedUrl,imageRevision=expectedRevision,value=result.value,policyKey=ruleKey(siteRule);
      const unchanged=()=>guard()&&enabled&&location.href===url&&revision===imageRevision&&input.isConnected&&current.image.isConnected&&findCaptchaTarget(input)?.image===current.image&&fingerprint(current.image)===image;
      const authorized=async()=>{
        const latest=await chrome.runtime.sendMessage({type:'KEYPILOT_CAPTCHA_POLICY'});
        return Boolean(latest?.enabled&&latest.sessionId===state.sessionId&&ruleKey(latest.rule)===policyKey&&unchanged());
      };
      if(!await authorized()||generation!==request||!open||input.value!==expectedValue)throw new Error('STALE_PAGE');
      if(!value||(input.maxLength>0&&value.length>input.maxLength))return {ok:false,message:t("验证码长度不符合输入框要求，请核对后填写。")};
      if(!existing){
        const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!;
        automaticValues.set(input,value);
        setter.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true,composed:true}));input.dispatchEvent(new Event('change',{bubbles:true,composed:true}));
      }
      if(!unchanged()||input.value!==value)throw new Error('STALE_PAGE');
      close();const completedGeneration=generation;
      const isCurrent=()=>generation===completedGeneration&&unchanged()&&input.value===value;
      return {ok:true,isCurrent,authorize:async()=>await authorized()&&isCurrent()};
    }catch(error){const text=errors[error instanceof Error?error.message:'OCR_FAILED']??stopped;if(open)message(text,true);return {ok:false,message:text};}
  };
  trigger.onclick=()=>{
    if(target)setTarget(findCaptchaTarget(target.input));
    if(!target)return;open=true;trigger.hidden=true;panel.hidden=false;reset();
    selectRule();
    try{preview.src=imageData(target.image);}catch{preview.removeAttribute('src');preview.alt=t("请核对网页上的验证码图片");}
    position();void run();
  };
  root.querySelector<HTMLButtonElement>('#kp-captcha-close')!.onclick=()=>{close();target?.input.focus();};
  recognize.onclick=()=>void run();
  length.onchange=()=>{reset();message(t("位数已切换，请重新识别。"));position();};
  root.querySelector('.rule-settings')!.addEventListener('toggle',position);
  saveRule.onclick=()=>void storeRule();clearRule.onclick=()=>void storeRule(true);
  disableSite.onclick=()=>void storeRule(false,true);
  function updateSelection(){
    for(const button of root.querySelectorAll<HTMLButtonElement>('.choices button'))button.setAttribute('aria-pressed',String(button.textContent===result.value));
    const formula=resultCandidates.find(candidate=>candidate.text===result.value)?.expression??resultCandidates[0]?.expression;
    expression.hidden=!arithmetic||!formula;expression.textContent=formula?t("识别算式：{0} = ?", [formula]):'';
  }
  result.oninput=()=>{updateSelection();apply.disabled=!valid();if(!arithmetic&&length.value&&result.value.length!==Number(length.value))message(t("请输入完整的 {0} 位验证码。", [length.value]),true);};
  apply.onclick=()=>{void(async()=>{
    const current=target,request=generation;if(!current||!valid()||pending)return;
    const resume=continuation;
    apply.disabled=true;
    try{
      const state=await chrome.runtime.sendMessage({type:'KEYPILOT_CAPTCHA_POLICY'});
      if(!state?.enabled)throw new Error('VAULT_LOCKED');
      if(ruleKey(state.rule)!==ruleKey(siteRule)){acceptPolicy(state);return;}
      if(request!==generation||!open||target!==current)return;
      if(resume && (!resume.guard() || resume.input!==current.input)){clearContinuation();message(t("本次登录已过期或账号内容已变化，请重新选择账号登录。"),true);return;}
      if(!current.input.isConnected||!current.image.isConnected||findCaptchaTarget(current.input)?.image!==current.image||location.href!==expectedUrl||revision!==expectedRevision||fingerprint(current.image)!==expectedImage)throw new Error('IMAGE_CHANGED');
      if(current.input.value!==expectedValue){message(t("输入框内容已变化，请重新识别后确认。"),true);return;}
      if(current.input.maxLength>0&&result.value.length>current.input.maxLength){message(t("结果超过输入框允许的长度，请修改后再填写。"),true);return;}
      const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!;
      automaticValues.delete(current.input);
      const value=result.value,image=expectedImage,url=expectedUrl,imageRevision=expectedRevision;
      setter.call(current.input,value);current.input.dispatchEvent(new Event('input',{bubbles:true,composed:true}));current.input.dispatchEvent(new Event('change',{bubbles:true,composed:true}));
      if(resume){
        pending=true;message(t("正在填写并继续登录…"));
        const fresh=()=>resume===continuation && resume.guard() && location.href===url && revision===imageRevision && current.input.value===value && fingerprint(current.image)===image;
        const outcome=await resume.resume(fresh);
        clearContinuation();pending=false;
        if(outcome.submitted)close();else {message(outcome.captchaMessage??t("登录已暂停，请核对页面后重试。"),true);expectedValue=current.input.value;}
      }else{close();current.input.focus();}
    }catch(error){message(errors[error instanceof Error?error.message:'OCR_FAILED']??errors.OCR_FAILED,true);}
    finally{if(resume)pending=false;apply.disabled=!valid();}
  })();};
  root.addEventListener('keydown',event=>{
    const key=event as KeyboardEvent;
    if(key.key==='Escape'){event.preventDefault();event.stopPropagation();close();target?.input.focus();}
    if(key.key==='Enter'&&event.target===result){
      event.preventDefault();event.stopPropagation();
      if(!key.isComposing&&!key.repeat&&!key.altKey&&!key.ctrlKey&&!key.metaKey&&!key.shiftKey&&!apply.disabled)apply.click();
    }
  });
  document.addEventListener('focusin',event=>{if(event.composedPath().includes(host)||!enabled)return;const input=event.composedPath().find(node=>node instanceof HTMLInputElement);if(input instanceof HTMLInputElement){const next=findCaptchaTarget(input);setTarget(next);if(next)scan();}});
  window.addEventListener('scroll',position,true);window.addEventListener('resize',position);
  chrome.runtime.onMessage.addListener(message=>{
    if(message?.type==='KEYPILOT_CAPTCHA_POLICY_CHANGED'){if(message.enabled)void policy();else {policyRequest++;setEnabled(false);}}
    if(message?.type==='KEYPILOT_SESSION_LOCKED'){policyRequest++;setEnabled(false);}
    return false;
  });
  document.addEventListener('visibilitychange',()=>{if(document.hidden)close();else void policy();});
  void policy();
}
