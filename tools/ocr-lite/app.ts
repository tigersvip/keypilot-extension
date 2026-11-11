import './styles.css';
import {gunzipSync} from 'fflate';
import {decodeTemplates,recognizeDigits,type DigitTemplate,type DigitResult,foreground,components,glyph,encodeTemplates} from '../../src/ocr-lite/digits';
const status=document.querySelector<HTMLElement>('#status')!,results=document.querySelector<HTMLElement>('#results')!,empty=document.querySelector<HTMLElement>('#empty')!,summary=document.querySelector<HTMLElement>('#summary')!;
const length=document.querySelector<HTMLSelectElement>('#length')!,files=document.querySelector<HTMLInputElement>('#files')!;
let templates:DigitTemplate[]=[];
let generation=0;
interface Entry {name:string;canvas:HTMLCanvasElement;truth:string;result:DigitResult;ms:number}
const entries:Entry[]=[];
function recognize(canvas:HTMLCanvasElement){return recognizeDigits(canvas.getContext('2d')!.getImageData(0,0,canvas.width,canvas.height),templates,length.value?Number(length.value):undefined);}
function updateSummary(){const labeled=entries.filter(entry=>/^[0-9]{2,10}$/.test(entry.truth)),correct=labeled.filter(entry=>entry.result.text===entry.truth).length;summary.textContent=labeled.length?`已核对 ${labeled.length} 张 · 整张正确 ${correct} 张 · 正确率 ${(correct/labeled.length*100).toFixed(1)}%（仅当前样本）`:`${entries.length} 张图片 · 填写正确答案后统计，留空不计入准确率`;}
function render(){
 results.replaceChildren();empty.hidden=entries.length>0;
 for(const entry of entries){
  const row=document.createElement('article');row.className='row';
  const original=document.createElement('div');original.className='original';const image=new Image();image.src=entry.canvas.toDataURL();image.alt=entry.name;original.append(image);
  const detail=document.createElement('div'),name=document.createElement('div');name.className='name';name.textContent=entry.name;
  const answer=document.createElement('div');answer.className='answer';answer.textContent=entry.result.text||'未得到完整结果';
  const hint=document.createElement('p');hint.className='hint'+(entry.result.state==='review'?'':' uncertain');hint.textContent=`${entry.result.reason} 用时 ${entry.ms.toFixed(0)} ms。`;
  const alternatives=document.createElement('p');alternatives.className='hint';alternatives.textContent=entry.result.alternatives.length?'其他候选：'+entry.result.alternatives.join(' / '):'';
  const truth=document.createElement('label');truth.className='truth';truth.append('正确答案');const input=document.createElement('input');input.type='text';input.inputMode='numeric';input.maxLength=10;input.value=entry.truth;input.autocomplete='off';input.setAttribute('aria-label','正确答案');
  const check=document.createElement('span');check.className='check';
  const update=()=>{entry.truth=input.value.trim();check.className='check';if(entry.truth&&!/^[0-9]{2,10}$/.test(entry.truth)){check.textContent='请输入 2–10 位数字';check.classList.add('bad');}else if(entry.truth){const correct=entry.truth===entry.result.text;check.textContent=correct?'整张正确':'不一致';check.classList.add(correct?'good':'bad');}else check.textContent='';updateSummary();};
  input.oninput=update;truth.append(input,check);detail.append(name,answer,hint,alternatives,truth);row.append(original,detail);results.append(row);update();
 }
 updateSummary();
}
function add(canvas:HTMLCanvasElement,name:string,truth=''){
 const start=performance.now(),result=recognize(canvas);entries.push({name,canvas,result,truth,ms:performance.now()-start});
}
files.onchange=()=>{void(async()=>{
 if(!templates.length)return;const request=++generation,selected=Array.from(files.files??[]).slice(0,Math.max(0,30-entries.length));
 const failures:string[]=[];let processed=0;status.textContent='正在本地处理图片…';
 for(const file of selected){
  if(request!==generation)return;
  try{if(!['image/png','image/jpeg','image/webp','image/bmp'].includes(file.type))throw new Error('请选择 PNG、JPEG、WebP 或 BMP 图片');if(file.size>5_000_000)throw new Error('图片超过 5 MB');const bitmap=await createImageBitmap(file);
   if(request!==generation){bitmap.close();return;}
   try{if(bitmap.width>1800||bitmap.height>600||bitmap.width<8||bitmap.height<8)throw new Error('请裁剪为验证码区域（8–1800 × 8–600 像素）');
    const canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;canvas.getContext('2d')!.drawImage(bitmap,0,0);add(canvas,file.name);processed++;
   }finally{bitmap.close();}
  }catch(error){failures.push(`${file.name}：${error instanceof Error?error.message:'无法读取图片'}`);}
  render();await new Promise(resolve=>setTimeout(resolve,0));
 }
 if(request===generation){files.value='';status.textContent=selected.length?`已处理 ${processed} 张。${failures.join('；')}`:'最多保留 30 张图片，请清空后继续。';}
 })();};
