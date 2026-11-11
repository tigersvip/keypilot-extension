import { createWorker, OEM, PSM, type Worker as TextWorker } from 'tesseract.js';
import { gunzipSync } from 'fflate';
import { decodeTemplates,recognizeDigits,type DigitTemplate,type Mask,type Pixels } from '../ocr-lite/digits';
import { CAPTCHA_MAX_DATA, assessAutoCaptcha, captchaCandidates, validCaptchaText, validCaptchaCrop, validCaptchaLength, type CaptchaCrop, type CaptchaMode, type CaptchaResult, type CaptchaCandidate } from '../shared/captcha';
import {combineCaptchaReadings,chooseNeuralReading,reviewEnhancedCase,reviewSpecialist,reviewSpecialistViews,type NeuralReading,type TextReading} from '../shared/captchaConsensus';
import {captchaReviewMasks,softCaptchaViews} from '../shared/captchaImage';
import {looksArithmetic,parseArithmeticCaptcha,recognizeArithmetic,type ArithmeticReading} from '../shared/captchaArithmetic';

let engine: TextWorker | undefined;
let initializing: Promise<TextWorker> | undefined;
let neuralWorker:Worker|undefined;
let rejectNeural:((error:Error)=>void)|undefined;
let neuralSequence=0;
let digitTemplates:Promise<DigitTemplate[]>|undefined;
function getDigitTemplates(){
  return digitTemplates??=fetch(chrome.runtime.getURL('ocr/digits-v1.bin.gz')).then(async response=>{
    if(!response.ok)throw new Error('MODEL_MISSING');
    const bytes=new Uint8Array(await response.arrayBuffer());
    return decodeTemplates(bytes[0]===31&&bytes[1]===139?gunzipSync(bytes):bytes);
  }).catch(error=>{digitTemplates=undefined;throw error;});
}
let epoch=0;
let busy = false;
let idle: ReturnType<typeof setTimeout> | undefined;
function canvas(width: number, height: number) {
  const element=document.createElement('canvas');element.width=Math.ceil(width);element.height=Math.ceil(height);return element;
}
async function dispose() {
  epoch++;digitTemplates=undefined;initializing=undefined;neuralWorker?.terminate();neuralWorker=undefined;
  rejectNeural?.(new Error('OCR_TIMEOUT'));rejectNeural=undefined;
  const current=engine;engine=undefined;await current?.terminate();
}
async function readNeural(source:HTMLCanvasElement,stretch=1,alternatives=false):Promise<NeuralReading>{
  const scaled=canvas(Math.max(2,Math.min(9600,Math.floor(source.width*64/source.height*stretch))),64),ctx=scaled.getContext('2d')!;
  ctx.fillStyle='#fff';ctx.fillRect(0,0,scaled.width,64);ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';ctx.drawImage(source,0,0,scaled.width,64);
  const rgba=ctx.getImageData(0,0,scaled.width,64).data,pixels=new Float32Array(scaled.width*64);
  for(let i=0;i<pixels.length;i++)pixels[i]=Math.round(.299*rgba[i*4]+.587*rgba[i*4+1]+.114*rgba[i*4+2])/255;
  const worker=neuralWorker??=new Worker(new URL('./captchaNeuralWorker.ts',import.meta.url),{type:'module'}),id=++neuralSequence;
  return new Promise((resolve,reject)=>{
    rejectNeural=reject;
    worker.onmessage=event=>{
      if(event.data?.id!==id)return;
      rejectNeural=undefined;
      if(event.data.ok)resolve(event.data.reading);else reject(new Error('OCR_FAILED'));
    };
    worker.onerror=event=>{event.preventDefault();rejectNeural=undefined;reject(new Error('OCR_FAILED'));};
    worker.postMessage({id,base:chrome.runtime.getURL('ocr/'),width:scaled.width,pixels,alternatives},[pixels.buffer]);
  });
}
async function getEngine() {
  if(engine)return engine;
  if(initializing)return initializing;
  const started=epoch;
  const pending=createWorker('eng',OEM.LSTM_ONLY,{
    workerPath:chrome.runtime.getURL('ocr/worker.min.js'),workerBlobURL:false,
    // Tiny images do not need multiple CPU builds. The portable LSTM core works
    // without SIMD; keeping one tested build bounds the offline package size.
    corePath:chrome.runtime.getURL('ocr/tesseract-core-lstm.js'),
    langPath:chrome.runtime.getURL('ocr'),gzip:true,cacheMethod:'none',
    errorHandler:()=>undefined
  },{load_system_dawg:'0',load_freq_dawg:'0',load_number_dawg:'0',load_punc_dawg:'0',load_unambig_dawg:'0',load_bigram_dawg:'0'})
    .then(async created=>{if(started!==epoch){await created.terminate();throw new Error('OCR_TIMEOUT');}engine=created;return created;})
    .finally(()=>{if(initializing===pending)initializing=undefined;});
  initializing=pending;
  return pending;
}
async function readImage(data: string, crop?: CaptchaCrop): Promise<HTMLCanvasElement> {
  if(typeof data!=='string'||!/^data:image\/(png|jpeg);base64,/.test(data)||data.length>(crop?30_000_000:CAPTCHA_MAX_DATA))throw new Error('IMAGE_INVALID');
  // Image.decode can wait for a rendering frame in an offscreen document.
  // Decode to a bitmap instead, which also works without a visible viewport.
  const bytes=Uint8Array.from(atob(data.slice(data.indexOf(',')+1)),char=>char.charCodeAt(0));
  const image=await createImageBitmap(new Blob([bytes],{type:data.startsWith('data:image/png')?'image/png':'image/jpeg'}));
  try {
    if(image.width*image.height>40_000_000)throw new Error('IMAGE_INVALID');
    if(crop){
      if(!validCaptchaCrop(crop))throw new Error('IMAGE_INVALID');
      const scaleX=image.width/crop.viewportWidth,scaleY=image.height/crop.viewportHeight;
      if(Math.abs(scaleX-scaleY)>0.05)throw new Error('CAPTURE_UNAVAILABLE');
      const result=canvas(crop.width,crop.height);
      result.getContext('2d')!.drawImage(image,crop.x*scaleX,crop.y*scaleY,crop.width*scaleX,crop.height*scaleY,0,0,result.width,result.height);
      return result;
    }
    if(image.width<16||image.height<12||image.width>1800||image.height>600)throw new Error('IMAGE_INVALID');
    const result=canvas(image.width,image.height);result.getContext('2d')!.drawImage(image,0,0);return result;
  } finally {image.close();}
}
function splitCharacters(mask: HTMLCanvasElement): HTMLCanvasElement[] {
  const {width,height}=mask,pixels=mask.getContext('2d')!.getImageData(0,0,width,height).data;
  const seen=new Uint8Array(width*height),parts:Array<{left:number;right:number;top:number;bottom:number;area:number}>=[];
  for(let start=0;start<seen.length;start++){
    if(seen[start]||pixels[start*4]>128)continue;
    const queue=[start];seen[start]=1;let left=width,right=0,top=height,bottom=0;
    for(let i=0;i<queue.length;i++){
      const at=queue[i],x=at%width,y=Math.floor(at/width);left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);
      for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){const nx=x+dx,ny=y+dy;if(nx>=0&&ny>=0&&nx<width&&ny<height){const next=ny*width+nx;if(!seen[next]&&pixels[next*4]<128){seen[next]=1;queue.push(next);}}}
    }
    if(queue.length>=3)parts.push({left,right,top,bottom,area:queue.length});
    if(parts.length>256)return [];
  }
  // Join disconnected dots with their letter rather than inventing another character.
  parts.sort((a,b)=>a.left-b.left);
  const joined:typeof parts=[];
  for(const part of parts){const previous=joined.at(-1);if(previous&&part.left<=previous.right){previous.right=Math.max(previous.right,part.right);previous.top=Math.min(previous.top,part.top);previous.bottom=Math.max(previous.bottom,part.bottom);previous.area+=part.area;}else joined.push({...part});}
  // Short glyphs such as '-' and '*' are real characters too. A height cutoff
  // erased them before single-character review and caused missing symbols.
  const letters=joined.filter(part=>part.area>=5);
  if(letters.length<2||letters.length>8||letters.some(part=>part.right-part.left>height))return [];
  const lineTop=Math.min(...letters.map(part=>part.top)),lineBottom=Math.max(...letters.map(part=>part.bottom));
  return letters.map(part=>{
    const w=part.right-part.left+1,h=part.bottom-part.top+1,scale=48/(lineBottom-lineTop+1);
    const image=canvas(Math.max(48,w*scale)+24,72),ctx=image.getContext('2d')!;
    ctx.fillStyle='#fff';ctx.fillRect(0,0,image.width,image.height);ctx.drawImage(mask,part.left,part.top,w,h,(image.width-w*scale)/2,12+(part.top-lineTop)*scale,w*scale,h*scale);return image;
  });
}
function variants(source: HTMLCanvasElement) {
  const scale=Math.min(4,Math.max(1,80/source.height),1200/source.width);
  const raw=canvas(source.width*scale+32,source.height*scale+32),ctx=raw.getContext('2d')!;
  ctx.fillStyle='#fff';ctx.fillRect(0,0,raw.width,raw.height);ctx.drawImage(source,16,16,source.width*scale,source.height*scale);
  const sourceCtx=source.getContext('2d')!,pixels=sourceCtx.getImageData(0,0,source.width,source.height);
  // Estimate the background from the border. Colour distance also retains
  // purple/blue characters whose luminance is close to a pale background.
  const border:number[][]=[[],[],[]];
  for(let y=0;y<source.height;y++)for(let x=0;x<source.width;x++)if(x<2||y<2||x>=source.width-2||y>=source.height-2){
    const at=(y*source.width+x)*4;for(let c=0;c<3;c++)border[c].push(pixels.data[at+c]);
  }
  const background=border.map(values=>values.sort((a,b)=>a-b)[Math.floor(values.length/2)]);
  const distances=new Uint8Array(source.width*source.height),histogram=new Array<number>(256).fill(0);
  for(let i=0;i<distances.length;i++){
    const d=Math.min(255,Math.round(Math.sqrt([0,1,2].reduce((sum,c)=>sum+(pixels.data[i*4+c]-background[c])**2,0)/3)));
    distances[i]=d;histogram[d]++;
  }
  let sum=0;for(let i=0;i<256;i++)sum+=i*histogram[i];
  let lowerWeight=0,lowerSum=0,best=0,threshold=35;
  for(let t=0;t<255;t++){
    lowerWeight+=histogram[t];lowerSum+=t*histogram[t];const upperWeight=distances.length-lowerWeight;
    if(!lowerWeight||!upperWeight)continue;
    const variance=lowerWeight*upperWeight*(lowerSum/lowerWeight-(sum-lowerSum)/upperWeight)**2;
    if(variance>best){best=variance;threshold=t;}
  }
  threshold=Math.max(22,threshold);
  for(let i=0;i<distances.length;i++){
    const value=distances[i]>threshold?0:255;pixels.data[i*4]=value;pixels.data[i*4+1]=value;pixels.data[i*4+2]=value;pixels.data[i*4+3]=255;
  }
  const mask=canvas(source.width,source.height);mask.getContext('2d')!.putImageData(pixels,0,0);
  const clean=canvas(raw.width,raw.height),cleanCtx=clean.getContext('2d')!;
  cleanCtx.fillStyle='#fff';cleanCtx.fillRect(0,0,clean.width,clean.height);cleanCtx.drawImage(mask,16,16,source.width*scale,source.height*scale);
  return {images:[raw,clean],letters:splitCharacters(mask)};
}
function reviewLine(letters:HTMLCanvasElement[]):HTMLCanvasElement {
  // Retain relative height, dots and baseline while reducing excessive gaps.
  // This extra pass is used only when the first readings disagree.
  const bounds=letters.map(letter=>{
    const pixels=letter.getContext('2d')!.getImageData(0,0,letter.width,letter.height).data;let left=letter.width,right=0;
    for(let y=0;y<letter.height;y++)for(let x=0;x<letter.width;x++)if(pixels[(y*letter.width+x)*4]<128){left=Math.min(left,x);right=Math.max(right,x);}
    return {left,width:right-left+1};
  });
  const line=canvas(24+bounds.reduce((sum,box)=>sum+box.width+6,0),72),ctx=line.getContext('2d')!;
  ctx.fillStyle='#fff';ctx.fillRect(0,0,line.width,line.height);let x=12;
  letters.forEach((letter,i)=>{const box=bounds[i];ctx.drawImage(letter,box.left,0,box.width,72,x,0,box.width,72);x+=box.width+6;});
  return line;
}
function maskCanvas(mask:Mask):HTMLCanvasElement {
  const result=canvas(mask.width,mask.height),ctx=result.getContext('2d')!,pixels=ctx.createImageData(mask.width,mask.height);
  for(let i=0;i<mask.data.length;i++){const v=mask.data[i]?0:255,at=i*4;pixels.data[at]=v;pixels.data[at+1]=v;pixels.data[at+2]=v;pixels.data[at+3]=255;}
  ctx.putImageData(pixels,0,0);
  let left=mask.width,right=0,top=mask.height,bottom=0;
  for(let y=0;y<mask.height;y++)for(let x=0;x<mask.width;x++)if(mask.data[y*mask.width+x]){left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);}
  if(left>right)return result;
  const cropped=canvas(right-left+17,bottom-top+17),croppedCtx=cropped.getContext('2d')!;
  croppedCtx.fillStyle='#fff';croppedCtx.fillRect(0,0,cropped.width,cropped.height);croppedCtx.drawImage(result,left,top,right-left+1,bottom-top+1,8,8,right-left+1,bottom-top+1);
  return cropped;
}
function softCanvas(pixels:Pixels,crop:boolean):HTMLCanvasElement {
  const result=canvas(pixels.width,pixels.height);result.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(pixels.data),pixels.width,pixels.height),0,0);
  if(!crop)return result;
  let left=pixels.width,right=-1,top=pixels.height,bottom=-1;
  for(let y=0;y<pixels.height;y++)for(let x=0;x<pixels.width;x++)if(pixels.data[(y*pixels.width+x)*4]<128){left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);}
  if(right<left)return result;
  const cropped=canvas(right-left+17,bottom-top+17),ctx=cropped.getContext('2d')!;
  ctx.fillStyle='#fff';ctx.fillRect(0,0,cropped.width,cropped.height);ctx.drawImage(result,left,top,right-left+1,bottom-top+1,8,8,right-left+1,bottom-top+1);return cropped;
}
export async function recognizeCaptcha(data: string, mode: CaptchaMode, crop?: CaptchaCrop, expectedLength?:number,arithmeticHint=false): Promise<CaptchaResult> {
  if(!validCaptchaLength(expectedLength))return {ok:false,error:'RULE_INVALID'};
  if(busy)return {ok:false,error:'BUSY'};
  busy=true;clearTimeout(idle);
  const started=epoch;
  const active=()=>{if(started!==epoch)throw new Error('OCR_TIMEOUT');};
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const work=(async():Promise<CaptchaResult>=>{
      const source=await readImage(data,crop);
      active();
      const pixels=source.getContext('2d')!.getImageData(0,0,source.width,source.height);
      const minimum=[255,255,255],maximum=[0,0,0];
      for(let i=0;i<pixels.data.length;i+=4)for(let c=0;c<3;c++){
        const value=pixels.data[i+c]*(pixels.data[i+3]/255)+255*(1-pixels.data[i+3]/255);
        minimum[c]=Math.min(minimum[c],value);maximum[c]=Math.max(maximum[c],value);
      }
      if(maximum.every((value,c)=>value-minimum[c]<8))return {ok:false,error:'NO_RESULT'};
      if(mode==='digits'){
        const result=recognizeDigits(pixels,await getDigitTemplates(),expectedLength);
        if(!result.text)return {ok:false,engine:'digits-lite',error:result.state==='length-mismatch'?'LENGTH_MISMATCH':'NO_RESULT',reason:result.reason};
        return {ok:true,engine:'digits-lite',uncertain:result.state==='uncertain',reason:result.reason,
          candidates:[result.text,...result.alternatives].map(text=>({text,confidence:0}))};
      }
      const digitResult=mode==='auto'?recognizeDigits(pixels,await getDigitTemplates(),expectedLength):undefined;
      active();
      const neural=mode==='auto'?await readNeural(source,1,true):undefined;
      active();
      const {images,letters}=variants(source),worker=await getEngine();
      active();
      // Automatic mode must not constrain letters/symbols to the digit alphabet.
      await worker.setParameters({tessedit_char_whitelist:mode==='auto'?'':'0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',user_defined_dpi:'150'});
      const candidates:TextReading[]=[];
      const readText=async(image:HTMLCanvasElement,psm:PSM)=>{
        await worker.setParameters({tessedit_pageseg_mode:psm});
        const {data:result}=await worker.recognize(image.toDataURL('image/png'),{}, {text:true,blocks:true});active();
        const characters=result.blocks?.flatMap(block=>block.paragraphs.flatMap(paragraph=>paragraph.lines.flatMap(line=>line.words.flatMap(word=>word.symbols.map(symbol=>({text:symbol.text,confidence:symbol.confidence}))))));
        candidates.push({text:result.text.replace(/\s/g,''),confidence:result.confidence,characters});
      };
      const passes:Array<readonly [HTMLCanvasElement,PSM]>=[[images[0],PSM.SINGLE_LINE],[images[1],PSM.SINGLE_LINE],[images[1],PSM.SINGLE_WORD],[images[0],PSM.RAW_LINE]];
      for(const [image,psm] of passes)await readText(image,psm);
      // Infer arithmetic from unrestricted observations before applying a math
      // alphabet. A restricted head alone cannot turn random letters into sums.
      const observed=[...candidates.map(item=>item.text),neural?.text??''];
      if(mode==='auto'&&(arithmeticHint||observed.some(text=>looksArithmetic(text)||parseArithmeticCaptcha(text)))){
        const unrestrictedCount=candidates.length;
        const mathViews:NeuralReading[]=neural?[neural]:[];
        await worker.setParameters({tessedit_char_whitelist:'0123456789+-*/=xX?×÷−()'});
        for(const image of [images[0],softCanvas(softCaptchaViews(pixels)[0],false)]){
          await readText(image,PSM.SINGLE_LINE);
          mathViews.push(await readNeural(image));active();
        }
        const readings:ArithmeticReading[]=[...candidates.map((item,i)=>({...item,source:i<unrestrictedCount?'text' as const:'focused' as const})),
          ...mathViews.flatMap(item=>[{...item,source:'neural' as const},...(item.arithmetic?[{...item.arithmetic,source:'arithmetic' as const}]:[])])];
        const solved=recognizeArithmetic(readings,arithmeticHint);
        if(solved)return solved;
        if(arithmeticHint||observed.some(looksArithmetic))return {ok:false,engine:'auto',arithmetic:true,error:'ARITHMETIC_UNCLEAR'};
        candidates.length=unrestrictedCount;
        await worker.setParameters({tessedit_char_whitelist:''});
      }
      // Keep each character's original height and baseline relative to its line.
      if(letters.length&&!(candidates.every(candidate=>candidate.text.trim()===candidates[0].text.trim())&&candidates[0].confidence>85)){
        await readText(reviewLine(letters),PSM.SINGLE_LINE);
        let text='',confidence=0,valid=true;const characters:CaptchaCandidate[]=[];
        await worker.setParameters({tessedit_pageseg_mode:PSM.SINGLE_CHAR});
        for(const letter of letters){const {data:part}=await worker.recognize(letter.toDataURL('image/png'),{},{text:true});active();const value=part.text.trim();if(!(mode==='auto'?/^[!-~]$/:/^[a-zA-Z0-9]$/).test(value)){valid=false;break;}text+=value;confidence+=part.confidence;characters.push({text:value,confidence:part.confidence});}
        if(valid)candidates.push({text,confidence:confidence/letters.length,characters});
      }
      if(digitResult){
        let result=assessAutoCaptcha(candidates,{text:digitResult.text,alternatives:digitResult.alternatives,uncertain:digitResult.state==='uncertain'},expectedLength);
        if(!result.ok&&digitResult.state==='length-mismatch')result.error='LENGTH_MISMATCH';
        if(!neural)return result;
        const digit={text:digitResult.text,uncertain:digitResult.state==='uncertain'||!digitResult.text};
        const initial=combineCaptchaReadings(neural,result,digit,expectedLength,letters.length||undefined,candidates);
        if(initial.ok&&neural.minimum>=85&&neural.text.length>=2&&letters.length>=neural.text.length)return reviewSpecialist(initial,neural.refinement,candidates,expectedLength);
        const originalReadings=[...candidates],originalResult=result;
        const alternates:NeuralReading[]=[];
        // Bound extra work: two masks, one stretch and two continuous views. No
        // destructive edits to the source and no retry loop on live websites.
        try{
          const masks=captchaReviewMasks(pixels);
          for(const mask of masks){
            const image=maskCanvas(mask);alternates.push(await readNeural(image));active();
            await readText(image,PSM.SINGLE_LINE);
          }
          if(masks[0]){alternates.push(await readNeural(maskCanvas(masks[0]),1.4));active();}
          for(const [i,view] of softCaptchaViews(pixels).entries()){
            const image=softCanvas(view,i===1);alternates.push(await readNeural(image));active();await readText(image,PSM.SINGLE_LINE);
          }
        }catch{active();await dispose();return reviewSpecialist(initial,neural.refinement,originalReadings,expectedLength);}
        const preferred=initial.candidates?.[0]?.text;
        const selected=chooseNeuralReading(neural,alternates,candidates,expectedLength,preferred);
        // Case-only differences must not discard the original glyph review.
        // New noisy text passes cannot overrule the untouched image's evidence.
        let combined=selected.text===neural.text||selected.text.toLowerCase()===preferred?.toLowerCase()?{...initial}:combineCaptchaReadings(selected,originalResult,digit,expectedLength,undefined,originalReadings);
        combined=reviewEnhancedCase(combined,selected,originalReadings,candidates.slice(originalReadings.length));
        const extra=alternates.filter(item=>validCaptchaText(item.text,'auto',expectedLength)&&item.text.length>=(preferred?.length??0))
          .sort((a,b)=>(b.minimum*.6+b.confidence*.4)-(a.minimum*.6+a.confidence*.4)).map(item=>({text:item.text,confidence:Math.round(item.confidence)}));
        const beam=(neural.alternatives??[]).filter(item=>validCaptchaText(item.text,'auto',expectedLength)&&item.text.length>=(combined.candidates?.[0]?.text.length??0)).map(item=>({text:item.text,confidence:0}));
        const ordered=[...(combined.candidates?.slice(0,1)??[]),...(initial.candidates?.slice(0,1)??[]),...beam,...extra,...(combined.candidates?.slice(1)??[]),...(initial.candidates?.slice(1)??[])];
        combined.candidates=ordered.filter((item,i)=>ordered.findIndex(other=>other.text===item.text)===i).slice(0,4);
        if(combined.candidates.length){combined.ok=true;delete combined.error;}
        if(selected!==neural||[...beam,...extra].some(item=>item.text!==preferred)){combined.uncertain=true;combined.reason='图片处理后的读数存在分歧，请对照原图核对后填写。';}
        return reviewSpecialistViews(combined,neural,alternates,candidates,expectedLength);
      }
      const ranked=captchaCandidates(candidates,mode,expectedLength);
      return ranked.length?{ok:true,engine:'tesseract',candidates:ranked}:{ok:false,error:expectedLength!==undefined&&captchaCandidates(candidates,mode).length?'LENGTH_MISMATCH':'NO_RESULT'};
    })();
    return await Promise.race([work,new Promise<CaptchaResult>((_,reject)=>{timeout=setTimeout(()=>reject(new Error('OCR_TIMEOUT')),25000);})]);
  } catch(error) {
    await dispose();
    return {ok:false,error:error instanceof Error&&['OCR_TIMEOUT','IMAGE_INVALID','CAPTURE_UNAVAILABLE'].includes(error.message)?error.message:'OCR_FAILED'};
  } finally {clearTimeout(timeout);busy=false;idle=setTimeout(()=>{void dispose();},60000);}
}

chrome.runtime.onMessage.addListener((message,sender,respond)=>{
  if(message?.target==='keypilot-captcha-crop'&&sender.id===chrome.runtime.id&&!sender.tab){
    void readImage(message.image,message.crop).then(image=>respond({ok:true,image:image.toDataURL('image/png')})).catch(()=>respond({ok:false,error:'CAPTURE_UNAVAILABLE'}));return true;
  }
  if(message?.target!=='keypilot-captcha-ocr'||sender.id!==chrome.runtime.id||sender.tab)return;
  void recognizeCaptcha(message.image,message.mode==='digits'?'digits':message.mode==='alnum'?'alnum':'auto',message.crop,message.expectedLength,message.arithmeticHint===true).then(respond);
  return true;
});
