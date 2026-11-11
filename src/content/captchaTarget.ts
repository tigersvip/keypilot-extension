// DOM detection only. Keep this module in the classic content-script bundle;
// OCR and extension pages must not import it as a shared runtime dependency.
export type CodeImage=HTMLImageElement|HTMLCanvasElement;
export interface CaptchaTarget {input:HTMLInputElement;image:CodeImage}
export const arithmeticHint=/算式|算术|計算結果|计算结果|运算结果|得数|計算答案|计算答案|math.?captcha|arithmetic|(?:calculate|solve).*?(?:answer|result)/i;
const strongWords=/\bcaptcha(?:code|image|img|input|response|text|value|answer)?\b|图形验证码|圖片驗證碼|图片验证码|画像認証|画像認證|보안\s*문자|\b(?:image|picture|visual)\s+(?:verification\s+|security\s+)?code\b|\b(?:characters?|letters?|numbers?|code)\b.{0,40}\b(?:image|picture|shown|above|below)\b/i;
const codeWords=/\b(?:captcha|verify\s*code|verification\s*code|validation\s*code|validate\s*code|check\s*code|security\s*code|auth\s*code|vcode|seccode|imgcode|randcode|vertify|yanzhengma)\b|验证码|校验码|驗證碼|校驗碼|認証コード|인증\s*코드|\bcode\s+(?:de\s+)?(?:verification|securite)\b|\bcodigo\s+(?:de\s+)?(?:verificacion|verificacao|seguridad|seguranca)\b|\b(?:sicherheitscode|bestatigungscode)\b|код\s+(?:проверки|подтверждения)|رمز\s+التحقق/i;
const nonImageCode=/\b(?:otp|totp|sms|mfa|2fa|one\s*time|authenticator|recovery\s*code|backup\s*code|security\s*answer)\b|短信|动态码|动态密码|動態密碼|手机验证码|手機驗證碼|邮箱验证码|郵箱驗證碼|邮件验证码|二次验证|身份验证器|恢复码|復原碼|\b(?:email|e\s*mail|phone|mobile|text\s*message)\s+(?:verification\s+|security\s+)?code\b/i;
const otherField=/\b(?:search|query|coupon|voucher|promo|promotion|discount|postal|postcode|zip|order|tracking|cvv|cvc|card\s*security)\b|搜索|搜尋|优惠|優惠|折扣|订单|訂單|邮编|郵遞區號|物流|卡片安全/i;
const delivery=/\b(?:send|resend|get|request)\s+(?:(?:a|the|verification|security|new)\s+)*code\b|\bcode\b.{0,32}\b(?:sent|emailed|texted)\b|\b(?:sent|send)\b.{0,32}\b(?:email|phone|mobile)\b|发送验证码|發送驗證碼|获取验证码|獲取驗證碼|重新发送|重新發送|短信|郵件|邮件|\bresend\s+(?:in|after)\b/i;
const imageHelp=/看不清|换一张|換一張|\b(?:refresh|reload)\s+(?:the\s+)?(?:image|captcha)\b|\b(?:another|new|different)\s+(?:image|captcha)\b/i;
const unrelatedImage=/\b(?:logo|avatar|qrcode|qr\s*code|barcode|banner|icon|thumbnail|product|advertisement)\b|二维码|二維碼|条形码|條碼|头像|頭像/i;
const interactiveField='input:not([type=hidden]):not([type=submit]):not([type=button]),textarea,select';
function normalized(text:string){return text.replace(/([a-z])([A-Z])/g,'$1 $2').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[_\-./]+/g,' ').toLowerCase();}
function metadata(element:Element){return normalized([element.id,element.getAttribute('name'),element.getAttribute('class'),element.getAttribute('alt'),element.getAttribute('title'),element.getAttribute('aria-label')].filter(Boolean).join(' '));}
export function captchaVisible(element:Element){
  const rect=element.getBoundingClientRect();if(!element.isConnected||rect.width<=0||rect.height<=0||!element.getClientRects().length)return false;
  for(let node:Element|null=element;node;node=node.parentElement??((node.getRootNode() as ShadowRoot).host??null)){
    const style=getComputedStyle(node);if(node.hasAttribute('hidden')||node.hasAttribute('inert')||node.getAttribute('aria-hidden')==='true'||style.display==='none'||style.visibility!=='visible'||style.opacity==='0')return false;
  }
  return true;
}
function references(element:Element,attribute:string){
  const root=element.getRootNode() as Document|ShadowRoot;
  return (element.getAttribute(attribute)??'').split(/\s+/).filter(Boolean).slice(0,8).map(id=>root.getElementById(id)).filter((node):node is HTMLElement=>Boolean(node));
}
function fieldRegion(input:HTMLInputElement){
  let last:HTMLElement|null=null;
  for(let node=input.parentElement,depth=0;node&&depth<4;node=node.parentElement,depth++){
    if(node.matches('form,body,html')||node.querySelectorAll(interactiveField).length>1)break;
    last=node;if(node.querySelector('img,canvas'))break;
  }
  return last;
}
function imageName(image:CodeImage){
  // Query-string values often contain unrelated page text. Inspect only the URL
  // path and route parameter names/values commonly used for CAPTCHA endpoints.
  let route='';try{const source=image.getAttribute('src');if(source){const url=new URL(source,location.href);route=url.pathname+' '+['a','action','c','type'].map(key=>url.searchParams.get(key)??'').join(' ');}}catch{}
  return metadata(image)+' '+normalized(route);
}
export function findCaptchaTarget(input:HTMLInputElement):CaptchaTarget|null {
  if(input.disabled||input.readOnly||!['text','tel','number'].includes(input.type)||!captchaVisible(input))return null;
  const labelled=references(input,'aria-labelledby'),described=references(input,'aria-describedby');
  const field=normalized([input.name,input.id,input.placeholder,input.getAttribute('aria-label'),input.autocomplete,...Array.from(input.labels??[]).map(label=>label.textContent),...labelled.map(node=>node.textContent),...described.map(node=>node.textContent)].join(' '));
  if(nonImageCode.test(field)||otherField.test(field)||delivery.test(field))return null;
  const region=fieldRegion(input),local=normalized(region?.innerText??'');
  if(delivery.test(local)||nonImageCode.test(local))return null;
  const form=input.closest('form'),scope=form??region?.parentElement??region??input.parentElement;
  if(!scope)return null;
  const strongField=strongWords.test(field),codeField=strongField||codeWords.test(field);
  const localCode=strongWords.test(local)||codeWords.test(local);
  const visualLocal=strongWords.test(local)||localCode&&imageHelp.test(local);
  const related=[...labelled,...described,...references(input,'aria-controls')];
  if(!codeField&&!localCode&&!related.length&&!Array.from(region?.querySelectorAll<CodeImage>('img,canvas')??[]).slice(0,12).some(image=>strongWords.test(imageName(image))||codeWords.test(imageName(image))))return null;
  const rect=input.getBoundingClientRect();
  const candidates=Array.from(scope.querySelectorAll<CodeImage>('img,canvas')).slice(0,100).flatMap(image=>{
    if(image.closest('form')!==form||!captchaVisible(image))return [];
    const box=image.getBoundingClientRect(),ratio=box.width/box.height;
    if(box.width<24||box.width>600||box.height<14||box.height>200||ratio<1.2||ratio>12)return [];
    const name=imageName(image);if(unrelatedImage.test(name))return [];
    const named=strongWords.test(name)||codeWords.test(name);
    const association=related.some(node=>node===image||node.contains(image));
    const sameRegion=Boolean(region?.contains(image));
    // An image owned by another input row cannot be borrowed by this field.
    for(let owner=image.parentElement;owner&&owner!==scope;owner=owner.parentElement){
      const fields=owner.querySelectorAll(interactiveField);
      if(fields.length){if(!owner.contains(input))return [];break;}
    }
    const distance=Math.hypot((box.left+box.right-rect.left-rect.right)/2,(box.top+box.bottom-rect.top-rect.bottom)/2);
    const gapX=Math.max(0,box.left-rect.right,rect.left-box.right),gapY=Math.max(0,box.top-rect.bottom,rect.top-box.bottom);
    if(distance>500||gapX>250||gapY>180)return [];
    const adjacent=gapX<100&&gapY<75;
    // Math wording alone is not CAPTCHA evidence (calculators/homework).
    // A generic field needs an explicitly named image and a local relationship.
    if(!(codeField&&(named||association||strongField&&(adjacent||sameRegion)||sameRegion&&localCode&&adjacent)||visualLocal&&sameRegion&&adjacent||
      named&&(association||sameRegion&&adjacent)))return [];
    // Generic security/verification-code labels plus a nearby anonymous logo
    // are too weak. Require visual wording or an explicit image marker.
    if(!named&&!association&&!strongField&&!visualLocal)return [];
    return [{image,score:(association?8:0)+(named?6:0)+(sameRegion?3:0)+(adjacent?2:0),distance}];
  }).sort((a,b)=>b.score-a.score||a.distance-b.distance);
  if(!candidates.length)return null;
  // Distance breaks ordering, not ambiguity. Two equally plausible images need
  // an explicit association; never silently take the first DOM match.
  if(candidates[1]&&candidates[0].score-candidates[1].score<3)return null;
  return {input,image:candidates[0].image};
}

/** Inspect open component roots, with bounded work and no polling timer. */
export function captchaRoots():Array<Document|ShadowRoot>{
  const roots:Array<Document|ShadowRoot>=[document];let visited=0;
  for(let i=0;i<roots.length&&i<40&&visited<4000;i++){
    const walker=document.createTreeWalker(roots[i],NodeFilter.SHOW_ELEMENT);
    while(walker.nextNode()&&visited++<4000){const element=walker.currentNode as Element;if(element.id==='keypilot-captcha-root')continue;if(element.shadowRoot&&roots.length<40)roots.push(element.shadowRoot);}
  }
  return roots;
}
