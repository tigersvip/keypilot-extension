import {test,expect,chromium,type BrowserContext,type Worker,type Page} from '@playwright/test';
import {resolve} from 'node:path';
import {mkdir} from 'node:fs/promises';
import {createEmptyVault} from '../../src/shared/defaults';
import {createEncryptedVault,exportVaultKey} from '../../src/shared/crypto';
import {generateSaveInboxKeyPair} from '../../src/shared/saveInbox';
import {buildReminderIndex} from '../../src/shared/reminders';

let context:BrowserContext,worker:Worker,base:string;
let pageErrors:string[]=[];
const evidence=resolve(process.env.TEMP??'..','keypilot-captcha-v1.8.8');
const style='<style>body{font:16px Arial;margin:24px}form{max-width:650px}label,.field{display:block;margin:16px 0}input{width:180px;height:36px}canvas{width:140px;height:48px;vertical-align:middle;margin:8px}button{min-height:36px}</style>';
const picture=(attributes='id="captcha-image"')=>`<canvas ${attributes} width="140" height="48"></canvas>`;
const field=(label='Captcha',attributes='',image=picture())=>`<div class="field"><label>${label}<input id="answer" ${attributes}></label>${image}</div>`;
test.beforeEach(async()=>{
 const extension=resolve('dist');context=await chromium.launchPersistentContext('',{channel:'chromium',headless:true,args:['--disable-extensions-except='+extension,'--load-extension='+extension,'--mute-audio']});
 pageErrors=[];context.on('page',page=>{page.on('pageerror',error=>pageErrors.push(error.message));page.on('console',message=>{if(message.type()==='error')pageErrors.push(message.text());});});
 worker=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker');base='chrome-extension://'+new URL(worker.url()).host;
 const vault=createEmptyVault();vault.settings.captchaAssistEnabled=true;vault.saveInboxKeyPair=await generateSaveInboxKeyPair();
 const {encryptedVault,key}=await createEncryptedVault('Synthetic-only!42',vault),cache={vault,encryptedVault,exportedKey:await exportVaultKey(key),cachedAt:Date.now(),sessionId:'detection-test'};
 await worker.evaluate(async({cache,index})=>{await navigator.locks.request('keypilot-vault-write',async()=>{
  await chrome.storage.local.set({'keypilot.encryptedVault':cache.encryptedVault,'keypilot.reminderIndex':index});
  await chrome.storage.session.set({'keypilot.unlockedSession':cache,'keypilot.sessionState':{id:cache.sessionId,expiresAt:0,highSecurity:false}});
 });},{cache,index:buildReminderIndex(vault,encryptedVault.kdf.salt,null)});
 await mkdir(evidence,{recursive:true});
});
test.afterEach(async()=>{await context?.close();expect(pageErrors).toEqual([]);});
let serial=0;
async function open(body:string,options:{form?:boolean;script?:string}={}){
 const page=await context.newPage(),url=`http://127.0.0.1:4173/detection/${++serial}`;
 await context.route(url,route=>route.fulfill({contentType:'text/html',body:`<!doctype html><meta charset="utf-8"><title>KeyPilot detection fixtures</title>${style}<h1>Detection fixture</h1>${options.form===false?body:`<form>${body}<button type="button">Continue</button></form>`}<script>for(const c of document.querySelectorAll('canvas')){const x=c.getContext('2d');x.fillStyle='#f4f8fb';x.fillRect(0,0,c.width,c.height);x.fillStyle='#26364a';x.font='bold 27px Arial';x.fillText('4827',10,34)}${options.script??''}</script>`}));
 await page.goto(url);await expect(page).toHaveTitle('KeyPilot detection fixtures');await expect(page.locator('h1')).toHaveText('Detection fixture');await expect(page.locator('vite-error-overlay')).toHaveCount(0);return page;
}
const trigger=(page:Page)=>page.getByRole('button',{name:'识别验证码',exact:true});
const panel=(page:Page)=>page.getByRole('dialog',{name:'本地验证码识别'});
async function noPrompt(page:Page){await expect.poll(()=>page.locator('#keypilot-captcha-root').count()).toBe(1);await page.locator('#answer').focus();await page.waitForTimeout(350);await expect(trigger(page)).toBeHidden();await expect(page.locator('#answer')).toHaveValue('');}

