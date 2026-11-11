import {test,expect,chromium,type BrowserContext,type Worker,type Page} from '@playwright/test';
import {resolve} from 'node:path';
import {mkdir} from 'node:fs/promises';
import {createEmptyVault} from '../../src/shared/defaults';
import {createEncryptedVault,exportVaultKey,importVaultKey,encryptVaultWithExistingKey} from '../../src/shared/crypto';
import {generateSaveInboxKeyPair} from '../../src/shared/saveInbox';
import {buildCredential} from '../../src/shared/vault';
import {buildReminderIndex} from '../../src/shared/reminders';
import {generateTotp} from '../../src/shared/totp';

const origin='https://continuation.example.test',url=origin+'/login';
const form=`<!doctype html><meta charset="utf-8"><style>body{font:16px Arial;padding:30px}label{display:block;margin:15px}input{height:36px}</style><form><label>Username<input id="username" autocomplete="username"></label><label>Password<input id="password" type="password" autocomplete="current-password"></label><button type="submit">Sign in</button></form><p id="submitted">0</p><script>document.querySelector('form').onsubmit=e=>{e.preventDefault();document.querySelector('#submitted').textContent=String(Number(document.querySelector('#submitted').textContent)+1)}</script>`;
const otp=`<form><h2>Authenticator code</h2><label>Code from your authenticator app<input id="otp" autocomplete="one-time-code" maxlength="6"></label><button type="submit">Verify</button></form><p id="verified">0</p><script>document.querySelector('form').onsubmit=e=>{e.preventDefault();document.querySelector('#verified').textContent='1'}</script>`;
const account={id:'public-rfc-fixture',issuer:'Synthetic',account:'synthetic-user',secret:'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',algorithm:'SHA1' as const,digits:6 as const,period:30,createdAt:1,updatedAt:1};
let context:BrowserContext,worker:Worker,base:string,credential:ReturnType<typeof buildCredential>;
test.beforeEach(async()=>{
 const extension=resolve('dist');context=await chromium.launchPersistentContext('',{channel:'chromium',headless:true,args:['--disable-extensions-except='+extension,'--load-extension='+extension,'--mute-audio']});
 worker=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker');base='chrome-extension://'+new URL(worker.url()).host;
 await context.route('https://**.example.test/**',route=>route.fulfill({contentType:'text/html',body:route.request().url().endsWith('/otp')?otp:form}));
});
test.afterEach(async()=>{await context?.close();});
async function seed(autoSubmit=true,autoTotp=false,duplicate=false,secondLogin=false){
 const vault=createEmptyVault();vault.saveInboxKeyPair=await generateSaveInboxKeyPair();vault.settings.autoFill=false;vault.settings.autoSubmit=autoSubmit;vault.settings.autoTotpOrigins=autoTotp?[origin]:[];
 credential=buildCredential({title:'Synthetic login',url,username:'synthetic-user',password:'Synthetic-only!42'});vault.credentials=[credential];
 if(secondLogin)vault.credentials.push({...buildCredential({title:'Other synthetic login',url,username:'other-user',password:'Other-fixture!42'}),updatedAt:Date.now()+1000});
 vault.totpAccounts=[{...account,credentialId:credential.id},...(duplicate?[{...account,id:'second',credentialId:credential.id}]:[])];
 const {encryptedVault,key}=await createEncryptedVault('Test-master!42',vault),cache={vault,encryptedVault,exportedKey:await exportVaultKey(key),cachedAt:Date.now(),sessionId:'continuation-test'};
 await worker.evaluate(async({cache,index})=>navigator.locks.request('keypilot-vault-write',async()=>{
  await chrome.storage.local.set({'keypilot.encryptedVault':cache.encryptedVault,'keypilot.reminderIndex':index});
  await chrome.storage.session.set({'keypilot.unlockedSession':cache,'keypilot.sessionState':{id:cache.sessionId,expiresAt:0,highSecurity:false}});
 }),{cache,index:buildReminderIndex(vault,encryptedVault.kdf.salt,null)});
}
async function open(){const page=await context.newPage();await page.goto(url);await expect(page.locator('html')).toHaveAttribute('data-keypilot-content-script','0.1.0');return page;}
async function fill(action='login'){
 return worker.evaluate(async({id,url,action})=>{
  const [tab]=await chrome.tabs.query({url});
  return (await chrome.scripting.executeScript({target:{tabId:tab.id!},func:async(id,action)=>chrome.runtime.sendMessage({type:'KEYPILOT_INLINE_FILL',request:{credentialId:id,action}}),args:[id,action]}))[0].result;
 },{id:credential.id,url,action});
}
async function changeSetting(name:string,value:any){
 const cache=await worker.evaluate(async()=>(await chrome.storage.session.get('keypilot.unlockedSession'))['keypilot.unlockedSession']);
 cache.vault.settings[name]=value;cache.encryptedVault=await encryptVaultWithExistingKey(await importVaultKey(cache.exportedKey),cache.encryptedVault,cache.vault);
 await worker.evaluate(async cache=>navigator.locks.request('keypilot-vault-write',async()=>{await chrome.storage.local.set({'keypilot.encryptedVault':cache.encryptedVault});await chrome.storage.session.set({'keypilot.unlockedSession':cache});}),cache);
}
async function showOtp(page:Page,markup=otp){await page.locator('form').evaluate((form,markup)=>{form.outerHTML=markup;},markup);}
async function expectCurrentCode(page:Page){await expect(page.locator('#otp')).toHaveValue(/^\d{6}$/,{timeout:15000});const value=await page.locator('#otp').inputValue(),now=Date.now();expect([await generateTotp(account,now),await generateTotp(account,now-30000)]).toContain(value);}

