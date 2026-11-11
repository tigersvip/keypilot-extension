import { test, expect, chromium, type BrowserContext, type Worker, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { createEmptyVault } from '../../src/shared/defaults';
import { createEncryptedVault, exportVaultKey } from '../../src/shared/crypto';
import { generateSaveInboxKeyPair } from '../../src/shared/saveInbox';
import { buildCredential } from '../../src/shared/vault';
import { buildReminderIndex } from '../../src/shared/reminders';
import { LOGIN_JOBS_KEY, LOGIN_WAIT_MS, type LoginJob } from '../../src/shared/loginJob';

const url = 'https://login.example.test/login';
const form = `<!doctype html><meta charset="utf-8"><title>Synthetic login</title>
<form><label>账号<input id="username" name="username" autocomplete="username"></label>
<label>密码<input id="password" name="password" type="password" autocomplete="current-password"></label>
<button type="submit">登录</button></form><p id="result">0</p>
<script>document.querySelector('form').onsubmit=e=>{e.preventDefault();document.querySelector('#result').textContent=String(Number(document.querySelector('#result').textContent)+1)}</script>`;
let context: BrowserContext, worker: Worker, base: string, control: Page, credential: ReturnType<typeof buildCredential>, cache: any;
test.beforeEach(async () => {
  const extension = resolve('dist');
  context = await chromium.launchPersistentContext('', {channel:'chromium',headless:true,args:['--disable-extensions-except='+extension,'--load-extension='+extension,'--mute-audio']});
  worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  base = 'chrome-extension://'+new URL(worker.url()).host;
  // Synthetic normal documents; no certificate exceptions or warning-page clicks.
  await context.route(/https?:\/\/[^/]*example\.test(?::\d+)?\//, route => route.fulfill({contentType:'text/html',body:form}));
  const vault = createEmptyVault();
  vault.saveInboxKeyPair = await generateSaveInboxKeyPair();
  vault.settings.autoFill = false;vault.settings.autoSubmit=true;
  credential = buildCredential({title:'Synthetic login',url,username:'synthetic-user',password:'Synthetic-only!42'});
  vault.credentials = [credential];
  const {encryptedVault,key} = await createEncryptedVault('Test-master!42',vault);
  cache = {vault,encryptedVault,exportedKey:await exportVaultKey(key),cachedAt:Date.now(),sessionId:'login-job-test'};
  const index = buildReminderIndex(vault,encryptedVault.kdf.salt,null);
  await worker.evaluate(async ({cache,index}) => {
    await navigator.locks.request('keypilot-vault-write',async () => {
      await chrome.storage.local.set({'keypilot.encryptedVault':cache.encryptedVault,'keypilot.reminderIndex':index});
      await chrome.storage.session.set({'keypilot.unlockedSession':cache,'keypilot.sessionState':{id:cache.sessionId,expiresAt:0,highSecurity:false}});
    });
  }, {cache,index});
  control = await context.newPage();
  await control.goto(base+'/login-status.html');
});
test.afterEach(async () => {await context?.close();});
async function jobs(): Promise<Record<string,LoginJob>> {
  return worker.evaluate(async key => (await chrome.storage.session.get(key))[key] ?? {},LOGIN_JOBS_KEY);
}
async function seedWait(patch: Partial<LoginJob> = {}) {
  const page = await context.newPage();
  const tabId = await worker.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    return tabs.filter(tab => tab.url === 'about:blank').sort((a,b) => b.id!-a.id!)[0].id!;
  });
  const now=Date.now();
  const job: LoginJob = {id:'synthetic-wait',tabId,credentialId:credential.id,vaultId:cache.encryptedVault.kdf.salt,origin:new URL(url).origin,autoSubmit:true,phase:'certificate',createdAt:now,updatedAt:now,expiresAt:now+LOGIN_WAIT_MS,certificateError:'net::ERR_CERT_AUTHORITY_INVALID',notified:true,...patch};
  await worker.evaluate(async ({key,job}) => {await chrome.storage.session.set({[key]:{[job.id]:job}});},{key:LOGIN_JOBS_KEY,job});
  return {page,job};
}

