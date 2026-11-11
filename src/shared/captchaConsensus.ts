import {validCaptchaText,type CaptchaResult,type CaptchaCandidate} from './captcha';

export interface NeuralReading { text:string; confidence:number; minimum:number; characters?:CaptchaCandidate[]; alternatives?:Array<{text:string;score:number}>; refinement?:NeuralReading; arithmetic?:NeuralReading }
export interface TextReading extends CaptchaCandidate { characters?:CaptchaCandidate[] }

/** Alternate views are correlated observations, not independent proof. Keep
 * strong original readings unless a complete text reading corroborates a rival. */
export function chooseNeuralReading(original:NeuralReading,alternates:NeuralReading[],texts:TextReading[],expectedLength?:number,preferred?:string):NeuralReading {
  const valid=(reading:NeuralReading)=>validCaptchaText(reading.text,'auto',expectedLength);
  const supported=(reading:NeuralReading)=>texts.some(item=>item.confidence>=45&&item.text.toLowerCase()===reading.text.toLowerCase());
  const strong=valid(original)&&original.minimum>=85&&original.confidence>=90;
  const inOriginalBeam=(reading:NeuralReading)=>original.alternatives?.some(item=>item.score>=.15&&item.text.toLowerCase()===reading.text.toLowerCase());
  const minimumLength=Math.max(valid(original)?original.text.length:0,preferred?.length??0);
  const pool=[original,...alternates].filter(reading=>valid(reading)&&reading.text.length>=minimumLength);
  const score=(reading:NeuralReading)=>reading.minimum*.6+reading.confidence*.4+(supported(reading)?12:0);
  const best=pool.sort((a,b)=>score(b)-score(a))[0];
  if(!best||best===original||best.minimum<80)return original;
  if(strong&&!supported(best)&&!inOriginalBeam(best))return original;
  if(!supported(best)&&!inOriginalBeam(best)&&alternates.filter(item=>item.text.toLowerCase()===best.text.toLowerCase()&&item.minimum>=65).length<2)return original;
  return !valid(original)||score(best)>=score(original)+8?best:original;
}

/** Compare disputed positions, not the average confidence of an entire word.
 * Only complete strings actually read from the image can become candidates. */
function reviewCandidate(preferred:string,neural:NeuralReading,readings:TextReading[],digit?:{text:string;uncertain:boolean}):string {
  if(preferred===digit?.text&&!digit.uncertain)return preferred;
  const distance=(a:string,b:string)=>[...a].filter((char,i)=>char.toLowerCase()!==b[i]?.toLowerCase()).length;
  const aligned=readings.filter(item=>item.text.length===preferred.length&&item.confidence>=20&&
    item.characters?.length===item.text.length&&item.characters.every((char,i)=>char.text===item.text[i]&&Number.isFinite(char.confidence))&&distance(item.text,preferred)<=1);
  if(!aligned.length)return preferred;
  const trusted=aligned.find(item=>item.confidence>=65&&item.characters!.every(char=>char.confidence>=90)&&
    aligned.filter(other=>other.text===item.text&&other.confidence>=65).length>=2);
  // Agreement across both engines protects a stable shape from repeated text
  // guesses. Multiple passes of one model are not independent engines.
  const rival=trusted?.text??preferred;
  const corroborated=neural.text.length===rival.length&&distance(neural.text,rival)===1&&
    aligned.some(item=>item.text===neural.text&&[...rival].every((char,i)=>char.toLowerCase()===neural.text[i].toLowerCase()||item.characters![i].confidence>=85))&&
    [...rival].every((char,i)=>char.toLowerCase()===neural.text[i].toLowerCase()||(neural.characters?.[i]?.confidence??0)>=80);
  if(corroborated)preferred=neural.text;
  else if(trusted)preferred=trusted.text;

  const options=[...new Set([preferred,...aligned.map(item=>item.text)])].filter(text=>distance(text,preferred)===0);
  const positions=[...preferred].map((_,i)=>i).filter(i=>options.some(text=>text[i]!==preferred[i]));
  if(positions.length){
    const caseEvidence=aligned.filter(item=>item.confidence>=60||aligned.filter(other=>other.text===item.text).length>=2);
    const support=(text:string)=>positions.reduce((sum,i)=>sum+Math.max(0,...caseEvidence.filter(item=>item.text[i]===text[i]&&distance(item.text,preferred)===0).map(item=>item.characters![i].confidence)),0)/positions.length;
    const ranked=options.sort((a,b)=>support(b)-support(a));
    if(support(ranked[0])>=85&&support(ranked[0])>=support(preferred)+5)preferred=ranked[0];
  }
  // A high word average must not conceal a very weak symbol at one position.
  const current=aligned.filter(item=>item.text===preferred);
  const replacement=aligned.find(item=>distance(item.text,preferred)===1&&item.characters!.every(char=>char.confidence>=90)&&
    current.length>0&&[...preferred].every((char,i)=>char===item.text[i]||current.every(other=>other.characters![i].confidence<70)));
  return replacement?.text??preferred;
}

