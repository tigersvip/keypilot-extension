import { unlockEncryptedVault } from '../../src/shared/crypto';
import { readFile } from 'node:fs/promises';
import type { VaultPlain } from '../../src/shared/types';
import { test, expect, chromium, type BrowserContext, type Worker } from '@playwright/test';
import { resolve } from 'node:path';
import { createEmptyVault, defaultSettings } from '../../src/shared/defaults';
import { createEncryptedVault, exportVaultKey } from '../../src/shared/crypto';
import { generateSaveInboxKeyPair } from '../../src/shared/saveInbox';
import { buildCredential } from '../../src/shared/vault';
import QRCode from 'qrcode';
import { mkdir } from 'node:fs/promises';
import { googleEntry, migrationUri, publicSecret, publicUri } from '../fixtures/totpImport';

let context:BrowserContext, worker:Worker, base:string;
test.beforeEach(async()=>{
  const extension=resolve('dist');
  context=await chromium.launchPersistentContext('',{channel:'chromium',headless:true,args:['--disable-extensions-except='+extension,'--load-extension='+extension],permissions:['clipboard-read','clipboard-write']});
  worker=context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  base='chrome-extension://'+new URL(worker.url()).host;
  await seedCredentials();
});
async function seedCredentials(credentials = [buildCredential({title:'测试账号',url:'http://127.0.0.1:4173/test-lab/simple-login.html',username:'synthetic-user',password:'Synthetic-only!42'})], patch: Partial<VaultPlain> = {}) {
  const vault=createEmptyVault(); vault.saveInboxKeyPair=await generateSaveInboxKeyPair();
  vault.settings.requireMasterPasswordForReveal=true;
  vault.credentials=credentials;
  Object.assign(vault, patch);
  const {encryptedVault,key}=await createEncryptedVault('Test-master!42',vault);
  const cache={vault,encryptedVault,exportedKey:await exportVaultKey(key),cachedAt:Date.now(),sessionId:'browser-test-session'};
  await worker.evaluate(async({encryptedVault,cache})=>{
    // Use the same transaction lock as the app: startup/session readers must
    // not observe a half-written synthetic session and clear it as locked.
    await navigator.locks.request('keypilot-vault-write',async()=>{
      await chrome.storage.local.set({'keypilot.encryptedVault':encryptedVault});
      await chrome.storage.session.set({'keypilot.unlockedSession':cache,'keypilot.sessionState':{id:cache.sessionId,expiresAt:0,highSecurity:false}});
    });
  },{encryptedVault,cache});
}
test.afterEach(async()=>{await context?.close();});

const qrEvidence=resolve(process.env.TEMP ?? '..','keypilot-qr-import-v1.4.2');
async function qrFile(uri:string,name='synthetic-qr.png') {
 return {name,mimeType:'image/png',buffer:await QRCode.toBuffer(uri,{width:640,margin:4,errorCorrectionLevel:'M'})};
}
for(const version of [1,2,3]) test(`QR import previews Google version ${version} batches offline, detects duplicates and generates matching codes`,async()=>{
 await seedCredentials([],{settings:{...defaultSettings,requireMasterPasswordForReveal:false}});
 const page=await context.newPage();await page.setViewportSize({width:1440,height:1000});
 const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
 await page.clock.install({time:new Date(59000)});await page.clock.pauseAt(new Date(59000));
 await page.goto(base+'/vault.html#authenticator');
 await expect(page.getByRole('heading',{name:'身份验证器',exact:true})).toBeVisible();
 await context.setOffline(true);
 await page.getByRole('button',{name:'导入二维码',exact:true}).click();
 const input=page.getByLabel('二维码图片或链接文件');
 const first=migrationUri([googleEntry({name:'Google:synthetic@example.test',issuer:'Google'})],{id:777,index:0,size:2,version});
 const second=migrationUri([googleEntry({secret:'12345678901234567890123456789012',name:'GitHub:synthetic-dev',issuer:'GitHub',algorithm:2,digits:2})],{id:777,index:1,size:2,version});
 await input.setInputFiles(await qrFile(first));
 await expect(page.getByText(/已读取 1 \/ 2 张/)).toBeVisible();
 await expect(page.getByRole('button',{name:'导入所选（1）'})).toBeDisabled();
 expect(await worker.evaluate(async()=>((await chrome.storage.session.get('keypilot.unlockedSession'))['keypilot.unlockedSession']).vault.totpAccounts.length)).toBe(0);
 await input.setInputFiles(await qrFile(first));
 await expect(page.getByText(/重复账号/)).toBeVisible();
 await expect(page.getByText(/已读取 1 \/ 2 张/)).toBeVisible();
 await input.setInputFiles(await qrFile(second));
 await expect(page.getByText(/已读取 2 \/ 2 张/)).toBeVisible();
 await expect(page.getByRole('button',{name:'导入所选（2）'})).toBeEnabled();
 await expect(page.getByRole('region',{name:'导入验证器'})).not.toContainText(publicSecret);
 await mkdir(qrEvidence,{recursive:true});await page.screenshot({path:resolve(qrEvidence,`import-vault-version-${version}.png`),fullPage:true});
 await page.getByRole('button',{name:'导入所选（2）'}).click();
 await expect(page.getByText('已导入 2 个账号。',{exact:true})).toBeVisible();
 await expect(page.getByRole('article',{name:'Google synthetic@example.test'}).getByLabel('动态验证码')).toHaveText('287 082');
 await expect(page.getByRole('article',{name:'GitHub synthetic-dev'}).getByLabel('动态验证码')).toHaveText('4611 9246');
 const stored=await worker.evaluate(async()=>JSON.stringify((await chrome.storage.local.get('keypilot.encryptedVault'))['keypilot.encryptedVault']));
 expect(stored).not.toContain(publicSecret);expect(stored).not.toContain('synthetic@example.test');
 await page.getByRole('button',{name:'导入二维码',exact:true}).click();
 await input.setInputFiles([await qrFile(first),await qrFile(second)]);
 await expect(page.getByText(/已存在/)).toHaveCount(2);
 await expect(page.getByRole('button',{name:'导入所选（0）'})).toBeDisabled();
 expect(errors).toEqual([]);
});

