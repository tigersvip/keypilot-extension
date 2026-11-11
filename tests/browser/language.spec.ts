import { test, expect, chromium, type BrowserContext, type Worker, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir } from 'node:fs/promises';
import { createEmptyVault } from '../../src/shared/defaults';
import { createEncryptedVault, exportVaultKey, unlockEncryptedVault } from '../../src/shared/crypto';
import { generateSaveInboxKeyPair } from '../../src/shared/saveInbox';
import { buildCredential } from '../../src/shared/vault';
import type { LanguagePreference } from '../../src/shared/language';

// Browser plugin not available. Real extension, isolated Chromium and synthetic data.
const evidence = resolve(process.env.TEMP ?? tmpdir(), 'keypilot-languages-1.17');
const password = 'Synthetic-language!42';
let context: BrowserContext, worker: Worker, base: string;
test.beforeEach(async () => {
  const extension = resolve('dist');
  context = await chromium.launchPersistentContext('', { channel: 'chromium', headless: true, locale: 'en-US', args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension, '--mute-audio'] });
  worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  base = 'chrome-extension://' + new URL(worker.url()).host;
  await mkdir(evidence, { recursive: true });
  await seed();
});
test.afterEach(async () => { await context?.close(); });

async function seed(language: LanguagePreference = 'zh-CN', locked = false) {
  const vault = createEmptyVault();
  vault.settings.language = language;
  vault.settings.onboardingDismissed = true;
  vault.settings.backupReminderEnabled = false;
  vault.settings.openStartPageOnLogin = false;
  vault.settings.captchaAssistEnabled = true;
  vault.saveInboxKeyPair = await generateSaveInboxKeyPair();
  vault.credentials = [buildCredential({ title: '账号', url: 'https://language.example.test/login', username: '保存', password: 'Synthetic-only!42', notes: '设置 {0} <b>literal text</b>', folder: '主目录' })];
  const { encryptedVault, key } = await createEncryptedVault(password, vault);
  const cache = { vault, encryptedVault, exportedKey: await exportVaultKey(key), cachedAt: Date.now(), sessionId: 'language-fixture' };
  await worker.evaluate(async ({ cache, language, locked }) => navigator.locks.request('keypilot-vault-write', async () => {
    await chrome.storage.local.set({ 'keypilot.encryptedVault': cache.encryptedVault, 'keypilot.language': language });
    if (locked) await chrome.storage.session.clear();
    else await chrome.storage.session.set({ 'keypilot.unlockedSession': cache, 'keypilot.sessionState': { id: cache.sessionId, expiresAt: 0, highSecurity: false } });
  }), { cache, language, locked });
}
async function layout(page: Page) {
  await expect(page).toHaveTitle(/KeyPilot/);
  await expect(page.locator('body')).not.toBeEmpty();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}
async function storedVault() {
  const encrypted = await worker.evaluate(async () => (await chrome.storage.local.get('keypilot.encryptedVault'))['keypilot.encryptedVault']);
  return (await unlockEncryptedVault(password, encrypted)).vault;
}

