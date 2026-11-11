import { acknowledgeReminders, pendingReminders, readReminderIndex, REMINDER_INDEX_KEY, updateReminderIndex } from '../shared/reminders';
import { getEncryptedVault, VAULT_STORAGE_KEY, withVaultLock } from '../shared/storage';
import { restoreCachedVaultSession } from '../shared/vault';
import { ensureOffscreenDocument } from './offscreen';

const ALARM = 'keypilot-reminders';
let queue = Promise.resolve();
let lastAlertSignature = '';
let savePromptPending = false;
export function setSavePromptBadge(active: boolean) {
  savePromptPending = active;
  void validIndex().then(index => updateBadge(pendingReminders(index).length)).catch(() => undefined);
}
async function updateBadge(count: number) {
  await chrome.action.setBadgeText({ text: count ? String(count) : savePromptPending ? '!' : '' });
  await chrome.action.setBadgeBackgroundColor({ color: count ? '#c43d24' : '#2563eb' });
}
async function validIndex() {
  const index = await readReminderIndex(), encrypted = await getEncryptedVault();
  return encrypted && index?.vaultId === encrypted.kdf.salt ? index : null;
}
async function audioState() {
  const index = await validIndex(), pending = pendingReminders(index);
  return { ok: true, active: pending.length > 0, sound: index?.sound ?? 'chime', volume: index?.volume ?? 60 };
}
async function ensureAlertWindow(focus: boolean) {
  const url = chrome.runtime.getURL('reminder.html');
  const tabs = await chrome.tabs.query({ url });
  if (!tabs.length) await chrome.windows.create({ url, type: 'popup', width: 480, height: 540, focused: true });
  else if (focus) await chrome.windows.update(tabs[0].windowId, { focused: true, state: 'normal' });
}
async function reconcile() {
  const index = await validIndex(), pending = pendingReminders(index);
  await updateBadge(pending.length);
  const next = index?.enabled ? index.items.flatMap(item => item.completedAt ? [] : item.times.filter(time => !item.acknowledged.includes(time))) : [];
  if (next?.length) {
    // A periodic alarm also catches device wake, clock changes and a dismissed alert window.
    await chrome.alarms.create(ALARM, { when: pending.length ? Date.now() + 60000 : Math.max(Date.now() + 1000, Math.min(...next)), periodInMinutes: 1 });
  } else await chrome.alarms.clear(ALARM);
  if (pending.length) {
    await ensureOffscreenDocument();
    await chrome.runtime.sendMessage({ target: 'keypilot-reminder-audio', active: true });
    const signature = JSON.stringify(pending.map(item => [item.id, item.revision, item.times.filter(time => time <= Date.now() && !item.acknowledged.includes(time))]));
    await ensureAlertWindow(signature !== lastAlertSignature);
    lastAlertSignature = signature;
  } else {
    lastAlertSignature = '';
    await chrome.runtime.sendMessage({ target: 'keypilot-reminder-audio', active: false }).catch(() => undefined);
  }
}
export function reconcileReminders() {
  queue = queue.then(reconcile, reconcile).catch(() => {
    // An alarm is the retry path if the browser is temporarily unable to open a window/document.
    void chrome.alarms.create(ALARM, { delayInMinutes: 1, periodInMinutes: 1 });
  });
  return queue;
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!['KEYPILOT_REMINDER_STATUS', 'KEYPILOT_REMINDER_ACK', 'KEYPILOT_REMINDER_AUDIO_STATE', 'KEYPILOT_REMINDER_REFRESH'].includes(message?.type)) return;
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(''))) { respond({ ok: false, error: '无权访问提醒。' }); return; }
  const operation = async () => {
    if (message.type === 'KEYPILOT_REMINDER_AUDIO_STATE') return audioState();
    if (message.type === 'KEYPILOT_REMINDER_REFRESH') { await reconcileReminders(); return { ok: true }; }
    if (message.type === 'KEYPILOT_REMINDER_ACK') {
      if (!Array.isArray(message.targets) || message.targets.length > 1000 || message.targets.some((target: { id?: unknown; revision?: unknown; times?: unknown }) =>
        !target || typeof target.id !== 'string' || typeof target.revision !== 'string' || !Array.isArray(target.times) || target.times.length > 2 || target.times.some(time => !Number.isFinite(time)))) {
        throw new Error('提醒确认参数无效。');
      }
      await withVaultLock(async () => {
        const index = await validIndex();
        await updateReminderIndex(current => current && index?.vaultId === current.vaultId ? acknowledgeReminders(current, message.targets) : current);
      });
      await reconcileReminders();
      return { ok: true };
    }
    const index = await validIndex(), pending = pendingReminders(index), session = await restoreCachedVaultSession();
    const audio = pending.length ? await chrome.runtime.sendMessage({ target: 'keypilot-reminder-audio-status' }).catch(() => null) : null;
    return { ok: true, enabled: index?.enabled ?? false, locked: !session,
      audio,
      items: pending.map(item => ({ id: item.id, revision: item.revision,
        times: item.times.filter(time => time <= Date.now() && !item.acknowledged.includes(time)),
        title: session?.vault.reminders?.find(reminder => reminder.id === item.id)?.title ?? '待确认提醒' })) };
  };
  void operation().then(respond).catch(error => respond({ ok: false, error: error instanceof Error ? error.message : '提醒操作失败。' }));
  return true;
});
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === ALARM) void reconcileReminders(); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes[REMINDER_INDEX_KEY] || changes[VAULT_STORAGE_KEY])) void reconcileReminders();
});
chrome.runtime.onStartup.addListener(() => { void reconcileReminders(); });
chrome.runtime.onInstalled.addListener(() => { void reconcileReminders(); });
void reconcileReminders();