for(const entry of ['inline','active','managed'])test(`global auto-submit off is respected by ${entry} login`,async()=>{
 await seed(false);let page:Page;
 if(entry==='managed'){
  const control=await context.newPage();await control.goto(base+'/login-status.html');
  await control.evaluate(id=>chrome.runtime.sendMessage({type:'KEYPILOT_OPEN_TAB',action:'login',credential:{id,autoSubmit:true}}),credential.id);
  await expect.poll(()=>context.pages().some(page=>page.url()===url)).toBe(true);page=context.pages().find(page=>page.url()===url)!;
 }else{
  page=await open();
  if(entry==='inline'){const result=await fill();expect(result.skippedSubmit).toBe(true);expect(result.captchaMessage).toContain('自动点击登录已关闭');}
  else await worker.evaluate(async({url,credential})=>{const [tab]=await chrome.tabs.query({url});return (await chrome.scripting.executeScript({target:{tabId:tab.id!},func:async credential=>chrome.runtime.sendMessage({type:'KEYPILOT_FILL_ACTIVE_TAB',credential:{...credential,autoSubmit:true}}),args:[credential]}))[0].result;},{url,credential});
 }
 await expect(page.locator('#password')).toHaveValue(credential.password);await page.waitForTimeout(3200);await expect(page.locator('#submitted')).toHaveText('0');
});
test('ordinary inline login submits once even when the login form remains visible',async()=>{
 await seed();const page=await open();expect((await fill()).submitted).toBe(true);await page.waitForTimeout(4500);await expect(page.locator('#submitted')).toHaveText('1');
});
for(const change of ['lock','disable','edit'])test(`waiting for a disabled button stops after ${change}`,async()=>{
 await seed();const page=await open();await page.getByRole('button',{name:'Sign in',exact:true}).evaluate((button:HTMLButtonElement)=>button.disabled=true);
 const filling=fill();await expect(page.locator('#password')).toHaveValue(credential.password);
 if(change==='lock')await worker.evaluate(()=>chrome.storage.session.remove(['keypilot.unlockedSession','keypilot.sessionState']));
 if(change==='disable')await changeSetting('autoSubmit',false);
 if(change==='edit')await page.locator('#password').fill('edited-password');
 await page.getByRole('button',{name:'Sign in',exact:true}).evaluate((button:HTMLButtonElement)=>button.disabled=false);
 expect((await filling).submitted).not.toBe(true);await page.waitForTimeout(1500);await expect(page.locator('#submitted')).toHaveText('0');
});
for(const navigation of [false,true])test(`opted-in TOTP fills once after ${navigation?'navigation':'dynamic login'} and never submits the OTP form`,async()=>{
 await seed(true,true);const page=await open();expect((await fill()).submitted).toBe(true);
 if(navigation)await page.goto(origin+'/otp');else await showOtp(page);
 await expectCurrentCode(page);await expect(page.locator('#verified')).toHaveText('0');
 if(navigation)expect(await worker.evaluate(async()=>(await chrome.storage.session.get('keypilot.unlockedSession'))['keypilot.unlockedSession'].vault.credentials[0].url)).toBe(url);
 await page.locator('#otp').fill('');await page.waitForTimeout(2200);await expect(page.locator('#otp')).toHaveValue('');
 const jobs=await worker.evaluate(()=>chrome.storage.session.get(null));const metadata=JSON.stringify(Object.entries(jobs).filter(([key])=>key.startsWith('keypilot.autoTotp.')));expect(metadata).not.toContain(account.secret);expect(metadata).not.toContain(credential.password);
});
for(const reason of ['opt-out','duplicate','sms','email','ambiguous','existing','wrong-origin','lock','disable'])test(`automatic TOTP pauses for ${reason}`,async()=>{
 await seed(true,reason!=='opt-out',reason==='duplicate');const page=await open();await fill();
 if(reason==='lock')await worker.evaluate(()=>chrome.storage.session.remove(['keypilot.unlockedSession','keypilot.sessionState']));
 if(reason==='disable')await changeSetting('autoTotpOrigins',[]);
 if(reason==='wrong-origin')await page.goto('https://other.example.test/otp');else await showOtp(page,
   reason==='sms'?otp.replace('Authenticator code','SMS code').replace('Code from your authenticator app','Code sent to your phone'):
   reason==='email'?otp.replace('Authenticator code','Email code').replace('Code from your authenticator app','Code sent to your email'):
   reason==='ambiguous'?otp.replace('</form>','<label>Authenticator code<input id="second-otp" maxlength="6"></label></form>'):
   reason==='existing'?otp.replace('id="otp"','id="otp" value="123456"'):otp);
 await page.waitForTimeout(2500);await expect(page.locator('#otp')).toHaveValue(reason==='existing'?'123456':'');
});
test('TOTP site option is visible and saved from the account details',async()=>{
 await seed(true);const page=await context.newPage();await page.setViewportSize({width:1280,height:900});await page.goto(base+'/vault.html');
 await page.getByText('Synthetic login',{exact:true}).first().click();
  await page.getByText('此网站设置',{exact:true}).click();
  const toggle=page.getByRole('switch',{name:'一键登录后自动填写动态验证码'});await expect(toggle).toBeVisible();await toggle.click();await expect(toggle).toBeChecked();
 await expect.poll(async()=>worker.evaluate(async()=>((await chrome.storage.session.get('keypilot.unlockedSession'))['keypilot.unlockedSession']).vault.settings.autoTotpOrigins)).toEqual([origin]);
 const dir=resolve(process.env.TEMP!,'keypilot-v1.10.0');await mkdir(dir,{recursive:true});await toggle.scrollIntoViewIfNeeded();await page.screenshot({path:resolve(dir,'totp-option.png')});
 await toggle.click();await expect(toggle).not.toBeChecked();await expect.poll(async()=>worker.evaluate(async()=>((await chrome.storage.session.get('keypilot.unlockedSession'))['keypilot.unlockedSession']).vault.settings.autoTotpOrigins)).toEqual([]);
});
test('near-expiry TOTP waits for the next time step',async()=>{
 await seed(true,true);const boundary=Math.ceil((Date.now()+30000)/30000)*30000;
 await worker.evaluate(now=>{Date.now=()=>now;},boundary-1000);
 const page=await open();await fill();await showOtp(page);await page.waitForTimeout(1500);await expect(page.locator('#otp')).toHaveValue('');
 await worker.evaluate(now=>{Date.now=()=>now;},boundary+1000);
 await expect(page.locator('#otp')).toHaveValue(await generateTotp(account,boundary+1000),{timeout:5000});
});
test('split authenticator inputs are filled as one group',async()=>{
 await seed(true,true);const page=await open();await fill();
 await showOtp(page,`<form><fieldset><legend>Authenticator code</legend>${Array.from({length:6},(_,index)=>`<input aria-label="Digit ${index+1}" maxlength="1" inputmode="numeric">`).join('')}</fieldset></form>`);
 await expect.poll(async()=>page.locator('fieldset input').evaluateAll(inputs=>inputs.map(input=>(input as HTMLInputElement).value).join('')),{timeout:15000}).toMatch(/^\d{6}$/);
});
test('TOTP job survives a worker restart but consumed jobs never replay',async()=>{
 await seed(true,true);const page=await open();await fill();
 const metadata=await worker.evaluate(async()=>Object.fromEntries(Object.entries(await chrome.storage.session.get(null)).filter(([key])=>key.startsWith('keypilot.autoTotp.'))));
 expect(Object.keys(metadata)).toHaveLength(1);expect(JSON.stringify(metadata)).not.toContain(account.secret);expect(JSON.stringify(metadata)).not.toContain(credential.password);
 const cdp=await context.newCDPSession(page);await cdp.send('ServiceWorker.enable');await cdp.send('ServiceWorker.stopAllWorkers');
 await showOtp(page);await expectCurrentCode(page);
 await page.reload();await showOtp(page);await page.waitForTimeout(1800);await expect(page.locator('#otp')).toHaveValue('');
});
test('same-origin iframe receives the code; multiple matching frames remain untouched',async()=>{
 await seed(true,true);const page=await open();await fill();
 await showOtp(page,'<iframe title="Authenticator frame" src="/otp"></iframe>');
 await expect(page.frameLocator('iframe').locator('#otp')).toHaveValue(/^\d{6}$/,{timeout:15000});
 await page.goto(url);await fill();await showOtp(page,'<iframe title="First" src="/otp"></iframe><iframe title="Second" src="/otp"></iframe>');
 await page.waitForTimeout(2500);
 await expect(page.frameLocator('iframe[title=First]').locator('#otp')).toHaveValue('');await expect(page.frameLocator('iframe[title=Second]').locator('#otp')).toHaveValue('');
});
test('locking invalidates an already probed OTP group inside an iframe',async()=>{
 await seed(true);const page=await open();await showOtp(page,'<iframe title="Authenticator frame" src="/otp"></iframe>');
 await expect(page.frameLocator('iframe').locator('#otp')).toBeVisible();
 await expect(page.frameLocator('iframe').locator('html')).toHaveAttribute('data-keypilot-content-script','0.1.0');
 const result=await worker.evaluate(async url=>{
  const [tab]=await chrome.tabs.query({url});const frames=await chrome.webNavigation.getAllFrames({tabId:tab.id!});const frame=frames!.find(frame=>frame.frameId!==0)!;
  const target={documentId:frame.documentId};
  const probe=await chrome.tabs.sendMessage(tab.id!,{type:'KEYPILOT_PROBE_TOTP',digits:6,expectedUrl:frame.url,automatic:true},target);
  if(probe.count!==1)throw new Error('Expected one synthetic OTP group');
  await chrome.tabs.sendMessage(tab.id!,{type:'KEYPILOT_SESSION_LOCKED'},target);
  return chrome.tabs.sendMessage(tab.id!,{type:'KEYPILOT_FILL_TOTP_CODE',code:'123456',expiresAt:Date.now()+30000,expectedUrl:frame.url,automatic:true,token:probe.token},target);
 },url);
 expect(result).toMatchObject({ok:false,error:'OTP_CHANGED'});await expect(page.frameLocator('iframe').locator('#otp')).toHaveValue('');
});

