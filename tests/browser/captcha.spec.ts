import {test,expect,chromium,type BrowserContext,type Worker,type Page} from '@playwright/test';
import {resolve} from 'node:path';
import {mkdir,readFile} from 'node:fs/promises';
import {createEmptyVault} from '../../src/shared/defaults';
import {createEncryptedVault,exportVaultKey} from '../../src/shared/crypto';
import {generateSaveInboxKeyPair} from '../../src/shared/saveInbox';
import {buildReminderIndex} from '../../src/shared/reminders';
import type {CaptchaSiteRule} from '../../src/shared/captcha';

let context:BrowserContext,worker:Worker,base:string;
const evidence=resolve(process.env.TEMP??'..','keypilot-captcha-v1.8.8');
const fixture=`<!doctype html><meta charset="utf-8"><title>KeyPilot Synthetic OCR</title>
<style>body{font:16px Arial;background:#f4f6fa;padding:24px;margin:0}main{max-width:440px;background:white;padding:24px}input{height:40px;font:17px Arial;max-width:100%;width:220px}label{display:block;margin-bottom:12px}canvas,img{max-width:100%}form>button{margin-top:65px}</style>
<main><h1>本地识别测试</h1><form><label>账号<input name="username" autocomplete="username"></label><label>密码<input name="password" type="password"></label><label>图形验证码<input id="captcha" inputmode="numeric" autocomplete="off"></label><canvas id="captcha-image" width="180" height="56"></canvas><br><button>登录</button></form><p id="submitted">0</p></main>
<script>window.drawCaptcha=(text='4827',dark=false)=>{const c=document.querySelector('canvas'),x=c.getContext('2d');x.fillStyle=dark?'#18334a':'#f2fbfc';x.fillRect(0,0,c.width,c.height);x.textBaseline='middle';x.font='bold 30px Arial';x.fillStyle=dark?'#f5f5f5':'#873f93';[...text].forEach((char,i)=>{x.save();x.translate(20+i*(145/text.length),28);x.rotate([-.16,.1,-.1,.18,-.06,.13][i]);x.fillText(char,0,0);x.restore()})};drawCaptcha();document.querySelector('form').onsubmit=e=>{e.preventDefault();document.querySelector('#submitted').textContent=String(Number(document.querySelector('#submitted').textContent)+1)}</script>`;
test.beforeEach(async()=>{
 const extension=resolve('dist');context=await chromium.launchPersistentContext('',{channel:'chromium',headless:true,args:['--disable-extensions-except='+extension,'--load-extension='+extension,'--mute-audio']});
 worker=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker');base='chrome-extension://'+new URL(worker.url()).host;
 await context.route('http://127.0.0.1:4173/captcha-lab**',route=>route.fulfill({contentType:'text/html',body:fixture}));await mkdir(evidence,{recursive:true});
});
test.afterEach(async()=>{await context?.close();});
async function seed(enabled=true,rule?:CaptchaSiteRule){
 const vault=createEmptyVault();vault.settings.captchaAssistEnabled=enabled;vault.saveInboxKeyPair=await generateSaveInboxKeyPair();
 if(rule)vault.settings.captchaSiteRules={'http://127.0.0.1:4173':rule};
 const {encryptedVault,key}=await createEncryptedVault('Synthetic-only!42',vault);
 const cache={vault,encryptedVault,exportedKey:await exportVaultKey(key),cachedAt:Date.now(),sessionId:'captcha-test'};
 await worker.evaluate(async({cache,index})=>{await navigator.locks.request('keypilot-vault-write',async()=>{
  await chrome.storage.local.set({'keypilot.encryptedVault':cache.encryptedVault,'keypilot.reminderIndex':index});await chrome.storage.session.set({'keypilot.unlockedSession':cache,'keypilot.sessionState':{id:cache.sessionId,expiresAt:0,highSecurity:false}});
 });},{cache,index:buildReminderIndex(vault,encryptedVault.kdf.salt,null)});
}
async function open(){const page=await context.newPage();await page.setViewportSize({width:1000,height:820});await page.goto('http://127.0.0.1:4173/captcha-lab');await page.locator('#captcha').focus();return page;}
function panel(page:Page){return page.getByRole('dialog',{name:'本地验证码识别'});}
async function review(page:Page,text:string){
 const result=panel(page).getByLabel('识别结果（可修改）');await expect(result).toBeVisible({timeout:30000});
 await expect(result).toHaveValue(text);
 await expect(panel(page).getByRole('button',{name:'确认填写'})).toBeEnabled();
}
async function recognize(page:Page,text='4827'){await page.getByRole('button',{name:'识别验证码',exact:true}).click();await review(page,text);}
async function complexImages(group:'joined'|'held') {
 const directory=resolve('tests/fixtures/captcha/complex-fixed');
 const labels=JSON.parse(await readFile(resolve(directory,'labels.json'),'utf8')) as Record<string,Array<{file:string;text:string}>>;
 return Promise.all(labels[group].map(async item=>({...item,image:'data:image/png;base64,'+(await readFile(resolve(directory,item.file))).toString('base64')})));
}
async function traceOcr(page:Page) {
 await page.addInitScript(()=>{
  const Native=window.Worker,readings:unknown[]=[];(window as any).ocrTestReadings=readings;
  window.Worker=class extends Native {
   constructor(url:string|URL,options?:WorkerOptions){
    super(url,options);const neural=String(url).includes('captchaNeuralWorker');
    this.addEventListener('message',event=>{
     if(neural&&event.data?.reading)readings.push({source:'neural',...event.data.reading});
     else if(event.data?.action==='recognize'&&event.data?.status==='resolve'){
      const data=event.data.data;readings.push({source:'text',text:data?.text,confidence:data?.confidence,characters:data?.blocks?.flatMap((b:any)=>b.paragraphs.flatMap((p:any)=>p.lines.flatMap((l:any)=>l.words.flatMap((w:any)=>w.symbols.map((s:any)=>({text:s.text,confidence:s.confidence}))))))});
     }
    });
   }
   postMessage(message:any,transfer:Transferable[]=[]){
    if(message.pixels instanceof Float32Array){let hash=2166136261;for(const byte of new Uint8Array(message.pixels.buffer))hash=Math.imul(hash^byte,16777619);readings.push({source:'input',width:message.width,hash:hash>>>0});}
    super.postMessage(message,transfer);
   }
  };
 });
}

