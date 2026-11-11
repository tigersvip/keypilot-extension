import {test,expect,chromium,type BrowserContext,type Worker,type Page} from '@playwright/test';
import {resolve} from 'node:path';
import {cp,mkdir,readFile,writeFile,mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {createEmptyVault} from '../../src/shared/defaults';
import {buildCredential} from '../../src/shared/vault';
import {createEncryptedVault,exportVaultKey} from '../../src/shared/crypto';
import {generateSaveInboxKeyPair} from '../../src/shared/saveInbox';
import type {FillProfile} from '../../src/shared/types';

// Browser plugin not available. Exercise the real registered command listener in
// an isolated extension copy; the packaged extension contains no test entry point.
let extension:string,context:BrowserContext,worker:Worker;
const site='https://shortcut.example.test';
const evidence=resolve(process.env.TEMP??tmpdir(),'keypilot-v1.15.0');
const fields='<label>Full name <input id="name" name="fullName" autocomplete="name"></label><label>Email <input id="email" type="email" autocomplete="email"></label><label>Street address <textarea id="address" autocomplete="street-address"></textarea></label><label>Country <select id="country" autocomplete="country-name"><option value="">Choose</option><option>United States</option></select></label>';
const login='<label>Username <input id="username" autocomplete="username"></label><label>Password <input id="password" type="password" autocomplete="current-password"></label>';
const profile=(id='one',name='Example Person'):FillProfile=>({id,title:name,countryCode:'US',category:'identity',createdAt:1,updatedAt:1,privacyVersion:1,fields:[
  {key:'fullName',label:'姓名',value:name,group:'personal',sensitivity:'normal'},
  {key:'email',label:'邮箱',value:id+'@example.test',group:'contact',sensitivity:'normal'},
  {key:'address',label:'地址',value:'123 Example Street',group:'address',sensitivity:'normal'}
]});
function fixture(){const vault=createEmptyVault();vault.settings.openStartPageOnLogin=false;vault.credentials=[buildCredential({title:'Synthetic login',url:site,username:'synthetic-user',password:'Synthetic-only!42'})];vault.fillProfiles=[profile()];return vault;}
test.beforeAll(async()=>{
  await mkdir(evidence,{recursive:true});extension=await mkdtemp(resolve(tmpdir(),'keypilot-shortcut-'));
  await cp(resolve('dist'),extension,{recursive:true});
  const path=resolve(extension,'background.js'),source=await readFile(path,'utf8');
  await writeFile(path,`const commandListeners=[];const registerCommand=chrome.commands.onCommand.addListener.bind(chrome.commands.onCommand);chrome.commands.onCommand.addListener=(listener)=>{commandListeners.push(listener);registerCommand(listener);};globalThis.fireKeypilotCommand=(command)=>commandListeners.forEach(listener=>listener(command));\n`+source);
});
test.beforeEach(async()=>{
  context=await chromium.launchPersistentContext('',{channel:'chromium',headless:true,args:['--disable-extensions-except='+extension,'--load-extension='+extension,'--mute-audio']});
  worker=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker');
  await seed();
});
test.afterEach(async()=>{await context?.close();});
async function seed(vault=fixture()){
  vault.saveInboxKeyPair=await generateSaveInboxKeyPair();
  const {encryptedVault,key}=await createEncryptedVault('Synthetic-shortcut!42',vault);
  const cache={vault,encryptedVault,exportedKey:await exportVaultKey(key),cachedAt:Date.now(),sessionId:'quick-fill-test'};
  await worker.evaluate(async({cache,encryptedVault})=>{await navigator.locks.request('keypilot-vault-write',async()=>{
    await chrome.storage.local.set({'keypilot.encryptedVault':encryptedVault});
    await chrome.storage.session.set({'keypilot.unlockedSession':cache,'keypilot.sessionState':{id:cache.sessionId,expiresAt:0,highSecurity:false}});
  });},{cache,encryptedVault});
}
async function pageWith(body:string){
  await context.route(site+'/**',route=>route.fulfill({contentType:'text/html',body:`<!doctype html><meta charset="utf-8"><title>Shortcut form fixture</title><style>body{font:16px system-ui;padding:32px;background:#f5f7fa;color:#172338}form{padding:20px;margin:12px;background:white;max-width:560px}label{display:block;margin:14px 0}input,select,textarea{display:block;font:inherit;padding:8px;min-width:240px}h2{font-size:20px}</style>${body}<script>window.submissions=0;document.addEventListener('submit',e=>{e.preventDefault();window.submissions++})</script>`}));
  const page=await context.newPage();await page.goto(site+'/form');await page.bringToFront();
  await expect(page).toHaveTitle('Shortcut form fixture');
  await expect(page.locator('body')).not.toBeEmpty();return page;
}
async function command(name='fill-current'){await worker.evaluate(name=>(globalThis as any).fireKeypilotCommand(name),name);}
async function panel(page:Page,title:string){const node=page.locator('#keypilot-fill-review');await expect(node).toHaveAttribute('aria-label',title);return node;}
async function confirm(page:Page){await panel(page,'预览填写内容');await page.keyboard.press('Enter');await panel(page,'填写完成');}
async function getProbe(page:Page){return worker.evaluate(async url=>{const tab=(await chrome.tabs.query({})).find(tab=>tab.url===url)!;return chrome.tabs.sendMessage(tab.id!,{type:'KEYPILOT_PROBE_QUICK_FILL'},{frameId:0});},page.url());}

async function defaultProfile(){return worker.evaluate(async()=>{
  const cache=(await chrome.storage.session.get('keypilot.unlockedSession'))['keypilot.unlockedSession'];
  return cache.vault.settings.siteLoginSettings?.['https://shortcut.example.test']?.defaultFillProfileId;
});}
async function toggleRemember(page:Page){
  await panel(page,'预览填写内容');
  for(let i=0;i<3;i++)await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Space');
  for(let i=0;i<3;i++)await page.keyboard.press('Tab');
}

async function currentVault(){return worker.evaluate(async()=>((await chrome.storage.session.get('keypilot.unlockedSession'))['keypilot.unlockedSession']).vault);}
function bindingFixture(){
  const vault=fixture();vault.fillProfiles!.push(profile('two','Second Person'));
  vault.fillProfiles![0].siteBindings=[
    {id:'domain-binding',domain:'shortcut.example.test',fields:[{key:'fullName',selector:'#name',controlLabel:'Full name'}],createdAt:1,updatedAt:1},
    {id:'other-binding',domain:'shortcut.example.test',pathPattern:'/other',fields:[{key:'email',selector:'#email'}],createdAt:1,updatedAt:1}
  ];
  vault.settings.siteLoginSettings={[site]:{defaultFillProfileId:'one',autoSubmit:false},[site+':8443']:{defaultFillProfileId:'two'}};
  return vault;
}

test('calibration collapses, follows field selection, moves by pointer and keyboard, and stays inside a narrow viewport',async()=>{
  const page=await pageWith('<form><h2>Personal information</h2>'+fields+'</form>');
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.locator('#name').focus();await command();await panel(page,'预览填写内容');await page.keyboard.press('Shift+Tab');await page.keyboard.press('Enter');
  const repair=page.locator('#keypilot-binding-root');await expect(repair.getByRole('button',{name:'展开',exact:true})).toBeVisible();
  expect((await repair.boundingBox())!.height).toBeLessThan(150);
  await page.locator('#name').click();await repair.getByLabel('选择要绑定的资料字段').selectOption('fullName');
  const handle=repair.getByRole('button',{name:'移动校准面板'}),box=(await handle.boundingBox())!,before=(await repair.boundingBox())!;
  await page.mouse.move(box.x+10,box.y+10);await page.mouse.down();await page.mouse.move(box.x-180,box.y+60);await page.mouse.up();
  expect((await repair.boundingBox())!.x).toBeLessThan(before.x-100);
  await handle.focus();await page.keyboard.press('ArrowLeft');
  await repair.getByRole('button',{name:'继续选取网页字段'}).click();await expect(repair.getByRole('button',{name:'展开',exact:true})).toBeVisible();
  await page.locator('#email').click();await expect(repair.getByRole('button',{name:'收起',exact:true})).toBeVisible();
  await repair.getByLabel('选择要绑定的资料字段').selectOption('email');
  await page.setViewportSize({width:360,height:560});
  await expect(repair.getByRole('button',{name:'保存绑定',exact:true})).toBeInViewport({ratio:1});
  const bounds=(await repair.boundingBox())!;expect(bounds.x).toBeGreaterThanOrEqual(0);expect(bounds.x+bounds.width).toBeLessThanOrEqual(360);expect(bounds.y+bounds.height).toBeLessThanOrEqual(560);
  await page.screenshot({path:resolve(evidence,'calibration-360.png')});
  await repair.getByRole('button',{name:'收起',exact:true}).click();await page.screenshot({path:resolve(evidence,'calibration-collapsed-360.png')});
  await repair.getByRole('button',{name:'展开',exact:true}).click();await repair.getByRole('button',{name:'保存绑定',exact:true}).click();await panel(page,'字段绑定已保存');
  expect((await currentVault()).fillProfiles[0].siteBindings[0].fields).toHaveLength(2);expect(errors).toEqual([]);
});

test('removing the last calibration field can clear an existing domain rule without touching other paths',async()=>{
  await seed(bindingFixture());
  const page=await pageWith('<form><h2>Personal information</h2>'+fields+'</form>');
  await page.locator('#name').focus();await command();await panel(page,'预览填写内容');await page.keyboard.press('Shift+Tab');await page.keyboard.press('Enter');
  const repair=page.locator('#keypilot-binding-root');await repair.getByRole('button',{name:'展开',exact:true}).click();
  await expect(repair.getByRole('button',{name:'整个域名'})).toHaveAttribute('aria-pressed','true');
  await repair.getByRole('button',{name:'移除',exact:true}).click();await expect(repair.getByRole('button',{name:'清除这组绑定'})).toBeEnabled();
  page.once('dialog',dialog=>dialog.dismiss());await repair.getByRole('button',{name:'清除这组绑定'}).click();expect((await currentVault()).fillProfiles[0].siteBindings).toHaveLength(2);
  page.once('dialog',dialog=>{expect(dialog.message()).toContain('整个域名');void dialog.accept();});await repair.getByRole('button',{name:'清除这组绑定'}).click();await panel(page,'字段绑定已清除');
  const saved=await currentVault();expect(saved.fillProfiles[0].siteBindings.map((item:any)=>item.id)).toEqual(['other-binding']);expect(saved.settings.siteLoginSettings[site].defaultFillProfileId).toBe('one');expect(saved.fillProfiles[0].fields).toHaveLength(3);
});

test('website manager searches, edits defaults, resets only the exact origin and clears only the selected binding',async()=>{
  await seed(bindingFixture());const page=await context.newPage(),errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  const base='chrome-extension://'+new URL(worker.url()).host;await page.goto(base+'/options.html#domains');await expect(page).toHaveTitle(/KeyPilot/);
  const manager=page.getByRole('region',{name:'网站填写设置'});await expect(manager.getByRole('heading',{name:'网站填写设置'})).toBeVisible();
  const search=manager.getByRole('searchbox');await search.fill(':8443');await expect(manager.locator('article')).toHaveCount(1);await search.clear();
  await manager.getByRole('button',{name:new RegExp('^https://shortcut.example.test 网站偏好')}).click();
  await manager.getByLabel('默认填写资料',{exact:true}).selectOption('two');await expect(manager.getByRole('status')).toContainText('已保存');await expect.poll(defaultProfile).toBe('two');
  await expect(manager.getByRole('switch',{name:/自动点击登录/})).not.toBeChecked();
  await page.setViewportSize({width:1280,height:800});await page.screenshot({path:resolve(evidence,'website-settings-desktop.png')});
  await page.setViewportSize({width:400,height:700});await manager.getByLabel('默认填写资料',{exact:true}).scrollIntoViewIfNeeded();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:resolve(evidence,'website-settings-400.png')});
  page.once('dialog',dialog=>dialog.dismiss());await manager.getByRole('button',{name:'恢复此网站默认设置'}).click();expect((await currentVault()).settings.siteLoginSettings[site]).toBeTruthy();
  page.once('dialog',dialog=>dialog.accept());await manager.getByRole('button',{name:'恢复此网站默认设置'}).click();await expect(manager.getByRole('status')).toContainText('已恢复');
  expect((await currentVault()).settings.siteLoginSettings[site]).toBeUndefined();expect((await currentVault()).settings.siteLoginSettings[site+':8443'].defaultFillProfileId).toBe('two');
  await manager.getByRole('combobox',{name:'设置类型'}).selectOption('bindings');await expect(manager.locator('article')).toHaveCount(2);
  await manager.getByRole('button',{name:/shortcut.example.test（整个域名）/}).click();await expect(manager).toContainText('不区分协议和端口');
  page.once('dialog',dialog=>dialog.accept());await manager.getByRole('button',{name:'清除这组绑定'}).click();await expect(manager.getByRole('status')).toContainText('已清除');await expect(manager.locator('article')).toHaveCount(1);
  await page.reload();await expect(manager.locator('article')).toHaveCount(2);expect((await currentVault()).fillProfiles[0].siteBindings[0].id).toBe('other-binding');
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);expect(errors).toEqual([]);
});

