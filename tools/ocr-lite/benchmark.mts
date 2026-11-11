import {chromium} from '@playwright/test';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';

// Do not use the holdout results to tune the model or thresholds. The font lists
// and seeds are declared before evaluation; every image counts, including rejects.
const split=process.argv.includes('--holdout')?'holdout':'development';
const fonts=split==='holdout'?['Verdana','Georgia','Segoe UI','Calibri','Palatino Linotype','Cambria']:['Arial','Tahoma','Times New Roman','Consolas','Trebuchet MS','Courier New'];
const destination=resolve(process.env.TEMP??'.','keypilot-ocr-lite');await mkdir(destination,{recursive:true});
const baselineDir=resolve(process.env.KEYPILOT_OCR_BASELINE_DIR??'dist');
const baselineVersion=JSON.parse(await readFile(resolve(baselineDir,'manifest.json'),'utf8')).version;
console.log(JSON.stringify({baselineDir,baselineVersion}));
const context=await chromium.launchPersistentContext('',{channel:'chromium',headless:true,args:['--disable-extensions-except='+baselineDir,'--load-extension='+baselineDir,'--mute-audio']});
try {
 const worker=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker');
 const extensionPage=await context.newPage();await extensionPage.goto('chrome-extension://'+new URL(worker.url()).host+'/offscreen.html');
 const page=await context.newPage();await page.goto('http://127.0.0.1:4174');await page.waitForFunction(()=>(window as any).digitLab?.templates.length>0);
 let state=split==='holdout'?739391:13241;const random=()=>{state=(Math.imul(1664525,state)+1013904223)>>>0;return state/4294967296;};
 const samples=fonts.flatMap(font=>Array.from({length:20},(_,i)=>({font,id:`${font}-${i}`,text:Array.from({length:i%2?6:4},()=>String(Math.floor(random()*10))).join(''),size:16+Math.floor(random()*20),weight:i%3?'normal':'bold',angle:(random()-.5)*24,dark:i%4===0,spacing:3+Math.floor(random()*8),transparent:i%7===0})));
 const rows:any[]=[];
 for(const sample of samples){
  const lite=await page.evaluate(sample=>{
   const canvas=document.createElement('canvas');canvas.width=Math.ceil(sample.text.length*(sample.size*.8+sample.spacing)+16);canvas.height=Math.ceil(sample.size*1.7+12);const ctx=canvas.getContext('2d')!;
   if(!sample.transparent){ctx.fillStyle=sample.dark?'#273a48':'#f0f8fa';ctx.fillRect(0,0,canvas.width,canvas.height);}
   ctx.font=`${sample.weight} ${sample.size}px "${sample.font}"`;ctx.textBaseline='middle';ctx.fillStyle=sample.transparent?'#563b82':sample.dark?'#f5f5fc':'#834d97';
   [...sample.text].forEach((digit,i)=>{ctx.save();ctx.translate(8+i*(sample.size*.8+sample.spacing)+sample.size*.3,canvas.height/2);ctx.rotate((i%2?sample.angle:-sample.angle)*Math.PI/180);ctx.fillText(digit,0,0);ctx.restore();});
   const api=(window as any).digitLab,start=performance.now();const result=api.recognizeDigits(ctx.getImageData(0,0,canvas.width,canvas.height),api.templates);
   return {result,ms:performance.now()-start,image:canvas.toDataURL('image/png')};
  },sample);
  const start=Date.now();const baseline=await worker.evaluate(async image=>chrome.runtime.sendMessage({target:'keypilot-captcha-ocr',image,mode:'digits'}),lite.image);
  const row={...sample,lite:{...lite.result,correct:lite.result.text===sample.text,ms:lite.ms},baseline:{...baseline,correct:baseline?.candidates?.[0]?.text===sample.text,ms:Date.now()-start}};rows.push(row);
  if(!row.lite.correct||rows.length<=4)await writeFile(resolve(destination,`${split}-${rows.length}.png`),Buffer.from(lite.image.split(',')[1],'base64'));
  if(rows.length%20===0)console.log(JSON.stringify({split,done:rows.length,liteCorrect:rows.filter(row=>row.lite.correct).length,baselineCorrect:rows.filter(row=>row.baseline.correct).length}));
 }
 const summary={split,fonts,count:rows.length,seed:split==='holdout'?739391:13241,modelSha256:createHash('sha256').update(gunzipSync(await readFile('src/ocr-lite/digits-v1.bin.gz'))).digest('hex'),sourceSha256:createHash('sha256').update(await readFile('src/ocr-lite/digits.ts')).digest('hex'),liteCorrect:rows.filter(row=>row.lite.correct).length,baselineCorrect:rows.filter(row=>row.baseline.correct).length,liteRejected:rows.filter(row=>!row.lite.text).length,liteMsMean:rows.reduce((sum,row)=>sum+row.lite.ms,0)/rows.length,baselineMsMean:rows.reduce((sum,row)=>sum+row.baseline.ms,0)/rows.length,limitation:'Synthetic printed digits only; no user-provided real CAPTCHA samples. Not a real-world accuracy estimate.'};
 Object.assign(summary,{baselineVersion});
 await writeFile(resolve(destination,`${split}-baseline-${baselineVersion}.json`),JSON.stringify({summary,rows},null,2));console.log(JSON.stringify(summary));
}finally{await context.close();}
