import {test,expect,chromium,type BrowserContext,type Worker,type Page} from '@playwright/test';
import {resolve} from 'node:path';
import {mkdir} from 'node:fs/promises';
import {createEmptyVault} from '../../src/shared/defaults';
import {createEncryptedVault,exportVaultKey} from '../../src/shared/crypto';
import {generateSaveInboxKeyPair} from '../../src/shared/saveInbox';
import {buildCredential} from '../../src/shared/vault';
import {buildReminderIndex} from '../../src/shared/reminders';

const url='https://captcha-login.example.test/login';
const form=`<!doctype html><meta charset="utf-8"><title>Synthetic one-click login</title>
<style>body{font:16px Arial;padding:24px}form{width:440px}label{display:block;margin:12px 0}input{height:36px;display:block}canvas{display:block}button{margin-top:180px}</style>
<form><label>Username<input id="username" name="username" autocomplete="username"></label><div id="password-step"><label>Password<input id="password" name="password" type="password" autocomplete="current-password"></label><div id="challenge"><label>Characters in the image<input id="captcha" name="captcha" autocomplete="off"></label><canvas id="captcha-image" width="180" height="56"></canvas></div></div><button id="login" type="submit">Sign in</button></form><p id="submitted">0</p><p id="steps">0</p>
<script>window.drawCaptcha=(text='4827')=>{const c=document.querySelector('canvas'),x=c.getContext('2d');x.fillStyle='#f2fbfc';x.fillRect(0,0,c.width,c.height);x.textBaseline='middle';x.font='bold 30px Arial';x.fillStyle='#873f93';[...text].forEach((char,i)=>{x.save();x.translate(20+i*(145/text.length),28);x.rotate([-.16,.1,-.1,.18,-.06,.13][i]);x.fillText(char,0,0);x.restore()})};drawCaptcha();
document.querySelector('form').onsubmit=e=>{e.preventDefault();if(document.querySelector('#password-step').hidden){document.querySelector('#password-step').hidden=false;document.querySelector('#login').textContent='Sign in';document.querySelector('#steps').textContent='1';return}document.querySelector('#submitted').textContent=String(Number(document.querySelector('#submitted').textContent)+1)};</script>`;
let context:BrowserContext,worker:Worker,base:string,credential:ReturnType<typeof buildCredential>;
const evidence=resolve(process.env.TEMP??'..','keypilot-v1.9.0');
test.beforeEach(async()=>{
 const extension=resolve('dist');context=await chromium.launchPersistentContext('',{channel:'chromium',headless:true,args:['--disable-extensions-except='+extension,'--load-extension='+extension,'--mute-audio']});
 worker=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker');base='chrome-extension://'+new URL(worker.url()).host;
 await context.route(url,route=>route.fulfill({contentType:'text/html',body:form}));
});
test.afterEach(async()=>{await context?.close();});
async function seed(enabled=true,disabledSite=false,language:'zh-CN'|'en-US'='zh-CN'){
 const vault=createEmptyVault();vault.settings.captchaAssistEnabled=enabled;vault.settings.autoFill=false;vault.settings.autoSubmit=true;vault.saveInboxKeyPair=await generateSaveInboxKeyPair();
 vault.settings.language=language;
 if(disabledSite)vault.settings.captchaSiteRules={[new URL(url).origin]:{mode:'auto',disabled:true}};
 credential=buildCredential({title:'Synthetic only',url,username:'synthetic-user',password:'Synthetic-only!42'});vault.credentials=[credential];
 const {encryptedVault,key}=await createEncryptedVault('Test-master!42',vault);
 const cache={vault,encryptedVault,exportedKey:await exportVaultKey(key),cachedAt:Date.now(),sessionId:'captcha-login-test'};
 await worker.evaluate(async({cache,index})=>{await navigator.locks.request('keypilot-vault-write',async()=>{
  await chrome.storage.local.set({'keypilot.encryptedVault':cache.encryptedVault,'keypilot.reminderIndex':index,'keypilot.language':cache.vault.settings.language});
  await chrome.storage.session.set({'keypilot.unlockedSession':cache,'keypilot.sessionState':{id:cache.sessionId,expiresAt:0,highSecurity:false}});
 });},{cache,index:buildReminderIndex(vault,encryptedVault.kdf.salt,null)});
}
async function open(){const page=await context.newPage();await page.goto(url);await expect(page.locator('html')).toHaveAttribute('data-keypilot-content-script','0.1.0');return page;}
async function fill(action:'login'|'fill'='login'){
 return worker.evaluate(async({id,url,action})=>{
  const [tab]=await chrome.tabs.query({url});
  return (await chrome.scripting.executeScript({target:{tabId:tab.id!},func:async(id,action)=>chrome.runtime.sendMessage({type:'KEYPILOT_INLINE_FILL',request:{credentialId:id,action}}),args:[id,action]}))[0].result;
 },{id:credential.id,url,action});
}
const panel=(page:Page)=>page.getByRole('dialog',{name:'本地验证码识别'});
async function pending(page:Page){await expect(panel(page).getByRole('status')).toContainText('正在本机',{timeout:15000});}