test('OCR is disabled by default; changing settings updates an already open webpage',async()=>{
 await seed(false);const page=await open();await expect(page.getByRole('button',{name:'识别验证码',exact:true})).toBeHidden();
 expect(await worker.evaluate(()=>chrome.offscreen.hasDocument())).toBe(false);
 const settings=await context.newPage();await settings.goto(base+'/options.html#autofill');
 await settings.getByRole('button',{name:'自动填表',exact:true}).click();
 const toggle=settings.getByRole('switch',{name:'本地验证码识别（实验功能）'});await expect(toggle).not.toBeChecked();await toggle.click();await expect(toggle).toBeChecked();
 await page.bringToFront();await page.locator('#captcha').focus();await expect(page.getByRole('button',{name:'识别验证码',exact:true})).toBeVisible();
 await settings.bringToFront();await toggle.click();await expect(toggle).not.toBeChecked();await page.bringToFront();await expect(page.getByRole('button',{name:'识别验证码',exact:true})).toBeHidden();
});

test('real local OCR runs offline, previews editable results, and never submits the website',async()=>{
 await seed();const page=await open(),errors:string[]=[],network:string[]=[];
 page.on('pageerror',e=>errors.push(e.message));context.on('request',request=>{if(request.url().startsWith('http'))network.push(request.url());});
 await context.setOffline(true);await recognize(page);
 expect(await panel(page).evaluate(element=>getComputedStyle(element).fontFamily)).toContain('Segoe UI');expect(await panel(page).evaluate(element=>getComputedStyle(element).fontSize)).toBe('15px');
  await expect(panel(page).getByLabel('识别结果（可修改）')).toHaveValue('4827');
 // Playwright's page request events omit Chrome's offscreen document. Verify
 // the actual frame -> background -> offscreen response instead.
 const engineResponse=await worker.evaluate(async()=>{
  const [tab]=await chrome.tabs.query({url:'http://127.0.0.1:4173/captcha-lab'});
  return (await chrome.scripting.executeScript({target:{tabId:tab.id!},func:async()=>chrome.runtime.sendMessage({type:'KEYPILOT_CAPTCHA_RECOGNIZE',image:document.querySelector('canvas')!.toDataURL(),mode:'digits',expectedUrl:location.href})}))[0].result;
 });
 expect(engineResponse).toMatchObject({ok:true,engine:'auto'});
 await expect(page.locator('#captcha')).toHaveValue('');await expect(page.locator('#submitted')).toHaveText('0');
 for(const width of [1000,380]){
  await page.setViewportSize({width,height:820});
  // Autofill widgets underneath the panel must not cover its image or controls.
  await expect.poll(()=>panel(page).evaluate(element=>{
   const box=element.getBoundingClientRect();
   for(let x=box.left+8;x<box.right-8;x+=16)for(let y=box.top+8;y<box.bottom-8;y+=16){
    if(document.elementFromPoint(x,y)?.id!=='keypilot-captcha-root')return false;
   }
   return true;
  })).toBe(true);
  await page.screenshot({path:resolve(evidence,`ocr-${width}.png`),fullPage:true});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 }
 await panel(page).getByLabel('识别结果（可修改）').fill('5931');await panel(page).getByRole('button',{name:'确认填写'}).click();
 await expect(page.locator('#captcha')).toHaveValue('5931');await expect(page.locator('#submitted')).toHaveText('0');expect(errors).toEqual([]);expect(network).toEqual([]);
 const saved=await worker.evaluate(async()=>JSON.stringify({...await chrome.storage.local.get(null),...await chrome.storage.session.get(null)}));expect(saved).not.toContain('data:image/png');
});