/** CTC decoding preserves repeated characters separated by a blank. The scores
 * describe this model, and must not be compared numerically with Tesseract. */
export function decodeCaptchaSequence(logits:ArrayLike<number>,alphabet:readonly string[]):NeuralReading {
  if(alphabet[0]!==''||alphabet.length<2||!logits.length||logits.length%alphabet.length)throw new Error('MODEL_INVALID');
  let previous=0,text='';const scores:number[]=[];
  for(let offset=0;offset<logits.length;offset+=alphabet.length){
    let best=0;
    for(let j=0;j<alphabet.length;j++){
      if(!Number.isFinite(logits[offset+j]))throw new Error('MODEL_INVALID');
      if(logits[offset+j]>logits[offset+best])best=j;
    }
    let denominator=0;
    for(let j=0;j<alphabet.length;j++)denominator+=Math.exp(logits[offset+j]-logits[offset+best]);
    const score=1/denominator;
    if(best&&best!==previous){text+=alphabet[best];scores.push(score);}
    else if(best&&scores.length)scores[scores.length-1]=Math.max(scores.at(-1)!,score);
    previous=best;
  }
  return {text,confidence:scores.length?Math.exp(scores.reduce((sum,value)=>sum+Math.log(value),0)/scores.length)*100:0,minimum:scores.length?Math.min(...scores)*100:0,characters:[...text].map((char,i)=>({text:char,confidence:scores[i]*100}))};
}

/** Bounded CTC prefix search. Summing blank/repeat paths retains plausible
 * missing characters without splitting touching glyphs or forcing a length.
 * Scores are relative sequence support, not a calibrated accuracy percentage. */
export function decodeCaptchaAlternatives(logits:ArrayLike<number>,alphabet:readonly string[]):Array<{text:string;score:number}> {
  if(alphabet[0]!==''||alphabet.length<2||!logits.length||logits.length%alphabet.length)throw new Error('MODEL_INVALID');
  let beams=new Map<string,[number,number]>([['',[1,0]]]);
  for(let offset=0;offset<logits.length;offset+=alphabet.length){
    const scores=Array.from({length:alphabet.length},(_,i)=>logits[offset+i]);
    if(scores.some(value=>!Number.isFinite(value)))throw new Error('MODEL_INVALID');
    const maximum=Math.max(...scores),probabilities=scores.map(value=>Math.exp(value-maximum)),sum=probabilities.reduce((a,b)=>a+b,0);
    const symbols=probabilities.map((value,i)=>({i,p:value/sum})).sort((a,b)=>b.p-a.p).slice(0,5).filter(item=>item.i&&item.p>=.0001);
    const next=new Map<string,[number,number]>();
    const add=(text:string,blank:number,ink:number)=>{const current=next.get(text)??[0,0];current[0]+=blank;current[1]+=ink;next.set(text,current);};
    for(const [text,[blank,ink]] of beams){
      add(text,(blank+ink)*probabilities[0]/sum,0);
      for(const {i,p} of symbols){
        const repeated=text.endsWith(alphabet[i]);
        if(repeated)add(text,0,ink*p);
        if(text.length<10)add(text+alphabet[i],0,(repeated?blank:blank+ink)*p);
      }
    }
    const ranked=[...next].sort((a,b)=>(b[1][0]+b[1][1])-(a[1][0]+a[1][1])).slice(0,12),scale=ranked[0][1][0]+ranked[0][1][1];
    if(!Number.isFinite(scale)||scale<=0)return [];
    beams=new Map(ranked.map(([text,[blank,ink]])=>[text,[blank/scale,ink/scale]]));
  }
  return [...beams].map(([text,[blank,ink]])=>({text,score:blank+ink})).filter(item=>item.text.length>=2&&item.score>=.08).slice(0,8);
}

/** The CAPTCHA model is strong on rotated glyphs but unreliable on case. The
 * small text model reviews case/symbols; an independent digit reading can
 * corroborate a numeric result. Never manufacture a character substitution. */
