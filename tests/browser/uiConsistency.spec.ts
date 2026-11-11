import { test, expect, chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { createEmptyVault } from '../../src/shared/defaults';
import { createEncryptedVault, exportVaultKey } from '../../src/shared/crypto';
import { generateSaveInboxKeyPair } from '../../src/shared/saveInbox';
import { buildCredential } from '../../src/shared/vault';

const artifacts = resolve(process.env.TEMP!, 'keypilot-v1.12.0');
const origin = 'https://ui.example.test';
let context: BrowserContext, worker: Worker, base: string, credentialId: string;
test.beforeEach(async () => {
  await mkdir(artifacts, { recursive: true });
  const extension = resolve('dist');
  context = await chromium.launchPersistentContext('', { channel: 'chromium', headless: true, args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension, '--mute-audio'] });
  worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  base = 'chrome-extension://' + new URL(worker.url()).host;
  const vault = createEmptyVault();
  vault.saveInboxKeyPair = await generateSaveInboxKeyPair();
  vault.settings.onboardingDismissed = true;
  vault.settings.backupReminderEnabled = false;
  vault.settings.autoTotpOrigins = [origin];
  vault.credentials = Array.from({ length: 24 }, (_, i) => buildCredential({ title: i ? `示例账号 ${i + 1}` : 'Design account', url: origin + '/login', username: `demo${i}@example.test`, password: 'Synthetic-only!42', notes: '用于界面测试的虚构账号。\n'.repeat(30) }));
  credentialId = vault.credentials[0].id;
  vault.totpAccounts = Array.from({ length: 7 }, (_, i) => ({ id: `totp-${i}`, issuer: ['GitHub', 'Google', 'Cloudflare', 'Microsoft', 'Amazon', 'Example', 'Service with a very long name'][i], account: `demo${i}@example.test`, credentialId: i === 0 ? credentialId : undefined, secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', algorithm: 'SHA1' as const, digits: 6 as const, period: 30, createdAt: 1, updatedAt: 1 }));
  const { encryptedVault, key } = await createEncryptedVault('Test-master!42', vault);
  const cache = { vault, encryptedVault, exportedKey: await exportVaultKey(key), cachedAt: Date.now(), sessionId: 'ui-fixture' };
  await worker.evaluate(async cache => navigator.locks.request('keypilot-vault-write', async () => {
    await chrome.storage.local.set({ 'keypilot.encryptedVault': cache.encryptedVault });
    await chrome.storage.session.set({ 'keypilot.unlockedSession': cache, 'keypilot.sessionState': { id: cache.sessionId, expiresAt: 0, highSecurity: false } });
  }), cache);
});
test.afterEach(async () => { await context?.close(); });

async function checkPage(page: Page) {
  await expect(page).toHaveTitle(/KeyPilot/);
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

test('popup keeps home density and uses consistent navigation with a compact authenticator', async () => {
  const page = await context.newPage();
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 400, height: 600 }); await page.goto(base + '/popup.html');
  const search = page.getByRole('textbox', { name: '搜索账号、网站或备注' });
  await search.fill('Design');
  await page.screenshot({ path: resolve(artifacts, 'popup-home.png') });
  await page.locator('.kp-tools-menu summary').click(); await page.getByRole('button', { name: '身份验证器', exact: true }).click();
  await expect(page.getByRole('heading', { name: '身份验证器', exact: true })).toHaveCount(1);
  await expect(page.locator('.kp-totp-row')).toHaveCount(7);
  await expect(page.locator('.kp-totp-row').nth(2)).toBeInViewport();
  await expect(page.locator('.kp-totp-row').first().getByRole('button', { name: '填写验证码' })).toBeInViewport();
  await page.screenshot({ path: resolve(artifacts, 'popup-authenticator.png') });
  await page.getByRole('textbox', { name: '搜索动态验证码' }).fill('Cloudflare');
  await expect(page.locator('.kp-totp-row')).toHaveCount(1);
  await page.getByRole('button', { name: '返回账号列表', exact: true }).click();
  await expect(search).toHaveValue('Design');
  await page.locator('.kp-tools-menu summary').click(); await page.getByRole('button', { name: '身份验证器', exact: true }).click();
  const menu = page.locator('.kp-secondary-menu');
  await menu.locator('summary').click(); await menu.getByRole('button', { name: '密码生成器', exact: true }).click();
  await expect(page.getByRole('heading', { name: '密码生成器', exact: true })).toHaveCount(1);
  await page.screenshot({ path: resolve(artifacts, 'popup-generator.png') });
  await menu.locator('summary').focus(); await page.keyboard.press('Enter'); await page.keyboard.press('Escape');
  await expect(menu).not.toHaveAttribute('open'); await expect(menu.locator('summary')).toBeFocused();
  await menu.locator('summary').click(); await menu.getByRole('button', { name: '导入账号', exact: true }).click();
  await expect(page.getByRole('heading', { name: '导入账号', exact: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: '返回账号列表', exact: true })).toBeInViewport();
  await page.getByRole('button', { name: '返回账号列表', exact: true }).click();
  await page.getByRole('button', { name: '查看 Design account', exact: true }).click();
  await page.locator('.compact-content').evaluate(el => { el.scrollTop = el.scrollHeight; });
  await expect(page.locator('.page-header').getByRole('button', { name: '返回', exact: true })).toBeInViewport();
  await page.locator('.page-header').getByRole('button', { name: '返回', exact: true }).click();
  await expect(search).toHaveValue('Design');
  await checkPage(page); expect(errors).toEqual([]);
});

test('detail keeps return and edit reachable while scrolling at wide and narrow widths', async () => {
  const page = await context.newPage();
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(base + '/vault.html?loginFor=' + credentialId);
  const pane = page.locator('.credential-detail-pane');
  await expect(pane).toBeVisible();
  await pane.getByText('此网站设置', { exact: true }).click();
  for (const width of [1600, 1280, 800, 480]) {
    await page.setViewportSize({ width, height: 900 });
    await pane.getByText('此网站设置', { exact: true }).scrollIntoViewIfNeeded();
    await expect(pane.getByRole('button', { name: '返回列表', exact: true })).toBeInViewport();
    await expect(pane.locator('.detail-toolbar').getByRole('button', { name: '编辑', exact: true })).toBeInViewport();
    expect(await pane.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    const bounds = (await pane.boundingBox())!;
    if (width <= 600) expect(bounds.x).toBe(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    if (width < 1400) await expect(page.locator('.vault-workspace')).toBeHidden();
    else await expect(page.locator('.vault-workspace')).toBeVisible();
    await checkPage(page);
    const switchBox = (await pane.getByRole('switch', { name: '允许网页填写账号密码', exact: true }).boundingBox())!;
    expect(switchBox.x + switchBox.width).toBeLessThanOrEqual(width);
    await expect(pane.getByRole('switch', { name: '允许网页填写账号密码', exact: true })).toBeVisible();
    await page.screenshot({ path: resolve(artifacts, `detail-${width}.png`) });
  }
  await pane.locator('.detail-toolbar').getByRole('button', { name: '编辑', exact: true }).click();
  const editor = page.locator('.edit-pane'); await expect(editor).toBeVisible();
  await editor.evaluate(el => { el.scrollTop = el.scrollHeight; });
  await expect(editor.getByRole('button', { name: '保存', exact: true })).toBeInViewport();
  await expect(editor.getByRole('button', { name: '关闭', exact: true })).toBeInViewport();
  await editor.getByRole('button', { name: '取消', exact: true }).click();
  await pane.getByRole('button', { name: '返回列表', exact: true }).click();
  await expect(pane).toHaveCount(0); await expect(page.locator('.vault-workspace')).toBeVisible();
  expect(errors).toEqual([]);
});

test('site switches show blocked settings truthfully and link to the correct global section', async () => {
  const page = await context.newPage(); await page.goto(base + '/vault.html?loginFor=' + credentialId);
  const panel = page.locator('.kp-site-settings'); await panel.getByText('此网站设置', { exact: true }).click();
  for (const label of ['一键登录时自动点击登录', '图片验证码识别', '一键登录后自动填写动态验证码']) {
    const toggle = panel.getByRole('switch', { name: label, exact: true });
    await expect(toggle).toBeChecked();
    await expect(toggle.locator('..')).toContainText('总开关已关闭');
  }
  const opened = context.waitForEvent('page'); await panel.getByRole('link', { name: /打开自动填表设置/ }).click();
  const options = await opened; await expect(options).toHaveURL(/options\.html#autofill/);
  await expect(options.getByRole('heading', { name: '自动填表', exact: true })).toBeVisible();
  await page.bringToFront(); await panel.getByRole('switch', { name: '允许网页填写账号密码', exact: true }).click();
  await expect(panel.getByRole('status')).toContainText('已保存');
  await expect(panel.getByRole('switch', { name: '一键登录后自动填写动态验证码' }).locator('..')).toContainText('需先允许网页填写');
  await panel.getByText('说明与重置', { exact: true }).click(); await panel.getByRole('button', { name: '恢复此网站默认设置' }).click();
  await expect(panel.getByRole('switch', { name: '允许网页填写账号密码' })).toBeChecked();
  await expect(panel.getByRole('switch', { name: '一键登录后自动填写动态验证码' })).not.toBeChecked();
  expect(await worker.evaluate(async () => ((await chrome.storage.session.get('keypilot.unlockedSession'))['keypilot.unlockedSession']).vault.settings.autoSubmit)).toBe(false);
});


test('readable rows fit the viewport and keyboard navigation opens the selected detail', async () => {
  const page = await context.newPage(); const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 }); await page.goto(base + '/vault.html#logins');
  const search = page.getByRole('textbox', { name: '在 KeyPilot 中搜索' });
  const rows = page.locator('.vault-row'); await expect(rows).toHaveCount(24);
  for (const width of [1440, 1024, 800, 480]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await rows.first().evaluate(el => el.getBoundingClientRect().height)).toBeLessThanOrEqual(49);
    expect(await rows.first().locator('strong').evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(15);
    expect(await page.locator('.vault-items').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await checkPage(page);
    await page.screenshot({ path: resolve(artifacts, 'vault-list-' + width + '.png') });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('button', { name: '紧凑视图' }).click();
  expect(await rows.first().evaluate(el => el.getBoundingClientRect().height)).toBeLessThanOrEqual(49);
  await page.locator('.vault-items').evaluate(async el => { el.scrollTop = 0; await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))); });
  await expect(page.locator('.vault-tabs').getByRole('button', { name: '常用', exact: true })).toBeVisible();
  await page.screenshot({ path: resolve(artifacts, 'vault-compact.png'), animations: 'disabled' });
  await page.getByRole('button', { name: '网格视图' }).click(); await expect(rows.first().locator('.item-name')).toBeVisible();
  await page.getByRole('button', { name: '表格视图' }).click();
  await search.fill('Design'); await search.press('ArrowDown');
  await expect(rows.first().locator('.item-name')).toBeFocused();
  await page.keyboard.press('Enter');
  const detail = page.locator('.credential-detail-pane'); await expect(detail).toBeVisible();
  await expect(detail.getByRole('button', { name: '复制密码', exact: true })).toBeInViewport();
  await expect(detail.locator('.detail-binding')).not.toHaveAttribute('open');
  await detail.getByRole('button', { name: '复制登录名' }).click();
  await expect(detail.locator('.kp-copy-feedback')).toContainText(['已复制', '']);
  await expect(page.locator('.vault-notice')).toHaveCount(0);
  await detail.evaluate(el => { el.scrollTop = 0; });
  await page.screenshot({ path: resolve(artifacts, 'detail-overview.png') });
  await detail.locator('.detail-binding summary').click();
  await expect(detail.getByRole('button', { name: '测试绑定' })).toBeVisible();
  await page.keyboard.press('Escape'); await expect(detail).toHaveCount(0);
  await expect(rows.first().locator('.item-name')).toBeFocused();
  await page.keyboard.press('Escape'); await expect(search).toBeFocused();
  await page.keyboard.press('Escape'); await expect(search).toHaveValue('');
  const first = rows.first(); await first.getByRole('button', { name: /^更多操作 / }).focus(); await page.keyboard.press('Enter');
  const menu = page.getByRole('menu', { name: /操作菜单/ }); await expect(menu).toBeVisible();
  const menuBounds = (await menu.boundingBox())!; expect(menuBounds.y + menuBounds.height).toBeLessThanOrEqual(900);
  await expect(menu.getByRole('menuitem', { name: '登录', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowDown'); await expect(menu.getByRole('menuitem', { name: '浏览并填写' })).toBeFocused();
  await page.keyboard.press('Escape'); await expect(menu).toHaveCount(0); await expect(first.getByRole('button', { name: /^更多操作 / })).toBeFocused();
  await page.locator('.vault-items').hover(); await page.mouse.wheel(0, 1200); await expect(rows.last()).toBeInViewport();
  expect(errors).toEqual([]);
});

test('popup arrows select accounts and Escape returns to search without logging in', async () => {
  const page = await context.newPage(); await page.setViewportSize({ width: 400, height: 600 }); await page.goto(base + '/popup.html');
  const search = page.getByRole('textbox', { name: '搜索账号、网站或备注' });
  await search.fill('示例');
  await search.dispatchEvent('keydown', { key: 'ArrowDown', isComposing: true }); await expect(search).toBeFocused();
  await search.press('ArrowDown');
  const accounts = page.locator('.kp-account-main'); await expect(accounts.first()).toBeFocused();
  await page.keyboard.press('ArrowDown'); await expect(accounts.nth(1)).toBeFocused();
  await page.keyboard.press('ArrowUp'); await expect(accounts.first()).toBeFocused();
  await page.keyboard.press('Escape'); await expect(search).toBeFocused(); await expect(search).toHaveValue('示例');
  await page.keyboard.press('Escape'); await expect(search).toHaveValue('');
  expect(context.pages()).toHaveLength(2);
});

test('six settings groups preserve all sections and direct links at desktop and narrow widths', async () => {
  const page = await context.newPage(); const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(base + '/options.html#autosave');
  await expect(page.locator('.settings-sidebar nav button')).toHaveCount(6);
  await expect(page.getByRole('heading', { name: '自动保存', exact: true })).toBeVisible();
  await expect(page.locator('.settings-sidebar nav button.active')).toHaveText('自动填表');
  await page.getByRole('button', { name: '域名', exact: true }).click(); await expect(page).toHaveURL(/#domains$/);
  await page.getByRole('button', { name: '一般', exact: true }).click();
  await page.getByRole('button', { name: '提醒', exact: true }).click(); await expect(page).toHaveURL(/#reminders$/);
  await page.getByRole('button', { name: '快捷键', exact: true }).click(); await expect(page.getByRole('heading', { name: '快捷键', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '登录与安全', exact: true }).click(); await page.getByRole('button', { name: '设备&活动', exact: true }).click();
  await expect(page.getByRole('heading', { name: '设备&活动', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '账户&数据', exact: true }).click(); await expect(page.getByRole('heading', { name: '账户&数据', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '关于与工具', exact: true }).click(); await expect(page.getByRole('heading', { name: '关于 KeyPilot', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '快捷入口', exact: true }).click(); await expect(page.getByRole('button', { name: '打开主页' })).toBeVisible();
  for (const width of [1280, 480]) {
    await page.setViewportSize({ width, height: 900 }); await checkPage(page);
    await page.screenshot({ path: resolve(artifacts, 'settings-' + width + '.png') });
  }
  await expect(page.getByRole('link', { name: '返回密码库' })).toBeVisible(); expect(errors).toEqual([]);
});


test('cancelled protected copies never report success in either detail surface', async () => {
  await worker.evaluate(async () => navigator.locks.request('keypilot-vault-write', async () => {
    const cache = (await chrome.storage.session.get('keypilot.unlockedSession'))['keypilot.unlockedSession'];
    cache.vault.settings.requireMasterPasswordForReveal = true;
    await chrome.storage.session.set({ 'keypilot.unlockedSession': cache });
  }));
  for (const path of ['/vault.html#logins', '/popup.html']) {
    const page = await context.newPage(); await page.goto(base + path);
    await page.getByRole('button', { name: '查看 Design account', exact: true }).click();
    const scope = page.locator(path.includes('vault') ? '.credential-detail-pane' : '.page-view');
    const copy = scope.getByRole('button', { name: '复制密码', exact: true }); await copy.click();
    const verification = page.getByRole('dialog', { name: '验证主密码' }); await expect(verification).toBeVisible();
    await verification.getByRole('button', { name: '取消', exact: true }).click();
    await expect(verification).not.toBeVisible(); await expect(copy).toBeEnabled();
    await expect(scope.locator('.kp-copy-feedback').filter({ hasText: '已复制' })).toHaveCount(0);
    await expect(scope.locator('.kp-totp-code output')).toHaveText('••• •••'); await page.close();
  }
});
