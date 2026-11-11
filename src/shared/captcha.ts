export type CaptchaMode = 'auto' | 'alnum' | 'digits';
export interface CaptchaSiteRule { mode: CaptchaMode; expectedLength?: number; disabled?:boolean }
export interface CaptchaCandidate { text: string; confidence: number; expression?:string }
export interface CaptchaResult { ok: boolean; candidates?: CaptchaCandidate[]; error?: string; engine?: 'auto'|'digits-lite'|'tesseract'; uncertain?: boolean; reason?: string; arithmetic?:boolean }
export interface CaptchaCrop { x: number; y: number; width: number; height: number; viewportWidth: number; viewportHeight: number }
export const CAPTCHA_MAX_DATA = 2_000_000;
export function validCaptchaLength(value:unknown):value is number|undefined {
  return value===undefined||(typeof value==='number'&&Number.isInteger(value)&&value>=2&&value<=10);
}
export function validCaptchaText(text: string, mode: CaptchaMode, expectedLength?:number): boolean {
  return validCaptchaLength(expectedLength)&&(expectedLength===undefined||text.length===expectedLength)&&
    (mode === 'digits' ? /^[0-9]{2,10}$/ : mode === 'alnum' ? /^[a-zA-Z0-9]{2,10}$/ : /^[!-~]{2,10}$/).test(text);
}

/** General OCR determines the alphabet. Digit templates can corroborate it,
 * but their similarity scores are not comparable to OCR confidence values. */
export function assessAutoCaptcha(items:CaptchaCandidate[],digits:{text:string;alternatives:string[];uncertain:boolean},expectedLength?:number):CaptchaResult {
  const general=captchaCandidates(items,'auto',expectedLength);
  const best=general[0];
  const digit=validCaptchaText(digits.text,'digits',expectedLength)?digits.text:'';
  const numeric=Boolean(best&&/^\d+$/.test(best.text));
  const similar=Boolean(best&&digit.length===best.text.length&&[...digit].filter((char,i)=>char!==best.text[i]).length<=1);
  const allowDigit=Boolean(digit&&(!best||numeric||similar||best.confidence<65));
  const agreed=Boolean(best&&digit===best.text);
  const votes=best?items.filter(item=>Number.isFinite(item.confidence)&&item.text.replace(/\s/g,'')===best.text).length:0;
  const rival=Boolean(best&&general.slice(1).some(item=>item.confidence>=best.confidence-15||
    (item.text.length!==best.text.length&&item.confidence>=50)));
  const conflict=Boolean(allowDigit&&best&&digit!==best.text);
  const uncertain=!best||rival||conflict||(!(agreed&&!digits.uncertain)&&(votes<2||best.confidence<50));
  // A digit-only guess must never silently replace a letter/symbol reading.
  const preferDigit=allowDigit&&numeric&&best.confidence<65;
  const texts=[...(preferDigit?[digit]:[]),...general.map(item=>item.text),...(allowDigit?[digit]:[])];
  if(!best&&digit)texts.push(...digits.alternatives.filter(text=>validCaptchaText(text,'digits',expectedLength)));
  const candidates=[...new Set(texts)].filter(Boolean).slice(0,4).map(text=>({text,confidence:general.find(item=>item.text===text)?.confidence??0}));
  if(!candidates.length)return {ok:false,engine:'auto',error:expectedLength!==undefined&&captchaCandidates(items,'auto').length?'LENGTH_MISMATCH':'NO_RESULT'};
  return {ok:true,engine:'auto',candidates,uncertain,reason:uncertain
    ?'识别结果存在分歧或把握不足。请对照原图选择候选，或手动输入。'
    :'已自动识别，请核对大小写和符号后确认填写。'};
}
export function captchaCandidates(items: CaptchaCandidate[], mode: CaptchaMode, expectedLength?:number): CaptchaCandidate[] {
  const unique = new Map<string, { confidence: number; votes: number }>();
  for (const item of items) {
    const text = item.text.replace(/\s/g, '');
    if (!validCaptchaText(text, mode, expectedLength) || !Number.isFinite(item.confidence)) continue;
    const previous = unique.get(text);
    unique.set(text, {confidence:Math.max(previous?.confidence ?? 0, Math.min(100,Math.max(0,item.confidence))),votes:(previous?.votes ?? 0)+1});
  }
  return [...unique].sort((a,b)=>(b[1].confidence + Math.min(b[1].votes-1,2)*8)-(a[1].confidence + Math.min(a[1].votes-1,2)*8))
    .slice(0,3).map(([text,value])=>({text,confidence:Math.round(value.confidence)}));
}
export function validCaptchaCrop(crop: CaptchaCrop): boolean {
  return Boolean(crop && Object.values(crop).every(value=>Number.isFinite(value)) &&
    crop.x >= 0 && crop.y >= 0 && crop.width >= 16 && crop.width <= 900 && crop.height >= 12 && crop.height <= 300 &&
    crop.viewportWidth >= 100 && crop.viewportHeight >= 100 && crop.viewportWidth <= 10000 && crop.viewportHeight <= 10000 &&
    crop.x+crop.width <= crop.viewportWidth+1 && crop.y+crop.height <= crop.viewportHeight+1);
}