test('normal open login fetches the saved credential and submits once; queue contains no secrets', async () => {
  const result = await control.evaluate(id => chrome.runtime.sendMessage({type:'KEYPILOT_OPEN_TAB',action:'login',credential:{id,autoSubmit:true,url:'https://wrong.example.test/',username:'wrong',password:'wrong'}}),credential.id);
  expect(result.ok).toBe(true);
  await expect.poll(async () => Object.values(await jobs())[0]?.phase).toBe('done');
  const page=context.pages().find(page=>page.url()===url)!;
  await expect(page.locator('#username')).toHaveValue(credential.username);
  await expect(page.locator('#password')).toHaveValue(credential.password);
  await expect(page.locator('#result')).toHaveText('1');
  // Observe past the legacy retry timers to catch repeated submissions.
  await page.waitForTimeout(3000);
  await expect(page.locator('#result')).toHaveText('1');
  const serialized=JSON.stringify(await jobs());
  expect(serialized).not.toContain(credential.password);
  expect(serialized).not.toContain(credential.username);
  await page.reload();
  await expect(page.locator('#password')).toHaveValue('');
  await expect(page.locator('#result')).toHaveText('0');
});

test('certificate wait resumes on a normal document, using the latest saved password', async () => {
  const {page}=await seedWait();
  await worker.evaluate(async () => {
    await navigator.locks.request('keypilot-vault-write',async () => {
      const key='keypilot.unlockedSession',state=(await chrome.storage.session.get(key))[key];
      state.vault.credentials[0].password='Updated-synthetic!73';
      await chrome.storage.session.set({[key]:state});
    });
  });
  await page.goto(url);
  await expect.poll(async () => (await jobs())['synthetic-wait']?.phase).toBe('done');
  await expect(page.locator('#password')).toHaveValue('Updated-synthetic!73');
  await expect(page.locator('#result')).toHaveText('1');
});

test('tab completion arriving during a stale loading check resumes once without waiting for an alarm',async()=>{
  const {page,job}=await seedWait();
  await worker.evaluate(tabId=>{
    const get=chrome.tabs.get.bind(chrome.tabs);let delayed=false;
    (chrome.tabs as any).get=async(id:number,callback?:(tab:chrome.tabs.Tab)=>void)=>{
      if(typeof callback==='function'){get(id,callback);return;}
      const tab=await get(id);
      if(id===tabId&&tab.url?.startsWith('https://login.example.test/')&&!delayed){
        delayed=true;await new Promise(resolve=>setTimeout(resolve,400));return {...tab,status:'loading'};
      }
      return tab;
    };
  },job.tabId);
  await page.goto(url);await expect.poll(async()=>(await jobs())[job.id]?.phase).toBe('done');
  await expect(page.locator('#password')).toHaveValue(credential.password);await expect(page.locator('#result')).toHaveText('1');
  await page.waitForTimeout(1000);await expect(page.locator('#result')).toHaveText('1');
});

test('locked vault pauses the continuation, then unlocking resumes it', async () => {
  const {page}=await seedWait();
  await worker.evaluate(async () => {await chrome.storage.session.remove(['keypilot.unlockedSession','keypilot.sessionState']);});
  await page.goto(url);
  await expect.poll(async () => (await jobs())['synthetic-wait']?.phase).toBe('locked');
  await expect(page.locator('#password')).toHaveValue('');
  await worker.evaluate(async cache => {await chrome.storage.session.set({'keypilot.unlockedSession':cache,'keypilot.sessionState':{id:cache.sessionId,expiresAt:0,highSecurity:false}});},cache);
  await expect.poll(async () => (await jobs())['synthetic-wait']?.phase).toBe('done');
  await expect(page.locator('#result')).toHaveText('1');
});