test('website manager refreshes stale settings instead of overwriting another page and cancels on lock',async()=>{
  const vault=bindingFixture();await seed(vault);const page=await context.newPage();await page.goto('chrome-extension://'+new URL(worker.url()).host+'/options.html#domains');
  const manager=page.getByRole('region',{name:'网站填写设置'});await manager.getByRole('button',{name:new RegExp('^https://shortcut.example.test 网站偏好')}).click();
  vault.settings.siteLoginSettings![site].autoSubmit=true;await seed(vault);
  await manager.getByLabel('默认填写资料',{exact:true}).selectOption('two');await expect(manager.getByRole('status')).toContainText('其他页面修改');expect(await defaultProfile()).toBe('one');
  await manager.getByLabel('默认填写资料',{exact:true}).selectOption('two');await expect(manager.getByRole('status')).toContainText('已保存');expect((await currentVault()).settings.siteLoginSettings[site].autoSubmit).toBe(true);
  await command('lock-vault');await expect(manager).toHaveCount(0);
});

test('default identity persists across navigation, switches explicitly, and can be cleared',async()=>{
  const vault=fixture();vault.fillProfiles=[profile(),profile('two','Second Person')];await seed(vault);
  const page=await pageWith('<form><h2>Personal information</h2>'+fields+'</form>');
  await page.locator('#name').focus();await command();await panel(page,'选择填写资料');await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');
  await toggleRemember(page);await page.screenshot({path:resolve(evidence,'default-preview-desktop.png')});await confirm(page);
  await expect.poll(defaultProfile).toBe('two');
  await page.reload();await page.locator('#name').focus();await command();await panel(page,'预览填写内容');
  await page.setViewportSize({width:400,height:650});await page.screenshot({path:resolve(evidence,'default-preview-400.png')});
  // The default must still offer a keyboard-accessible profile switch.
  for(let i=0;i<4;i++)await page.keyboard.press('Shift+Tab');await page.keyboard.press('Enter');
  await panel(page,'选择填写资料');await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');await confirm(page);await expect(page.locator('#name')).toHaveValue('Example Person');
  await expect.poll(defaultProfile).toBe('two');
  await page.reload();await page.locator('#name').focus();await command();await panel(page,'预览填写内容');await toggleRemember(page);await confirm(page);
  await expect.poll(defaultProfile).toBeUndefined();
  await page.reload();await page.locator('#name').focus();await command();await panel(page,'选择填写资料');
});