test('cross-origin image is cropped from visible pixels without fetching a new code',async()=>{
 await seed();const page=await open();const png=await page.locator('canvas').evaluate(canvas=>(canvas as HTMLCanvasElement).toDataURL('image/png'));
 let fetches=0;await context.route('http://localhost:4173/captcha.png',route=>{fetches++;return route.fulfill({contentType:'image/png',body:Buffer.from(png.split(',')[1],'base64')});});
 await page.evaluate(()=>{const image=new Image();image.id='captcha-image';image.width=180;image.height=56;image.src='http://localhost:4173/captcha.png';document.querySelector('canvas')!.replaceWith(image);});
 await expect.poll(()=>page.locator('#captcha-image').evaluate(image=>(image as HTMLImageElement).complete)).toBe(true);await page.locator('#captcha').focus();
 await recognize(page);await expect(panel(page).getByLabel('识别结果（可修改）')).toHaveValue('4827');expect(fetches).toBe(1);
 await panel(page).getByRole('button',{name:'确认填写'}).click();await expect(page.locator('#captcha')).toHaveValue('4827');await expect(page.locator('#submitted')).toHaveText('0');
});

test('changed canvas invalidates an old result, and a fresh recognition can be applied',async()=>{
 await seed();const page=await open();await recognize(page);
 await page.evaluate(()=>(window as any).drawCaptcha('5931'));
 await panel(page).getByRole('button',{name:'确认填写'}).click();await expect(panel(page).getByRole('status')).toContainText('已刷新');await expect(page.locator('#captcha')).toHaveValue('');
 await panel(page).getByRole('button',{name:'重新识别'}).click();await expect(panel(page).getByLabel('识别结果（可修改）')).toHaveValue('5931',{timeout:30000});
 await panel(page).getByRole('button',{name:'确认填写'}).click();await expect(page.locator('#captcha')).toHaveValue('5931');
});

test('manual input and locking cannot be overwritten by a pending result',async()=>{
 await seed();const page=await open();await recognize(page);await page.locator('#captcha').fill('user-entry');
 await panel(page).getByRole('button',{name:'确认填写'}).click();await expect(panel(page).getByRole('status')).toContainText('输入框内容已变化');await expect(page.locator('#captcha')).toHaveValue('user-entry');
 await worker.evaluate(async()=>{await chrome.storage.session.remove(['keypilot.unlockedSession','keypilot.sessionState']);});
 await expect(panel(page)).toBeHidden();await expect(page.locator('#captcha')).toHaveValue('user-entry');
});

