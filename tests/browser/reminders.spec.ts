import { test, expect, chromium, type BrowserContext, type Worker, type Page } from '@playwright/test';
import { mockSyntheticIcons } from './syntheticIcons';
import { resolve, join } from 'node:path';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createEmptyVault } from '../../src/shared/defaults';
import { createEncryptedVault, exportVaultKey, unlockEncryptedVault } from '../../src/shared/crypto';
import { generateSaveInboxKeyPair } from '../../src/shared/saveInbox';
import { buildReminderIndex, REMINDER_INDEX_KEY } from '../../src/shared/reminders';
import type { Reminder, VaultPlain } from '../../src/shared/types';

let context: BrowserContext, worker: Worker, base: string, profile: string;
const master = 'Synthetic-reminders!42', evidence = resolve(process.env.TEMP ?? '..', 'keypilot-reminders-v1.7.0');
async function launch(path: string) {
  const extension = resolve('dist');
  context = await chromium.launchPersistentContext(path, { channel: 'chromium', headless: true, args: ['--disable-extensions-except='+extension, '--load-extension='+extension, '--mute-audio'], permissions: ['clipboard-read','clipboard-write'] });
  await mockSyntheticIcons(context);
  worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker'); base = 'chrome-extension://'+new URL(worker.url()).host;
}
test.beforeEach(async () => { profile = await mkdtemp(join(tmpdir(), 'keypilot-reminder-test-')); await launch(profile); await mkdir(evidence, { recursive: true }); });
test.afterEach(async () => { await context?.close(); });
function item(id: string, dueAt: number): Reminder { return { id, revision: id+'-revision', title: 'Synthetic '+id, dueAt, leadDays: 0, acknowledged: [], createdAt: Date.now(), updatedAt: Date.now() }; }
async function seed(vault: VaultPlain = createEmptyVault()) {
  vault.settings.openStartPageOnLogin = false;
  vault.saveInboxKeyPair = await generateSaveInboxKeyPair();
  const { encryptedVault, key } = await createEncryptedVault(master, vault);
  const cache = { vault, encryptedVault, exportedKey: await exportVaultKey(key), cachedAt: Date.now(), sessionId: 'reminder-test-session' };
  const index = buildReminderIndex(vault, encryptedVault.kdf.salt, null);
  await worker.evaluate(async ({ encryptedVault, cache, index }) => {
    await navigator.locks.request('keypilot-vault-write', async () => {
      await chrome.storage.local.set({ 'keypilot.encryptedVault': encryptedVault, 'keypilot.reminderIndex': index });
      await chrome.storage.session.set({ 'keypilot.unlockedSession': cache, 'keypilot.sessionState': { id: cache.sessionId, expiresAt: 0, highSecurity: false } });
    });
  }, { encryptedVault, cache, index });
}
async function stored() { return worker.evaluate(async () => (await chrome.storage.local.get('keypilot.encryptedVault'))['keypilot.encryptedVault']); }
async function decrypted() { return (await unlockEncryptedVault(master, await stored())).vault; }
async function open(path = '/vault.html#reminders') { const page = await context.newPage(); await page.goto(base+path); return page; }
async function alertPage() { await expect.poll(() => context.pages().some(page => page.url() === base+'/reminder.html'), {timeout:15000}).toBe(true); return context.pages().find(page => page.url() === base+'/reminder.html')!; }
async function status(page: Page) { return page.evaluate(() => chrome.runtime.sendMessage({ type: 'KEYPILOT_REMINDER_STATUS' })); }
function errorsOn(page: Page) { const errors: string[] = []; page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); }); return errors; }