test('cancelled preference does not persist; missing default falls back to selection',async()=>{
  const page=await pageWith('<form><h2>Personal information</h2>'+fields+'</form>');await page.locator('#name').focus();await command();await toggleRemember(page);await page.keyboard.press('Escape');
  expect(await defaultProfile()).toBeUndefined();await expect(page.locator('#name')).toHaveValue('');
  const vault=fixture();vault.fillProfiles=[profile(),profile('two')];vault.settings.siteLoginSettings={[site]:{defaultFillProfileId:'deleted'}};await seed(vault);
  await page.locator('#name').focus();await command();await panel(page,'选择填写资料');
});

test('default belongs only to the exact origin, and lock cancels a remembered preview',async()=>{
  const vault=fixture();vault.fillProfiles=[profile(),profile('two')];vault.settings.siteLoginSettings={'http://shortcut.example.test':{defaultFillProfileId:'two'},'https://shortcut.example.test:8443':{defaultFillProfileId:'two'}};await seed(vault);
  const page=await pageWith('<form><h2>Personal information</h2>'+fields+'</form>');await page.locator('#name').focus();await command();await panel(page,'选择填写资料');await page.keyboard.press('Enter');await toggleRemember(page);
  await command('lock-vault');await expect(page.locator('#keypilot-fill-review')).toHaveCount(0);await expect(page.locator('#name')).toHaveValue('');
});