for (const changed of ['https://other.example.test/login','https://login.example.test:8443/login','http://login.example.test/login']) {
  test(`changed destination blocks resumed filling: ${changed}`,async () => {
    const {page}=await seedWait();
    await page.goto(changed);
    await expect.poll(async () => (await jobs())['synthetic-wait']?.phase).toBe('failed');
    await expect(page.locator('#password')).toHaveValue('');
    await expect(page.locator('#result')).toHaveText('0');
  });
}

test('cancelling from the status window prevents subsequent filling', async () => {
  const {page,job}=await seedWait();
  await control.goto(base+'/login-status.html?job='+job.id);
  await control.getByRole('button',{name:'取消本次登录'}).click();
  await expect(control.getByRole('heading')).toHaveText('本次登录已取消');
  await page.goto(url);
  await expect(page.locator('#password')).toHaveValue('');
  expect((await jobs())[job.id].phase).toBe('cancelled');
});

test('closing the target or expiring the wait prevents filling', async () => {
  const first=await seedWait();await first.page.close();
  await expect.poll(async () => (await jobs())[first.job.id]?.phase).toBe('cancelled');
  const second=await seedWait({expiresAt:Date.now()-1});
  await second.page.goto(url);
  await expect.poll(async () => (await jobs())[second.job.id]?.phase).toBe('expired');
  await expect(second.page.locator('#password')).toHaveValue('');
});

test('different vault identity stops the pending login', async () => {
  const {page}=await seedWait({vaultId:'different-vault'});
  await page.goto(url);
  await expect.poll(async () => (await jobs())['synthetic-wait']?.phase).toBe('failed');
  await expect(page.locator('#password')).toHaveValue('');
});

for (const phase of ['certificate','filling'] as const) test(`worker restart handles ${phase} jobs without repeating a dispatched submission`, async () => {
  const {page,job}=await seedWait({phase});
  const cdp=await context.newCDPSession(control);
  let versionId='';
  cdp.on('ServiceWorker.workerVersionUpdated',event=>{
    for(const version of event.versions)if(version.scriptURL===worker.url()&&version.runningStatus==='running')versionId=version.versionId;
  });
  await cdp.send('ServiceWorker.enable');
  await expect.poll(()=>versionId).not.toBe('');
  await cdp.send('ServiceWorker.stopWorker',{versionId});
  await control.evaluate(id=>chrome.runtime.sendMessage({type:'KEYPILOT_LOGIN_STATUS',id}),job.id);
  worker=context.serviceWorkers().find(item=>item.url()===base+'/background.js') ?? await context.waitForEvent('serviceworker',{timeout:5000});
  await page.goto(url);
  await expect.poll(async()=>(await jobs())[job.id]?.phase).toBe(phase==='certificate'?'done':'failed');
  await expect(page.locator('#result')).toHaveText(phase==='certificate'?'1':'0');
  await cdp.detach();
});

test('status window is readable at compact and desktop widths without storage write loops', async () => {
  const {job}=await seedWait();
  const errors:string[]=[];control.on('pageerror',error=>errors.push(error.message));
  await control.goto(base+'/login-status.html?job='+job.id);
  await expect(control.getByRole('heading')).toHaveText('网站证书异常，自动登录已暂停');
  await worker.evaluate(() => {
    (globalThis as any).jobWrites=0;
    chrome.storage.onChanged.addListener((changes,area)=>{if(area==='session'&&changes['keypilot.loginJobs'])(globalThis as any).jobWrites++;});
  });
  for (const width of [540,380]) {
    await control.setViewportSize({width,height:560});
    await expect(control.getByRole('button',{name:'取消本次登录'})).toBeVisible();
    expect(await control.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  }
  for (let i=0;i<3;i++) await control.evaluate(id=>chrome.runtime.sendMessage({type:'KEYPILOT_LOGIN_STATUS',id}),job.id);
  expect(await worker.evaluate(()=>(globalThis as any).jobWrites)).toBe(0);
  expect(errors).toEqual([]);
});