length.onchange=()=>{for(const entry of entries){const start=performance.now();entry.result=recognize(entry.canvas);entry.ms=performance.now()-start;}render();};
document.querySelector<HTMLButtonElement>('#clear')!.onclick=()=>{generation++;entries.length=0;files.value='';render();};
document.querySelector<HTMLButtonElement>('#demo')!.onclick=()=>{
 if(!templates.length||entries.length>28)return;
 for(const [text,font,dark] of [['1047','Georgia',false],['906125','Verdana',true]] as const){const canvas=document.createElement('canvas');canvas.width=200;canvas.height=58;const ctx=canvas.getContext('2d')!;ctx.fillStyle=dark?'#24394f':'#eff8ff';ctx.fillRect(0,0,200,58);ctx.fillStyle=dark?'#fff':'#684698';ctx.font=`32px ${font}`;ctx.textBaseline='middle';[...text].forEach((digit,i)=>ctx.fillText(digit,12+i*29,29));add(canvas,`演示 ${text}`,text);}
 render();
};
document.querySelector<HTMLButtonElement>('#background-demo')!.onclick=()=>{
 if(!templates.length||entries.length>26)return;
 for(const [kind,text] of [['渐变','1047'],['杂点','906125'],['浅色细线','9751'],['网格','4308']] as const){
  const canvas=document.createElement('canvas');canvas.width=200;canvas.height=58;const ctx=canvas.getContext('2d')!;
  const gradient=ctx.createLinearGradient(0,0,200,58);gradient.addColorStop(0,'#fff9eb');gradient.addColorStop(1,'#adbed3');
  ctx.fillStyle=kind==='渐变'?gradient:'#f2f8fc';ctx.fillRect(0,0,200,58);
  if(kind==='杂点'){ctx.fillStyle='#a9bdc9';for(let i=0;i<70;i++)ctx.fillRect(i*37%200,i*17%58,i%3?1:2,i%3?1:2);}
  if(kind==='浅色细线'||kind==='网格'){
   ctx.strokeStyle=kind==='网格'?'#97afbd':'#d7e2e9';ctx.lineWidth=1;
   for(let y=8;y<58;y+=8){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(200,y+4);ctx.stroke();}
   if(kind==='网格')for(let x=9;x<200;x+=18){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,58);ctx.stroke();}
  }
  ctx.fillStyle='#65428a';ctx.font='28px Tahoma';ctx.textBaseline='middle';[...text].forEach((digit,i)=>ctx.fillText(digit,12+i*29,29));add(canvas,`${kind}演示（合成图片）`,text);
 }
 render();
};
// Development-only entry points for reproducible template generation and evaluation.
(window as any).digitLab={foreground,components,glyph,encodeTemplates,decodeTemplates,recognizeDigits,get templates(){return templates;}};
try {const response=await fetch(new URL('../../src/ocr-lite/digits-v1.bin.gz',import.meta.url));if(!response.ok)throw new Error('MODEL_MISSING');const bytes=new Uint8Array(await response.arrayBuffer());
 // Vite's development server sets Content-Encoding: gzip; fetch then returns
 // decompressed bytes. The standalone build embeds the compressed file itself.
 const compressed=bytes[0]===31&&bytes[1]===139;templates=decodeTemplates(compressed?gunzipSync(bytes):bytes);
 status.textContent=`${compressed?`压缩模板 ${(bytes.byteLength/1024).toFixed(0)} KB`:`${templates.length.toLocaleString()} 个数字模板`} · 在本机运行 · 先验证数字，不保证真实网站准确率`;
}catch{status.textContent='数字模板加载失败，请重新打开原型；开发环境请检查模板文件。';}
