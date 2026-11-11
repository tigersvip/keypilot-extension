import {chromium} from '@playwright/test';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
const fonts=['Arial','Tahoma','Times New Roman','Consolas','Trebuchet MS','Courier New'];
const browser=await chromium.launch({channel:'chromium',headless:true});
try {
 const page=await browser.newPage();await page.goto('http://127.0.0.1:4174');await page.waitForFunction(()=>Boolean((window as any).digitLab));
 const result=await page.evaluate(({fonts})=>{
  const api=(window as any).digitLab,templates:any[]=[];
  for(const font of fonts)for(const weight of ['normal','bold'])for(const style of ['normal','italic'])for(const size of [18,34])for(const angle of [-20,-10,0,10,20])for(let digit=0;digit<10;digit++){
   const canvas=document.createElement('canvas');canvas.width=100;canvas.height=100;const ctx=canvas.getContext('2d')!;
   ctx.fillStyle='white';ctx.fillRect(0,0,100,100);ctx.fillStyle='black';ctx.font=`${style} ${weight} ${size}px "${font}"`;ctx.textAlign='center';ctx.textBaseline='middle';ctx.translate(50,50);ctx.rotate(angle*Math.PI/180);ctx.fillText(String(digit),0,0);
   const mask=api.foreground(ctx.getImageData(0,0,100,100)),boxes=api.components(mask);
   if(boxes.length!==1)throw new Error(`Cannot form template ${font} ${digit} ${weight} ${style} ${size} ${angle}: ${JSON.stringify(boxes)}`);
   const glyph=api.glyph(mask,boxes[0]);templates.push({digit,aspect:glyph.aspect,features:glyph.features});
  }
  const bytes=api.encodeTemplates(templates);return {bytes:Array.from(bytes) as number[],count:templates.length};
 },{fonts});
 const bytes=Buffer.from(result.bytes),model=resolve('src/ocr-lite/digits-v1.bin.gz');await writeFile(model,gzipSync(bytes,{level:9}));
 const metadata={format:'KPD1',version:1,kind:'rendered-digit-templates',fonts,weights:['normal','bold'],styles:['normal','italic'],sizes:[18,34],angles:[-20,-10,0,10,20],count:result.count,bytes:bytes.length,gzipBytes:gzipSync(bytes,{level:9}).length,sha256:createHash('sha256').update(bytes).digest('hex'),note:'Generated from local system fonts through Chromium canvas. No font files are redistributed. Synthetic templates; real CAPTCHA accuracy is unverified.'};
 await writeFile(resolve('src/ocr-lite/digits-v1.json'),JSON.stringify(metadata,null,2)+'\n');console.log(JSON.stringify(metadata));
}finally{await browser.close();}