test('same-page authenticator code fills before exactly one login submit',async()=>{
 await seed(true,true);const page=await open();
 await page.locator('form').evaluate(form=>form.insertAdjacentHTML('beforeend','<label>Authenticator code<input id="otp" autocomplete="one-time-code" maxlength="6"></label>'));
 expect((await fill()).submitted).toBe(true);await expectCurrentCode(page);await expect(page.locator('#submitted')).toHaveText('1');
 await page.waitForTimeout(2000);await expect(page.locator('#submitted')).toHaveText('1');
});

for(const reason of ['disabled','sms','existing','ambiguous'])test(`same-page verification pauses for ${reason}`,async()=>{
 await seed(true,reason!=='disabled');const page=await open();
 await page.locator('form').evaluate((form,reason)=>form.insertAdjacentHTML('beforeend',`<label>${reason==='sms'?'SMS code sent to your phone':'Authenticator code'}<input id="otp" autocomplete="one-time-code" maxlength="6" value="${reason==='existing'?'123456':''}"></label>${reason==='ambiguous'?'<label>Authenticator code<input id="second-otp" maxlength="6"></label>':''}`),reason);
 expect((await fill()).submitted).not.toBe(true);await expect(page.locator('#submitted')).toHaveText('0');await expect(page.locator('#otp')).toHaveValue(reason==='existing'?'123456':'');
 await expect(page.locator('#keypilot-login-feedback')).toBeVisible();
});