test('optional reminder settings expose four sounds, save preferences and keep compact popup uncluttered', async () => {
  await seed(); const page = await open('/options.html#reminders'), errors = errorsOn(page);
  await expect(page.getByLabel('开启浏览器提醒')).not.toBeChecked();
  expect(await worker.evaluate(() => chrome.alarms.get('keypilot-reminders'))).toBeUndefined();
  const popup = await open('/popup.html'); await popup.setViewportSize({width:400,height:600});
  await popup.getByTitle('更多操作').click(); await expect(popup.getByRole('button', {name:'提醒中心',exact:true})).toHaveCount(0);
  await page.getByLabel('开启浏览器提醒').click(); await expect(page.getByLabel('提示音')).toBeEnabled();
  await expect(page.getByLabel('提示音').locator('option')).toHaveCount(4);
  await page.getByLabel('提示音').selectOption('bell'); await expect(page.getByLabel('提醒音量')).toBeEnabled();
  await page.getByLabel('提醒音量').selectOption('80'); await expect.poll(async () => (await decrypted()).settings.reminderVolume).toBe(80);
  await page.getByRole('button', {name:'试听',exact:true}).click(); await expect(page.getByRole('alert')).toHaveCount(0);
  await page.screenshot({path:resolve(evidence,'settings.png'),fullPage:true});
  await popup.reload(); await popup.getByTitle('更多操作').click(); await expect(popup.getByRole('button',{name:'提醒中心',exact:true})).toBeVisible();
  expect(await popup.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await popup.screenshot({path:resolve(evidence,'popup-menu.png'),fullPage:true}); expect(errors).toEqual([]);
});

test('paste preview creates two dated reminders and requires resolving ambiguous dates', async () => {
  const vault = createEmptyVault(); vault.settings.remindersEnabled = true; await seed(vault);
  const page = await open(), errors = errorsOn(page); await page.setViewportSize({width:1440,height:1000});
  await page.getByRole('button',{name:'粘贴文字识别'}).click();
  await page.getByLabel('粘贴待办或到期信息').fill('IP Address\t192.0.2.10\n帳號\tSynthetic-user\n密碼\tSynthetic-secret!\n到期时间 2099-11-17\n----------\nIP Address\t192.0.2.20\n到期时间 2099-12.1');
  await page.getByRole('button',{name:'识别并预览'}).click();
  await expect(page.getByLabel('事项 1 到期时间')).toHaveValue('2099-11-17T09:00'); await expect(page.getByLabel('事项 2 到期时间')).toHaveValue('2099-12-01T09:00');
  await page.screenshot({path:resolve(evidence,'parse-preview.png'),fullPage:true});
  await page.getByRole('button',{name:'保存选中 2 条'}).click(); await expect(page.locator('.reminder-row')).toHaveCount(2);
  const saved = await decrypted(); expect(saved.reminders).toHaveLength(2); expect(JSON.stringify(saved.reminders)).not.toContain('Synthetic-secret');
  expect(JSON.stringify(await worker.evaluate(async () => (await chrome.storage.local.get('keypilot.reminderIndex'))['keypilot.reminderIndex']))).not.toContain('192.0.2.10');
  await page.getByRole('button',{name:'粘贴文字识别'}).click(); await page.getByLabel('粘贴待办或到期信息').fill('会议 03/04/2099'); await page.getByRole('button',{name:'识别并预览'}).click();
  await expect(page.locator('.reminder-preview')).toContainText('月、日顺序不明确'); await page.getByRole('button',{name:'保存选中 1 条'}).click(); await expect(page.getByRole('alert')).toContainText('有效日期');
  await page.getByLabel('事项 1 到期时间').fill('2099-04-03T10:30'); await page.getByRole('button',{name:'保存选中 1 条'}).click(); await expect(page.locator('.reminder-row')).toHaveCount(3);
  await page.screenshot({path:resolve(evidence,'center.png'),fullPage:true}); expect(errors).toEqual([]);
});

test('locked due reminders sound repeatedly, survive closing the window and stop only on acknowledgement', async () => {
  const vault = createEmptyVault(); vault.settings.remindersEnabled = true; vault.reminders = [item('renewal-a',Date.now()-2000),item('renewal-b',Date.now()-1000)]; await seed(vault);
  const page = await open(), alert = await alertPage(), errors = errorsOn(alert);
  await expect(alert.getByRole('heading',{name:'2 条提醒待确认'})).toBeVisible();
  await expect.poll(async () => (await status(page)).audio?.running).toBe(true);
  const firstBeat = (await status(page)).audio.lastPlayedAt;
  await page.evaluate(() => chrome.runtime.sendMessage({type:'KEYPILOT_LOCK_VAULT'}));
  await expect(alert.getByText('密码库已锁定',{exact:false})).toBeVisible(); await expect(alert.locator('body')).not.toContainText('Synthetic renewal');
  await alert.setViewportSize({width:400,height:600}); expect(await alert.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await alert.screenshot({path:resolve(evidence,'locked-alert-compact.png'),fullPage:true}); await alert.close();
  await expect.poll(async () => (await status(page)).audio?.lastPlayedAt, {timeout:20000}).toBeGreaterThan(firstBeat);
  expect((await status(page)).items).toHaveLength(2);
  await page.evaluate(() => chrome.runtime.sendMessage({type:'KEYPILOT_REMINDER_REFRESH'})); const reopened = await alertPage();
  await reopened.getByRole('button',{name:'全部确认收到'}).click(); await expect(reopened.getByRole('heading',{name:'暂无待确认提醒'})).toBeVisible();
  await expect.poll(() => worker.evaluate(() => chrome.runtime.sendMessage({target:'keypilot-reminder-audio-status'}))).toMatchObject({running:false});
  expect(await worker.evaluate(() => chrome.action.getBadgeText({}))).toBe('');
  await page.evaluate(() => chrome.runtime.sendMessage({type:'KEYPILOT_REMINDER_REFRESH'})); expect((await status(page)).items).toHaveLength(0); expect(errors).toEqual([]);
});

test('real browser alarm fires future reminder and disabling cancels sound while preserving records', async () => {
  const vault = createEmptyVault(); vault.settings.remindersEnabled = true; vault.reminders = [item('future',Date.now()+6500)]; await seed(vault);
  const page = await open('/options.html#reminders');
  await expect.poll(() => worker.evaluate(async () => Boolean(await chrome.alarms.get('keypilot-reminders')))).toBe(true);
  const alert = await alertPage(); await expect(alert.getByText('Synthetic future',{exact:true})).toBeVisible();
  await expect.poll(async () => (await status(page)).audio?.running).toBe(true);
  await page.getByLabel('开启浏览器提醒').click(); await expect(alert.getByRole('heading',{name:'暂无待确认提醒'})).toBeVisible();
  await expect.poll(() => worker.evaluate(() => chrome.runtime.sendMessage({target:'keypilot-reminder-audio-status'}))).toMatchObject({running:false});
  expect((await decrypted()).reminders).toHaveLength(1); expect(await worker.evaluate(() => chrome.alarms.get('keypilot-reminders'))).toBeUndefined();
  await page.getByLabel('开启浏览器提醒').click(); await expect(alert.getByRole('heading',{name:'1 条提醒待确认'})).toBeVisible(); await alert.getByRole('button',{name:'全部确认收到'}).click();
});

test('restart catches missed reminders with no unlocked session, and acknowledgement survives a second restart', async () => {
  const vault = createEmptyVault(); vault.settings.remindersEnabled = true; vault.reminders = [item('restart',Date.now()+3000)]; await seed(vault);
  await context.close(); await new Promise(resolve => setTimeout(resolve,3100)); await launch(profile);
  const alert = await alertPage(); await expect(alert.getByRole('heading',{name:'1 条提醒待确认'})).toBeVisible();
  await expect(alert.locator('body')).not.toContainText('Synthetic restart'); await expect.poll(async () => (await status(alert)).audio?.running).toBe(true);
  await alert.getByRole('button',{name:'全部确认收到'}).click(); await expect(alert.getByRole('heading',{name:'暂无待确认提醒'})).toBeVisible();
  await context.close(); await launch(profile); const page = await open('/reminder.html'); await expect(page.getByRole('heading',{name:'暂无待确认提醒'})).toBeVisible();
  expect((await status(page)).items).toHaveLength(0);
});

test('reminder messages reject web content scripts; stale receipts cannot dismiss edited dates', async () => {
  const vault = createEmptyVault(); vault.settings.remindersEnabled = true; vault.reminders = [item('secure',Date.now()-1000)]; await seed(vault);
  await context.route('https://reminder.example.test/**', route => route.fulfill({contentType:'text/html',body:'<h1>Synthetic web page</h1>'}));
  const page = await context.newPage(); await page.goto('https://reminder.example.test/');
  const result = await worker.evaluate(async () => {
    const tab = (await chrome.tabs.query({url:'https://reminder.example.test/*'}))[0];
    return chrome.scripting.executeScript({target:{tabId:tab.id!},func:()=>chrome.runtime.sendMessage({type:'KEYPILOT_REMINDER_STATUS'})});
  }); expect(result[0].result.ok).toBe(false);
  const alert = await alertPage(); await alert.evaluate(() => chrome.runtime.sendMessage({type:'KEYPILOT_REMINDER_ACK',targets:[{id:'secure',revision:'stale',times:[0]}]}));
  expect((await status(alert)).items).toHaveLength(1); await alert.getByRole('button',{name:'全部确认收到'}).click();
});

test('shared offscreen audio preserves a clipboard clear deadline longer than the audio idle timeout', async () => {
  test.setTimeout(60000);
  const vault = createEmptyVault(); vault.settings.remindersEnabled = true; vault.reminders = [item('clipboard',Date.now()-1000)]; await seed(vault);
  const page = await open(), alert = await alertPage();
  await expect.poll(async () => (await status(page)).audio?.running).toBe(true);
  await page.evaluate(() => chrome.runtime.sendMessage({type:'KEYPILOT_COPY_TEXT',value:'Synthetic-clipboard-value',seconds:33}));
  await alert.getByRole('button',{name:'全部确认收到'}).click();
  await expect.poll(() => page.evaluate(()=>navigator.clipboard.readText()),{timeout:40000,intervals:[1000]}).toBe('');
});

test('pasted reminders suggest unique accounts, allow correction and never retain pasted passwords', async () => {
  const vault=createEmptyVault();vault.settings.remindersEnabled=true;
  vault.credentials=['10','20','30','30'].map((ip,index)=>({id:'server-'+index,title:'Server '+index,domain:'192.0.2.'+ip,url:'https://192.0.2.'+ip,username:'synthetic-'+index,password:'Synthetic-only!42',iconType:'default' as const,createdAt:1,updatedAt:1}));
  await seed(vault);const page=await open(),errors=errorsOn(page);
  await page.getByRole('button',{name:'粘贴文字识别'}).click();
  await page.getByLabel('粘贴待办或到期信息').fill('IP Address 192.0.2.10\n密码 Synthetic-pasted-secret!\n到期时间 2099-11-17\n----------\nIP Address 192.0.2.20\n到期时间 2099-12.1\n----------\nIP Address 192.0.2.30\n到期时间 2099-12.2');
  await page.getByRole('button',{name:'识别并预览'}).click();
  await expect(page.getByLabel('事项 1 关联账号')).toHaveValue('server-0');await expect(page.getByLabel('事项 2 关联账号')).toHaveValue('server-1');await expect(page.getByLabel('事项 3 关联账号')).toHaveValue('');
  await page.getByLabel('事项 3 关联账号').selectOption('server-3');
  await page.getByRole('button',{name:'保存选中 3 条'}).click();await expect(page.locator('.reminder-row')).toHaveCount(3);
  const saved=await decrypted();expect(saved.reminders?.map(item=>item.credentialId)).toEqual(['server-0','server-1','server-3']);expect(JSON.stringify(saved.reminders)).not.toContain('Synthetic-pasted-secret');
  const index=await worker.evaluate(async()=> (await chrome.storage.local.get('keypilot.reminderIndex'))['keypilot.reminderIndex']);expect(JSON.stringify(index)).not.toContain('192.0.2.');
  await page.getByLabel('搜索提醒').fill('Server 1');await expect(page.locator('.reminder-row')).toHaveCount(1);
  await page.getByLabel('搜索提醒').fill('');
  for(const width of [1280,390]){await page.setViewportSize({width,height:800});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:resolve(evidence,`linked-reminders-${width}.png`)});}
  await page.locator('.reminder-row').last().scrollIntoViewIfNeeded();await expect(page.locator('.reminder-row').last()).toBeInViewport();await page.screenshot({path:resolve(evidence,'linked-reminders-scrolled-390.png')});
  expect(errors).toEqual([]);
});

