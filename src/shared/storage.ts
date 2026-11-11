import type { VaultEncrypted, VaultPlain } from './types';
import { buildReminderIndex, REMINDER_INDEX_KEY, updateReminderIndex } from './reminders';
export const VAULT_STORAGE_KEY = 'keypilot.encryptedVault';
export const UNLOCKED_SESSION_KEY = 'keypilot.unlockedSession';
export const SESSION_STATE_KEY = 'keypilot.sessionState';
export const SNAPSHOT_STORAGE_KEY = 'keypilot.recoverySnapshots';
export interface SessionState { id: string; expiresAt: number; highSecurity: boolean }
export interface UnlockedVaultCache {
  vault: VaultPlain; encryptedVault: VaultEncrypted; exportedKey: string; cachedAt: number; sessionId: string;
}
let secureMemoryCache: UnlockedVaultCache | null = null;
let fallbackQueue = Promise.resolve();
export async function withVaultLock<T>(operation: () => Promise<T>): Promise<T> {
  if (globalThis.navigator?.locks) return await navigator.locks.request('keypilot-vault-write', operation);
  const result = fallbackQueue.then(operation, operation);
  fallbackQueue = result.then(() => undefined, () => undefined);
  return result;
}
async function read<T>(key: string, session = false): Promise<T | null> {
  const area = session ? globalThis.chrome?.storage?.session : globalThis.chrome?.storage?.local;
  if (area) return (await area.get(key))[key] as T ?? null;
  const value = (session ? window.sessionStorage : window.localStorage).getItem(key);
  return value ? JSON.parse(value) as T : null;
}
async function write(key: string, value: unknown, session = false): Promise<void> {
  const area = session ? globalThis.chrome?.storage?.session : globalThis.chrome?.storage?.local;
  if (area) { await area.set({ [key]: value }); return; }
  (session ? window.sessionStorage : window.localStorage).setItem(key, JSON.stringify(value));
}
async function remove(key: string, session = false): Promise<void> {
  const area = session ? globalThis.chrome?.storage?.session : globalThis.chrome?.storage?.local;
  if (area) { await area.remove(key); return; }
  (session ? window.sessionStorage : window.localStorage).removeItem(key);
}
export const getEncryptedVault = () => read<VaultEncrypted>(VAULT_STORAGE_KEY);
export async function saveEncryptedVault(vault: VaultEncrypted, plain?: VaultPlain, replaceReminders = false): Promise<void> {
  if (!plain) return write(VAULT_STORAGE_KEY, vault);
  // Publish ciphertext and its content-free schedule together, under the receipt lock.
  await updateReminderIndex(previous => buildReminderIndex(plain, vault.kdf.salt, replaceReminders ? null : previous), async index => {
    if (globalThis.chrome?.storage?.local) await chrome.storage.local.set({ [VAULT_STORAGE_KEY]: vault, [REMINDER_INDEX_KEY]: index });
    else { await write(VAULT_STORAGE_KEY, vault); await write(REMINDER_INDEX_KEY, index); }
  });
}
export const getSessionState = () => read<SessionState>(SESSION_STATE_KEY, true);
async function secureCache(action: 'get' | 'set' | 'clear', cache?: UnlockedVaultCache): Promise<UnlockedVaultCache | null> {
  if (typeof document === 'undefined' || !globalThis.chrome?.runtime?.id) {
    if (action === 'set') secureMemoryCache = cache ?? null;
    if (action === 'clear') secureMemoryCache = null;
    return secureMemoryCache;
  }
  const response = await chrome.runtime.sendMessage({ type: 'KEYPILOT_SECURE_CACHE', action, cache });
  if (!response?.ok) throw new Error('VAULT_LOCKED');
  return response.cache ?? null;
}
// The worker restricts this endpoint to its own extension pages.
export function handleSecureCacheMessage(message: { action: string; cache?: UnlockedVaultCache }) {
  if (message.action === 'set') secureMemoryCache = message.cache ?? null;
  if (message.action === 'clear') secureMemoryCache = null;
  return { ok: true, cache: message.action === 'get' ? secureMemoryCache : null, sessionId: secureMemoryCache?.sessionId };
}
export async function isVaultSessionActive(sessionId: string): Promise<boolean> {
  const state = await getSessionState();
  if (!state || state.id !== sessionId || (state.expiresAt && Date.now() >= state.expiresAt)) return false;
  if (!state.highSecurity) return true;
  if (typeof document === 'undefined' || !globalThis.chrome?.runtime?.id) return secureMemoryCache?.sessionId === sessionId;
  const response = await chrome.runtime.sendMessage({type:'KEYPILOT_SECURE_CACHE',action:'status'});
  return response?.sessionId === sessionId;
}
export async function getUnlockedVaultCache(): Promise<UnlockedVaultCache | null> {
  const state = await getSessionState();
  if (!state || (state.expiresAt && Date.now() >= state.expiresAt)) return null;
  const cache = state.highSecurity ? await secureCache('get') : await read<UnlockedVaultCache>(UNLOCKED_SESSION_KEY, true);
  return cache?.sessionId === state.id ? cache : null;
}
export async function saveUnlockedVaultCache(cache: UnlockedVaultCache): Promise<void> {
  const highSecurity = cache.vault.settings.highSecurityMode;
  if (highSecurity) {
    await secureCache('set', cache);
    await remove(UNLOCKED_SESSION_KEY, true);
  } else {
    await write(UNLOCKED_SESSION_KEY, cache, true);
    await secureCache('clear');
  }
  const minutes = cache.vault.settings.autoLockMinutes;
  const expiresAt = minutes > 0 ? cache.cachedAt + minutes * 60000 : 0;
  await write(SESSION_STATE_KEY, { id: cache.sessionId, expiresAt, highSecurity }, true);
  if (globalThis.chrome?.alarms) {
    await chrome.alarms.clear('keypilot-auto-lock');
    if (expiresAt) await chrome.alarms.create('keypilot-auto-lock', { when: expiresAt });
  }
}
export async function clearUnlockedVaultCache(): Promise<void> {
  await remove(SESSION_STATE_KEY, true);
  await remove(UNLOCKED_SESSION_KEY, true);
  await secureCache('clear').catch(() => undefined);
}
export async function clearEncryptedVault(): Promise<void> {
  await withVaultLock(async () => {
    await clearUnlockedVaultCache();
    await remove(VAULT_STORAGE_KEY);
    await remove(SNAPSHOT_STORAGE_KEY);
    await updateReminderIndex(() => null);
  });
}
export interface RecoverySnapshot { createdAt: number; vault: VaultEncrypted }
export const getRecoverySnapshots = () => read<RecoverySnapshot[]>(SNAPSHOT_STORAGE_KEY);
export async function snapshotEncryptedVault(vault: VaultEncrypted): Promise<void> {
  const previous = await getRecoverySnapshots() ?? [];
  await write(SNAPSHOT_STORAGE_KEY, [{ createdAt: Date.now(), vault }, ...previous].slice(0, 3));
}
