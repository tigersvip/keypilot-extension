/** Development-only synthetic corpus. Labels are fixed before any inference. */
import {chromium} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {complexFixtures,renderComplex} from '../../tests/fixtures/captcha/complex';

const args=process.argv.slice(2),outIndex=args.indexOf('--out');
if(outIndex<0||!args[outIndex+1])throw new Error('Provide --out outside the repository.');
const root=resolve(args[outIndex+1]);await mkdir(root,{recursive:true});
const fonts=['Arial','Verdana','Georgia','Tahoma','Trebuchet MS','Courier New','Times New Roman','Segoe UI','Arial Black'];
const fixtures=complexFixtures(202611186,500).map((fixture,i)=>({...fixture,font:fonts[i%fonts.length]}));
await writeFile(resolve(root,'labels.json'),JSON.stringify(fixtures));
const browser=await chromium.launch({headless:true}),page=await browser.newPage();
try{
  for(const [i,fixture] of fixtures.entries()){
    const image=await page.evaluate(renderComplex,fixture);
    await writeFile(resolve(root,`${i}.png`),Buffer.from(image.split(',')[1],'base64'));
  }
  console.log(`Rendered ${fixtures.length} synthetic training images. Rendering depends on installed fonts.`);
}finally{await browser.close();}