test('Chinese, English and international CAPTCHA labels identify the image without selecting a language',async()=>{
 const cases=[
  ['Chinese',field('验证码')],['Traditional Chinese',field('驗證碼')],['English',field('CAPTCHA')],
  ['English security code',field('Security code')],['English visual instruction',field('Enter the characters shown in the image','',picture('id="picture"'))],
  ['French',field('Code de vérification')],['Spanish',field('Código de verificación')],['Portuguese',field('Código de verificação')],
  ['German',field('Sicherheitscode')],['Japanese',field('画像認証')],['Korean',field('보안 문자')],['Russian',field('Код проверки')],['Arabic',field('رمز التحقق')],
  ['random field name',field('Answer','name="f_928"')],['concatenated names',field('','name="captchacode"',picture('id="captchaimg"'))],
  ['accessible label',`<span id="hint">Enter the letters shown below</span><div class="field"><input id="answer" aria-labelledby="hint">${picture('id="random-image"')}</div>`],
  ['explicit image association',`<label>Security code<input id="answer" aria-describedby="challenge"></label>${picture('id="challenge"')}`],
  ['arithmetic CAPTCHA',field('Calculate the answer','',picture('id="math-captcha"'))],
  ['unassociated English caption',`<div class="field"><span>CAPTCHA</span><input id="answer">${picture('id="random-image"')}</div>`],
  ['Chinese refresh hint',`<div class="field"><label>验证码<input id="answer"></label>${picture('id="random-image"')}<button type="button">看不清，换一张</button></div>`],
  ['English refresh hint',`<div class="field"><label>Verification code<input id="answer"></label>${picture('id="random-image"')}<button type="button">Refresh image</button></div>`],
 ];
 for(const [name,html] of cases)await test.step(name,async()=>{const page=await open(html);await page.locator('#answer').focus();await expect(trigger(page)).toBeVisible();await expect(panel(page)).toBeHidden();expect(page.workers()).toHaveLength(0);await page.close();});
});

test('ordinary fields, delivery codes, calculators and unrelated images never start OCR',async()=>{
 const cases=[
  ['search',field('Search','type="search"')],['generic query',field('Search the catalog','name="query"')],['coupon',field('Promotion code','name="coupon"')],
  ['postal',field('Postal code')],['order',field('Order number')],['card security',field('Card security code')],
  ['SMS',field('SMS verification code')],['email',field('Email verification code')],['autocomplete OTP',field('Verification code','autocomplete="one-time-code"')],
  ['authenticator',field('Authenticator code')],['recovery',field('Recovery code')],
  ['send button',`<div class="field"><label>Verification code<input id="answer"></label>${picture()}<button type="button">Send code</button></div>`],
  ['countdown',`<div class="field"><label>验证码<input id="answer"></label>${picture()}<span>Resend in 45 seconds</span></div>`],
  ['delivered description',`<span id="sent">Code sent to your email</span>${field('Verification code','aria-describedby="sent"')}`],
  ['calculator',field('Calculate the answer','',picture('id="equation"'))],['Chinese math exercise',field('计算结果','',picture('id="equation"'))],
  ['logo',field('Verification code','',picture('id="company-logo"'))],['anonymous nearby image',field('Verification code','',picture('id="illustration"'))],
  ['QR code',field('Captcha','',picture('id="qr-code"'))],['avatar',field('Captcha','',picture('id="avatar"'))],
  ['readonly',field('Captcha','readonly')],['disabled',field('Captcha','disabled')],
  ['hidden ancestor',`<div style="opacity:0">${field()}</div>`],
  ['different form',`<form><label>验证码<input id="answer"></label></form><form>${picture()}</form>`],
 ];
 for(const [name,html] of cases)await test.step(name,async()=>{const page=await open(html,{form:name!=='different form'});await noPrompt(page);expect(page.workers()).toHaveLength(0);await page.close();});
});