test('multiple associated authenticators use only the selected default',async()=>{
 await seed(true,true,true);const page=await open();
 await changeSetting('siteLoginSettings',{[origin]:{totpAccountByCredential:{[credential.id]:'second'}}});
 await fill();
 const jobs=await worker.evaluate(async()=>Object.entries(await chrome.storage.session.get(null)).filter(([key])=>key.startsWith('keypilot.autoTotp.')).map(([,value])=>value));
 expect(jobs[0].accountId).toBe('second');await showOtp(page);await expectCurrentCode(page);
 await page.goto(url);await changeSetting('siteLoginSettings',{[origin]:{totpAccountByCredential:{[credential.id]:'missing'}}});
 await fill();await showOtp(page);await page.waitForTimeout(2000);await expect(page.locator('#otp')).toHaveValue('');
});

test('waiting and ambiguous TOTP states are visible, with a manual account entry',async()=>{
 await seed(true,true);const boundary=Math.ceil((Date.now()+30000)/30000)*30000;
 await worker.evaluate(now=>{Date.now=()=>now;},boundary-1000);
 const page=await open();await fill();await showOtp(page);
 await expect(page.locator('#keypilot-login-feedback')).toContainText('等待下一组');
 await page.locator('form').evaluate(form=>form.insertAdjacentHTML('beforeend','<label>Authenticator code<input id="second-otp" maxlength="6"></label>'));
 await expect(page.locator('#keypilot-login-feedback')).toContainText('多处动态验证码');
 const dir=resolve(process.env.TEMP!,'keypilot-v1.10.0');await mkdir(dir,{recursive:true});await page.screenshot({path:resolve(dir,'login-progress.png')});
 const opened=context.waitForEvent('page');await page.getByRole('button',{name:'打开账号与验证码'}).click();const detail=await opened;
 await expect(detail.getByRole('heading',{name:'动态验证码',exact:true})).toBeInViewport();
 await page.getByRole('button',{name:'关闭登录进度'}).click();await expect(page.locator('#keypilot-login-feedback')).toHaveCount(0);
});