test('popup QR paste, TXT links, selection and cancel work without revealing imported secrets',async()=>{
 await seedCredentials([]);const page=await context.newPage();await page.setViewportSize({width:400,height:600});
 await page.goto(base+'/popup.html');await page.locator('.kp-tools-menu summary').click();
 await page.getByRole('button',{name:'身份验证器',exact:true}).click();
 await page.getByRole('button',{name:'导入二维码',exact:true}).click();
 const image=(await qrFile(publicUri)).buffer.toString('base64');
 await expect(page.getByRole('region',{name:'导入验证器'})).toBeFocused();
 await page.evaluate(base64=>{
  const data=new DataTransfer();data.items.add(new File([Uint8Array.from(atob(base64),char=>char.charCodeAt(0))],'synthetic.png',{type:'image/png'}));
  document.activeElement!.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));
 },image);
 await expect(page.getByRole('checkbox',{name:'导入 Example synthetic@example.test'})).toBeChecked();
 const another=publicUri.replace('Example','Second').replace('Example','Second')+'&algorithm=SHA256';
 await page.getByLabel('二维码图片或链接文件').setInputFiles({name:'synthetic.txt',mimeType:'text/plain',buffer:Buffer.from(another)});
 await expect(page.getByRole('button',{name:'导入所选（2）'})).toBeEnabled();
 await page.getByRole('checkbox',{name:'导入 Second synthetic@example.test'}).uncheck();
 await expect(page.getByRole('button',{name:'导入所选（1）'})).toBeEnabled();
 await expect(page.getByRole('region',{name:'导入验证器'})).not.toContainText(publicSecret);
 await mkdir(qrEvidence,{recursive:true});await page.screenshot({path:resolve(qrEvidence,'import-popup.png'),fullPage:true});
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
 await page.getByRole('button',{name:'取消',exact:true}).click();
 expect(await worker.evaluate(async()=>((await chrome.storage.session.get('keypilot.unlockedSession'))['keypilot.unlockedSession']).vault.totpAccounts.length)).toBe(0);
 await page.getByRole('button',{name:'导入二维码',exact:true}).click();
 await page.getByLabel('二维码图片或链接文件').setInputFiles(await qrFile(publicUri));
 await page.getByRole('button',{name:'导入所选（1）'}).click();
 await expect(page.getByText('已导入 1 个账号。',{exact:true})).toBeVisible();
 await expect(page.getByLabel('动态验证码',{exact:true})).toHaveText('••• •••');
});

test('QR import rejects invalid content, acknowledges unsupported records and clears on lock',async()=>{
 await seedCredentials([]);const page=await context.newPage();await page.goto(base+'/vault.html#authenticator');
 await page.getByRole('button',{name:'导入二维码',exact:true}).click();
 await page.getByText('粘贴验证器链接 / 导入 TXT',{exact:true}).click();
 await page.getByLabel('验证器链接',{exact:true}).fill('123456');await page.getByRole('button',{name:'读取链接',exact:true}).click();
 await expect(page.getByRole('alert')).toContainText('临时验证码');
 await page.getByLabel('二维码图片或链接文件').setInputFiles({name:'invalid.png',mimeType:'image/png',buffer:Buffer.from('not an image')});
 await expect(page.getByRole('alert')).toContainText('图片无法打开');
 const mixed=migrationUri([googleEntry(),googleEntry({type:1})]);
 await page.getByLabel('二维码图片或链接文件').setInputFiles(await qrFile(mixed));
 await expect(page.getByText(/HOTP 计数器/)).toBeVisible();
 await expect(page.getByRole('button',{name:'导入所选（1）'})).toBeDisabled();
 await page.getByRole('checkbox',{name:'我已了解，仅导入支持的账号'}).check();
 await expect(page.getByRole('button',{name:'导入所选（1）'})).toBeEnabled();
 await worker.evaluate(()=>chrome.storage.session.remove('keypilot.sessionState'));
 await expect(page.getByRole('region',{name:'导入验证器'})).toHaveCount(0);
 expect(await worker.evaluate(async()=>((await chrome.storage.local.get('keypilot.encryptedVault'))['keypilot.encryptedVault']).encryptedData)).toBeTruthy();
});

test('QR camera reports permission denial, scans a synthetic stream and stops all tracks',async()=>{
 await seedCredentials([]);const page=await context.newPage();await page.goto(base+'/vault.html#authenticator');
 await page.getByRole('button',{name:'导入二维码',exact:true}).click();
 await page.evaluate(()=>{navigator.mediaDevices.getUserMedia=async()=>{throw new DOMException('denied','NotAllowedError');};});
 await page.getByRole('button',{name:'摄像头扫描',exact:true}).click();
 await expect(page.getByRole('alert')).toContainText('未获得摄像头权限');
 await page.getByRole('button',{name:'关闭摄像头',exact:true}).click();
 await page.evaluate(()=>{navigator.mediaDevices.getUserMedia=()=>new Promise(resolve=>{(window as any).resolveCamera=resolve;});});
 await page.getByRole('button',{name:'摄像头扫描',exact:true}).click();
 await expect.poll(()=>page.evaluate(()=>typeof (window as any).resolveCamera)).toBe('function');
 await page.getByRole('button',{name:'关闭摄像头',exact:true}).click();
 await page.evaluate(()=>{
  const canvas=document.createElement('canvas');canvas.width=640;canvas.height=480;
  const stream=canvas.captureStream(10);(window as any).lateTracks=stream.getTracks();(window as any).resolveCamera(stream);
 });
 await expect.poll(()=>page.evaluate(()=>(window as any).lateTracks.every((track:MediaStreamTrack)=>track.readyState==='ended'))).toBe(true);
 const encoded=(await qrFile(publicUri)).buffer.toString('base64');
 await page.evaluate(base64=>{
  navigator.mediaDevices.getUserMedia=async()=>{
   const image=new Image();image.src='data:image/png;base64,'+base64;await image.decode();
   const canvas=document.createElement('canvas');canvas.width=640;canvas.height=640;canvas.getContext('2d')!.drawImage(image,0,0);
   const stream=canvas.captureStream(10);(window as any).testTracks=stream.getTracks();(window as any).testCanvas=canvas;return stream;
  };
 },encoded);
 await page.getByRole('button',{name:'摄像头扫描',exact:true}).click();
 await expect(page.getByRole('checkbox',{name:'导入 Example synthetic@example.test'})).toBeVisible();
 await expect(page.getByLabel('二维码扫描画面')).toHaveCount(0);
 expect(await page.evaluate(()=>(window as any).testTracks.every((track:MediaStreamTrack)=>track.readyState==='ended'))).toBe(true);
 await page.evaluate(()=>{
  navigator.mediaDevices.getUserMedia=async()=>{
   const canvas=document.createElement('canvas');canvas.width=640;canvas.height=480;
   const stream=canvas.captureStream(10);(window as any).testTracks=stream.getTracks();(window as any).testCanvas=canvas;return stream;
  };
 });
 await page.getByRole('button',{name:'摄像头扫描',exact:true}).click();
 await expect(page.getByLabel('二维码扫描画面')).toBeVisible();
 await expect.poll(()=>page.evaluate(()=>(window as any).testTracks?.some((track:MediaStreamTrack)=>track.readyState==='live'))).toBe(true);
 await worker.evaluate(()=>chrome.storage.session.remove('keypilot.sessionState'));
 await expect(page.getByRole('region',{name:'导入验证器'})).toHaveCount(0);
 expect(await page.evaluate(()=>(window as any).testTracks.every((track:MediaStreamTrack)=>track.readyState==='ended'))).toBe(true);
});