test('language choice reloads settings, persists in the encrypted vault and never translates saved data', async () => {
  const page = await context.newPage(), errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base + '/options.html#general');
  await page.getByLabel('界面语言 / Language').selectOption('en-US');
  await page.getByRole('button', { name: '应用语言', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en-US');
  await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Interface language / Language' })).toHaveValue('en-US');
  await layout(page); await page.screenshot({ animations: 'disabled', path: resolve(evidence, 'settings-en.png') });
  const saved = await storedVault();
  expect(saved.settings.language).toBe('en-US');
  expect(saved.credentials[0]).toMatchObject({ title: '账号', username: '保存', notes: '设置 {0} <b>literal text</b>' });
  const popup = await context.newPage(); await popup.setViewportSize({ width: 400, height: 600 });
  await popup.goto(base + '/popup.html');
  await expect(popup.getByRole('textbox', { name: 'Search accounts, websites or notes' })).toBeVisible();
  await expect(popup.getByRole('button', { name: 'View 账号', exact: true })).toBeVisible();
  await layout(popup); await popup.screenshot({ animations: 'disabled', path: resolve(evidence, 'popup-en.png') });
  const vault = await context.newPage(); await vault.goto(base + '/vault.html#generator');
  await expect(vault.getByRole('heading', { name: 'Password generator', exact: true })).toBeVisible();
  await expect(vault.getByRole('button', { name: 'Standard strong', exact: true })).toBeVisible();
  await vault.getByRole('button', { name: 'High strength', exact: true }).click();
  await layout(vault); await vault.screenshot({ animations: 'disabled', path: resolve(evidence, 'generator-en.png') });
  await vault.getByRole('button', { name: /^Home\s*1$/ }).click();
  await expect(vault.getByRole('button', { name: /^Home\s*1$/ })).toHaveClass(/active/);
  await expect(vault.getByText('账号', { exact: true }).first()).toBeVisible();
  expect(errors).toEqual([]);
});

for (const [language, heading] of [['zh-TW', '一般'], ['ja', '一般'], ['es', 'General']] as const) {
  test(`${language} applies to settings and popup without horizontal overflow`, async () => {
    await seed(language);
    const page = await context.newPage(), errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({ width: 480, height: 850 }); await page.goto(base + '/options.html');
    await expect(page.locator('html')).toHaveAttribute('lang', language);
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
    await expect(page.locator('#kp-language')).toHaveValue(language);
    await layout(page); await page.screenshot({ animations: 'disabled', path: resolve(evidence, `settings-${language}-480.png`) });
    await page.setViewportSize({ width: 400, height: 600 }); await page.goto(base + '/popup.html');
    await expect(page.locator('html')).toHaveAttribute('lang', language);
    await expect(page.getByRole('textbox').first()).toBeVisible();
    await layout(page); await page.screenshot({ animations: 'disabled', path: resolve(evidence, `popup-${language}.png`) });
    for (const label of await page.locator('.kp-mode-chips > button span, .kp-lock-state span').all()) {
      expect(await label.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    }
    expect(errors).toEqual([]);
  });
}

test('language can be selected while locked and is saved to the vault on unlock', async () => {
  await seed('zh-CN', true);
  const page = await context.newPage(); await page.goto(base + '/options.html');
  await page.getByLabel('界面语言 / Language').selectOption('en-US');
  await page.getByRole('button', { name: '应用语言', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Unlock settings' })).toBeVisible();
  await page.getByLabel('Master password', { exact: true }).fill(password);
  await page.locator('button[type="submit"]').click();
  await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible();
  expect((await storedVault()).settings.language).toBe('en-US');
});

test('browser language and invalid stored preferences have deterministic fallbacks', async () => {
  await seed('auto');
  const page = await context.newPage(); await page.goto(base + '/options.html');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en-US');
  await expect(page.locator('#kp-language')).toHaveValue('auto');
  await worker.evaluate(() => chrome.storage.local.set({ 'keypilot.language': '../../missing' }));
  await page.reload(); await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await expect(page.getByRole('heading', { name: '一般', exact: true })).toBeVisible();
});

test('in-page captcha controls use English without translating the website or submitting it', async () => {
  await seed('en-US');
  await context.route('https://language.example.test/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><title>Language fixture</title><h1>密码 保存 设置</h1><form><label>Username<input name="username" autocomplete="username"></label><label>Password<input name="password" type="password"></label><label>Verification code<input id="captcha" name="captcha" autocomplete="off"></label><canvas id="captcha-image" width="120" height="40"></canvas><button>Login</button></form><script>window.submissions=0;document.querySelector("form").onsubmit=e=>{e.preventDefault();window.submissions++};const x=document.querySelector("canvas").getContext("2d");x.fillStyle="white";x.fillRect(0,0,120,40);x.fillStyle="black";x.font="28px Arial";x.fillText("4827",10,30)</script>' }));
  const page = await context.newPage(); await page.goto('https://language.example.test/login');
  await page.locator('#captcha').focus();
  await expect(page.getByRole('button', { name: 'Recognize captcha', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '密码 保存 设置' })).toBeVisible();
  expect(await page.locator('html').getAttribute('lang')).toBeNull();
  expect(await page.evaluate(() => (window as any).submissions)).toBe(0);
});