test('delivery controls in another field do not suppress a genuine visual CAPTCHA',async()=>{
 const page=await open(`<div class="field"><label>SMS code<input id="sms"></label><button type="button">Send code</button></div>${field('Enter the code in the image')}`);
 await page.locator('#answer').focus();await expect(trigger(page)).toBeVisible();await page.locator('#sms').focus();await expect(trigger(page)).toBeHidden();
 await page.locator('#answer').focus();await trigger(page).click();await expect(panel(page).getByLabel('识别结果（可修改）')).toHaveValue('4827',{timeout:30000});
 await expect(page.locator('#sms')).toHaveValue('');await panel(page).getByLabel('识别结果（可修改）').press('Enter');await expect(page.locator('#answer')).toHaveValue('4827');
});

test('multiple equally plausible images are rejected, while explicit associations select the correct image',async()=>{
 const page=await open(`<div class="field"><label>Captcha<input id="answer"></label>${picture('id="captcha-a"')}${picture('id="captcha-b"')}</div>`);
 await noPrompt(page);
 await page.locator('#answer').evaluate(input=>input.setAttribute('aria-controls','captcha-b'));await expect(trigger(page)).toBeVisible();
 await page.locator('#captcha-b').evaluate(canvas=>{const c=canvas as HTMLCanvasElement,x=c.getContext('2d')!;x.fillStyle='#fff';x.fillRect(0,0,c.width,c.height);x.fillStyle='#222';x.font='bold 27px Arial';x.fillText('5931',10,34);});
 await trigger(page).click();await expect(panel(page).getByLabel('识别结果（可修改）')).toHaveValue('5931',{timeout:30000});
});

test('two CAPTCHA rows stay paired with their own focused input',async()=>{
 const page=await open(field('Captcha')+field('Captcha').replace('id="answer"','id="second"').replace('id="captcha-image"','id="captcha-second"'));
 await expect(trigger(page)).toBeHidden();await page.locator('#second').focus();await expect(trigger(page)).toBeVisible();
 await page.locator('#captcha-second').evaluate(canvas=>{const c=canvas as HTMLCanvasElement,x=c.getContext('2d')!;x.fillStyle='#fff';x.fillRect(0,0,c.width,c.height);x.fillStyle='#222';x.font='bold 27px Arial';x.fillText('5931',10,34);});
 await trigger(page).click();await expect(panel(page).getByLabel('识别结果（可修改）')).toHaveValue('5931',{timeout:30000});await panel(page).getByLabel('识别结果（可修改）').press('Enter');
 await expect(page.locator('#second')).toHaveValue('5931');await expect(page.locator('#answer')).toHaveValue('');
});

test('open web components and dynamic labels are detected, then invalidated when converted to OTP',async()=>{
 const page=await open('<div id="component"></div>',{form:false,script:`const s=document.querySelector('#component').attachShadow({mode:'open'});s.innerHTML=${JSON.stringify(style+field('Captcha'))};`});
 await page.locator('#answer').focus();await expect(trigger(page)).toBeVisible();
 await page.locator('#answer').evaluate(input=>{input.setAttribute('aria-label','SMS verification code');});await expect(trigger(page)).toBeHidden();
 await page.locator('#answer').evaluate(input=>{input.removeAttribute('aria-label');});await expect(trigger(page)).toBeVisible();
 await page.locator('#captcha-image').evaluate(image=>image.setAttribute('class','logo'));await expect(trigger(page)).toBeHidden();
});

test('late-rendered anonymous CAPTCHA images follow English instructions and hidden-state changes',async()=>{
 const page=await open('<div id="mount"></div>');await expect(trigger(page)).toBeHidden();
 await page.locator('#mount').evaluate((node,markup)=>{node.innerHTML=markup;},field('Enter the characters in the image','',picture('id="random-image"')));
 await page.locator('#answer').focus();await expect(trigger(page)).toBeVisible();
 await page.locator('#mount').evaluate(node=>node.setAttribute('hidden',''));await expect(trigger(page)).toBeHidden();
 await page.locator('#mount').evaluate(node=>node.removeAttribute('hidden'));await page.locator('#answer').focus();await expect(trigger(page)).toBeVisible();
  await page.locator('#mount label').evaluate(node=>{node.firstChild!.textContent='Verification code sent to your phone';});await expect(trigger(page)).toBeHidden();
});