test('generator copy action stays legible through hover, focus, press and disabled states', async () => {
  const page = await context.newPage();
  await page.setViewportSize({width:1440,height:1000});
  await page.goto(base+'/vault.html');
  await page.getByRole('button',{name:'密码生成器',exact:true}).click();
  const copy = page.locator('.generator-actions button.primary');
  async function textContrast() {
    return copy.evaluate(async button => {
      await Promise.all(button.getAnimations().map(animation=>animation.finished.catch(()=>undefined)));
      const style=getComputedStyle(button);
      const luminance=(color:string)=>{
        const channels=color.match(/[\d.]+/g)!.slice(0,3).map(Number).map(value=>{
          const normalized=value/255;
          return normalized<=0.04045 ? normalized/12.92 : ((normalized+0.055)/1.055)**2.4;
        });
        return channels[0]*0.2126+channels[1]*0.7152+channels[2]*0.0722;
      };
      const foreground=luminance(style.color),background=luminance(style.backgroundColor);
      return (Math.max(foreground,background)+0.05)/(Math.min(foreground,background)+0.05);
    });
  }
  await expect(copy).toBeEnabled();
  expect(await textContrast()).toBeGreaterThanOrEqual(4.5);
  await copy.hover();
  expect(await textContrast()).toBeGreaterThanOrEqual(4.5);
  await page.screenshot({path:'output/playwright/generator-hover.png'});
  await page.mouse.down();
  expect(await textContrast()).toBeGreaterThanOrEqual(4.5);
  await page.mouse.move(10,10); await page.mouse.up();
  await page.getByRole('button',{name:'重新生成密码',exact:true}).focus();
  await page.keyboard.press('Tab');
  await expect(copy).toBeFocused();
  expect(await textContrast()).toBeGreaterThanOrEqual(4.5);
  for(const label of ['大写字母','小写字母','数字','符号']) {
    await page.locator('.generator-switch').filter({has:page.getByText(label,{exact:true})}).click();
  }
  await expect(copy).toBeDisabled();
  await copy.hover();
  expect(await textContrast()).toBeGreaterThanOrEqual(4.5);
  await page.getByRole('button',{name:'标准强密码',exact:true}).click();
  await expect(copy).toBeEnabled();
  await page.mouse.move(10,10);
  await page.locator('.generator-workbench').evaluate(async panel=>{
    await Promise.all(panel.getAnimations({subtree:true}).map(animation=>animation.finished.catch(()=>undefined)));
  });
  await page.screenshot({path:'output/playwright/generator-typography.png'});
});

test('popup shows all records, disambiguates accounts and handles empty searches', async () => {
  await context.route('https://**', route => route.abort());
  const names = ['Cloudflare', 'GitHub', 'GitHub', 'Microsoft', '设计工作台', '开发服务器', '项目文档', '团队邮箱', '域名管理', '测试环境', '网站后台', '个人笔记', '一个很长的账号名称用于检查单行截断是否正确'];
  const records = Array.from({length:284}, (_, index) => buildCredential({
    title: names[index] ?? `示例账号 ${String(index + 1).padStart(3,'0')}`,
    url: 'https://example.test/login', username:`demo${index + 1}@example.test`, password:'Synthetic-only!42'
  }));
  records.forEach((record,index)=>{record.lastUsedAt=Date.now()-index*1000;});
  await seedCredentials(records);
  const page = await context.newPage(); await page.setViewportSize({width:400,height:600});
  await page.goto(base+'/popup.html');
  await expect(page.locator('.kp-account-row')).toHaveCount(284);
  await expect(page.locator('.kp-result-count')).toHaveText('284 条');
  await expect(page.locator('.kp-site-context')).toHaveCount(0);
  await expect(page.getByRole('button',{name:'登录 GitHub (demo2@example.test)',exact:true})).toBeVisible();
  await expect(page.locator('.kp-account-health')).toHaveCount(0);
  await page.screenshot({path:'output/playwright/popup-readable.png'});
  await page.locator('.kp-account-row').last().scrollIntoViewIfNeeded();
  await expect(page.getByText('示例账号 284',{exact:true})).toBeInViewport();
  const search=page.getByRole('textbox',{name:'搜索账号、网站或备注'});
  await search.fill('demo2@example.test');
  await expect(page.getByRole('button',{name:'登录 GitHub (demo2@example.test)',exact:true})).toBeVisible();
  await search.fill('示例账号 284');
  await expect(page.locator('.kp-account-row')).toHaveCount(1);
  await expect(page.locator('.kp-result-count')).toHaveText('1 / 284 条');
  await search.fill('不存在的记录');
  await expect(page.getByText('没有匹配的账号',{exact:true})).toBeVisible();
  await expect(page.getByText('还没有账号',{exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'显示全部账号',exact:true}).click();
  await expect(page.locator('.kp-account-row')).toHaveCount(284);
  await page.getByRole('tab',{name:'填写登录名',exact:true}).click();
  await page.getByRole('region',{name:'填写登录名',exact:true}).getByRole('tab',{name:'所有',exact:true}).click();
  await expect(page.getByRole('textbox')).toHaveCount(1);
  await page.getByRole('textbox',{name:'搜索登录名',exact:true}).fill('示例账号 284');
  await expect(page.locator('.kp-account-row')).toHaveCount(1);
  await page.getByRole('tab',{name:'身份资料',exact:true}).click();
  await expect(page.getByRole('textbox')).toHaveCount(1);
  await expect(page.getByText('没有匹配身份资料',{exact:true})).toBeVisible();
  await page.getByRole('region',{name:'填写身份ID',exact:true}).getByRole('button',{name:'清除搜索',exact:true}).click();
  await expect(page.getByText('还没有身份资料',{exact:true})).toBeVisible();
  await page.getByRole('tab',{name:'登录',exact:true}).click();
  await page.locator('.kp-tools-menu summary').click();
  await expect(page.getByRole('button',{name:'设置',exact:true})).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.kp-tools-menu')).not.toHaveAttribute('open','');
  await page.getByRole('button',{name:'查看 GitHub (demo2@example.test)',exact:true}).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('demo2@example.test',{exact:true}).first()).toBeVisible();
});