test('click-first repair saves a missing field, retries scoped preview and works after reload',async()=>{
  const vault=fixture();vault.fillProfiles![0].fields.push({key:'projectCode',label:'项目编号',value:'PROJECT-42',group:'custom',sensitivity:'normal'} as any);await seed(vault);
  const page=await pageWith('<form id="main"><h2>Personal information</h2>'+fields+'<label>Internal field<input id="opaque" name="zqxv"></label></form><form><h2>Other form</h2><input id="other" name="fullName"></form>');
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.locator('#name').focus();await command();await panel(page,'预览填写内容');await page.keyboard.press('Shift+Tab');await page.keyboard.press('Enter');
  const repair=page.locator('#keypilot-binding-root');await expect(repair.getByRole('heading',{name:'校准漏填字段'})).toBeVisible();
  await expect(repair.getByLabel('选择要绑定的资料字段')).toBeDisabled();await page.locator('#other').click();await expect(repair.getByLabel('选择要绑定的资料字段')).toBeDisabled();
  await page.locator('#opaque').click();await expect(repair.getByLabel('选择要绑定的资料字段')).toBeEnabled();await repair.getByLabel('选择要绑定的资料字段').selectOption('projectCode');
  await expect(repair).toContainText('项目编号 →');await page.setViewportSize({width:400,height:650});
  await page.screenshot({path:resolve(evidence,'repair-400.png')});await repair.getByRole('button',{name:'保存绑定'}).click();
  await panel(page,'字段绑定已保存');await page.keyboard.press('Enter');await confirm(page);await expect(page.locator('#opaque')).toHaveValue('PROJECT-42');await expect(page.locator('#other')).toHaveValue('');
  await page.reload();await page.locator('#name').focus();await command();await confirm(page);await expect(page.locator('#opaque')).toHaveValue('PROJECT-42');expect(errors).toEqual([]);
});