test('a cross-origin frame detects its own CAPTCHA without borrowing the parent image',async()=>{
 await context.route('http://localhost:4173/embedded-challenge',route=>route.fulfill({contentType:'text/html',body:style+field('Image verification code')}));
 const page=await open(field('Verification code','',picture('id="logo"'))+'<iframe title="Verification frame" src="http://localhost:4173/embedded-challenge" width="600" height="250"></iframe>');
 await noPrompt(page);
 const frame=page.frameLocator('iframe');await frame.locator('#answer').focus();await expect(frame.getByRole('button',{name:'识别验证码',exact:true})).toBeVisible();
 await expect(trigger(page)).toBeHidden();
});

test('legacy image endpoints identify CAPTCHA routes without treating arbitrary query values as evidence',async()=>{
 const page=await open(field('Verification code','',picture('id="picture"')));await noPrompt(page);
 const png=await page.locator('#picture').evaluate(canvas=>(canvas as HTMLCanvasElement).toDataURL());
 await context.route('http://127.0.0.1:4173/challenge.php**',route=>route.fulfill({contentType:'image/png',body:Buffer.from(png.split(',')[1],'base64')}));
 await page.locator('#picture').evaluate(canvas=>{const image=document.createElement('img');image.id='picture';image.width=140;image.height=48;image.src='/challenge.php?a=vertify&lang=en';canvas.replaceWith(image);});
 await expect(trigger(page)).toBeVisible();
 await page.locator('#picture').evaluate(image=>{image.setAttribute('src','/challenge.php?redirect=captcha');});await noPrompt(page);
});

test('site opt-out persists, blocks direct OCR requests, stays origin scoped and can be restored in settings',async()=>{
 const page=await open(field());const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));await page.locator('#answer').focus();await trigger(page).click();
 await expect(panel(page).getByLabel('识别结果（可修改）')).toHaveValue('4827',{timeout:30000});
 await panel(page).locator('.rule-settings summary').click();await page.setViewportSize({width:380,height:600});await page.screenshot({path:resolve(evidence,'site-opt-out-380.png')});
 await panel(page).getByRole('button',{name:'此网站不再提示'}).click();await expect(trigger(page)).toBeHidden();await expect(panel(page)).toBeHidden();
 await page.reload();await noPrompt(page);
 const response=await worker.evaluate(async url=>{const [tab]=await chrome.tabs.query({url});return (await chrome.scripting.executeScript({target:{tabId:tab.id!},func:async()=>chrome.runtime.sendMessage({type:'KEYPILOT_CAPTCHA_RECOGNIZE',image:'data:image/png;base64,',expectedUrl:location.href})}))[0].result;},page.url());
 expect(response).toMatchObject({ok:false,error:'DISABLED'});
 const other=await context.newPage();await context.route('http://localhost:4173/detection-other',route=>route.fulfill({contentType:'text/html',body:style+field()}));await other.goto('http://localhost:4173/detection-other');await other.locator('#answer').focus();await expect(trigger(other)).toBeVisible();
 const settings=await context.newPage();await settings.goto(base+'/options.html#autofill');await settings.getByRole('button',{name:'自动填表',exact:true}).click();await settings.locator('.captcha-rules-settings summary').click();await expect(settings.getByText('此网站已关闭验证码提示',{exact:true})).toBeVisible();
 await settings.setViewportSize({width:1100,height:850});await settings.screenshot({path:resolve(evidence,'site-opt-out-settings.png'),fullPage:true});
 await settings.getByRole('button',{name:'清除 http://127.0.0.1:4173 的验证码规则',exact:true}).click();await page.bringToFront();await page.locator('#answer').focus();await expect(trigger(page)).toBeVisible();
 expect(errors).toEqual([]);await expect(page.locator('#answer')).toHaveValue('');
});