export function combineCaptchaReadings(neural:NeuralReading,general:CaptchaResult,digit?:{text:string;uncertain:boolean},expectedLength?:number,observedLength?:number,readings:TextReading[]=[]):CaptchaResult {
  const text=validCaptchaText(neural.text,'auto',expectedLength)?neural.text:'';
  // Do not discard a compatible reading merely because the general engine's
  // top-three limit ranked it below an unrelated high-confidence word.
  const alternatives=(general.candidates??[]).filter(item=>validCaptchaText(item.text,'auto',expectedLength));
  for(const item of readings)if(validCaptchaText(item.text,'auto',expectedLength)&&Number.isFinite(item.confidence)&&!alternatives.some(other=>other.text===item.text))alternatives.push({text:item.text,confidence:item.confidence});
  if(!text&&!alternatives.length)return {ok:false,engine:'auto',error:expectedLength!==undefined&&validCaptchaText(neural.text,'auto')?'LENGTH_MISMATCH':general.error??'NO_RESULT'};
  const strong=neural.minimum>=80&&neural.confidence>=90;
  const sameCase=alternatives.find(item=>item.confidence>=45&&item.text.toLowerCase()===text.toLowerCase());
  const matchingPositions=(value:string)=>[...text].filter((char,i)=>char.toLowerCase()===value[i]?.toLowerCase()).length;
  const near=alternatives.find(item=>item.confidence>=45&&item.text.length===text.length&&matchingPositions(item.text)>=text.length-1);
  // Prefer an observed numeric reading only when every changed position is a
  // known lookalike. It remains a disagreement requiring explicit review.
  const numeric=alternatives.find(item=>/^\d+$/.test(item.text)&&item.text.length===text.length&&
    (item.confidence>=65||(item.text===digit?.text&&!digit.uncertain))&&
    [...text].every((char,i)=>char===item.text[i]||['0oO','1iIlL','5sS','8bB','2zZ'].some(group=>group.includes(char)&&group.includes(item.text[i]))));
  const fallback=alternatives[0]?.confidence>=65?alternatives[0].text:text;
  // Connected components undercount touching/overlapping characters. They
  // may expose a missing symbol, but must never force a complete line shorter.
  const complete=observedLength&&text.length<observedLength?alternatives.find(item=>item.text.length===observedLength&&item.confidence>=45):undefined;
  // A joined glyph can have a confident shorter greedy path. Two detailed text
  // readings plus a real CTC path can support the missing character.
  const extended=alternatives.find(item=>item.text.length>text.length&&
    neural.alternatives?.some(beam=>beam.score>=.08&&beam.text.toLowerCase()===item.text.toLowerCase())&&
    readings.filter(reading=>reading.text===item.text&&reading.confidence>=80&&Number.isFinite(reading.confidence)&&reading.characters?.length===item.text.length&&
      reading.characters.every((char,i)=>char.text===item.text[i]&&Number.isFinite(char.confidence)&&char.confidence>=90)).length>=2);
  // A review head can retain a joined glyph that the greedy path drops. Use
  // repeated, aligned text evidence only where that head is itself unsure;
  // a word-average confidence crossing a threshold must not erase the glyph.
  const refinement=neural.refinement;
  const reviewedComplete=refinement&&Number.isFinite(refinement.confidence)&&refinement.confidence>=80&&refinement.characters?.length===refinement.text.length
    ?alternatives.find(item=>item.text.length>text.length&&item.text.length===refinement.text.length&&
      refinement.characters!.every((char,i)=>char.text===refinement.text[i]&&Number.isFinite(char.confidence)&&
        (char.text.toLowerCase()===item.text[i].toLowerCase()||char.confidence<85))&&
      readings.filter(reading=>reading.text===item.text&&Number.isFinite(reading.confidence)&&reading.confidence>=65&&
        reading.characters?.length===item.text.length&&reading.characters.every((char,i)=>char.text===item.text[i]&&Number.isFinite(char.confidence)&&char.confidence>=90)).length>=2&&
      !readings.some(reading=>reading.text===text&&reading.confidence>=80&&reading.characters?.length===text.length&&
        reading.characters.every((char,i)=>char.text===text[i]&&Number.isFinite(char.confidence)&&char.confidence>=90)))
    :undefined;
  const beamSupported=!strong?alternatives.find(item=>item.confidence>=65&&item.text.length>=text.length&&neural.alternatives?.some(beam=>beam.score>=.15&&beam.text.toLowerCase()===item.text.toLowerCase())):undefined;
  const initial=!text?alternatives[0]?.text:complete?.text??extended?.text??reviewedComplete?.text??numeric?.text??sameCase?.text??beamSupported?.text??(!strong?(near?.text??fallback):text);
  const preferred=reviewCandidate(initial,neural,readings.filter(item=>validCaptchaText(item.text,'auto',expectedLength)),digit);
  const texts=[preferred,text,...alternatives.map(item=>item.text)].filter(Boolean);
  const candidates:CaptchaCandidate[]=[...new Set(texts)].slice(0,4).map(value=>({text:value,confidence:value===text?Math.round(neural.confidence):alternatives.find(item=>item.text===value)?.confidence??0}));
  const disagreed=Boolean(text&&alternatives[0]&&text!==alternatives[0].text);
  const uncertain=!strong||!text||disagreed||preferred!==initial||Boolean(complete)||Boolean(general.uncertain)||!alternatives.length;
  return {ok:true,engine:'auto',candidates,uncertain,reason:uncertain
    ?'识别结果存在分歧或把握不足。请对照原图核对大小写和符号，选择候选或手动输入。'
    :'已自动识别，请核对大小写和符号后确认填写。'};
}