test('repair excludes passwords and cancels on navigation or lock',async()=>{
  const page=await pageWith('<form><h2>Create account</h2>'+fields+'<input id="password" type="password" autocomplete="new-password"></form>');
  await page.locator('#name').focus();await command();await panel(page,'预览填写内容');await page.keyboard.press('Shift+Tab');await page.keyboard.press('Enter');
  const repair=page.locator('#keypilot-binding-root');await expect(repair).toBeVisible();await page.locator('#password').click();await expect(repair.getByLabel('选择要绑定的资料字段')).toBeDisabled();
  await page.evaluate(()=>{location.hash='changed';});await expect(repair).toHaveCount(0);
  await page.locator('#name').focus();await command();await panel(page,'预览填写内容');await page.keyboard.press('Shift+Tab');await page.keyboard.press('Enter');await expect(repair).toBeVisible();await command('lock-vault');await expect(repair).toHaveCount(0);
});

test('profile changes while calibrating cannot be overwritten by stale bindings',async()=>{
  const page=await pageWith('<form><h2>Personal information</h2>'+fields+'</form>');
  await page.locator('#name').focus();await command();await panel(page,'预览填写内容');await page.keyboard.press('Shift+Tab');await page.keyboard.press('Enter');
  const repair=page.locator('#keypilot-binding-root');await expect(repair).toBeVisible();await page.locator('#name').click();await repair.getByLabel('选择要绑定的资料字段').selectOption('fullName');
  const vault=fixture();vault.fillProfiles![0].updatedAt=2;vault.fillProfiles![0].fields[0].value='New value';await seed(vault);
  await repair.getByRole('button',{name:'保存绑定'}).click();await expect(repair.getByRole('status')).toContainText('资料已变化');
  await expect(page.locator('#name')).toHaveValue('');
  expect(await worker.evaluate(async()=>{const cache=(await chrome.storage.session.get('keypilot.unlockedSession'))['keypilot.unlockedSession'];return cache.vault.fillProfiles[0].siteBindings??[];})).toEqual([]);
});

