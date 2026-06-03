import type { VaultEncrypted, VaultPlain } from './types';

const VAULT_STORAGE_KEY = 'keypilot.encryptedVault';
const UNLOCKED_SESSION_KEY = 'keypilot.unlockedSession';

export interface UnlockedVaultCache {
  vault: VaultPlain;
  encryptedVault: VaultEncrypted;
  exportedKey: string;
  cachedAt: number;
}

function hasChromeStorage(): boolean {
  return Boolean(globalThis.chrome?.storage?.local);
}

function hasChromeSessionStorage(): boolean {
  return Boolean(globalThis.chrome?.storage?.session);
}

export async function getEncryptedVault(): Promise<VaultEncrypted | null> {
  if (hasChromeStorage()) {
    const result = await chrome.storage.local.get(VAULT_STORAGE_KEY);
    return (result[VAULT_STORAGE_KEY] as VaultEncrypted | undefined) ?? null;
  }

  const value = window.localStorage.getItem(VAULT_STORAGE_KEY);
  return value ? (JSON.parse(value) as VaultEncrypted) : null;
}

export async function saveEncryptedVault(vault: VaultEncrypted): Promise<void> {
  if (hasChromeStorage()) {
    await chrome.storage.local.set({ [VAULT_STORAGE_KEY]: vault });
    return;
  }

  window.localStorage.setItem(VAULT_STORAGE_KEY, JSON.stringify(vault));
}

export async function clearEncryptedVault(): Promise<void> {
  if (hasChromeStorage()) {
    await chrome.storage.local.remove(VAULT_STORAGE_KEY);
    await clearUnlockedVaultCache();
    return;
  }

  window.localStorage.removeItem(VAULT_STORAGE_KEY);
  window.sessionStorage.removeItem(UNLOCKED_SESSION_KEY);
}

export async function getUnlockedVaultCache(): Promise<UnlockedVaultCache | null> {
  if (hasChromeSessionStorage()) {
    const result = await chrome.storage.session.get(UNLOCKED_SESSION_KEY);
    return (result[UNLOCKED_SESSION_KEY] as UnlockedVaultCache | undefined) ?? null;
  }

  const value = window.sessionStorage.getItem(UNLOCKED_SESSION_KEY);
  return value ? (JSON.parse(value) as UnlockedVaultCache) : null;
}

export async function saveUnlockedVaultCache(cache: UnlockedVaultCache): Promise<void> {
  if (hasChromeSessionStorage()) {
    await chrome.storage.session.set({ [UNLOCKED_SESSION_KEY]: cache });
    return;
  }

  window.sessionStorage.setItem(UNLOCKED_SESSION_KEY, JSON.stringify(cache));
}

export async function clearUnlockedVaultCache(): Promise<void> {
  if (hasChromeSessionStorage()) {
    await chrome.storage.session.remove(UNLOCKED_SESSION_KEY);
    return;
  }

  window.sessionStorage.removeItem(UNLOCKED_SESSION_KEY);
}