test('SMS fields and pages without a nearby code image do not show an OCR trigger',async()=>{
 await seed();const page=await open();await expect(page.getByRole('button',{name:'识别验证码',exact:true})).toBeVisible();
 await page.locator('#captcha').evaluate(input=>{input.setAttribute('autocomplete','one-time-code');input.setAttribute('placeholder','短信验证码');});
 await page.locator('[name=username]').focus();await page.locator('#captcha').focus();
 await expect(page.getByRole('button',{name:'识别验证码',exact:true})).toBeHidden();
 await page.reload();await page.locator('#captcha').focus();await expect(page.getByRole('button',{name:'识别验证码',exact:true})).toBeVisible();
 await page.locator('#captcha-image').evaluate(image=>image.remove());await page.locator('#captcha').focus();await expect(page.getByRole('button',{name:'识别验证码',exact:true})).toBeHidden();
});

test('dark-background digits and mixed letters are recognized using the actual packaged engine',async()=>{
 await seed();const page=await open();await page.evaluate(()=>(window as any).drawCaptcha('3579',true));await recognize(page,'3579');await expect(panel(page).getByLabel('识别结果（可修改）')).toHaveValue('3579');
 await panel(page).getByRole('button',{name:'关闭验证码识别'}).click();await page.evaluate(()=>(window as any).drawCaptcha('K9pR'));
 await recognize(page,'K9pR');await expect(panel(page).getByLabel('字符类型')).toHaveCount(0);await expect(panel(page).getByLabel('识别结果（可修改）')).toHaveValue('K9pR');
});

test('blank images leave the website input untouched and allow manual entry',async()=>{
 await seed();const page=await open();await page.locator('canvas').evaluate(canvas=>{const c=canvas as HTMLCanvasElement,x=c.getContext('2d')!;x.fillStyle='#fff';x.fillRect(0,0,c.width,c.height);});
 await page.getByRole('button',{name:'识别验证码',exact:true}).click();
 await expect(panel(page).getByRole('status')).toContainText('未得到清晰',{timeout:30000});await expect(panel(page).locator('#kp-captcha-apply')).toBeDisabled();
 await expect(page.locator('#captcha')).toHaveValue('');await panel(page).getByRole('button',{name:'关闭验证码识别'}).click();await page.locator('#captcha').fill('1234');await expect(page.locator('#captcha')).toHaveValue('1234');
});

test('a canvas that cannot be checked for repaint does not accept screenshot results',async()=>{
 await seed();const page=await open();const png=await page.locator('canvas').evaluate(canvas=>(canvas as HTMLCanvasElement).toDataURL('image/png'));
 await context.route('http://localhost:4173/tainted.png',route=>route.fulfill({contentType:'image/png',body:Buffer.from(png.split(',')[1],'base64')}));
 await page.evaluate(async()=>{const image=new Image();image.src='http://localhost:4173/tainted.png';await image.decode();document.querySelector('canvas')!.getContext('2d')!.drawImage(image,0,0);});
 await page.getByRole('button',{name:'识别验证码',exact:true}).click();await expect(panel(page).getByRole('status')).toContainText('暂时无法读取');await expect(panel(page).locator('#kp-captcha-apply')).toBeDisabled();await expect(page.locator('#captcha')).toHaveValue('');
});

test('known length is remembered for the exact site; incomplete readings and manual edits cannot be applied',async()=>{
 await seed();const page=await open();await recognize(page);
 await panel(page).locator('.rule-settings summary').click();await panel(page).getByLabel('已知位数').selectOption('4');
 await panel(page).getByRole('button',{name:'记住此网站规则'}).click();
 await expect(panel(page).getByRole('status')).toContainText('网站规则已保存');
 await page.reload();await recognize(page);await expect(panel(page).getByLabel('已知位数')).toHaveValue('4');
 await panel(page).getByLabel('识别结果（可修改）').fill('123');await expect(panel(page).locator('#kp-captcha-apply')).toBeDisabled();
 await page.evaluate(()=>(window as any).drawCaptcha('012'));
 await panel(page).getByRole('button',{name:'重新识别'}).click();await expect(panel(page).getByRole('status')).toContainText('位数不一致');
 await expect(panel(page).locator('#kp-captcha-apply')).toBeDisabled();await expect(page.locator('#captcha')).toHaveValue('');
 await page.evaluate(()=>(window as any).drawCaptcha('0012'));
 await panel(page).getByRole('button',{name:'开始识别'}).click();await expect(panel(page).getByLabel('识别结果（可修改）')).toHaveValue('0012');
 await panel(page).getByRole('button',{name:'确认填写'}).click();await expect(page.locator('#captcha')).toHaveValue('0012');await expect(page.locator('#submitted')).toHaveText('0');
 await context.route('http://localhost:4173/captcha-lab',route=>route.fulfill({contentType:'text/html',body:fixture}));
 await page.goto('http://localhost:4173/captcha-lab');await page.locator('#captcha').focus();await recognize(page);
 await expect(panel(page).getByLabel('已知位数')).toHaveValue('');
});