test('default can be cleared when the form already has values, without changing those values',async()=>{
  const vault=fixture();vault.settings.siteLoginSettings={[site]:{defaultFillProfileId:'one'}};await seed(vault);
  const page=await pageWith('<form><h2>Personal information</h2>'+fields+'</form>');
  await page.locator('#name').fill('Keep name');await page.locator('#email').fill('keep@example.test');await page.locator('#address').fill('Keep address');await page.locator('#country').selectOption({label:'United States'});
  await page.locator('#name').focus();await command();await panel(page,'预览填写内容');
  // With no empty fields, focus starts on Cancel; changing the preference enables Save.
  await page.keyboard.press('Shift+Tab');await page.keyboard.press('Space');for(let i=0;i<3;i++)await page.keyboard.press('Tab');await page.keyboard.press('Enter');
  await panel(page,'填写完成');await expect.poll(defaultProfile).toBeUndefined();
  await expect(page.locator('#name')).toHaveValue('Keep name');await expect(page.locator('#email')).toHaveValue('keep@example.test');await expect(page.locator('#address')).toHaveValue('Keep address');
});

test('recording a successful fill does not invalidate its immediate repair action',async()=>{
  const page=await pageWith('<form><h2>Personal information</h2>'+fields+'</form>');
  await page.locator('#name').focus();await command();await confirm(page);
  await expect.poll(()=>worker.evaluate(async()=>{const cache=(await chrome.storage.session.get('keypilot.unlockedSession'))['keypilot.unlockedSession'];return cache.vault.fillProfiles[0].lastUsedAt??0;})).toBeGreaterThan(0);
  await page.keyboard.press('Shift+Tab');await page.keyboard.press('Enter');
  const repair=page.locator('#keypilot-binding-root');await expect(repair).toBeVisible();await page.locator('#name').click();await repair.getByLabel('选择要绑定的资料字段').selectOption('fullName');
  await repair.getByRole('button',{name:'保存绑定'}).click();await panel(page,'字段绑定已保存');
});

test('single identity previews English form, keeps existing values, fills select/textarea and can undo',async()=>{
  const page=await pageWith('<form><h2>Personal information</h2>'+fields+'<button>Save</button></form>');
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.locator('#email').fill('already@example.test');await page.locator('#name').focus();await command();
  await panel(page,'预览填写内容');await expect(page.locator('#name')).toHaveValue('');
  await page.screenshot({path:resolve(evidence,'shortcut-preview.png')});
  await confirm(page);await expect(page.locator('#name')).toHaveValue('Example Person');
  await expect(page.locator('#email')).toHaveValue('already@example.test');await expect(page.locator('#address')).toHaveValue('123 Example Street');await expect(page.locator('#country')).toHaveValue('United States');
  expect(await page.evaluate(()=>(window as any).submissions)).toBe(0);
  await page.keyboard.press('Shift+Tab');await page.keyboard.press('Shift+Tab');await page.keyboard.press('Enter');
  await expect(page.locator('#name')).toHaveValue('');await expect(page.locator('#email')).toHaveValue('already@example.test');expect(errors).toEqual([]);
});

test('multiple identities support keyboard choice, and repeated shortcut does not replace selection',async()=>{
  const vault=fixture();vault.fillProfiles=[profile(),profile('two','Second Person')];await seed(vault);
  const page=await pageWith('<form><h2>个人资料</h2>'+fields+'</form>');await page.locator('#name').focus();await command();await panel(page,'选择填写资料');
  await command();await expect(page.locator('#keypilot-fill-review')).toHaveCount(1);await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');
  await confirm(page);await expect(page.locator('#name')).toHaveValue('Second Person');
});

test('searchable identity picker works at narrow width without exposing field values',async()=>{
  const vault=fixture();vault.fillProfiles=Array.from({length:8},(_,i)=>profile(String(i),'资料 '+i));await seed(vault);
  const page=await pageWith('<form><h2>Shipping address</h2>'+fields+'</form>');await page.setViewportSize({width:400,height:650});
  await page.locator('#name').focus();const probe=await getProbe(page);expect(JSON.stringify(probe)).not.toContain('123 Example Street');
  await command();await panel(page,'选择填写资料');await page.keyboard.type('资料 7');await page.screenshot({path:resolve(evidence,'shortcut-picker-400.png')});await page.keyboard.press('Enter');await confirm(page);
  await expect(page.locator('#name')).toHaveValue('资料 7');
});

test('login shortcut fills matching credentials without submitting even when auto login is enabled',async()=>{
  const vault=fixture();vault.settings.autoSubmit=true;await seed(vault);
  const page=await pageWith('<form><h2>Sign in</h2>'+login+'<button>Login</button></form>');await page.locator('#username').focus();await command();
  await expect(page.locator('#username')).toHaveValue('synthetic-user');await expect(page.locator('#password')).toHaveValue('Synthetic-only!42');
  expect(await page.evaluate(()=>(window as any).submissions)).toBe(0);await expect(page.locator('#keypilot-fill-review')).toHaveCount(0);
});