test('site switches affect login and fill; reset and reload preserve valid defaults',async()=>{
 await seed(true,true,true);const target=await open();const page=await context.newPage();
 const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
 await page.goto(base+'/vault.html?loginFor='+credential.id);await page.getByText('此网站设置',{exact:true}).click();
 await page.getByLabel('本账号默认动态验证码',{exact:true}).selectOption('second');
 await expect.poll(async()=>worker.evaluate(async()=>((await chrome.storage.session.get('keypilot.unlockedSession'))['keypilot.unlockedSession']).vault.settings.siteLoginSettings)).toEqual({[origin]:{totpAccountByCredential:{[credential.id]:'second'}}});
 await page.getByRole('switch',{name:'一键登录时自动点击登录',exact:true}).click();await expect(page.locator('.kp-site-settings [role=status]')).toContainText('已保存');
 expect((await fill()).submitted).not.toBe(true);await expect(target.locator('#submitted')).toHaveText('0');
 await page.getByRole('switch',{name:'允许网页填写账号密码',exact:true}).click();await expect(page.locator('.kp-site-settings [role=status]')).toContainText('已保存');
 await target.locator('#password').fill('');expect((await fill()).ok).toBe(false);await expect(target.locator('#password')).toHaveValue('');
 await page.reload();await page.getByText('Synthetic login',{exact:true}).first().click();await page.getByText('此网站设置',{exact:true}).click();
 await expect(page.getByRole('switch',{name:'允许网页填写账号密码'})).not.toBeChecked();await expect(page.getByLabel('本账号默认动态验证码',{exact:true})).toHaveValue('second');
 await expect(page).toHaveTitle(/KeyPilot/);await expect(page.locator('.kp-site-settings')).toContainText('此网站设置');await expect(page.locator('vite-error-overlay')).toHaveCount(0);
 const dir=resolve(process.env.TEMP!,'keypilot-v1.10.0');await mkdir(dir,{recursive:true});
 for(const width of [1280,480]){await page.setViewportSize({width,height:900});await page.getByText('此网站设置',{exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:resolve(dir,`site-settings-${width}.png`)});}
 await page.getByText('说明与重置',{exact:true}).click();await page.getByRole('button',{name:'恢复此网站默认设置'}).click();await expect(page.getByRole('switch',{name:'允许网页填写账号密码'})).toBeChecked();
 await expect(page.getByRole('switch',{name:'一键登录后自动填写动态验证码'})).not.toBeChecked();expect(errors).toEqual([]);
 expect((await fill()).submitted).toBe(true);
});