test('account reminders link both ways, scope the list and preselect new reminders without launching login',async()=>{
  const vault=createEmptyVault();vault.settings.remindersEnabled=true;
  vault.credentials=[{id:'linked-login',title:'Synthetic linked account',domain:'example.test',url:'https://example.test',username:'example',password:'Synthetic!42',iconType:'default',createdAt:1,updatedAt:1}];
  vault.reminders=[{...item('renewal',Date.UTC(2099,10,17)),credentialId:'linked-login'},{...item('finished',Date.UTC(2099,10,18)),credentialId:'linked-login',completedAt:Date.now()},item('other',Date.UTC(2099,10,19))];
  await seed(vault);const page=await open('/vault.html?loginFor=linked-login#logins'),errors=errorsOn(page);
  const section=page.getByRole('region',{name:'账号到期提醒'});await expect(section).toContainText('1 条未完成提醒');await expect(section).toContainText('Synthetic renewal');await expect(section).not.toContainText('Synthetic finished');
  await page.setViewportSize({width:390,height:800});await section.scrollIntoViewIfNeeded();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:resolve(evidence,'account-reminders-390.png')});
  await section.getByRole('link',{name:'查看 2 条提醒'}).click();await expect(page.getByLabel('按关联账号筛选提醒')).toHaveValue('linked-login');await expect(page.locator('.reminder-row')).toHaveCount(2);
  await page.getByRole('button',{name:'新建提醒',exact:true}).click();await expect(page.getByLabel('关联账号（可选）')).toHaveValue('linked-login');await expect(page.getByLabel('提醒标题')).toHaveValue('Synthetic linked account · 到期');await page.getByRole('button',{name:'取消',exact:true}).click();
  await page.getByRole('link',{name:'查看账号：Synthetic linked account · example.test'}).first().click();await expect(page.getByRole('region',{name:'账号到期提醒'})).toContainText('1 条未完成提醒');
  expect(context.pages().every(page=>!page.url().startsWith('https://example.test'))).toBe(true);expect(errors).toEqual([]);
});