test('saved rules can be cleared in settings and update an already open website',async()=>{
 await seed();const page=await open();await recognize(page);await panel(page).locator('.rule-settings summary').click();await panel(page).getByLabel('已知位数').selectOption('4');
 await panel(page).getByRole('button',{name:'记住此网站规则'}).click();await expect(panel(page).getByRole('status')).toContainText('网站规则已保存');
 await panel(page).getByRole('button',{name:'开始识别'}).click();await expect(panel(page).getByLabel('识别结果（可修改）')).toBeVisible();
 const settings=await context.newPage();await settings.goto(base+'/options.html#autofill');await settings.getByRole('button',{name:'自动填表',exact:true}).click();
 await settings.locator('.captcha-rules-settings summary').click();await expect(settings.locator('.captcha-rules-settings')).toContainText('自动识别 · 4 位');
 await settings.setViewportSize({width:1100,height:850});await settings.screenshot({path:resolve(evidence,'rules-settings.png'),fullPage:true});
 await settings.getByRole('button',{name:'清除 http://127.0.0.1:4173 的验证码规则',exact:true}).click();await expect(settings.locator('.captcha-rules-settings summary')).toContainText('（0）');
 await page.bringToFront();await page.locator('#captcha').focus();
 if(!await panel(page).isVisible())await recognize(page);
 await expect(panel(page).getByLabel('已知位数')).toHaveValue('');await expect(panel(page).getByRole('button',{name:'清除规则',exact:true})).toBeHidden();
 await expect(page.locator('#captcha')).toHaveValue('');
});

test('packaged lightweight engine handles gradient, dots and grids without automatically filling',async()=>{
 await seed();const page=await open();
 for(const kind of ['gradient','dots','grid']){
  await page.locator('canvas').evaluate((canvas,kind)=>{
   const c=canvas as HTMLCanvasElement,x=c.getContext('2d')!;c.width=200;c.height=58;
   const gradient=x.createLinearGradient(0,0,200,58);gradient.addColorStop(0,'#fff9eb');gradient.addColorStop(1,'#adbed3');
   x.fillStyle=kind==='gradient'?gradient:'#f2f8fc';x.fillRect(0,0,200,58);
   if(kind==='dots'){x.fillStyle='#a9bdc9';for(let i=0;i<70;i++)x.fillRect(i*37%200,i*17%58,i%3?1:2,i%3?1:2);}
   if(kind==='grid'){x.strokeStyle='#97afbd';x.lineWidth=1;for(let y=8;y<58;y+=8){x.beginPath();x.moveTo(0,y);x.lineTo(200,y+4);x.stroke();}for(let at=9;at<200;at+=18){x.beginPath();x.moveTo(at,0);x.lineTo(at,58);x.stroke();}}
   x.fillStyle='#65428a';x.font='28px Tahoma';x.textBaseline='middle';[...'4308'].forEach((digit,i)=>x.fillText(digit,12+i*29,29));
  },kind);
  await recognize(page,'4308');await expect(panel(page).getByLabel('识别结果（可修改）')).toHaveValue('4308');
  await expect(page.locator('#captcha')).toHaveValue('');await expect(page.locator('#submitted')).toHaveText('0');
  if(kind==='grid')await page.screenshot({path:resolve(evidence,'background-grid.png'),fullPage:true});
  await panel(page).getByRole('button',{name:'关闭验证码识别'}).click();
 }
});