test('popup matches only web pages and lets users choose among current-site accounts', async () => {
  await context.route('https://**',route=>route.abort());
  await seedCredentials([
    buildCredential({title:'本地账号一',url:'http://127.0.0.1:4173/test-lab/simple-login.html',username:'one',password:'Synthetic!42'}),
    buildCredential({title:'本地账号二',url:'http://127.0.0.1:4173/test-lab/simple-login.html',username:'two',password:'Synthetic!42'}),
    buildCredential({title:'其他网站',url:'https://example.test',username:'other',password:'Synthetic!42'})
  ]);
  const target = await context.newPage(); await target.goto('chrome://newtab/');
  const page = await context.newPage(); await page.setViewportSize({width:400,height:600});
  await page.goto(base+'/popup.html');
  await worker.evaluate(async()=>{const tab=(await chrome.tabs.query({url:'chrome://newtab/'}))[0];await chrome.tabs.update(tab.id!,{active:true});});
  await page.reload();
  await expect(page.locator('.kp-account-row')).toHaveCount(3);
  await expect(page.locator('.kp-site-context')).toHaveCount(0);
  await target.goto('http://127.0.0.1:4173/test-lab/simple-login.html');
  await page.reload();
  await expect(page.getByRole('region',{name:'当前网站'})).toContainText('127.0.0.1');
  await page.getByRole('button',{name:'本站 2 条',exact:true}).click();
  await expect(page.locator('.kp-account-row')).toHaveCount(2);
  await expect(page.locator('.kp-result-count')).toHaveText('2 / 3 条');
  await expect(target.locator('input[type=password]')).toHaveValue('');
  await page.screenshot({path:'output/playwright/popup-matched.png'});
  await page.getByRole('button',{name:'显示全部账号',exact:true}).click();
  await expect(page.locator('.kp-account-row')).toHaveCount(3);
});

test('lock reaches the vault and settings pages',async()=>{
  const vault=await context.newPage();await vault.goto(base+'/vault.html');
  await expect(vault.getByText('测试账号',{exact:true}).first()).toBeVisible();
  const options=await context.newPage();await options.goto(base+'/options.html');
  await expect(options.locator('input[type=password]').first()).not.toBeVisible();
  await worker.evaluate(()=>chrome.storage.session.remove('keypilot.sessionState'));
  await expect(vault.locator('input[type=password]')).toBeVisible();
  await expect(options.locator('input[type=password]')).toBeVisible();
});