test('orphaned reminders remain editable and can be unlinked',async()=>{
  const vault=createEmptyVault();vault.settings.remindersEnabled=true;vault.reminders=[{...item('orphan',Date.UTC(2099,10,17)),credentialId:'deleted-login'}];await seed(vault);
  const page=await open('/vault.html?reminderAccount=deleted-login#reminders');await expect(page.locator('.reminder-row')).toContainText('原关联账号已不可用');await expect(page.locator('.reminder-row a')).toHaveCount(0);
  await page.getByRole('button',{name:'编辑 Synthetic orphan'}).click();await expect(page.getByLabel('关联账号（可选）')).toHaveValue('deleted-login');await page.getByRole('button',{name:'保存提醒',exact:true}).click();await expect(page.getByRole('alert')).toContainText('关联账号已不可用');
  await page.getByLabel('关联账号（可选）').selectOption('');await page.getByRole('button',{name:'保存提醒',exact:true}).click();await expect.poll(async()=>(await decrypted()).reminders?.[0].credentialId).toBeUndefined();
  await page.getByLabel('按关联账号筛选提醒').selectOption('');await expect(page.locator('.reminder-row')).toHaveCount(1);
});

test('account shortcut supports editing, completion, encrypted backup and removal', async () => {
  const vault = createEmptyVault(); vault.settings.remindersEnabled = true;
  vault.credentials = [{id:'linked-login',title:'Synthetic linked account',domain:'example.test',url:'https://example.test',username:'example',password:'Synthetic!42',iconType:'default',createdAt:1,updatedAt:1}];
  await seed(vault); const page = await open('/vault.html'), errors = errorsOn(page);
  await page.getByText('Synthetic linked account',{exact:true}).first().dblclick(); await page.getByRole('button',{name:'添加到期提醒'}).click();
  await expect(page.getByLabel('提醒标题')).toHaveValue('Synthetic linked account · 到期'); await page.getByLabel('到期时间',{exact:true}).fill('2099-12-01T09:00');
  await page.getByLabel('提醒方式').selectOption('3'); await page.getByRole('button',{name:'保存提醒',exact:true}).click(); await expect(page.locator('.reminder-row')).toHaveCount(1);
  expect((await decrypted()).reminders![0].credentialId).toBe('linked-login');
  await page.getByRole('button',{name:'编辑 Synthetic linked account · 到期'}).click(); await page.getByLabel('提醒标题').fill('Synthetic updated expiry'); await page.getByRole('button',{name:'保存提醒',exact:true}).click();
  await expect(page.locator('.reminder-row')).toContainText('Synthetic updated expiry');
  await page.getByRole('button',{name:'完成 Synthetic updated expiry'}).click(); await expect(page.locator('.reminder-row')).toContainText('已完成');
  const options = await open('/options.html#account'); const downloading = options.waitForEvent('download');
  await options.getByRole('button',{name:'导出完整加密备份',exact:true}).click(); const downloaded = await downloading;
  const raw = await readFile((await downloaded.path())!,'utf8'), restored = (await unlockEncryptedVault(master,JSON.parse(raw))).vault;
  expect(restored.reminders).toEqual((await decrypted()).reminders); expect(restored.settings.remindersEnabled).toBe(true); expect(raw).not.toContain('Synthetic updated expiry');
  page.once('dialog',dialog=>dialog.accept()); await page.getByRole('button',{name:'删除 Synthetic updated expiry'}).click(); await expect(page.locator('.reminder-row')).toHaveCount(0);
  expect(await worker.evaluate(()=>chrome.alarms.get('keypilot-reminders'))).toBeUndefined(); expect(errors).toEqual([]);
});