test('rule messages reject stale URLs, invalid data and attempts to choose another origin',async()=>{
 await seed();const page=await open();
 const response=await worker.evaluate(async()=>{
  const [tab]=await chrome.tabs.query({url:'http://127.0.0.1:4173/captcha-lab'});
  return (await chrome.scripting.executeScript({target:{tabId:tab.id!},func:async()=>{
   const stale=await chrome.runtime.sendMessage({type:'KEYPILOT_CAPTCHA_SAVE_RULE',rule:{mode:'digits',expectedLength:4},expectedUrl:'https://other.test/'});
   const invalid=await chrome.runtime.sendMessage({type:'KEYPILOT_CAPTCHA_SAVE_RULE',rule:{mode:'digits',expectedLength:4,answer:'1234'},expectedUrl:location.href});
   const valid=await chrome.runtime.sendMessage({type:'KEYPILOT_CAPTCHA_SAVE_RULE',rule:{mode:'digits',expectedLength:4},origin:'https://other.test',expectedUrl:location.href});
   return {stale,invalid,valid};
  }}))[0].result;
 });
 expect(response.stale).toMatchObject({ok:false,error:'STALE_PAGE'});expect(response.invalid).toMatchObject({ok:false,error:'RULE_INVALID'});expect(response.valid.ok).toBe(true);
 const rules=await worker.evaluate(async()=>((await chrome.storage.session.get('keypilot.unlockedSession'))['keypilot.unlockedSession'] as any).vault.settings.captchaSiteRules);
 expect(rules).toEqual({'http://127.0.0.1:4173':{mode:'digits',expectedLength:4}});
 await expect(page.locator('#submitted')).toHaveText('0');
});

test('automatic recognition ignores old numeric restrictions and preserves punctuation without a mode selector',async()=>{
 await seed(true,{mode:'digits',expectedLength:4});const page=await open();
 await page.locator('canvas').evaluate(canvas=>{
  const c=canvas as HTMLCanvasElement,x=c.getContext('2d')!;x.fillStyle='#fff';x.fillRect(0,0,c.width,c.height);x.fillStyle='#222';x.font='30px Arial';x.textBaseline='middle';x.fillText('A7+9',12,28);
 });
 await recognize(page,'A7+9');await expect(panel(page).getByLabel('字符类型')).toHaveCount(0);
 await expect(panel(page).getByLabel('已知位数')).toHaveValue('4');
 await panel(page).getByRole('button',{name:'确认填写'}).click();await expect(page.locator('#captcha')).toHaveValue('A7+9');await expect(page.locator('#submitted')).toHaveText('0');
 await page.evaluate(()=>(window as any).drawCaptcha('K9pR'));await recognize(page,'K9pR');
 await panel(page).getByRole('button',{name:'确认填写'}).click();await expect(page.locator('#captcha')).toHaveValue('K9pR');
});

test('first candidate is preselected despite ambiguity, and Enter confirms without scrolling or submitting',async()=>{
 await seed();const page=await open();await page.getByRole('button',{name:'识别验证码',exact:true}).click();
 await expect(panel(page).getByLabel('识别结果（可修改）')).toBeVisible({timeout:30000});
 await expect(panel(page).getByLabel('识别结果（可修改）')).toHaveValue('4827');
 await expect(panel(page).getByRole('button',{name:'确认填写'})).toBeEnabled();
 await expect(panel(page).getByRole('button',{name:'选择候选 4827',exact:true})).toBeVisible();
 await expect(panel(page).getByRole('button',{name:'选择候选 A827',exact:true})).toBeVisible();
 await expect(panel(page).getByRole('button',{name:'选择候选 4827',exact:true})).toHaveAttribute('aria-pressed','true');
 for(const size of [{width:1000,height:820},{width:380,height:450}]){
  await page.setViewportSize(size);
  await expect.poll(()=>panel(page).evaluate(element=>element.scrollHeight<=element.clientHeight)).toBe(true);
  const input=await panel(page).getByLabel('识别结果（可修改）').boundingBox(),button=await panel(page).getByRole('button',{name:'确认填写'}).boundingBox(),box=await panel(page).boundingBox();
  expect(Math.abs(input!.y-button!.y)).toBeLessThan(2);expect(box!.height).toBeLessThan(320);expect(button!.y+button!.height).toBeLessThan(size.height);
  await page.screenshot({path:resolve(evidence,`compact-${size.width}.png`),fullPage:true});
 }
 await panel(page).getByLabel('识别结果（可修改）').press('Enter');
 await expect(panel(page)).toBeHidden();await expect(page.locator('#captcha')).toHaveValue('4827');await expect(page.locator('#submitted')).toHaveText('0');
});