test('page navigation into verification does not count as a successful login',async()=>{
 await seed();await changeSetting('siteRules',[{id:'outcome-rule',domain:new URL(origin).hostname,source:'manual-binding',createdAt:1,updatedAt:1,successCount:2,failureCount:1}]);const page=await open();await fill();await page.goto(origin+'/otp');
 await expect(page.locator('#keypilot-login-feedback')).toContainText('等待网站验证');
 const diagnostics=await worker.evaluate(async url=>{const [tab]=await chrome.tabs.query({url});return chrome.tabs.sendMessage(tab.id!,{type:'KEYPILOT_INLINE_DIAGNOSTICS'});},origin+'/otp');
 expect(diagnostics.submitOutcome.status).toBe('waitingVerification');
 await page.bringToFront();const control=await context.newPage();await control.goto(base+'/login-status.html');await page.bringToFront();
 await control.evaluate(()=>chrome.runtime.sendMessage({type:'KEYPILOT_GET_ACTIVE_TAB_DIAGNOSTICS'}));
 const rules=await worker.evaluate(async()=>((await chrome.storage.session.get('keypilot.unlockedSession'))['keypilot.unlockedSession']).vault.settings.siteRules);
 expect(rules.find((rule:any)=>rule.id==='outcome-rule')).toMatchObject({successCount:2,failureCount:1,lastOutcome:'waitingVerification'});
});

for(const change of ['lock','settings','typing'])test(`same-page TOTP waiting cancels on ${change}`,async()=>{
 await seed(true,true);const boundary=Math.ceil((Date.now()+30000)/30000)*30000;await worker.evaluate(now=>{Date.now=()=>now;},boundary-1000);
 const page=await open();await page.locator('form').evaluate(form=>form.insertAdjacentHTML('beforeend','<label>Authenticator code<input id="otp" autocomplete="one-time-code" maxlength="6"></label>'));
 const filling=fill();await expect(page.locator('#keypilot-login-feedback')).toContainText('等待下一组');
 if(change==='lock')await worker.evaluate(()=>chrome.storage.session.remove(['keypilot.unlockedSession','keypilot.sessionState']));
 if(change==='settings')await changeSetting('siteLoginSettings',{[origin]:{autoSubmit:false}});
 if(change==='typing')await page.locator('#password').fill('User-edited-fixture');
 await worker.evaluate(now=>{Date.now=()=>now;},boundary+1000);
 expect((await filling).submitted).not.toBe(true);await expect(page.locator('#otp')).toHaveValue('');await expect(page.locator('#submitted')).toHaveText('0');
});