test('focus separates login from profile and only fills selected profile form',async()=>{
  const page=await pageWith('<form id="login"><h2>Sign in</h2>'+login+'</form><form id="shipping"><h2>Shipping address</h2>'+fields+'</form><form id="billing"><h2>Billing address</h2>'+fields.replaceAll('id="','id="bill-')+'</form>');
  await page.locator('#bill-name').focus();await command();await confirm(page);
  await expect(page.locator('#bill-name')).toHaveValue('Example Person');await expect(page.locator('#name')).toHaveValue('');await expect(page.locator('#username')).toHaveValue('');
});

test('ambiguous page asks for form first; focused second login fills only that form',async()=>{
  const page=await pageWith('<form><h2>Sign in</h2>'+login+'</form><form><h2>Personal information</h2>'+fields+'</form>');
  await command();await panel(page,'选择要填写的表单');await page.keyboard.press('Escape');await expect(page.locator('#username')).toHaveValue('');
  await page.goto(site+'/form');await page.evaluate(html=>{const form=document.createElement('form');form.innerHTML='<h2>Another login</h2>'+html;document.body.append(form);},login.replaceAll('id="','id="second-'));
  await page.locator('#second-username').focus();await command();await expect(page.locator('#second-username')).toHaveValue('synthetic-user');await expect(page.locator('#username')).toHaveValue('');
});

test('registration fields use identity preview and never fill saved password',async()=>{
  const page=await pageWith('<form><h2>Create account</h2>'+fields+'<input id="password" type="password" autocomplete="new-password"></form>');
  await page.locator('#name').focus();await command();await confirm(page);await expect(page.locator('#password')).toHaveValue('');
});

test('lock cancels chooser and preview; edited or replaced fields cannot be filled by stale confirmation',async()=>{
  const page=await pageWith('<form><h2>Personal information</h2>'+fields+'</form>');await page.locator('#name').focus();await command();await panel(page,'预览填写内容');
  await command('lock-vault');await expect(page.locator('#keypilot-fill-review')).toHaveCount(0);await expect(page.locator('#name')).toHaveValue('');
  await seed();await page.locator('#name').focus();await command();await panel(page,'预览填写内容');
  await page.evaluate(()=>{(document.querySelector('#name') as HTMLInputElement).value='User edit';});await page.keyboard.press('Enter');
  await panel(page,'预览填写内容');await expect(page.locator('#name')).toHaveValue('User edit');await expect(page.locator('#email')).toHaveValue('');await page.keyboard.press('Escape');await expect(page.locator('#keypilot-fill-review')).toHaveCount(0);
  const vault=fixture();vault.fillProfiles=[profile(),profile('two','Second Person')];await seed(vault);await page.locator('#name').focus();await command();await panel(page,'选择填写资料');await command('lock-vault');await expect(page.locator('#keypilot-fill-review')).toHaveCount(0);
});

test('multiple matching logins choose the requested account without profile distraction',async()=>{
  const vault=fixture();vault.credentials.push(buildCredential({title:'Second login',url:site,username:'second-user',password:'Second-only!42'}));await seed(vault);
  const page=await pageWith('<form><h2>Sign in</h2>'+login+'</form>');await page.locator('#username').focus();await command();await panel(page,'选择登录账号');await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');
  await expect(page.locator('#username')).toHaveValue('second-user');await expect(page.locator('#password')).toHaveValue('Second-only!42');expect(await page.evaluate(()=>(window as any).submissions)).toBe(0);
});

test('Chinese textarea and select-only profile form works without a login input',async()=>{
  const page=await pageWith('<form><h2>收货地址</h2><label>地址<textarea id="address" name="address"></textarea></label><label>国家<select id="country" name="country"><option value="">请选择</option><option value="United States">United States</option></select></label></form>');
  await page.locator('#address').focus();await command();await confirm(page);await expect(page.locator('#address')).toHaveValue('123 Example Street');await expect(page.locator('#country')).toHaveValue('United States');
});