test('explicit inline login recognizes and fills the first result, then submits exactly once',async()=>{
 await seed();const page=await open(),errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
 const result=await fill();expect(result).toMatchObject({ok:true,submitted:true,skippedSubmit:false});
 await expect(page.locator('#username')).toHaveValue(credential.username);await expect(page.locator('#password')).toHaveValue(credential.password);
 await expect(page.locator('#captcha')).toHaveValue('4827');await expect(page.locator('#submitted')).toHaveText('1');await expect(panel(page)).toBeHidden();
 await page.waitForTimeout(3500);await expect(page.locator('#submitted')).toHaveText('1');expect(errors).toEqual([]);
 await mkdir(evidence,{recursive:true});await page.screenshot({path:resolve(evidence,'one-click-complete.png'),fullPage:true});
});

test('one-click login waits for a delayed English language pack before preparing captcha controls',async()=>{
 await worker.evaluate(()=>{
  const original=globalThis.fetch;
  const gate=new Promise<void>(resolve=>(globalThis as any).releaseLanguage=resolve);
  globalThis.fetch=async(...args)=>{
   if(String(args[0]).endsWith('/locales/messages.json'))await gate;
   return original(...args);
  };
 });
 await seed(true,false,'en-US');const page=await open();
 const response=fill();
 await expect(page.locator('#password')).toHaveValue(credential.password);
 await expect(page.locator('#keypilot-captcha-root')).toHaveCount(0);
 await worker.evaluate(()=>(globalThis as any).releaseLanguage());
 expect(await response).toMatchObject({ok:true,submitted:true,skippedSubmit:false});
 await expect(page.locator('#captcha')).toHaveValue('4827');
 await expect(page.locator('#submitted')).toHaveText('1');
 await expect(page.getByRole('dialog',{name:'Local captcha recognition'})).toBeHidden();
});
test('opening a saved login through the managed job also completes CAPTCHA without a second click',async()=>{
 await seed();const control=await context.newPage();await control.goto(base+'/login-status.html');
 const response=await control.evaluate(id=>chrome.runtime.sendMessage({type:'KEYPILOT_OPEN_TAB',action:'login',credential:{id,autoSubmit:true}}),credential.id);expect(response.ok).toBe(true);
 await expect.poll(async()=>worker.evaluate(async()=>Object.values((await chrome.storage.session.get('keypilot.loginJobs'))['keypilot.loginJobs']??{}).map((job:any)=>job.phase)),{timeout:35000}).toEqual(['done']);
 const page=context.pages().find(page=>page.url()===url)!;await expect(page.locator('#captcha')).toHaveValue('4827');await expect(page.locator('#submitted')).toHaveText('1');
});
test('fill-only leaves the CAPTCHA and submit action to the user',async()=>{
 await seed();const page=await open();const result=await fill('fill');expect(result.ok).toBe(true);
 await expect(page.locator('#password')).toHaveValue(credential.password);await expect(page.locator('#captcha')).toHaveValue('');await expect(page.locator('#submitted')).toHaveText('0');
 expect(await worker.evaluate(()=>chrome.offscreen.hasDocument())).toBe(false);
});
for(const disabledSite of [false,true])test(`disabled ${disabledSite?'site':'global'} OCR is respected by one-click login`,async()=>{
 await seed(disabledSite,disabledSite);const page=await open();const result=await fill();expect(result).toMatchObject({ok:true,skippedSubmit:true,submitted:false});
 expect(result.captchaMessage).toContain(disabledSite?'此网站已关闭':'开启本地');await expect(page.locator('#captcha')).toHaveValue('');await expect(page.locator('#submitted')).toHaveText('0');
 expect(await worker.evaluate(()=>chrome.offscreen.hasDocument())).toBe(false);
});
test('SMS in the same form prevents automatic submission even with a valid image CAPTCHA',async()=>{
 await seed();const page=await open();await page.locator('form').evaluate(form=>form.insertAdjacentHTML('beforeend','<label>SMS code<input name="sms" autocomplete="one-time-code"></label>'));
 const result=await fill();expect(result.skippedSubmit).toBe(true);await expect(page.locator('#captcha')).toHaveValue('');await expect(page.locator('#submitted')).toHaveText('0');
});
test('blank images pause for manual handling without submitting',async()=>{
 await seed();const page=await open();await page.evaluate(()=>(window as any).drawCaptcha(''));
 const result=await fill();expect(result.skippedSubmit).toBe(true);await expect(panel(page).getByRole('status')).toContainText('未得到清晰');await expect(page.locator('#submitted')).toHaveText('0');
});
for(const mutation of ['image','captcha','password','close'] as const)test(`a ${mutation} change during OCR cancels automatic fill and submission`,async()=>{
 await seed();const page=await open();const response=fill();await pending(page);
 if(mutation==='image')await page.evaluate(()=>(window as any).drawCaptcha('5931'));
 if(mutation==='captcha')await page.locator('#captcha').fill('manual-code');
 if(mutation==='password')await page.locator('#password').fill('edited-password');
 if(mutation==='close')await panel(page).getByRole('button',{name:'关闭验证码识别'}).click();
 const result=await response;expect(result.submitted).toBe(false);await expect(page.locator('#submitted')).toHaveText('0');
 await expect(page.locator('#captcha')).toHaveValue(mutation==='captcha'?'manual-code':'');
});
test('locking during OCR cancels the pending login',async()=>{
 await seed();const page=await open();const response=fill();await pending(page);
 await worker.evaluate(()=>chrome.storage.session.remove(['keypilot.unlockedSession','keypilot.sessionState']));
 const result=await response;expect(result.submitted).not.toBe(true);await expect(page.locator('#captcha')).toHaveValue('');await expect(page.locator('#submitted')).toHaveText('0');
});
test('repeated one-click requests share no second recognition or submission',async()=>{
 await seed();const page=await open();const first=fill();await pending(page);const duplicate=await fill();expect(duplicate).toMatchObject({ok:false,error:'LOGIN_IN_PROGRESS'});
 expect((await first).submitted).toBe(true);await page.waitForTimeout(3000);await expect(page.locator('#submitted')).toHaveText('1');
});
test('a reactive disabled button is clicked once after CAPTCHA input enables it',async()=>{
 await seed();const page=await open();await page.evaluate(()=>{const button=document.querySelector<HTMLButtonElement>('#login')!;button.disabled=true;document.querySelector('#captcha')!.addEventListener('input',()=>setTimeout(()=>button.disabled=false,650));});
 expect((await fill()).submitted).toBe(true);await expect(page.locator('#submitted')).toHaveText('1');
});
test('already entered CAPTCHA is preserved and submitted without starting OCR',async()=>{
 await seed();const page=await open();await page.locator('#captcha').fill('4827');expect((await fill()).submitted).toBe(true);await expect(page.locator('#captcha')).toHaveValue('4827');await expect(page.locator('#submitted')).toHaveText('1');
 expect(await worker.evaluate(()=>chrome.offscreen.hasDocument())).toBe(false);
});
test('a two-step login continues through the password and CAPTCHA step once',async()=>{
 await seed();const page=await open();await page.evaluate(()=>{document.querySelector<HTMLElement>('#password-step')!.hidden=true;document.querySelector('#login')!.textContent='Next';});
 const result=await fill();expect(result).toMatchObject({ok:true,stage:'usernameOnly',submitted:true});
 await expect(page.locator('#submitted')).toHaveText('1',{timeout:35000});await expect(page.locator('#steps')).toHaveText('1');await expect(page.locator('#captcha')).toHaveValue('4827');
 await page.waitForTimeout(3000);await expect(page.locator('#submitted')).toHaveText('1');
});
test('arithmetic is calculated and submitted automatically without choosing a mode',async()=>{
 await seed();const page=await open();await page.locator('canvas').evaluate(canvas=>{
  const c=canvas as HTMLCanvasElement;c.width=240;c.height=64;const x=c.getContext('2d')!;
  x.fillStyle='#f4f8fb';x.fillRect(0,0,240,64);x.fillStyle='#483267';x.font='bold 30px Arial';x.textBaseline='middle';x.fillText('3 + 4 = ?',12,32);
 });
 expect((await fill()).submitted).toBe(true);await expect(page.locator('#captcha')).toHaveValue('7');await expect(page.locator('#submitted')).toHaveText('1');
});
test('manual submission during OCR prevents a later automated submission',async()=>{
 await seed();const page=await open();const response=fill();await pending(page);await page.locator('#login').click();
 expect((await response).submitted).toBe(false);await expect(page.locator('#captcha')).toHaveValue('');await page.waitForTimeout(3000);await expect(page.locator('#submitted')).toHaveText('1');
});
test('refreshing the image after CAPTCHA input or before click prevents submission',async()=>{
 await seed();const page=await open();await page.locator('#captcha').evaluate(input=>input.addEventListener('input',()=> (window as any).drawCaptcha('5931'),{once:true}));
 expect((await fill()).submitted).toBe(false);await expect(page.locator('#submitted')).toHaveText('0');
 await page.reload();await page.locator('#login').evaluate(button=>button.addEventListener('mousedown',()=> (window as any).drawCaptcha('5931'),{once:true}));
 expect((await fill()).submitted).toBe(false);await expect(page.locator('#submitted')).toHaveText('0');
});
test('a new explicit login rereads a refreshed image instead of reusing its previous automatic answer',async()=>{
 await seed();const page=await open();expect((await fill()).submitted).toBe(true);await expect(page.locator('#captcha')).toHaveValue('4827');
 await page.evaluate(()=>(window as any).drawCaptcha('5931'));
 expect((await fill()).submitted).toBe(true);await expect(page.locator('#captcha')).toHaveValue('5931');await expect(page.locator('#submitted')).toHaveText('2');
});
test('reinjected content script installs no duplicate login or OCR listeners',async()=>{
 await seed();const page=await open();await worker.evaluate(async url=>{const [tab]=await chrome.tabs.query({url});await chrome.scripting.executeScript({target:{tabId:tab.id!},files:['content.js']});},url);
 expect((await fill()).submitted).toBe(true);await expect(page.locator('#captcha')).toHaveValue('4827');await page.waitForTimeout(3000);await expect(page.locator('#submitted')).toHaveText('1');
});

