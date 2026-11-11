import { test, expect, chromium, type BrowserContext, type Worker, type Page } from '@playwright/test';
import { mockSyntheticIcons } from './syntheticIcons';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createEncryptedVault, exportVaultKey, unlockEncryptedVault } from '../../src/shared/crypto';
import { generateSaveInboxKeyPair } from '../../src/shared/saveInbox';
import { completeBackupFixture } from '../fixtures/completeBackup';
import { createEmptyVault } from '../../src/shared/defaults';
import { backupCollections } from '../../src/shared/backupInventory';
import type { VaultPlain } from '../../src/shared/types';

let context: BrowserContext, worker: Worker, base: string;
const master = 'Synthetic-backup!42', currentMaster = 'Synthetic-current!42';
const evidence = resolve(process.env.TEMP ?? '..','keypilot-complete-backup-v1.5.0');
test.beforeEach(async () => {
  const extension = resolve('dist');
  context = await chromium.launchPersistentContext('',{channel:'chromium',headless:true,args:['--disable-extensions-except='+extension,'--load-extension='+extension]});
  await mockSyntheticIcons(context);
  worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  base = 'chrome-extension://'+new URL(worker.url()).host;
  await worker.evaluate(async()=>{await chrome.storage.local.clear();await chrome.storage.session.clear();});
  await mkdir(evidence,{recursive:true});
});
test.afterEach(async()=>{await context?.close();});

