import {chromium} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {arithmeticFixtures,renderArithmetic} from '../../tests/fixtures/captcha/arithmetic';
const args=process.argv.slice(2),value=(name:string)=>args[args.indexOf(name)+1];
if(!args.includes('--out'))throw new Error('Provide --out outside the repository.');
const out=resolve(value('--out')),extension=resolve(args.includes('--extension')?value('--extension'):'dist');
const seed=Number(args.includes('--seed')?value('--seed'):202611187),count=Number(args.includes('--count')?value('--count'):20);
if(!Number.isSafeInteger(seed)||!Number.isInteger(count)||count<1||count>1000)throw new Error('Invalid seed/count');
const fonts=args.includes('--fonts')?value('--fonts')?.split(',').map(font=>font.trim()):undefined;
if(fonts&&(!fonts.length||fonts.some(font=>!font||font.length>64||/["\\]/.test(font))))throw new Error('Invalid fonts');
const fixtures=arithmeticFixtures(seed,count).map((fixture,i)=>fonts?{...fixture,font:fonts[i%fonts.length]}:fixture);await mkdir(out,{recursive:true});
if(args.includes('--render-only')){
  const browser=await chromium.launch({headless:true}),page=await browser.newPage();
  try{for(const [i,fixture] of fixtures.entries()){
    const image=await page.evaluate(renderArithmetic,fixture);await writeFile(resolve(out,`${i}.png`),Buffer.from(image.split(',')[1],'base64'));
  }await writeFile(resolve(out,'labels.json'),JSON.stringify(fixtures,null,2));console.log(`Rendered ${fixtures.length} images.`);}finally{await browser.close();}
}else{
  const context=await chromium.launchPersistentContext('',{channel:'chromium',headless:true,args:['--disable-extensions-except='+extension,'--load-extension='+extension]});
  try{
    const worker=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker'),page=await context.newPage();await page.goto('chrome-extension://'+new URL(worker.url()).host+'/offscreen.html');await context.setOffline(true);
    const rows=[];
    for(const [i,fixture] of fixtures.entries()){
      const image=await page.evaluate(renderArithmetic,fixture),started=performance.now();
      const result=await worker.evaluate(image=>chrome.runtime.sendMessage({target:'keypilot-captcha-ocr',image,mode:'auto'}),image);
      rows.push({...fixture,result,ms:performance.now()-started});await writeFile(resolve(out,`${i}.png`),Buffer.from(image.split(',')[1],'base64'));
    }
    const summary=['+','-','*','/'].map(operator=>{const a=rows.filter(r=>r.operator===operator);return {operator,total:a.length,first:a.filter(r=>r.result.candidates?.[0]?.text===r.answer).length,any:a.filter(r=>r.result.candidates?.some((c:{text:string})=>c.text===r.answer)).length};});
    await writeFile(resolve(out,'results.json'),JSON.stringify({seed,fonts,summary,rows},null,2));console.log(JSON.stringify(summary));
  }finally{await context.close();}
}