test('password reveal requires verification and automatically hides',async()=>{
  const page=await context.newPage();await page.clock.install();await page.goto(base+'/vault.html');
  await page.getByText('测试账号',{exact:true}).first().dblclick();
  const reveal=page.getByRole('button',{name:'显示密码',exact:true}).first();
  await expect(reveal).toBeVisible();await reveal.click();
  await expect(page.getByRole('dialog',{name:'验证主密码'})).toBeVisible();
  await page.getByLabel('主密码',{exact:true}).fill('wrong');
  await page.getByRole('button',{name:'验证',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('主密码错误');
  await page.getByLabel('主密码',{exact:true}).fill('Test-master!42');
  await page.getByRole('button',{name:'验证',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'验证主密码'})).not.toBeVisible();
  await expect(page.getByText('Synthetic-only!42',{exact:true})).toBeVisible();
  await page.clock.fastForward(30001);
  await expect(page.getByText('Synthetic-only!42',{exact:true})).not.toBeVisible();
});

test('preview does not fill before confirmation; undo preserves subsequent edits',async()=>{
  const page=await context.newPage();await page.goto('http://127.0.0.1:4173/test-lab/fill-preview.html');
  const id=await worker.evaluate(async()=> (await chrome.tabs.query({url:'http://127.0.0.1:4173/test-lab/fill-preview.html'}))[0].id!);
  await worker.evaluate(async({id})=>{
    await chrome.scripting.executeScript({target:{tabId:id},files:['content.js']});
    (globalThis as any).pendingFill=chrome.tabs.sendMessage(id,{type:'KEYPILOT_FILL_PROFILE',profile:{id:'test',title:'测试资料',countryCode:'US',category:'identity',onlyEmpty:true,fields:[
      {key:'firstName',label:'First name',value:'Synthetic',group:'personal',sensitivity:'normal',aliases:['given name']},
      {key:'lastName',label:'Last name',value:'Person',group:'personal',sensitivity:'normal',aliases:['family name']},
      {key:'email',label:'Email',value:'synthetic@example.test',group:'contact',sensitivity:'normal',aliases:['email']}
    ]}});
  },{id});
  await expect(page.locator('#keypilot-fill-review')).toBeVisible();
  await expect(page.locator('[name=firstName]')).toHaveValue('');
  await page.screenshot({path:'output/playwright/fill-preview.png'});
  await page.keyboard.press('Enter');
  await expect(page.locator('[name=firstName]')).toHaveValue('Synthetic');
  await page.keyboard.press('Shift+Tab');await page.keyboard.press('Shift+Tab');
  // Keep the undo button focused while simulating a later site/user edit.
  await page.evaluate(()=>{const input=document.querySelector<HTMLInputElement>('[name=firstName]')!;input.value='User edit';input.dispatchEvent(new Event('input',{bubbles:true}));});
  await page.keyboard.press('Enter');
  await expect(page.locator('[name=firstName]')).toHaveValue('User edit');
  await expect(page.locator('[name=lastName]')).toHaveValue('');
});

test('offscreen clipboard clears after the originating page closes and preserves newer text',async()=>{
 const page=await context.newPage();await page.goto(base+'/vault.html');
 const copy=(value:string)=>page.evaluate(value=>chrome.runtime.sendMessage({type:'KEYPILOT_COPY_TEXT',value,seconds:1}),value);
 await copy('synthetic-secret');await page.close();
 const helper=await context.newPage();await helper.goto(base+'/options.html');
 await expect.poll(()=>helper.evaluate(()=>navigator.clipboard.readText())).toBe('');
 await helper.evaluate(()=>chrome.runtime.sendMessage({type:'KEYPILOT_COPY_TEXT',value:'first-secret',seconds:1}));
 await helper.evaluate(()=>navigator.clipboard.writeText('new-user-text'));
 await new Promise(resolve=>setTimeout(resolve,1400));
 expect(await helper.evaluate(()=>navigator.clipboard.readText())).toBe('new-user-text');
});

test('high security keeps the current session usable without session-storage secrets',async()=>{
 const page=await context.newPage();await page.goto(base+'/options.html');
 // Toggle via the real settings UI.
 await page.getByRole('button',{name:'登录与安全',exact:true}).click();
 const toggle=page.locator('.setting-row').filter({has:page.getByText('高安全模式',{exact:true})}).getByRole('switch');
 await toggle.click();
 await expect.poll(()=>worker.evaluate(async()=>Boolean((await chrome.storage.session.get('keypilot.unlockedSession'))['keypilot.unlockedSession']))).toBe(false);
 const vault=await context.newPage();await vault.goto(base+'/vault.html');
 await expect(vault.getByText('测试账号',{exact:true}).first()).toBeVisible();
});

test('backup UI previews without overwriting and restores with a recovery point',async()=>{
 const page=await context.newPage();await page.goto(base+'/options.html');
 await page.getByRole('button',{name:'账户&数据',exact:true}).click();
 const original=await worker.evaluate(async()=>(await chrome.storage.local.get('keypilot.encryptedVault'))['keypilot.encryptedVault']);
 await page.locator('.kp-backup-panel input[type=file]').setInputFiles({name:'synthetic-backup.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(original))});
 await page.getByLabel('备份主密码',{exact:true}).fill('Test-master!42');
 await page.getByRole('button',{name:'预览备份',exact:true}).click();
 await expect(page.locator('.kp-backup-preview')).toContainText('账号 1');
 expect(await worker.evaluate(async()=>(await chrome.storage.local.get('keypilot.encryptedVault'))['keypilot.encryptedVault'].encryptedData)).toBe(original.encryptedData);
 await page.screenshot({path:'output/playwright/backup-preview.png',fullPage:true});
 await page.getByRole('button',{name:'确认合并',exact:true}).click();
 await expect(page.getByRole('status')).toContainText('合并完成');
 expect(await worker.evaluate(async()=>(await chrome.storage.local.get('keypilot.recoverySnapshots'))['keypilot.recoverySnapshots'].length)).toBe(1);
});

test('registered shortcuts are shown with their actual bindings',async()=>{
 const page=await context.newPage();await page.goto(base+'/options.html');
 await page.getByRole('button',{name:'一般',exact:true}).click();
 await page.getByRole('button',{name:'快捷键',exact:true}).click();
 const commands=await worker.evaluate(()=>chrome.commands.getAll());
 expect(commands.map(item=>item.name)).toEqual(expect.arrayContaining(['_execute_action','fill-current','lock-vault','search-vault']));
 await expect(page.getByText('锁定密码库',{exact:true})).toBeVisible();
});

for (const scenario of ['simple-login','unsafe-login']) {
 test(scenario+' fills password without touching verification fields',async()=>{
  const page=await context.newPage();const url='http://127.0.0.1:4173/test-lab/'+scenario+'.html';await page.goto(url);
  const result=await worker.evaluate(async({url,unsafe})=>{
    const tab=(await chrome.tabs.query({url}))[0];
    await chrome.scripting.executeScript({target:{tabId:tab.id!},files:['content.js']});
    return chrome.tabs.sendMessage(tab.id!,{type:'KEYPILOT_FILL_CREDENTIAL',credential:{id:'synthetic',url,domain:'127.0.0.1',username:'synthetic@example.test',password:'Synthetic-only!42',autoSubmit:unsafe}});
  },{url,unsafe:scenario==='unsafe-login'});
  expect(result.ok).toBe(true);
  await expect(page.locator('input[type=password]')).toHaveValue('Synthetic-only!42');
  if(scenario==='unsafe-login'){
    await expect(page.locator('#unsafe-otp')).toHaveValue('');
    await expect(page.locator('#unsafe-captcha')).toHaveValue('');
    expect(result.submitted).not.toBe(true);
  }
 });
}

test('global lock cancels an outstanding fill preview without writing fields',async()=>{
 const page=await context.newPage();await page.goto('http://127.0.0.1:4173/test-lab/fill-preview.html');
 await worker.evaluate(async()=>{
  const tab=(await chrome.tabs.query({url:'http://127.0.0.1:4173/test-lab/fill-preview.html'}))[0];
  await chrome.scripting.executeScript({target:{tabId:tab.id!},files:['content.js']});
  (globalThis as any).preview=chrome.tabs.sendMessage(tab.id!,{type:'KEYPILOT_FILL_PROFILE',profile:{id:'test',title:'test',countryCode:'US',category:'identity',fields:[{key:'email',label:'Email',value:'synthetic@example.test',group:'contact',sensitivity:'normal',aliases:['email']}]}}).catch(()=>null);
 });
 await expect(page.locator('#keypilot-fill-review')).toBeVisible();
 await worker.evaluate(()=>chrome.storage.session.remove('keypilot.sessionState'));
 await expect(page.locator('#keypilot-fill-review')).not.toBeVisible();
 await expect(page.locator('[name=email]')).toHaveValue('');
});


test('copy cancellation never reports success', async () => {
 const page=await context.newPage();await page.goto(base+'/vault.html#section=generator');
 await page.getByRole('button',{name:'密码生成器',exact:true}).click();
 await page.getByRole('button',{name:'复制',exact:true}).click();
 await expect(page.getByRole('dialog')).toBeVisible();
 await expect(page.getByRole('button',{name:'已复制',exact:true})).toHaveCount(0);
 await page.getByRole('button',{name:'取消',exact:true}).click();
 await expect(page.getByRole('button',{name:'复制',exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'已复制',exact:true})).toHaveCount(0);
});

test('ordinary profile fields show and copy directly while payment fields remain protected',async()=>{
 await seedCredentials(undefined,{fillProfiles:[{id:'sensitive',title:'测试身份',category:'identity',countryCode:'CN',createdAt:1,updatedAt:1,fields:[
  {key:'dob',label:'出生日期',value:'1990-01-02',group:'personal',sensitivity:'private'},
  {key:'idNumber',label:'证件号码',value:'SYNTHETIC-ID-99',group:'sensitive',sensitivity:'secret'},
  {key:'cardNumber',label:'卡号',value:'4111111111111111',group:'payment',sensitivity:'secret'}
 ]}]});
 const page=await context.newPage();await page.goto(base+'/popup.html');
 await page.getByRole('tab',{name:'身份资料',exact:true}).click();
 await page.getByText('测试身份',{exact:true}).click();
 await expect(page.getByText('1990-01-02',{exact:true})).toBeVisible();
 await expect(page.getByText('SYNTHETIC-ID-99',{exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'查看 出生日期',exact:true})).toHaveCount(0);
 await page.getByRole('button',{name:'复制 出生日期',exact:true}).click();
 await expect(page.getByText('已复制出生日期。',{exact:true})).toBeVisible();
 await expect(page.getByRole('dialog')).toHaveCount(0);
 await expect(page.getByText('4111111111111111',{exact:true})).toHaveCount(0);
 await expect(page.locator('[title="4111111111111111"]')).toHaveCount(0);
 await page.getByRole('button',{name:'查看 卡号',exact:true}).click();
 await page.getByRole('dialog').getByLabel('主密码',{exact:true}).fill('Test-master!42');
 await page.getByRole('button',{name:'验证',exact:true}).click();
 await expect(page.getByText('4111111111111111',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'隐藏 卡号',exact:true}).click();
 await expect(page.getByText('4111111111111111',{exact:true})).toHaveCount(0);
 await page.getByRole('button',{name:'复制 卡号',exact:true}).click();
 await expect(page.getByRole('dialog')).toBeVisible();
 await page.getByRole('button',{name:'取消',exact:true}).click();
 const vault=await context.newPage();await vault.goto(base+'/vault.html');
 await vault.getByRole('button',{name:/^个人信息\s*1$/}).click();
 await vault.getByText('测试身份',{exact:true}).click();
 await expect(vault.getByText('1990-01-02',{exact:true})).toBeVisible();
 await vault.getByRole('button',{name:'复制 出生日期',exact:true}).click();
 await expect(vault.getByText('已复制出生日期。',{exact:true})).toBeVisible();
 await expect(vault.getByRole('dialog')).toHaveCount(0);
 await vault.getByRole('navigation',{name:'资料分组'}).getByRole('button',{name:/付款/}).click();
 await expect(vault.getByText('4111111111111111',{exact:true})).toHaveCount(0);
 await vault.getByRole('button',{name:'复制 卡号',exact:true}).click();
 await expect(vault.getByRole('dialog')).toBeVisible();
});

test('settings affect popup dock and context menus; unsupported controls are absent',async()=>{
 const page=await context.newPage();await page.goto(base+'/options.html');
 await page.getByRole('button',{name:'一般',exact:true}).click();
 await expect(page.getByText('English (United States)',{exact:true})).toHaveCount(0);
 await expect(page.getByRole('switch',{name:'同时显示书签和登录信息'})).toHaveCount(0);
 await page.getByRole('switch',{name:'弹窗底部显示紧凑工具栏'}).click();
 await expect(page.getByRole('switch',{name:'弹窗底部显示紧凑工具栏'})).toHaveAttribute('aria-checked','false');
 const popup=await context.newPage();await popup.goto(base+'/popup.html');
 await expect(popup.locator('.kp-dock')).toHaveCount(0);
 await popup.locator('.kp-tools-menu summary').click();
 await expect(popup.getByRole('button',{name:'新建账号',exact:true})).toBeVisible();
 await expect.poll(()=>worker.evaluate(()=>chrome.contextMenus.update('fill-current',{title:'KeyPilot：填写当前网站'}).then(()=>true,()=>false))).toBe(true);
 await page.getByRole('switch',{name:'在浏览器右键菜单中显示 KeyPilot 指令'}).click();
 await expect.poll(()=>worker.evaluate(()=>chrome.contextMenus.update('fill-current',{title:'KeyPilot：填写当前网站'}).then(()=>true,()=>false))).toBe(false);
});

test('backup export records status and reminder can be disabled',async()=>{
 const page=await context.newPage();await page.goto(base+'/options.html');
 await page.getByRole('button',{name:'账户&数据',exact:true}).click();
 const panel=page.getByRole('region',{name:'备份状态'});
 await expect(panel.getByText('还没有导出过加密备份。')).toBeVisible();
 const download=page.waitForEvent('download');
 await panel.getByRole('button',{name:'导出完整加密备份'}).click();
 expect((await download).suggestedFilename()).toMatch(/^keypilot-vault-backup-/);
 await expect(panel).toContainText('上次发起备份导出');
 await expect(panel).toContainText('此后新增 0 条');
 await panel.getByRole('checkbox',{name:'备份提醒'}).uncheck();
 await expect.poll(()=>worker.evaluate(async()=>((await chrome.storage.session.get('keypilot.unlockedSession'))['keypilot.unlockedSession']).vault.settings.backupReminderEnabled)).toBe(false);
});

async function fillLab(url:string, autoSubmit=false, allFrames=false) {
 return worker.evaluate(async({url,autoSubmit,allFrames})=>{
  const tab=(await chrome.tabs.query({url}))[0];
  await chrome.scripting.executeScript({target:{tabId:tab.id!,allFrames},files:['content.js']});
  const cache=(await chrome.storage.session.get('keypilot.unlockedSession'))['keypilot.unlockedSession'];
  const saved=autoSubmit?cache.vault.credentials.find((item:any)=>item.url===url):undefined;
  return chrome.tabs.sendMessage(tab.id!,{type:'KEYPILOT_FILL_CREDENTIAL',credential:saved?{...saved,autoSubmit}:{id:'synthetic',url,domain:'127.0.0.1',username:'synthetic@example.test',password:'Synthetic-only!42',autoSubmit}}, {frameId:0});
 },{url,autoSubmit,allFrames});
}

test('stepped login continues after the delayed password field appears',async()=>{
 const url='http://127.0.0.1:4173/test-lab/stepped-login.html';
 await seedCredentials([buildCredential({title:'Stepped synthetic',url,username:'synthetic@example.test',password:'Synthetic-only!42'})],{settings:{...defaultSettings,autoSubmit:true}});
 const page=await context.newPage();await page.goto(url);
 const result=await fillLab(url,true);
 expect(result.ok).toBe(true);
 await expect(page.locator('#step-username')).toHaveValue('synthetic@example.test');
 await expect(page.locator('#step-password')).toHaveValue('Synthetic-only!42');
 await expect(page.locator('#result')).toContainText('分步登录已提交');
});

test('dynamically inserted login fields can be filled',async()=>{
 const page=await context.newPage();const url='http://127.0.0.1:4173/test-lab/dynamic-login.html';await page.goto(url);
 await page.getByRole('button',{name:'加载登录表单'}).click();
 await expect(page.locator('input[type=password]')).toBeVisible();
 expect((await fillLab(url)).ok).toBe(true);
 await expect(page.locator('input[type=password]')).toHaveValue('Synthetic-only!42');
});

for(const update of [false,true]) test(update?'insecure HTTP login updates the existing password':'insecure HTTP login saves with a cryptographic UUID',async()=>{
 const url='http://keypilot-insecure.test/login';
 await seedCredentials([buildCredential({title:'HTTP fixture',url,username:'synthetic-user',password:'Synthetic-only!42'})]);
 await context.route('http://keypilot-insecure.test/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><meta charset="utf-8"><title>HTTP login fixture</title><form><label>账号<input id="login" autocomplete="username"></label><label>密码<input id="password" type="password" autocomplete="current-password"></label><button type="submit">模拟登录</button></form><p id="result"></p>'}));
 const page=await context.newPage();const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto(url);
 const environment=await worker.evaluate(async url=>{
  const tab=(await chrome.tabs.query({url}))[0];
  await chrome.scripting.executeScript({target:{tabId:tab.id!},files:['content.js']});
  const [result]=await chrome.scripting.executeScript({target:{tabId:tab.id!},func:()=>({secure:isSecureContext,uuid:typeof crypto.randomUUID})});
  return result.result;
 },url);
 expect(environment).toEqual({secure:false,uuid:'undefined'});
 await page.evaluate(()=>document.querySelector('form')!.addEventListener('submit',event=>{
  event.preventDefault();document.querySelector('form')!.style.display='none';document.querySelector('#result')!.textContent='登录成功';
 }));
 const username=update?'synthetic-user':'new-synthetic-user';
 await page.locator('#login').fill(username);await page.locator('#password').fill('Changed-synthetic!55');
 await page.getByRole('button',{name:'模拟登录',exact:true}).click();
 const prompt=page.locator('#keypilot-save-prompt-root');await expect(prompt).toBeVisible();
 await expect(prompt.locator('svg.default-site-icon')).toBeVisible();
 await prompt.getByRole('button',{name:update?'更新密码':'保存',exact:true}).click();
 await expect.poll(()=>worker.evaluate(async username=>((await chrome.storage.session.get('keypilot.unlockedSession'))['keypilot.unlockedSession']).vault.credentials.find((item:any)=>item.username===username)?.password,username)).toBe('Changed-synthetic!55');
 expect(await worker.evaluate(async()=>((await chrome.storage.session.get('keypilot.unlockedSession'))['keypilot.unlockedSession']).vault.credentials.length)).toBe(update?1:2);
 expect(errors).toEqual([]);
});

test('inline icons and password generation work when the page blocks external images',async()=>{
 const url='https://keypilot-icons.test/register';const requests:string[]=[];const errors:string[]=[];
 await context.route('https://keypilot-icons.test/**',route=>route.fulfill({contentType:'text/html',headers:{'Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; img-src 'none'"},body:'<!doctype html><meta charset="utf-8"><title>注册账号</title><style>body{font:16px sans-serif;padding:60px}label{display:block;margin:24px 0}input{padding:12px;margin-left:12px}</style><h1>注册账号</h1><form><label>账号<input autocomplete="username"></label><label>设置密码<input id="password" type="password" autocomplete="new-password"></label><button>注册</button></form>'}));
 const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
 page.on('request',request=>{if(request.url().startsWith(base+'/icons/'))requests.push(request.url());});
 page.on('console',message=>{if(message.type()==='error'&&/chrome-extension:|Unsafe attempt/i.test(message.text()))errors.push(message.text());});
 await page.goto(url);
 await worker.evaluate(async url=>{const tab=(await chrome.tabs.query({url}))[0];await chrome.scripting.executeScript({target:{tabId:tab.id!},files:['content.js']});},url);
 await page.locator('#password').focus();
 const trigger=page.getByRole('button',{name:'打开 KeyPilot 密码生成器',exact:true});
 await expect(trigger).toBeVisible();await expect(trigger.locator('svg')).toBeVisible();await trigger.click();
 const generator=page.getByRole('dialog',{name:'KeyPilot 密码生成器',exact:true});
 await expect(generator).toBeVisible();await expect(generator.locator('.pg-brand svg')).toBeVisible();
 const password=await generator.locator('.pg-output code').textContent();expect(password).toHaveLength(16);
 await generator.getByRole('button',{name:'重新生成密码',exact:true}).click();
 await expect(generator.locator('.pg-output code')).not.toHaveText(password!);
 const evidence=resolve(process.env.TEMP ?? '..','keypilot-http-fix-v1.4.1');await mkdir(evidence,{recursive:true});
 await page.screenshot({path:resolve(evidence,'inline-generator.png'),fullPage:true});
 await generator.locator('[data-pg-action="fill"]').click();await expect(page.locator('#password')).toHaveValue(/.{16}/);
 expect(requests).toEqual([]);expect(errors).toEqual([]);
});

for(const update of [false,true]) test(update?'successful login updates the existing password without duplication':'successful login saves only after explicit confirmation',async()=>{
 const username=update?'synthetic-user':'new-synthetic-user';
 const page=await context.newPage();const url='http://127.0.0.1:4173/test-lab/save-capture.html';await page.goto(url);
 await worker.evaluate(async url=>{const tab=(await chrome.tabs.query({url}))[0];await chrome.scripting.executeScript({target:{tabId:tab.id!},files:['content.js']});},url);
 await page.locator('#save-login').fill(username);await page.locator('#save-password').fill('Changed-synthetic!55');
 await page.getByRole('button',{name:'模拟登录',exact:true}).click();
 const prompt=page.locator('#keypilot-save-prompt-root');await expect(prompt).toBeVisible();
 const before=await worker.evaluate(async()=>((await chrome.storage.session.get('keypilot.unlockedSession'))['keypilot.unlockedSession']).vault.credentials);
 expect(before.length).toBe(1);expect(before[0].password).toBe('Synthetic-only!42');
 await prompt.getByRole('button',{name:update?'更新密码':'保存',exact:true}).click();
 await expect.poll(()=>worker.evaluate(async username=>((await chrome.storage.session.get('keypilot.unlockedSession'))['keypilot.unlockedSession']).vault.credentials.find((item:any)=>item.username===username)?.password,username)).toBe('Changed-synthetic!55');
 expect(await worker.evaluate(async()=>((await chrome.storage.session.get('keypilot.unlockedSession'))['keypilot.unlockedSession']).vault.credentials.length)).toBe(update?1:2);
});


test('background fills the matching iframe and leaves the unrelated origin untouched',async()=>{
 const page=await context.newPage();const url='http://127.0.0.1:4173/test-lab/iframe-login.html';await page.goto(url);
 await expect(page.frameLocator('iframe[title="同源登录"]').locator('input[type=password]')).toBeVisible();
 await expect(page.frameLocator('iframe[title="其他网站"]').locator('input[type=password]')).toBeVisible();
 const result=await worker.evaluate(async url=>{
  const tab=(await chrome.tabs.query({url}))[0];
  await chrome.scripting.executeScript({target:{tabId:tab.id!,allFrames:true},files:['content.js']});
  const cache=(await chrome.storage.session.get('keypilot.unlockedSession'))['keypilot.unlockedSession'];
  const credential={...cache.vault.credentials[0],autoSubmit:false};
  const response=await chrome.scripting.executeScript({target:{tabId:tab.id!},func:credential=>chrome.runtime.sendMessage({type:'KEYPILOT_FILL_ACTIVE_TAB',credential}),args:[credential]});
  return response[0].result;
 },url);
 expect(result.ok).toBe(true);
 await expect(page.frameLocator('iframe[title="同源登录"]').locator('input[type=password]')).toHaveValue('Synthetic-only!42');
 await expect(page.frameLocator('iframe[title="其他网站"]').locator('input[type=password]')).toHaveValue('');
});


const testTotp={id:'totp-fixture',issuer:'Example',account:'synthetic@example.test',secret:'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',algorithm:'SHA1' as const,digits:6 as const,period:30,createdAt:1,updatedAt:1};

test('TOTP creation, validation, editing, removal and restore work in the vault',async()=>{
 const page=await context.newPage();await page.goto(base+'/vault.html#authenticator');
 await expect(page.getByRole('heading',{name:'身份验证器',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'添加验证码'}).click();
 await page.getByLabel('密钥或 otpauth 链接',{exact:true}).fill('invalid-secret');
 await page.getByRole('button',{name:'保存身份验证器'}).click();
 await expect(page.getByRole('alert')).toContainText('Base32');
 await page.getByLabel('密钥或 otpauth 链接',{exact:true}).fill(`otpauth://totp/Example:synthetic@example.test?secret=${testTotp.secret}&issuer=Example`);
 await page.getByRole('button',{name:'读取密钥或链接'}).click();
 await expect(page.getByLabel('服务名称',{exact:true})).toHaveValue('Example');
 await page.getByRole('button',{name:'保存身份验证器'}).click();
 const row=page.locator('.kp-totp-row');await expect(row).toHaveCount(1);
 await expect(row.locator('output')).toHaveText('••• •••');
 await expect(page.getByText(testTotp.secret,{exact:true})).toHaveCount(0);
 await row.getByRole('button',{name:'查看验证码'}).click();
 await page.getByRole('dialog').getByLabel('主密码',{exact:true}).fill('Test-master!42');await page.getByRole('button',{name:'验证',exact:true}).click();
 await expect(row.locator('output')).toHaveText(/\d{3} \d{3}/);
 await expect(page.locator('.kp-backup-status')).toBeVisible();
 expect((await page.locator('.kp-backup-status').boundingBox())!.height).toBeLessThan(120);
 expect((await page.locator('.vault-topbar').boundingBox())!.y).toBeGreaterThanOrEqual(0);
 await page.screenshot({path:'output/playwright/totp-vault.png',fullPage:true});
 await row.getByLabel('更多验证码操作').click();await row.getByRole('button',{name:'编辑身份验证器'}).click();
 await page.getByRole('dialog').getByLabel('主密码',{exact:true}).fill('Test-master!42');await page.getByRole('button',{name:'验证',exact:true}).click();
 await expect(page.getByLabel('密钥或 otpauth 链接',{exact:true})).toHaveValue('');
 await page.getByLabel('服务名称',{exact:true}).fill('Example Edited');await page.getByRole('button',{name:'保存身份验证器'}).click();
 await expect(row).toContainText('Example Edited');
 await row.getByLabel('更多验证码操作').click();await row.getByRole('button',{name:'移除身份验证器'}).click();await page.getByRole('button',{name:'确认移除'}).click();
 await expect(row).toHaveCount(0);await page.getByText('已移除（1）',{exact:true}).click();await page.getByRole('button',{name:'恢复',exact:true}).click();
 await expect(row).toHaveCount(1);
 const persisted=await worker.evaluate(()=>chrome.storage.local.get('keypilot.encryptedVault'));
 expect(JSON.stringify(persisted)).not.toContain(testTotp.secret);
 const plain=await unlockEncryptedVault('Test-master!42',persisted['keypilot.encryptedVault']);
 expect(plain.vault.totpAccounts?.[0].secret).toBe(testTotp.secret);
});

test('TOTP refreshes on a boundary and copy generates the current code after verification',async()=>{
 await seedCredentials(undefined,{totpAccounts:[testTotp]});
 const page=await context.newPage();await page.clock.install({time:new Date(59000)});await page.clock.pauseAt(new Date(59000));
 await page.goto(base+'/vault.html#authenticator');
 const row=page.locator('.kp-totp-row');await row.getByRole('button',{name:'查看验证码'}).click();
 await page.getByRole('dialog').getByLabel('主密码',{exact:true}).fill('Test-master!42');await page.getByRole('button',{name:'验证',exact:true}).click();
 await expect(row.locator('output')).toHaveText('287 082');
 await row.getByRole('button',{name:'复制验证码'}).click();await expect(page.getByRole('dialog')).toBeVisible();
 await page.clock.runFor(1500);
 await expect(row.locator('output')).toHaveText('359 152');
 await page.getByRole('dialog').getByLabel('主密码',{exact:true}).fill('Test-master!42');await page.getByRole('button',{name:'验证',exact:true}).click();
 await expect(row.getByRole('status').filter({hasText:'已复制验证码'})).toBeVisible();
 expect(await page.evaluate(()=>navigator.clipboard.readText())).toBe('359152');
 await worker.evaluate(()=>chrome.storage.session.remove('keypilot.sessionState'));
 await page.clock.runFor(1500);
 await expect(page.locator('.kp-totp-row')).toHaveCount(0);
});

test('TOTP is available in the compact popup and encrypted backup',async()=>{
 await seedCredentials(undefined,{totpAccounts:[testTotp]});
 const page=await context.newPage();await page.setViewportSize({width:400,height:600});await page.goto(base+'/popup.html');
 await page.locator('.kp-tools-menu summary').click();await page.getByRole('button',{name:'身份验证器',exact:true}).click();
 await expect(page.locator('.kp-totp-row')).toContainText('Example');
 await page.screenshot({path:'output/playwright/totp-popup.png',fullPage:true});
 expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(400);
 const options=await context.newPage();await options.goto(base+'/options.html');await options.getByRole('button',{name:'账户&数据',exact:true}).click();
 const downloading=options.waitForEvent('download');await options.getByRole('region',{name:'备份状态'}).getByRole('button',{name:'导出完整加密备份'}).click();
 const downloaded=await downloading;const data=await readFile((await downloaded.path())!,'utf8');
 expect(data).not.toContain(testTotp.secret);
 expect((await unlockEncryptedVault('Test-master!42',JSON.parse(data))).vault.totpAccounts?.[0]).toEqual(testTotp);
});


for(const enabled of [true,false]) test(`opening the start page after unlock respects setting ${enabled}`,async()=>{
 await seedCredentials(undefined,{settings:{...defaultSettings,openStartPageOnLogin:enabled}});
 await worker.evaluate(()=>chrome.storage.session.remove(['keypilot.sessionState','keypilot.unlockedSession']));
 const page=await context.newPage();await page.goto(base+'/popup.html');
 await page.getByPlaceholder('输入主密码',{exact:true}).fill('Test-master!42');
 const newPage=enabled?context.waitForEvent('page'):undefined;
 await page.getByRole('button',{name:'解锁 Vault',exact:true}).click();
 if(newPage) await expect(await newPage).toHaveURL(/vault\.html/);
 else {await expect(page.locator('.kp-home')).toBeVisible();expect(context.pages().filter(item=>item.url().includes('/vault.html'))).toHaveLength(0);}
});

for(const enabled of [true,false]) test(`blank-tab start page setting ${enabled}`,async()=>{
 await seedCredentials(undefined,{settings:{...defaultSettings,openStartPageOnToolbarClick:enabled}});
 const popup=await context.newPage();const blank=await context.newPage();await blank.goto('about:blank');await blank.bringToFront();
 const newPage=enabled?context.waitForEvent('page'):undefined;
 await popup.goto(base+'/popup.html');
 if(newPage) await expect(await newPage).toHaveURL(/vault\.html/);
 else {await expect(popup.locator('.kp-home')).toBeVisible();expect(context.pages().filter(item=>item.url().includes('/vault.html'))).toHaveLength(0);}
});