test('candidate selection, manual edits and invalid keyboard confirmation stay consistent',async()=>{
 await seed(true,{mode:'auto',expectedLength:4});const page=await open();await recognize(page);
 const result=panel(page).getByLabel('识别结果（可修改）'),alternative=panel(page).getByRole('button',{name:'选择候选 A827',exact:true});
 await alternative.click();await expect(result).toHaveValue('A827');await expect(alternative).toHaveAttribute('aria-pressed','true');
 await expect(panel(page).getByRole('button',{name:'选择候选 4827',exact:true})).toHaveAttribute('aria-pressed','false');
 await result.fill('123');await result.press('Enter');await expect(panel(page)).toBeVisible();await expect(page.locator('#captcha')).toHaveValue('');
 await expect(panel(page).locator('.choices [aria-pressed=true]')).toHaveCount(0);
 await result.fill('5931');await result.dispatchEvent('keydown',{key:'Enter',isComposing:true});await expect(panel(page)).toBeVisible();await expect(page.locator('#captcha')).toHaveValue('');
 await result.press('Enter');await expect(page.locator('#captcha')).toHaveValue('5931');await expect(page.locator('#submitted')).toHaveText('0');
});

test('real rotated CAPTCHA fixtures are the first candidate offline and need confirmation',async()=>{
 await seed();const page=await open();await context.setOffline(true);
 const labels=JSON.parse(await readFile(resolve('tests/fixtures/captcha/labels.json'),'utf8')) as Array<{file:string;expected:string}>;
 for(const {file,expected} of labels){
  const image='data:image/png;base64,'+(await readFile(resolve('tests/fixtures/captcha',file))).toString('base64');
  await page.locator('canvas').evaluate(async(canvas,src)=>{
   const image=new Image();image.src=src;await image.decode();const c=canvas as HTMLCanvasElement;c.width=image.naturalWidth;c.height=image.naturalHeight;c.getContext('2d')!.drawImage(image,0,0);
  },image);
  await page.locator('#captcha').focus();await page.getByRole('button',{name:'识别验证码',exact:true}).click();
  await expect(panel(page).getByLabel('识别结果（可修改）')).toBeVisible({timeout:30000});
  await expect(panel(page).getByLabel('识别结果（可修改）')).toHaveValue(expected);
  await expect(page.locator('#captcha')).toHaveValue('');await expect(page.locator('#submitted')).toHaveText('0');
  await review(page,expected);
  if(file==='user-preview-ukay.png'){
   await page.setViewportSize({width:380,height:820});await page.screenshot({path:resolve(evidence,'seajoin-380.png'),fullPage:true});
   await panel(page).getByRole('button',{name:'确认填写'}).click();await expect(page.locator('#captcha')).toHaveValue(expected);await expect(page.locator('#submitted')).toHaveText('0');
  }else await panel(page).getByRole('button',{name:'关闭验证码识别'}).click();
 }
});

test('OCR workers are released after idle time and initialize again for another request',async()=>{
 const page=await context.newPage();await page.clock.install();await page.goto(base+'/offscreen.html');
 const image='data:image/png;base64,'+(await readFile(resolve('tests/fixtures/captcha/user-inline-ukay.png'))).toString('base64');
 const recognize=()=>worker.evaluate(image=>chrome.runtime.sendMessage({target:'keypilot-captcha-ocr',image,mode:'auto'}),image);
 expect((await recognize()).candidates[0].text).toBe('ukay');
 expect(page.workers().length).toBeGreaterThan(0);
 await page.clock.fastForward(60001);await expect.poll(()=>page.workers().length).toBe(0);
 expect((await recognize()).candidates[0].text).toBe('ukay');
 expect(page.workers().length).toBeGreaterThan(0);
});

test('joined and warped regression images retain complete candidates offline',async()=>{
 const page=await context.newPage();await traceOcr(page);await page.goto(base+'/offscreen.html');await context.setOffline(true);
 for(const fixture of await complexImages('joined')){
  await page.evaluate(()=>{(window as any).ocrTestReadings.length=0;});
  const image=fixture.image;
  const result=await worker.evaluate(image=>chrome.runtime.sendMessage({target:'keypilot-captcha-ocr',image,mode:'auto'}),image);
  expect(result.ok).toBe(true);expect(result.candidates[0].text,JSON.stringify({file:fixture.file,result,readings:await page.evaluate(()=>(window as any).ocrTestReadings)})).toBe(fixture.text);
  expect(result.uncertain).toBe(true);expect(result.candidates.length).toBeLessThanOrEqual(4);
 }
});