test('navigation cancels pending preview and replacing target fields blocks a stale plan',async()=>{
  const page=await pageWith('<form><h2>Personal information</h2>'+fields+'</form>');await page.locator('#name').focus();await command();await panel(page,'预览填写内容');
  await page.evaluate(()=>{location.hash='other-form';});await expect(page.locator('#keypilot-fill-review')).toHaveCount(0);await expect(page.locator('#name')).toHaveValue('');
  await page.locator('#name').focus();await command();await panel(page,'预览填写内容');
  await page.evaluate(()=>{const old=document.querySelector('#name')!;old.replaceWith(old.cloneNode(true));});await page.keyboard.press('Enter');await expect(page.locator('#name')).toHaveValue('');await expect(page.locator('#email')).toHaveValue('');await page.keyboard.press('Escape');await expect(page.locator('#keypilot-fill-review')).toHaveCount(0);
});

test('cancelling while confirmation is authorizing does not fill afterwards',async()=>{
  const page=await pageWith('<form><h2>Personal information</h2>'+fields+'</form>');await page.locator('#name').focus();await command();await panel(page,'预览填写内容');
  await worker.evaluate(()=>{const get=chrome.storage.session.get.bind(chrome.storage.session);(chrome.storage.session as any).get=async(keys:any)=>{await new Promise(resolve=>setTimeout(resolve,500));return get(keys);};});
  await page.keyboard.press('Enter');await page.keyboard.press('Escape');await expect(page.locator('#keypilot-fill-review')).toHaveCount(0);
  await page.waitForTimeout(1400);await expect(page.locator('#name')).toHaveValue('');await expect(page.locator('#email')).toHaveValue('');
});

test('missing profiles and search-only pages show clear guidance without filling',async()=>{
  const vault=fixture();vault.fillProfiles=[];await seed(vault);
  const page=await pageWith('<form><h2>Personal information</h2>'+fields+'</form>');await page.locator('#name').focus();await command();await panel(page,'还没有填写资料');await expect(page.locator('#name')).toHaveValue('');await page.keyboard.press('Escape');
  await page.evaluate(()=>{document.body.innerHTML='<form><input id="search" type="search" name="q"></form>';});await page.locator('#search').focus();await command();await panel(page,'快捷填写');await expect(page.locator('#search')).toHaveValue('');
});

test('same-origin iframe uses its focused form; unfocused cross-origin iframe is not selected',async()=>{
  const page=await pageWith('<h2>Profile host</h2><iframe style="width:700px;height:600px"></iframe>');
  // Replace the child route before loading the frame to avoid recursive iframe markup.
  await context.route(site+'/child',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><form><h2>Shipping address</h2>'+fields+'</form>'}));
  await page.locator('iframe').evaluate((frame:HTMLIFrameElement)=>{frame.src='/child';});
  const frame=page.frameLocator('iframe');await frame.locator('#name').focus();await command();await expect(frame.locator('#keypilot-fill-review')).toHaveAttribute('aria-label','预览填写内容');await page.keyboard.press('Enter');await expect(frame.locator('#name')).toHaveValue('Example Person');
  await context.route('https://other.example.test/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><form><h2>Profile</h2>'+fields+'</form>'}));
  await page.locator('iframe').evaluate((frame:HTMLIFrameElement)=>{frame.src='https://other.example.test/form';});await expect(frame.locator('#name')).toBeVisible();await page.locator('h2').first().click();await command();await panel(page,'快捷填写');await expect(frame.locator('#name')).toHaveValue('');
  await page.keyboard.press('Escape');await frame.locator('#name').focus();await command();await expect(frame.locator('#keypilot-fill-review')).toHaveAttribute('aria-label','选择要填写的表单');
  await page.keyboard.press('Enter');await expect(frame.locator('#keypilot-fill-review')).toHaveAttribute('aria-label','预览填写内容');await page.keyboard.press('Enter');await expect(frame.locator('#name')).toHaveValue('Example Person');
});

test('hidden same-origin frame cannot become an automatic profile destination',async()=>{
  const page=await pageWith('<h2>Welcome</h2><iframe style="opacity:0;width:700px;height:500px"></iframe>');
  await context.route(site+'/child',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><form><h2>Profile</h2>'+fields+'</form>'}));
  await page.locator('iframe').evaluate((frame:HTMLIFrameElement)=>{frame.src='/child';});
  await expect(page.frameLocator('iframe').locator('#name')).toHaveCount(1);await page.locator('h2').first().click();await command();await panel(page,'快捷填写');await expect(page.frameLocator('iframe').locator('#name')).toHaveValue('');
});
