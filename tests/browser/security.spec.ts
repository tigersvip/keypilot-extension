import {test,expect,chromium,type BrowserContext,type Worker,type Page} from '@playwright/test';
import {resolve} from 'node:path';
import {mkdir,readFile} from 'node:fs/promises';
import {createEmptyVault} from '../../src/shared/defaults';
import {buildCredential} from '../../src/shared/vault';
import {createEncryptedVault,exportVaultKey,unlockEncryptedVault} from '../../src/shared/crypto';
import {generateSaveInboxKeyPair} from '../../src/shared/saveInbox';
import {parseTotpInput,generateTotp} from '../../src/shared/totp';
import {completeBackupFixture} from '../fixtures/completeBackup';
import {decodeQrPixels} from '../../src/shared/qrImport';
import type {VaultPlain} from '../../src/shared/types';

let context:BrowserContext,worker:Worker,base:string;
const master='Test-security!42', evidence=resolve(process.env.TEMP ?? '..','keypilot-security-v1.6.0');
const site='https://otp.example.test';
function fixture() {
  const vault=createEmptyVault();vault.settings.openStartPageOnLogin=false;
  vault.credentials=[{...buildCredential({title:'Synthetic OTP login',url:site,username:'synthetic-user',password:'Synthetic-current!42'}),id:'login-1',iconType:'default' as const,iconUrl:undefined}];
  vault.totpAccounts=[{...completeBackupFixture().totpAccounts![0],id:'otp-1',digits:6 as const,credentialId:'login-1'}];
  return vault;
}
test.beforeEach(async()=>{
  const extension=resolve('dist');context=await chromium.launchPersistentContext('',{channel:'chromium',headless:true,args:['--disable-extensions-except='+extension,'--load-extension='+extension],permissions:['clipboard-read','clipboard-write']});
  worker=context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');base='chrome-extension://'+new URL(worker.url()).host;
  await mkdir(evidence,{recursive:true});
});
test.afterEach(async()=>{await context?.close();});
async function seed(vault=fixture()) {
  vault.saveInboxKeyPair=await generateSaveInboxKeyPair();
  const {encryptedVault,key}=await createEncryptedVault(master,vault);
  const cache={vault,encryptedVault,exportedKey:await exportVaultKey(key),cachedAt:Date.now(),sessionId:'security-test-session'};
  await worker.evaluate(async({encryptedVault,cache})=>{await navigator.locks.request('keypilot-vault-write',async()=>{await chrome.storage.local.set({'keypilot.encryptedVault':encryptedVault});await chrome.storage.session.set({'keypilot.unlockedSession':cache,'keypilot.sessionState':{id:cache.sessionId,expiresAt:0,highSecurity:false}});});},{encryptedVault,cache});
}
async function decrypted(){const encrypted=await worker.evaluate(async()=>(await chrome.storage.local.get('keypilot.encryptedVault'))['keypilot.encryptedVault']);return (await unlockEncryptedVault(master,encrypted)).vault;}
async function authenticate(page:Page){const dialog=page.getByRole('dialog',{name:'验证主密码'});await dialog.getByLabel('主密码',{exact:true}).fill(master);await dialog.getByRole('button',{name:'验证',exact:true}).click();await expect(dialog).not.toBeVisible();}
function errorsOn(page:Page){const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));page.on('console',msg=>{if(msg.type()==='error')errors.push(msg.text());});return errors;}
async function formPage(body:string,path='/verify') {
  await context.route(site+'/**',route=>route.fulfill({contentType:'text/html',body:`<!doctype html><meta charset="utf-8"><title>Synthetic verification</title><style>body{font:16px sans-serif;padding:40px}input{width:140px;padding:10px;margin:6px}input[maxlength="1"]{width:28px}</style><h1>Two-step verification</h1><form>${body}<button>Submit</button></form><script>window.inputEvents=[];window.submissions=0;document.addEventListener('input',e=>window.inputEvents.push(e.target.value));document.querySelector('form').addEventListener('submit',e=>{e.preventDefault();window.submissions++;});</script>`}));
  const page=await context.newPage();await page.goto(site+path);return page;
}
async function openFill(page:Page){await page.locator('.kp-totp-row').getByRole('button',{name:'填写验证码',exact:true}).click();return page.getByRole('dialog',{name:'填写动态验证码'});}
async function setOtpTime(time:number) {
  await worker.evaluate(async time=>{
    Date.now=()=>time;
    for(const tab of await chrome.tabs.query({url:'https://otp.example.test/*'}))if(tab.id)await chrome.scripting.executeScript({target:{tabId:tab.id,allFrames:true},func:time=>{Date.now=()=>time;},args:[time]});
  },time);
}