test('trained local review head improves held development regressions without a character type hint',async()=>{
 const page=await context.newPage();await page.goto(base+'/offscreen.html');await context.setOffline(true);
 for(const fixture of await complexImages('held')){
  const image=fixture.image;
  const result=await worker.evaluate(image=>chrome.runtime.sendMessage({target:'keypilot-captcha-ocr',image,mode:'auto'}),image);
  expect(result.ok).toBe(true);expect(result.candidates[0].text).toBe(fixture.text);
  expect(result.uncertain).toBe(true);expect(result.candidates.length).toBeLessThanOrEqual(4);
 }
});

test('arithmetic CAPTCHAs automatically show answers, including one digit and negatives, without a mode selector',async()=>{
 await seed(true,{mode:'auto',expectedLength:4});const page=await open();await context.setOffline(true);
 for(const [formula,expected] of [['8 × 3 = ?','24'],['3 + 4 = ?','7'],['4 - 9 = ?','-5'],['5 - 5 = ?','0'],['24 ÷ 6 = ?','4'],['10 / 4 = ?','2.5']]){
  await page.locator('#captcha').fill('');
  await page.locator('canvas').evaluate((canvas,text)=>{
   const c=canvas as HTMLCanvasElement;c.width=240;c.height=64;const x=c.getContext('2d')!;
   x.fillStyle='#f4f8fb';x.fillRect(0,0,240,64);x.fillStyle='#483267';x.font='bold 30px Arial';x.textBaseline='middle';x.fillText(text,12,32);
  },formula);
  await page.locator('#captcha').focus();await recognize(page,expected);
  await expect(panel(page).getByLabel('识别算式')).toBeVisible();await expect(panel(page).getByLabel('字符类型')).toHaveCount(0);
  await expect(panel(page).getByRole('status')).toContainText('自动计算');await expect(page.locator('#captcha')).toHaveValue('');
  if(expected==='24'){
   await page.setViewportSize({width:380,height:450});await expect.poll(()=>panel(page).evaluate(element=>element.scrollHeight<=element.clientHeight)).toBe(true);
   await page.screenshot({path:resolve(evidence,'arithmetic-380.png'),fullPage:true});
  }
  await panel(page).getByLabel('识别结果（可修改）').press('Enter');await expect(page.locator('#captcha')).toHaveValue(expected);await expect(page.locator('#submitted')).toHaveText('0');
 }
 // The arithmetic result length does not rewrite the stored rule for normal codes.
 await page.evaluate(()=>(window as any).drawCaptcha('4827'));await page.locator('#captcha').fill('');await recognize(page);
 await expect(panel(page).getByLabel('识别算式')).toBeHidden();await expect(panel(page).getByLabel('已知位数')).toHaveValue('4');
 await panel(page).getByLabel('识别结果（可修改）').fill('7');await expect(panel(page).getByRole('button',{name:'确认填写'})).toBeDisabled();
});

test('a failed extra OCR pass retains the original answer and recovers for the next request',async()=>{
 const page=await context.newPage();
 await page.addInitScript(()=>{
  const Native=window.Worker;let failOnce=true;
  window.Worker=class extends Native {
   private neural:boolean;private calls=0;
   constructor(url:string|URL,options?:WorkerOptions){super(url,options);this.neural=String(url).includes('captchaNeuralWorker');}
   postMessage(message:any,transfer:Transferable[]=[]){
    if(this.neural&&++this.calls===2&&failOnce){failOnce=false;this.dispatchEvent(new ErrorEvent('error',{message:'Synthetic extra-pass failure'}));return;}
    super.postMessage(message,transfer);
   }
  };
 });
 await page.goto(base+'/offscreen.html');await context.setOffline(true);
 const image=(await complexImages('joined')).find(item=>item.text==='489132')!.image;
 const recognize=()=>worker.evaluate(image=>chrome.runtime.sendMessage({target:'keypilot-captcha-ocr',image,mode:'auto'}),image);
 expect((await recognize()).candidates[0].text).toBe('489132');
 await expect.poll(()=>page.workers().length).toBe(0);
 expect((await recognize()).candidates[0].text).toBe('489132');
 expect(page.workers().length).toBeGreaterThan(0);
});