test('failed OCR offers an editable answer and Enter fills and continues login once',async()=>{
 await seed();const page=await open();await page.evaluate(()=>(window as any).drawCaptcha(''));
 expect((await fill()).skippedSubmit).toBe(true);
 const result=panel(page).getByLabel('识别结果（可修改）');await expect(result).toBeVisible();await result.fill('4827');
 const button=panel(page).getByRole('button',{name:'继续登录',exact:true});await expect(button).toBeEnabled();
 await mkdir(evidence,{recursive:true});await page.screenshot({path:resolve(evidence,'continue-login-manual.png')});
 await result.press('Enter');await expect(page.locator('#submitted')).toHaveText('1');await expect(panel(page)).toBeHidden();
 await page.waitForTimeout(2500);await expect(page.locator('#submitted')).toHaveText('1');
});
test('a rejected automatic CAPTCHA can be corrected and explicitly resubmitted',async()=>{
 await seed();const page=await open();await fill();await expect(page.locator('#submitted')).toHaveText('1');
 await page.getByRole('button',{name:'修正验证码',exact:true}).click();
 const result=panel(page).getByLabel('识别结果（可修改）');await expect(result).toBeVisible();await result.fill('5931');await result.press('Enter');
 await expect(page.locator('#captcha')).toHaveValue('5931');await expect(page.locator('#submitted')).toHaveText('2');
 await page.waitForTimeout(2000);await expect(page.locator('#submitted')).toHaveText('2');
});
for(const change of ['close','password','disable'] as const)test(`CAPTCHA continuation cannot submit after ${change}`,async()=>{
 await seed();const page=await open();await page.evaluate(()=>(window as any).drawCaptcha(''));await fill();
 if(change==='close'){
  await panel(page).getByRole('button',{name:'关闭验证码识别'}).click();await page.getByRole('button',{name:'识别验证码',exact:true}).click();
  await expect(panel(page).getByLabel('识别结果（可修改）')).toBeVisible();
 }else if(change==='password')await page.locator('#password').fill('edited');
 else await worker.evaluate(async()=>navigator.locks.request('keypilot-vault-write',async()=>{const key='keypilot.unlockedSession',cache=(await chrome.storage.session.get(key))[key];cache.vault.settings.autoSubmit=false;await chrome.storage.session.set({[key]:cache});}));
 // Moving focus outside the CAPTCHA cancels the pending action; reopen as a manual assist.
 if(change==='password'){await page.locator('#captcha').focus();await page.getByRole('button',{name:'识别验证码',exact:true}).click();await expect(panel(page).getByLabel('识别结果（可修改）')).toBeVisible();}
 await panel(page).getByLabel('识别结果（可修改）').fill('4827');await panel(page).getByLabel('识别结果（可修改）').press('Enter');
 await page.waitForTimeout(1500);await expect(page.locator('#submitted')).toHaveText('0');
});
