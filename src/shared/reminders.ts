import type { Reminder, VaultPlain } from './types';

export const REMINDER_INDEX_KEY = 'keypilot.reminderIndex';
export const REMINDER_LIMIT = 1000;
export const reminderSounds = [
  { id: 'chime', label: '清脆双响' }, { id: 'bell', label: '柔和钟声' },
  { id: 'triple', label: '三连提示' }, { id: 'digital', label: '电子铃' }
] as const;
export type ReminderSound = typeof reminderSounds[number]['id'];
export interface ReminderSchedule {
  id: string; revision: string; times: number[]; acknowledged: number[]; completedAt?: number; updatedAt: number;
}
export interface ReminderIndex {
  vaultId: string; enabled: boolean; sound: ReminderSound; volume: number; items: ReminderSchedule[];
}
export function reminderTimes(item: Reminder): number[] {
  const early = new Date(item.dueAt);
  early.setDate(early.getDate() - item.leadDays);
  return item.leadDays > 0 ? [early.getTime(), item.dueAt] : [item.dueAt];
}
export function pendingReminders(index: ReminderIndex | null, now = Date.now()) {
  if (!index?.enabled) return [];
  return index.items.filter(item => !item.completedAt && item.times.some(time => time <= now && !item.acknowledged.includes(time)));
}
export function reminderIsPending(item: Reminder, now = Date.now()) {
  return !item.completedAt && reminderTimes(item).some(time => time <= now && !item.acknowledged.includes(time));
}
export function validateReminder(item: Reminder) {
  if (!item || typeof item.id !== 'string' || !item.id || typeof item.revision !== 'string' || !item.revision ||
      typeof item.title !== 'string' || !item.title.trim() || item.title.length > 200 ||
      !Number.isFinite(item.dueAt) || item.dueAt < 0 || item.dueAt > 253402214400000 ||
      !Number.isInteger(item.leadDays) || item.leadDays < 0 || item.leadDays > 365 ||
      !Number.isFinite(item.createdAt) || !Number.isFinite(item.updatedAt) ||
      (item.completedAt !== undefined && !Number.isFinite(item.completedAt)) ||
      (item.credentialId !== undefined && typeof item.credentialId !== 'string') ||
      !Array.isArray(item.acknowledged) || item.acknowledged.length > 2 || item.acknowledged.some(time => !Number.isFinite(time))) {
    throw new Error('提醒记录格式不正确，请检查标题和日期。');
  }
}
export function buildReminderIndex(vault: VaultPlain, vaultId: string, previous: ReminderIndex | null): ReminderIndex {
  const old = new Map(previous?.vaultId === vaultId ? previous.items.map(item => [item.id, item]) : []);
  return {
    vaultId, enabled: vault.settings.remindersEnabled === true,
    sound: reminderSounds.some(sound => sound.id === vault.settings.reminderSound) ? vault.settings.reminderSound! : 'chime',
    volume: Math.min(100, Math.max(10, Number(vault.settings.reminderVolume) || 60)),
    items: (vault.reminders ?? []).map(item => {
      const times = reminderTimes(item), prior = old.get(item.id);
      const match = prior?.revision === item.revision ? prior : undefined;
      return { id: item.id, revision: item.revision, times,
        acknowledged: [...new Set([...item.acknowledged, ...(match?.acknowledged ?? [])])].filter(time => times.includes(time)),
        completedAt: item.completedAt || match?.completedAt,
        updatedAt: Math.max(item.updatedAt, match?.updatedAt ?? 0) };
    })
  };
}
export function overlayReminderIndex(vault: VaultPlain, vaultId: string, index: ReminderIndex | null): VaultPlain {
  if (!index || index.vaultId !== vaultId) return vault;
  const entries = new Map(index.items.map(item => [item.id, item]));
  return { ...vault, reminders: (vault.reminders ?? []).map(item => {
    const state = entries.get(item.id);
    if (state?.revision !== item.revision) return item;
    return { ...item, acknowledged: [...new Set([...item.acknowledged, ...state.acknowledged])].filter(time => reminderTimes(item).includes(time)),
      ...((item.completedAt || state.completedAt) ? { completedAt: item.completedAt || state.completedAt } : {}), updatedAt: Math.max(item.updatedAt, state.updatedAt) };
  }) };
}
export function acknowledgeReminders(index: ReminderIndex, targets: { id: string; revision: string; times: number[] }[], now = Date.now()): ReminderIndex {
  if (!index.enabled) return index;
  return { ...index, items: index.items.map(item => {
    const target = targets.find(target => target.id === item.id && target.revision === item.revision);
    if (!target) return item;
    const times = target.times.filter(time => item.times.includes(time) && time <= now);
    return times.length ? { ...item, acknowledged: [...new Set([...item.acknowledged, ...times])], updatedAt: now } : item;
  }) };
}

export async function readReminderIndex(): Promise<ReminderIndex | null> {
  if (globalThis.chrome?.storage?.local) return (await chrome.storage.local.get(REMINDER_INDEX_KEY))[REMINDER_INDEX_KEY] ?? null;
  if (typeof localStorage !== 'undefined') return JSON.parse(localStorage.getItem(REMINDER_INDEX_KEY) ?? 'null');
  return null;
}
let stateQueue = Promise.resolve();
export async function updateReminderIndex(change: (previous: ReminderIndex | null) => ReminderIndex | null, commit?: (index: ReminderIndex | null) => Promise<void>) {
  const operation = async () => {
    const previous = await readReminderIndex(), next = change(previous);
    if (commit) { await commit(next); return next; }
    if (JSON.stringify(previous) === JSON.stringify(next)) return next;
    if (globalThis.chrome?.storage?.local) {
      if (next) await chrome.storage.local.set({ [REMINDER_INDEX_KEY]: next });
      else await chrome.storage.local.remove(REMINDER_INDEX_KEY);
    } else if (typeof localStorage !== 'undefined') {
      if (next) localStorage.setItem(REMINDER_INDEX_KEY, JSON.stringify(next)); else localStorage.removeItem(REMINDER_INDEX_KEY);
    }
    return next;
  };
  if (globalThis.navigator?.locks) return navigator.locks.request('keypilot-reminder-state', operation);
  const pending = stateQueue.then(operation, operation);
  stateQueue = pending.then(() => undefined, () => undefined);
  return pending;
}
export async function applyReminderReceipts(vault: VaultPlain, vaultId: string) {
  return overlayReminderIndex(vault, vaultId, await readReminderIndex());
}
export const syncReminderIndex = (vault: VaultPlain, vaultId: string, replace = false) => updateReminderIndex(previous => buildReminderIndex(vault, vaultId, replace ? null : previous));

export function localDateInput(time: number): string {
  const date = new Date(time), pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}${date.getSeconds() ? ':'+pad(date.getSeconds()) : ''}`;
}
export function dateFromInput(value: string): number | null {
  const time = new Date(value).getTime();
  const canonical = /T\d{2}:\d{2}:00$/.test(value) ? value.slice(0, -3) : value;
  return Number.isFinite(time) && localDateInput(time) === canonical ? time : null;
}