/** Enhanced text views may review case only when the full shape agrees with a
 * neural observation. They cannot introduce arbitrary substitutions here. */
export function reviewEnhancedCase(result:CaptchaResult,neural:NeuralReading,originals:TextReading[],enhanced:TextReading[]):CaptchaResult {
  const preferred=result.candidates?.[0]?.text;
  if(!preferred||preferred.toLowerCase()!==neural.text.toLowerCase())return result;
  const supported=enhanced.filter(item=>item.text.toLowerCase()===preferred.toLowerCase()&&item.confidence>=65&&
    Number.isFinite(item.confidence)&&item.characters?.length===item.text.length&&item.characters.every((char,i)=>char.text===item.text[i]&&Number.isFinite(char.confidence)&&char.confidence>=85));
  if(!supported.length)return result;
  const reviewed=reviewCandidate(preferred,neural,[...originals,...supported]);
  if(reviewed===preferred||reviewed.toLowerCase()!==preferred.toLowerCase())return result;
  const candidates=[{text:reviewed,confidence:supported.find(item=>item.text===reviewed)?.confidence??result.candidates![0].confidence},...result.candidates!];
  return {...result,candidates:candidates.filter((item,i)=>candidates.findIndex(other=>other.text===item.text)===i).slice(0,4),uncertain:true,
    reason:'图片处理后的大小写读数存在分歧，请对照原图核对后填写。'};
}

/** A small trained output head shares the frozen encoder. It is additional
 * evidence, not an independent vote or a calibrated probability of correctness.
 * Keep punctuation and complete, strongly supported original shape readings. */
export function reviewSpecialist(result:CaptchaResult,refinement:NeuralReading|undefined,texts:TextReading[],expectedLength?:number):CaptchaResult {
  const preferred=result.candidates?.[0]?.text;
  if(!preferred||!refinement||!validCaptchaText(refinement.text,'auto',expectedLength)||!/^[a-zA-Z0-9]+$/.test(refinement.text)||
    refinement.text.length<preferred.length||!Number.isFinite(refinement.confidence)||!Number.isFinite(refinement.minimum)||
    refinement.confidence<70||refinement.minimum<40||refinement.text===preferred)return result;
  const supported=texts.some(item=>item.text===preferred&&item.confidence>=80&&Number.isFinite(item.confidence)&&
    item.characters?.length===preferred.length&&item.characters.every((char,i)=>char.text===preferred[i]&&char.confidence>=90&&Number.isFinite(char.confidence)));
  const differentShape=preferred.toLowerCase()!==refinement.text.toLowerCase();
  const promote=/^[a-zA-Z0-9]+$/.test(preferred)&&refinement.minimum>=80&&refinement.confidence>=90&&!(differentShape&&supported);
  const candidate={text:refinement.text,confidence:Math.round(refinement.confidence)};
  const candidates=promote?[candidate,...result.candidates!]:[result.candidates![0],candidate,...result.candidates!.slice(1)];
  return {...result,candidates:candidates.filter((item,i)=>candidates.findIndex(other=>other.text===item.text)===i).slice(0,4),uncertain:true,
    reason:'识别模型的读数存在分歧，请对照原图核对后填写。'};
}

/** Reuse already computed alternate views. Two agreeing complete observations
 * may rescue a weak original, but correlated views do not imply certainty. */
export function reviewSpecialistViews(result:CaptchaResult,original:NeuralReading,alternates:NeuralReading[],texts:TextReading[],expectedLength?:number):CaptchaResult {
  const reviewed=reviewSpecialist(result,original.refinement,texts,expectedLength),preferred=reviewed.candidates?.[0]?.text;
  if(!preferred)return reviewed;
  const views=[original,...alternates].flatMap(item=>item.refinement?[item.refinement]:[]);
  const pool=views.filter(item=>validCaptchaText(item.text,'auto',expectedLength)&&item.minimum>=80&&item.confidence>=90&&item.text.length>=preferred.length&&
    views.filter(other=>other.text===item.text&&other.minimum>=60&&other.confidence>=80).length>=2);
  const best=pool.sort((a,b)=>(b.minimum*.6+b.confidence*.4)-(a.minimum*.6+a.confidence*.4))[0];
  const stable=original.refinement?.text===preferred&&original.refinement.minimum>=80&&original.refinement.confidence>=90;
  return best&&(!stable||best.text.length>preferred.length)?reviewSpecialist(reviewed,best,texts,expectedLength):reviewed;
}
