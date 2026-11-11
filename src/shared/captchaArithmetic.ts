import type {CaptchaCandidate,CaptchaResult} from './captcha';
export const ARITHMETIC_ALPHABET=['',...'0123456789+-*/=?'];

export interface ArithmeticReading {text:string;confidence:number;minimum?:number;source:'text'|'focused'|'neural'|'arithmetic'}
export interface ArithmeticExpression {expression:string;answer:string;marked:boolean;ambiguousLetter:boolean}
const normalize=(text:string)=>text.normalize('NFKC').replace(/\s/g,'').replace(/[−–﹣]/g,'-').replace(/[×✕✖]/g,'*').replace(/÷/g,'/');

/** Deliberately small grammar: two integer operands, one operator and optional
 * answer marker. Never eval OCR text or round a non-terminating division. */
export function parseArithmeticCaptcha(text:string):ArithmeticExpression|undefined {
  if(typeof text!=='string'||text.length>64)return;
  const normalized=normalize(text),match=/^([+-]?\d{1,4})([+*/xX-])([+-]?\d{1,4})(?:=(?:\?|\(\?\)|\(\))?|\?)?$/.exec(normalized);
  if(!match)return;
  const a=BigInt(match[1]),b=BigInt(match[3]),op=match[2].toLowerCase()==='x'?'*':match[2];let answer:string;
  if(op==='+')answer=String(a+b);
  else if(op==='-')answer=String(a-b);
  else if(op==='*')answer=String(a*b);
  else {
    if(b===0n)return;
    const negative=(a<0n)!==(b<0n),numerator=a<0n?-a:a,denominator=b<0n?-b:b;
    let rest=numerator%denominator;answer=String(numerator/denominator);
    if(rest){answer+='.';for(let i=0;i<6&&rest;i++){rest*=10n;answer+=String(rest/denominator);rest%=denominator;}}
    if(rest)return;
    if(negative&&numerator!==0n)answer='-'+answer;
  }
  if(answer.length>10)return;
  const display=op==='*'?'×':op==='/'?'÷':op==='-'?'−':'+';
  return {expression:`${a} ${display} ${b}`,answer,marked:/[=?×÷✕✖]/.test(text.normalize('NFKC')),ambiguousLetter:/[xX]/.test(match[2])};
}

export function looksArithmetic(text:string):boolean {
  if(typeof text!=='string'||text.length>64)return false;
  const normalized=normalize(text);
  return /^[\d+*/xX=?.()-]+$/.test(normalized)&&/[+*/xX-]/.test(normalized)&&/\d.*\d/.test(normalized)&&/[=?]/.test(normalized);
}

/** A restricted math head cannot declare an arbitrary letter image arithmetic.
 * Require equation evidence from an unrestricted reading or the field label. */
export function recognizeArithmetic(readings:ArithmeticReading[],hint=false):CaptchaResult|undefined {
  const usable=readings.filter(item=>Number.isFinite(item.confidence)&&item.confidence>=35&&
    (item.source==='text'||item.source==='focused'||Number.isFinite(item.minimum)&&item.minimum!>=50&&item.confidence>=80));
  const observed=readings.filter(item=>(item.source==='text'||item.source==='neural')&&Number.isFinite(item.confidence));
  const intent=hint||observed.some(item=>looksArithmetic(item.text)||parseArithmeticCaptcha(item.text)?.marked);
  const parsed=usable.map(item=>({item,formula:parseArithmeticCaptcha(item.text)})).filter((pair):pair is {item:ArithmeticReading;formula:ArithmeticExpression}=>Boolean(pair.formula));
  const groups=[...new Set(parsed.map(pair=>pair.formula.expression))].map(expression=>{
    const group=parsed.filter(pair=>pair.formula.expression===expression),formula=group[0].formula;
    const unrestricted=group.filter(pair=>pair.item.source==='text'||pair.item.source==='neural');
    const strong=group.some(pair=>pair.item.source==='text'||pair.item.source==='focused'?pair.item.confidence>=65:pair.item.confidence>=92&&pair.item.minimum!>=80);
    const marked=group.some(pair=>pair.formula.marked);
    const supported=(intent&&(strong&&(unrestricted.length>0||hint)||group.length>=2))||
      (marked&&unrestricted.some(pair=>pair.item.confidence>=65))||
      (!formula.ambiguousLetter&&unrestricted.length>=2&&unrestricted.every(pair=>pair.item.confidence>=50));
    const sources=new Set(group.map(pair=>pair.item.source==='focused'?'text':pair.item.source)).size;
    const trainedReadings=group.filter(pair=>pair.item.source==='arithmetic'&&pair.item.minimum!>=50&&pair.item.confidence>=85);
    const trained=trainedReadings.length>=2&&trainedReadings.some(pair=>pair.item.minimum!>=60);
    return {formula,group,supported,rank:(trained?1000:0)+sources*100+Math.min(group.length,4)*10+Math.max(...group.map(pair=>pair.item.confidence))/10};
  }).filter(group=>group.supported).sort((a,b)=>b.rank-a.rank);
  if(!groups.length)return;
  const candidates:CaptchaCandidate[]=groups.map(({formula,group})=>({text:formula.answer,expression:formula.expression,confidence:Math.round(Math.max(...group.map(pair=>pair.item.confidence)))}))
    .filter((candidate,i,items)=>items.findIndex(other=>other.text===candidate.text)===i).slice(0,4);
  return {ok:true,engine:'auto',arithmetic:true,candidates,uncertain:groups.length>1||groups[0].group.length<2,
    reason:'已自动计算，请核对算式后确认填写。'};
}