test('all four preview sounds produce different bounded oscillator envelopes and stop their contexts', async () => {
  await seed(); const page = await context.newPage();
  await page.addInitScript(() => {
    const NativeContext = window.AudioContext;
    (window as any).soundEvidence = [];
    window.AudioContext = class extends NativeContext {
      constructor(options?: AudioContextOptions) {
        super(options); const record = {frequencies:[] as number[],peaks:[] as number[],closed:false}; (window as any).soundEvidence.push(record);
        const oscillator = this.createOscillator.bind(this), gain = this.createGain.bind(this), close = this.close.bind(this);
        this.createOscillator = () => { const node=oscillator(),start=node.start.bind(node);node.start=(time?:number)=>{record.frequencies.push(node.frequency.value);start(time);};return node; };
        this.createGain = () => { const node=gain(),ramp=node.gain.linearRampToValueAtTime.bind(node.gain);node.gain.linearRampToValueAtTime=(value:number,time:number)=>{record.peaks.push(value);return ramp(value,time);};return node; };
        this.close=async()=>{await close();record.closed=true;};
      }
    };
  });
  await page.goto(base+'/options.html#reminders');
  for (const sound of ['chime','bell','triple','digital']) {
    await page.getByLabel('提示音').selectOption(sound); await expect(page.getByLabel('提示音')).toBeEnabled();
    await expect.poll(async()=>(await decrypted()).settings.reminderSound).toBe(sound);
    await page.getByRole('button',{name:'试听',exact:true}).click();
  }
  await expect.poll(()=>page.evaluate(()=>(window as any).soundEvidence.filter((entry:any)=>entry.closed).length)).toBe(4);
  const sounds=await page.evaluate(()=>(window as any).soundEvidence as {frequencies:number[];peaks:number[]}[]);
  expect(new Set(sounds.map(sound=>JSON.stringify(sound.frequencies))).size).toBe(4);
  for(const sound of sounds){expect(sound.frequencies.length).toBeGreaterThan(1);expect(sound.peaks.every(peak=>peak>0 && peak<=.22)).toBe(true);}
});