test('same-page split TOTP fills all six fields before submitting once',async()=>{
 await seed(true,true);const page=await open();await page.locator('form').evaluate(form=>form.insertAdjacentHTML('beforeend','<fieldset><legend>Authenticator code</legend>'+Array.from({length:6},(_,i)=>`<input maxlength="1" aria-label="Digit ${i+1}">`).join('')+'</fieldset>'));
 expect((await fill()).submitted).toBe(true);await expect(page.locator('#submitted')).toHaveText('1');
 expect(await page.locator('fieldset input').evaluateAll(inputs=>inputs.map(input=>(input as HTMLInputElement).value).join(''))).toMatch(/^\d{6}$/);
});

test('site preference cannot override the global submit switch or affect another origin',async()=>{
 await seed(false);const page=await open();await changeSetting('siteLoginSettings',{[origin]:{autoSubmit:true}});
 expect((await fill()).submitted).not.toBe(true);await expect(page.locator('#submitted')).toHaveText('0');
 await changeSetting('autoSubmit',true);await changeSetting('siteLoginSettings',{'https://other.example.test':{fillEnabled:false,autoSubmit:false}});
 expect((await fill()).submitted).toBe(true);await expect(page.locator('#submitted')).toHaveText('1');
});

test('first-choice account ranks ahead of the previous order and persists after reload',async()=>{
 await seed(true,false,false,true);const page=await open();const control=await context.newPage();await control.goto(base+'/vault.html?loginFor='+credential.id);await control.getByText('此网站设置',{exact:true}).click();
 await control.getByLabel('网站首选账号',{exact:true}).selectOption(credential.id);
 await expect.poll(async()=>worker.evaluate(async()=>((await chrome.storage.session.get('keypilot.unlockedSession'))['keypilot.unlockedSession']).vault.settings.siteLoginSettings?.[new URL('https://continuation.example.test').origin]?.defaultCredentialId)).toBe(credential.id);
 await control.reload();await control.getByText('Synthetic login',{exact:true}).first().click();await control.getByText('此网站设置',{exact:true}).click();await expect(control.getByLabel('网站首选账号',{exact:true})).toHaveValue(credential.id);
 // Public list is read through the same content-script sender path used by the inline menu.
 const response=await worker.evaluate(async url=>{const [tab]=await chrome.tabs.query({url});return (await chrome.scripting.executeScript({target:{tabId:tab.id!},func:()=>chrome.runtime.sendMessage({type:'KEYPILOT_GET_INLINE_MATCHES'})}))[0].result;},url);
 expect(response.matches[0].id).toBe(credential.id);await expect(page.locator('#submitted')).toHaveText('0');
});

test('a stale active-tab fill request cannot fill after locking',async()=>{
 await seed();const page=await open();await worker.evaluate(()=>chrome.storage.session.remove(['keypilot.unlockedSession','keypilot.sessionState']));
 const result=await worker.evaluate(async({url,credential})=>{const [tab]=await chrome.tabs.query({url});return (await chrome.scripting.executeScript({target:{tabId:tab.id!},func:async credential=>chrome.runtime.sendMessage({type:'KEYPILOT_FILL_ACTIVE_TAB',credential:{...credential,autoSubmit:true}}),args:[credential]}))[0].result;},{url,credential});
 expect(result.ok).toBe(false);await expect(page.locator('#password')).toHaveValue('');await expect(page.locator('#submitted')).toHaveText('0');
});


test('real form navigation carries neutral progress once and later browsing does not replay it',async()=>{
 await seed();await context.route(origin+'/done',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Signed-in fixture</title><h1>Account dashboard</h1>'}));
 const page=await open();await page.locator('form').evaluate((form:HTMLFormElement)=>{form.onsubmit=null;form.action='/done';form.method='post';});
 const filling=fill();await expect(page).toHaveURL(origin+'/done');await filling;
 await expect(page.locator('#keypilot-login-feedback')).toContainText(/尚未确认|可能登录成功/);
 await page.goto(origin+'/elsewhere');await page.waitForTimeout(2200);await expect(page.locator('#keypilot-login-feedback')).toHaveCount(0);
});