test('binding appears in account details and compact popup; edits keep links and statistics count 2FA',async()=>{
  const source=fixture();delete source.totpAccounts![0].credentialId;await seed(source);
  const page=await context.newPage(),errors=errorsOn(page);await page.setViewportSize({width:1440,height:1000});
  await page.goto(base+'/vault.html');await page.getByText('Synthetic OTP login',{exact:true}).first().dblclick();
  const panel=page.getByRole('region',{name:'账号验证与恢复'});
  await panel.getByLabel('选择已有验证码').selectOption('otp-1');await panel.getByRole('button',{name:'关联验证码',exact:true}).click();
  await expect(panel.getByRole('button',{name:'填写验证码'})).toBeVisible();
  expect((await decrypted()).totpAccounts![0].credentialId).toBe('login-1');
  await page.screenshot({path:resolve(evidence,'account-detail.png'),fullPage:true});
  await page.goto(base+'/vault.html#authenticator');await page.getByLabel('更多验证码操作').click();await page.getByRole('button',{name:'编辑身份验证器'}).click();
  await expect(page.getByLabel('关联登录账号')).toHaveValue('login-1');await page.getByLabel('服务名称',{exact:true}).fill('Renamed service');await page.getByRole('button',{name:'保存身份验证器'}).click();
  expect((await decrypted()).totpAccounts![0].credentialId).toBe('login-1');
  const popup=await context.newPage();await popup.setViewportSize({width:400,height:600});await popup.goto(base+'/popup.html');
  await popup.getByRole('button',{name:'查看 Synthetic OTP login',exact:true}).click();
  await expect(popup.getByRole('region',{name:'账号验证与恢复'})).toContainText('Renamed service');
  await popup.getByRole('region',{name:'账号验证与恢复'}).scrollIntoViewIfNeeded();
  expect(await popup.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await popup.screenshot({path:resolve(evidence,'account-popup.png'),fullPage:true});
  await page.goto(base+'/options.html#account');await expect(page.locator('.metric').filter({hasText:'全部项目'})).toContainText('2');
  expect(errors).toEqual([]);
});

for(const digits of [6,8])test(`one-click 2FA fills ${digits}-digit segmented inputs without submitting or sending secrets`,async()=>{
  const source=fixture();source.totpAccounts![0].digits=digits as 6|8;await seed(source);
  const target=await formPage('<fieldset><legend>验证码</legend>'+Array.from({length:digits},(_,i)=>`<input maxlength="1" inputmode="numeric" aria-label="验证码第${i+1}位">`).join('')+'</fieldset>');
  await setOtpTime(60000);
  const page=await context.newPage(),errors=errorsOn(page);await page.goto(base+'/vault.html#authenticator');
  const dialog=await openFill(page);await dialog.getByRole('button',{name:'填写到此页面'}).click();await expect(dialog).not.toBeVisible();
  const expected=await generateTotp(source.totpAccounts![0],60000);
  expect(await target.locator('input[maxlength="1"]').evaluateAll(inputs=>inputs.map(input=>(input as HTMLInputElement).value).join(''))).toBe(expected);
  expect(await target.evaluate(()=>({events:(window as any).inputEvents.length,submissions:(window as any).submissions}))).toEqual({events:digits,submissions:0});
  expect(await target.locator('body').textContent()).not.toContain(source.totpAccounts![0].secret);
  expect(errors).toEqual([]);
});

test('single OTP respects master verification, expiry, existing text and explicit target tab selection',async()=>{
  const source=fixture();source.settings.requireMasterPasswordForReveal=true;await seed(source);
  const first=await formPage('<label>验证码<input autocomplete="one-time-code" maxlength="6"></label>');
  const second=await context.newPage();await second.goto(site+'/second');
  await setOtpTime(59000);
  const page=await context.newPage();await page.goto(base+'/vault.html#authenticator');const dialog=await openFill(page);
  const tabs=await worker.evaluate(()=>chrome.tabs.query({url:'https://otp.example.test/second'}));await dialog.getByLabel('目标网页').selectOption(String(tabs[0].id));
  await dialog.getByRole('button',{name:'填写到此页面'}).click();await page.getByRole('dialog',{name:'验证主密码'}).getByRole('button',{name:'取消'}).click();
  await expect(first.locator('input[autocomplete="one-time-code"]')).toHaveValue('');await expect(second.locator('input[autocomplete="one-time-code"]')).toHaveValue('');
  await dialog.getByRole('button',{name:'填写到此页面'}).click();await authenticate(page);await expect(dialog).toContainText('即将过期');
  await setOtpTime(60000);await second.locator('input[autocomplete="one-time-code"]').fill('111111');
  await dialog.getByRole('button',{name:'填写到此页面'}).click();await authenticate(page);await expect(dialog).toContainText('已有其他内容');
  await second.locator('input[autocomplete="one-time-code"]').fill('');await dialog.getByRole('button',{name:'填写到此页面'}).click();await authenticate(page);
  await expect(dialog).not.toBeVisible();await expect(second.locator('input[autocomplete="one-time-code"]')).toHaveValue('359152');await expect(first.locator('input[autocomplete="one-time-code"]')).toHaveValue('');
});

test('OTP refuses unrelated domains, foreign iframes, captcha and locked sessions',async()=>{
  await seed();await context.route('https://foreign.example.test/**',route=>route.fulfill({contentType:'text/html',body:'<input autocomplete="one-time-code">'}));
  const target=await formPage('<input name="captcha" placeholder="图片验证码"><iframe src="https://foreign.example.test/"></iframe>');
  const foreign=await context.newPage();await foreign.goto('https://foreign.example.test/');
  await worker.evaluate(()=>{Date.now=()=>60000;});const page=await context.newPage();await page.goto(base+'/vault.html#authenticator');
  const dialog=await openFill(page);await dialog.getByRole('button',{name:'填写到此页面'}).click();await expect(dialog).toContainText('未找到验证码输入框');
  await expect(target.locator('input[name="captcha"]')).toHaveValue('');await expect(target.frameLocator('iframe').locator('input[autocomplete="one-time-code"]')).toHaveValue('');
  const foreignId=(await worker.evaluate(()=>chrome.tabs.query({url:'https://foreign.example.test/'})))[0].id;
  const response=await page.evaluate(async tabId=>chrome.runtime.sendMessage({type:'KEYPILOT_FILL_TOTP',accountId:'otp-1',tabId,sessionId:'security-test-session'}),foreignId);
  expect(response.error).toBe('OTP_SITE_MISMATCH');await expect(foreign.locator('input[autocomplete="one-time-code"]')).toHaveValue('');
  await page.evaluate(()=>chrome.runtime.sendMessage({type:'KEYPILOT_LOCK_VAULT'}));await expect(dialog).not.toBeVisible();
  const locked=await page.evaluate(async tabId=>chrome.runtime.sendMessage({type:'KEYPILOT_FILL_TOTP',accountId:'otp-1',tabId,sessionId:'security-test-session'}),foreignId);expect(locked.error).toBe('VAULT_LOCKED');
});

test('ambiguous OTPs require a focused field, while same-origin iframes fill without exposing a content-script command',async()=>{
  await seed();
  const target=await formPage('<label>验证码<input id="first" autocomplete="one-time-code"></label><label>验证码<input id="second" autocomplete="one-time-code"></label>');
  await setOtpTime(60000);
  const page=await context.newPage();await page.goto(base+'/vault.html#authenticator');
  let dialog=await openFill(page);await dialog.getByRole('button',{name:'填写到此页面'}).click();await expect(dialog).toContainText('找到多个验证码输入框');
  await target.locator('#second').click();await dialog.getByRole('button',{name:'填写到此页面'}).click();await expect(dialog).not.toBeVisible();
  await expect(target.locator('#first')).toHaveValue('');await expect(target.locator('#second')).toHaveValue('359152');
  await context.route(site+'/frame',route=>route.fulfill({contentType:'text/html',body:'<label>验证码<input autocomplete="one-time-code"></label>'}));
  await context.route(site+'/frame-host',route=>route.fulfill({contentType:'text/html',body:'<input readonly autocomplete="one-time-code"><iframe src="/frame"></iframe>'}));
  await target.goto(site+'/frame-host');await setOtpTime(60000);
  dialog=await openFill(page);await dialog.getByRole('button',{name:'填写到此页面'}).click();await expect(dialog).not.toBeVisible();
  await expect(target.locator('input[autocomplete="one-time-code"]')).toHaveValue('');await expect(target.frameLocator('iframe').locator('input[autocomplete="one-time-code"]')).toHaveValue('359152');
  const response=await worker.evaluate(async()=>{
    const tab=(await chrome.tabs.query({url:'https://otp.example.test/frame-host'}))[0];
    return chrome.scripting.executeScript({target:{tabId:tab.id!},func:async()=>chrome.runtime.sendMessage({type:'KEYPILOT_FILL_TOTP',accountId:'otp-1',tabId:1,sessionId:'security-test-session'})});
  });
  expect(response[0].result.error).toBe('REAUTH_REQUIRED');
});

test('QR export forces verification, round-trips locally, downloads PNG and clears on expiry and lock',async()=>{
  await seed();const page=await context.newPage(),errors=errorsOn(page);await page.clock.install();await page.goto(base+'/vault.html#authenticator');await context.setOffline(true);
  await page.getByLabel('更多验证码操作').click();await page.getByRole('button',{name:'导出二维码 / 链接'}).click();
  await expect(page.getByRole('dialog',{name:'验证主密码'})).toBeVisible();await authenticate(page);
  const dialog=page.getByRole('dialog',{name:'导出身份验证器'});await expect(dialog).toBeVisible();
  const uri=await dialog.getByLabel('标准设置链接').inputValue();expect(parseTotpInput(uri).secret).toBe(fixture().totpAccounts![0].secret);
  const qrSource=await dialog.getByRole('img').getAttribute('src');expect(qrSource).toMatch(/^data:image\/png;base64,/);
  const pixels=await dialog.getByRole('img').evaluate(async(image:HTMLImageElement)=>{await image.decode();const canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;const ctx=canvas.getContext('2d')!;ctx.drawImage(image,0,0);return {data:Array.from(ctx.getImageData(0,0,canvas.width,canvas.height).data),width:canvas.width,height:canvas.height};});
  expect(decodeQrPixels({...pixels,data:new Uint8ClampedArray(pixels.data)})).toContain(uri);
  const downloading=page.waitForEvent('download');await dialog.getByRole('button',{name:'下载二维码'}).click();const download=await downloading;expect((await readFile((await download.path())!)).subarray(1,4).toString()).toBe('PNG');
  await page.screenshot({path:resolve(evidence,'qr-export.png'),fullPage:true});
  await page.clock.runFor(30001);await expect(dialog).not.toBeVisible();await expect(page.getByLabel('标准设置链接')).toHaveCount(0);
  await page.getByRole('button',{name:'导出二维码 / 链接'}).click();await authenticate(page);await expect(dialog).toBeVisible();
  await page.evaluate(()=>chrome.runtime.sendMessage({type:'KEYPILOT_LOCK_VAULT'}));await expect(dialog).not.toBeVisible();expect(errors).toEqual([]);
});

test('password history restores and records the displaced password; recovery codes stay masked and persist used states',async()=>{
  const source=fixture();source.credentials[0].passwordHistory=[{id:'old-password',password:'Synthetic-old!42',changedAt:1}];await seed(source);
  const page=await context.newPage(),errors=errorsOn(page);await page.goto(base+'/vault.html');await page.getByText('Synthetic OTP login',{exact:true}).first().dblclick();
  const panel=page.getByRole('region',{name:'账号验证与恢复'});await panel.getByText('密码历史（1）',{exact:true}).click();
  await expect(panel).not.toContainText('Synthetic-old!42');page.once('dialog',dialog=>dialog.accept());await panel.getByRole('button',{name:'恢复此密码'}).click();
  await expect(panel.locator('p[role=status]')).toHaveText('已保存。');
  await expect.poll(async()=>(await decrypted()).credentials[0].password).toBe('Synthetic-old!42');expect((await decrypted()).credentials[0].passwordHistory![0].password).toBe('Synthetic-current!42');
  await panel.getByText('网站恢复码（0 个未使用）',{exact:true}).click();await panel.getByRole('button',{name:'添加网站恢复码'}).click();await panel.getByLabel('网站恢复码，每行一个').fill('RECOVERY-ONE\nRECOVERY-TWO\nRECOVERY-ONE');await panel.getByRole('button',{name:'保存恢复码'}).click();
  await expect(panel.getByText('网站恢复码（2 个未使用）')).toBeVisible();await expect(panel).not.toContainText('RECOVERY-ONE');
  await panel.getByRole('button',{name:'标记已使用',exact:true}).first().click();await expect(panel.getByText('网站恢复码（1 个未使用）')).toBeVisible();
  expect((await decrypted()).credentials[0].recoveryCodes!.filter(item=>item.usedAt)).toHaveLength(1);
  const securityBounds=await panel.boundingBox(),notesBounds=await page.locator('.detail-notes').boundingBox();
  expect(notesBounds!.y).toBeGreaterThanOrEqual(securityBounds!.y+securityBounds!.height);
  await panel.getByText('网站恢复码（1 个未使用）',{exact:true}).scrollIntoViewIfNeeded();
  await page.screenshot({path:resolve(evidence,'history-recovery.png'),fullPage:true});
  const raw=await worker.evaluate(async()=>JSON.stringify((await chrome.storage.local.get('keypilot.encryptedVault'))['keypilot.encryptedVault']));expect(raw).not.toContain('RECOVERY-ONE');expect(raw).not.toContain('Synthetic-old!42');expect(errors).toEqual([]);
});

test('backup conflict choices update preview counts and remap bound 2FA to the selected login',async()=>{
  const current=fixture();current.totpAccounts=[];await seed(current);
  const incoming=fixture();incoming.credentials[0].password='Incoming-password!42';
  const {encryptedVault}=await createEncryptedVault(master,incoming);
  const page=await context.newPage();await page.goto(base+'/options.html#account');
  await page.getByLabel('备份文件',{exact:true}).setInputFiles({name:'synthetic.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(encryptedVault))});await page.getByLabel('备份主密码',{exact:true}).fill(master);await page.getByRole('button',{name:'预览备份',exact:true}).click();
  const conflict=page.getByLabel('冲突 1 的处理方式');await expect(conflict).toHaveValue('both');await conflict.selectOption('current');
  await expect(page.getByRole('table',{name:'合并预览'}).getByRole('row').filter({hasText:'登录账号'})).toHaveText('登录账号001');
  await conflict.selectOption('incoming');await page.screenshot({path:resolve(evidence,'backup-conflict.png'),fullPage:true});await page.getByRole('button',{name:'确认合并',exact:true}).click();
  await expect(page.getByText(/合并完成/)).toBeVisible();const merged=await decrypted();expect(merged.credentials).toHaveLength(1);expect(merged.credentials[0].password).toBe('Incoming-password!42');expect(merged.credentials[0].passwordHistory![0].password).toBe('Synthetic-current!42');expect(merged.totpAccounts![0].credentialId).toBe(merged.credentials[0].id);
});