async function seed(vault: VaultPlain, password = currentMaster) {
  vault.saveInboxKeyPair ??= await generateSaveInboxKeyPair();
  const {encryptedVault,key} = await createEncryptedVault(password,vault);
  const cache = {vault,encryptedVault,exportedKey:await exportVaultKey(key),cachedAt:Date.now(),sessionId:'backup-browser-session'};
  await worker.evaluate(async({encryptedVault,cache})=>{
    await chrome.storage.local.set({'keypilot.encryptedVault':encryptedVault});
    await chrome.storage.session.set({'keypilot.unlockedSession':cache,'keypilot.sessionState':{id:cache.sessionId,expiresAt:0,highSecurity:false}});
  },{encryptedVault,cache});
}
async function stored() { return worker.evaluate(async()=>(await chrome.storage.local.get('keypilot.encryptedVault'))['keypilot.encryptedVault']); }
async function selectBackup(page: Page, vault = completeBackupFixture()) {
  const {encryptedVault} = await createEncryptedVault(master,vault);
  await page.getByLabel('备份文件',{exact:true}).setInputFiles({name:'synthetic-complete.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(encryptedVault))});
  await page.getByLabel('备份主密码',{exact:true}).fill(master);
  return encryptedVault;
}
async function inspect(page: Page) {
  await page.getByRole('button',{name:'预览备份',exact:true}).click();
  await expect(page.locator('.kp-backup-preview')).toBeVisible();
}
function errorsOn(page: Page) {
  const errors: string[] = [];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
  return errors;
}

for (const entry of ['popup','vault','options']) test(`fresh ${entry} restores a complete encrypted backup without creating an empty vault`,async()=>{
  const page = await context.newPage(), errors = errorsOn(page);
  await page.setViewportSize(entry==='popup'?{width:400,height:600}:{width:1440,height:1000});
  await page.goto(base+`/${entry}.html`);
  await page.getByText('已有备份？直接恢复',{exact:true}).click();
  const incoming = await selectBackup(page);
  await page.getByLabel('备份主密码',{exact:true}).fill('wrong-password');
  await page.getByRole('button',{name:'预览备份',exact:true}).click();
  await expect(page.getByText(/无法读取备份/)).toBeVisible();
  expect(await stored()).toBeUndefined();
  await page.getByLabel('备份主密码',{exact:true}).fill(master);await inspect(page);
  await expect(page.locator('.kp-backup-preview')).toContainText('身份验证器（2FA） 1');
  await expect(page.locator('.kp-backup-preview')).not.toContainText(completeBackupFixture().totpAccounts![0].secret);
  const cancel=page.getByRole('button',{name:'取消',exact:true});
  await expect(cancel).toHaveCSS('font-size','14px');
  await expect(cancel).toHaveCSS('font-family',await page.locator('body').evaluate(element=>getComputedStyle(element).fontFamily));
  await cancel.hover();await expect(cancel).toHaveCSS('color','rgb(23, 55, 103)');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.locator('.kp-backup-preview').scrollIntoViewIfNeeded();
  await page.screenshot({path:resolve(evidence,`fresh-${entry}-preview.png`),fullPage:true});
  await page.getByRole('button',{name:'取消',exact:true}).click();
  expect(await stored()).toBeUndefined();
  await page.getByLabel('备份主密码',{exact:true}).fill(master);await inspect(page);
  await page.getByRole('button',{name:'恢复到本机',exact:true}).click();
  await expect.poll(async()=>Boolean(await stored())).toBe(true);
  const restored = (await unlockEncryptedVault(master,await stored())).vault;
  const original = (await unlockEncryptedVault(master,incoming)).vault;
  for (const {key} of backupCollections) expect(restored[key]).toEqual(original[key]);
  expect(restored.settings).toEqual(original.settings);
  await page.clock.install({time:new Date(59000)});await page.clock.pauseAt(new Date(59000));
  await page.goto(base+'/vault.html#authenticator');
  await expect(page.getByRole('article',{name:'Backup example synthetic@example.test'}).getByLabel('动态验证码')).toHaveText('9428 7082');
  expect(errors).toEqual([]);
});

test('complete backup download includes every collection and settings; configuration-only changes request a new backup',async()=>{
  const source=completeBackupFixture();await seed(source);
  const page=await context.newPage(), errors=errorsOn(page);await page.setViewportSize({width:1440,height:1100});
  await page.goto(base+'/vault.html');
  const opened=context.waitForEvent('page');await page.getByRole('button',{name:'完整备份',exact:true}).click();
  const options=await opened;const optionErrors=errorsOn(options);
  await expect(options).toHaveURL(base+'/options.html#account');
  const panel=options.getByRole('region',{name:'备份状态'});
  await expect(panel).toContainText('身份验证器（2FA） 1');
  await expect(panel).toContainText('不能代替完整备份');
  const download=options.waitForEvent('download');await panel.getByRole('button',{name:'导出完整加密备份'}).click();
  const file=await download;const raw=await readFile((await file.path())!,'utf8');
  const restored=(await unlockEncryptedVault(currentMaster,JSON.parse(raw))).vault;
  for(const {key} of backupCollections)expect(restored[key]).toEqual(source[key]);
  for(const [key,value] of Object.entries(source.settings))expect(restored.settings[key as keyof typeof restored.settings]).toEqual(value);
  expect(raw).not.toContain(source.totpAccounts![0].secret);
  await expect(panel.getByText('完整加密备份',{exact:true})).toBeVisible();
  await options.getByRole('button',{name:'自动填表',exact:true}).click();
  const clipboard=options.locator('.setting-row').filter({has:options.getByText('复制后清空剪贴板',{exact:true})}).getByRole('combobox');
  await clipboard.selectOption('60');
  await options.getByRole('button',{name:'账户&数据',exact:true}).click();
  await expect(panel).toContainText('设置或规则已变化');
  await expect(panel).toContainText('此后新增 0 条 · 修改 0 条 · 移除 0 条');
  await options.screenshot({path:resolve(evidence,'settings-backup-reminder.png'),fullPage:true});
  await panel.getByRole('button',{name:'导出完整加密备份'}).click();
  await expect(panel).not.toContainText('设置或规则已变化');
  expect(errors.concat(optionErrors)).toEqual([]);
});

test('merge preview exposes duplicates and conflicts and restores only checked configuration groups',async()=>{
  const current=completeBackupFixture();current.settings=createEmptyVault().settings;
  await seed(current);
  const incoming=completeBackupFixture();incoming.credentials=[{...current.credentials[0],password:'Different-password!42'}];
  incoming.totpAccounts=[{...current.totpAccounts![0],id:'renamed-totp',issuer:'Renamed issuer'}];
  const page=await context.newPage(), errors=errorsOn(page);await page.setViewportSize({width:1440,height:1100});
  await page.goto(base+'/options.html#account');await selectBackup(page,incoming);await inspect(page);
  const table=page.getByRole('table',{name:'合并预览'});
  await expect(table.getByRole('row').filter({hasText:'登录账号'})).toHaveText('登录账号101');
  await expect(table.getByRole('row').filter({hasText:'身份验证器'})).toHaveText('身份验证器（2FA）010');
  await page.getByRole('checkbox',{name:/黑名单与静默规则/}).check();
  await page.getByRole('checkbox',{name:/字段映射模板与导入进度/}).check();
  await expect(page.getByRole('checkbox',{name:/插件偏好与安全设置/})).not.toBeChecked();
  await page.locator('.kp-backup-preview').scrollIntoViewIfNeeded();
  await page.screenshot({path:resolve(evidence,'merge-preview.png'),fullPage:true});
  await page.getByRole('button',{name:'确认合并',exact:true}).click();
  await expect(page.getByText(/合并完成，保留当前主密码，已恢复勾选的配置/)).toBeVisible();
  const merged=(await unlockEncryptedVault(currentMaster,await stored())).vault;
  expect(merged.credentials).toHaveLength(2);expect(merged.totpAccounts).toEqual(current.totpAccounts);
  expect(merged.settings.autoFill).toBe(true);expect(merged.settings.siteRules).toEqual([]);
  expect(merged.settings.blacklist).toEqual(incoming.settings.blacklist);
  expect(merged.settings.fillImportMappingTemplates).toEqual(incoming.settings.fillImportMappingTemplates);
  expect(merged.settings.fillImportBatches).toEqual(incoming.settings.fillImportBatches);
  expect(await worker.evaluate(async()=>(await chrome.storage.local.get('keypilot.recoverySnapshots'))['keypilot.recoverySnapshots'].length)).toBe(1);
  expect(errors).toEqual([]);
});

test('replace restores all settings and password; stale merge previews must be refreshed',async()=>{
  await seed(createEmptyVault());const page=await context.newPage(), errors=errorsOn(page);
  await page.goto(base+'/options.html#account');await selectBackup(page);await inspect(page);
  const other=await context.newPage();await other.goto(base+'/options.html#account');
  const downloaded=other.waitForEvent('download');await other.getByRole('button',{name:'导出完整加密备份'}).click();await downloaded;
  await page.getByRole('button',{name:'确认合并',exact:true}).click();
  await expect(page.getByText(/密码库已在其他页面更新/)).toBeVisible();
  expect((await unlockEncryptedVault(currentMaster,await stored())).vault.credentials).toHaveLength(0);
  await page.getByLabel('备份主密码',{exact:true}).fill(master);await inspect(page);
  await page.getByRole('radio',{name:/替换：/}).check();
  page.once('dialog',dialog=>dialog.accept());
  await page.getByRole('button',{name:'确认替换',exact:true}).click();
  await expect(page.getByText(/恢复完成，数据和设置已恢复/)).toBeVisible();
  await expect(other.getByRole('heading',{name:'解锁设置',exact:true})).toBeVisible();
  const restored=(await unlockEncryptedVault(master,await stored())).vault;
  expect(restored.settings).toEqual(completeBackupFixture().settings);
  await expect(unlockEncryptedVault(currentMaster,await stored())).rejects.toThrow();
  expect(errors).toEqual([]);
});
