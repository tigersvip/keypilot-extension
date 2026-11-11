import { applyReminderReceipts } from './reminders';
import { assertVaultSession, cacheVaultSession, normalizeVault, restoreCachedVaultSession } from './vault';
import { decryptVaultWithKey, encryptVaultWithExistingKey } from './crypto';
import { getEncryptedVault, saveEncryptedVault, withVaultLock } from './storage';
import { defaultSettings } from './defaults';
import { backupSettingsSnapshot } from './backupSettings';
import type { UnlockedVaultSession, VaultPlain } from './types';

export function backupRecords(vault: VaultPlain) {
  return (['credentials', 'totpAccounts', 'reminders', 'secureNotes', 'identities', 'fillProfiles', 'folders', 'deletedItems'] as const)
    .flatMap(kind => (vault[kind] ?? []).map(item => ({ id: `${kind}:${item.id}`, updatedAt: 'updatedAt' in item ? item.updatedAt : item.deletedAt })));
}
export function backupStatus(vault: VaultPlain, now = Date.now()) {
  const previous = vault.settings.backupExport;
  const records = backupRecords(vault);
  const ids = new Set(previous?.recordIds ?? []);
  const currentIds = new Set(records.map(item => item.id));
  const added = records.filter(item => !ids.has(item.id)).length;
  const changed = previous ? records.filter(item => ids.has(item.id) && item.updatedAt > previous.requestedAt).length : 0;
  const removed = [...ids].filter(id => !currentIds.has(id)).length;
  const snapshot = backupSettingsSnapshot(vault.settings);
  const settingsUntracked = Boolean(previous && previous.settingsSnapshot === undefined);
  const settingsChanged = Boolean(previous?.settingsSnapshot !== undefined && previous.settingsSnapshot !== snapshot);
  const hasContent = records.length > 0 || snapshot !== backupSettingsSnapshot(defaultSettings);
  const due = previous ? settingsChanged || settingsUntracked || ((added + changed + removed > 0) && now - previous.requestedAt >= 7 * 86400000) : hasContent;
  return { previous, added, changed, removed, settingsChanged, settingsUntracked, due: vault.settings.backupReminderEnabled !== false && due };
}

export async function prepareEncryptedBackup(session: UnlockedVaultSession): Promise<UnlockedVaultSession> {
  return withVaultLock(async () => {
    await assertVaultSession(session);
    const current = await getEncryptedVault();
    if (!current || current.kdf.salt !== session.encryptedVault.kdf.salt) throw new Error('VAULT_LOCKED');
    const vault = normalizeVault(await applyReminderReceipts(await decryptVaultWithKey(session.key, current), current.kdf.salt));
    vault.settings = { ...vault.settings, backupExport: {
      requestedAt: Date.now(), recordIds: backupRecords(vault).map(item => item.id), settingsSnapshot: backupSettingsSnapshot(vault.settings)
    } };
    const encryptedVault = await encryptVaultWithExistingKey(session.key, current, vault);
    await saveEncryptedVault(encryptedVault, vault);
    const next = { ...session, vault, encryptedVault };
    await cacheVaultSession(next);
    return next;
  });
}

export async function exportEncryptedBackup(): Promise<UnlockedVaultSession> {
  const current = await restoreCachedVaultSession();
  if (!current) throw new Error('VAULT_LOCKED');
  const next = await prepareEncryptedBackup(current);
  const url = URL.createObjectURL(new Blob([JSON.stringify(next.encryptedVault)], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `keypilot-vault-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return next;
}
