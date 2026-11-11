import { applyReminderReceipts, validateReminder, REMINDER_LIMIT, reminderSounds } from './reminders';
import { validateCaptchaRules } from './captchaRules';
import { validateAutoTotpOrigins, validateSiteLoginSettings } from './loginSettings';
import { validateTotpConfig } from './totp';
import { decryptVaultWithKey, encryptVaultWithExistingKey, unlockEncryptedVault } from './crypto';
import { defaultSettings } from './defaults';
import type { BackupSettingsSelection } from './backupSettings';
import { mergeBackup, type BackupConflictChoices } from './backupMerge';
export { mergeBackup, backupMergeSummary, backupMergeConflicts } from './backupMerge';
import { generateSaveInboxKeyPair } from './saveInbox';
import { assertVaultSession, cacheVaultSession, normalizeVault } from './vault';
import { getEncryptedVault, saveEncryptedVault, snapshotEncryptedVault, withVaultLock } from './storage';
import type { UnlockedVaultSession, VaultEncrypted, VaultPlain } from './types';

export interface BackupPreview { encrypted: VaultEncrypted; vault: VaultPlain; key: CryptoKey; baseData?: string; currentVault?: VaultPlain }
export async function previewBackup(file: File, password: string, session?: UnlockedVaultSession): Promise<BackupPreview> {
  if (file.size > 50 * 1024 * 1024) throw new Error('备份文件超过 50 MB，请检查文件。');
  const encrypted = JSON.parse(await file.text()) as VaultEncrypted;
  if (!encrypted?.kdf?.salt || !encrypted.cipher?.iv || !encrypted.verifier || !encrypted.encryptedData) throw new Error('备份文件格式不正确。');
  const { vault, key } = await unlockEncryptedVault(password, encrypted);
  validateBackup(vault);
  return withVaultLock(async () => {
    if (session) await assertVaultSession(session);
    const current = await getEncryptedVault();
    const currentVault = session && current ? normalizeVault(await applyReminderReceipts(await decryptVaultWithKey(session.key, current), current.kdf.salt)) : undefined;
    return { encrypted, vault: normalizeVault(vault), key, baseData: current?.encryptedData, currentVault };
  });
}
export function validateBackup(vault: VaultPlain) {
  if (!vault || vault.version !== 1 || !vault.settings || typeof vault.settings !== 'object' || Array.isArray(vault.settings) || !Array.isArray(vault.credentials)) throw new Error('备份文件不完整。');
  for (const [key, value] of Object.entries(defaultSettings)) {
    const actual = vault.settings[key as keyof typeof defaultSettings];
    if (actual !== undefined && (Array.isArray(value) ? !Array.isArray(actual) : typeof value !== typeof actual)) throw new Error('备份设置格式不正确。');
  }
  validateCaptchaRules(vault.settings.captchaSiteRules);
  validateAutoTotpOrigins(vault.settings.autoTotpOrigins);
  validateSiteLoginSettings(vault.settings.siteLoginSettings);
  for (const name of ['credentials','totpAccounts','reminders','secureNotes','identities','fillProfiles','folders','deletedItems'] as const) {
    const values = vault[name];
    if (values !== undefined && (!Array.isArray(values) || values.some(value => !value || typeof value.id !== 'string'))) throw new Error('备份记录格式不正确。');
    if (values && new Set(values.map(value => value.id)).size !== values.length) throw new Error('备份中存在重复记录 ID。');
  }
  if ((vault.reminders?.length ?? 0) > REMINDER_LIMIT) throw new Error('提醒数量超过上限。');
  for (const item of vault.reminders ?? []) validateReminder(item);
  if (vault.settings.reminderSound !== undefined && !reminderSounds.some(sound => sound.id === vault.settings.reminderSound)) throw new Error('提醒声音设置无效。');
  if (vault.settings.reminderVolume !== undefined && (!Number.isFinite(vault.settings.reminderVolume) || vault.settings.reminderVolume < 10 || vault.settings.reminderVolume > 100)) throw new Error('提醒音量设置无效。');
  for (const item of vault.totpAccounts ?? []) {
    validateTotpConfig(item);
    if (typeof item.issuer !== 'string' || typeof item.account !== 'string' || !item.account.trim() || !Number.isFinite(item.createdAt) || !Number.isFinite(item.updatedAt)) throw new Error('身份验证器备份字段不完整。');
    if (item.credentialId !== undefined && typeof item.credentialId !== 'string') throw new Error('验证码关联账号格式不正确。');
  }
  if (vault.credentials.some(item => typeof item.password !== 'string' || typeof item.username !== 'string' || typeof item.url !== 'string')) throw new Error('备份账号字段不完整。');
  const credentials = [...vault.credentials,...(vault.deletedItems ?? []).flatMap(item=>item.kind==='credential'?[item.item]:[])];
  for (const item of credentials) {
    if (item.passwordHistory !== undefined && (!Array.isArray(item.passwordHistory) || item.passwordHistory.length>10 || item.passwordHistory.some(entry=>!entry || typeof entry.id!=='string' || typeof entry.password!=='string' || !Number.isFinite(entry.changedAt)))) throw new Error('密码历史格式不正确。');
    if (item.recoveryCodes !== undefined && (!Array.isArray(item.recoveryCodes) || item.recoveryCodes.length>100 || item.recoveryCodes.some(entry=>!entry || typeof entry.id!=='string' || typeof entry.code!=='string' || !entry.code || entry.code.length>256 || !Number.isFinite(entry.createdAt) || (entry.usedAt!==undefined && !Number.isFinite(entry.usedAt))))) throw new Error('网站恢复码格式不正确。');
    for (const entries of [item.passwordHistory,item.recoveryCodes]) if (entries && new Set(entries.map(entry=>entry.id)).size!==entries.length) throw new Error('账号安全记录存在重复 ID。');
  }
}
export async function initializeVaultFromBackup(preview: BackupPreview): Promise<UnlockedVaultSession> {
  return withVaultLock(async () => {
    if (await getEncryptedVault()) throw new Error('本机已存在密码库，请先解锁，再选择合并或替换。');
    validateBackup(preview.vault);
    const vault = normalizeVault(preview.vault);
    vault.saveInboxKeyPair ??= await generateSaveInboxKeyPair();
    const encryptedVault = await encryptVaultWithExistingKey(preview.key, preview.encrypted, vault);
    const next = { key: preview.key, vault, encryptedVault, sessionId: crypto.randomUUID() };
    await saveEncryptedVault(encryptedVault, vault, true);
    await cacheVaultSession(next);
    return next;
  });
}

export async function restoreBackup(preview: BackupPreview, mode: 'merge' | 'replace', session: UnlockedVaultSession, selected: BackupSettingsSelection = {}, choices: BackupConflictChoices = {}): Promise<UnlockedVaultSession> {
  return withVaultLock(async () => {
    await assertVaultSession(session);
    const current = await getEncryptedVault();
    if (!current) throw new Error('VAULT_LOCKED');
    if (current.encryptedData !== preview.baseData) throw new Error('密码库已在其他页面更新，请重新预览后再恢复。');
    const currentVault = normalizeVault(await applyReminderReceipts(await decryptVaultWithKey(session.key, current), current.kdf.salt));
    const vault = mode === 'merge' ? mergeBackup(currentVault, preview.vault, selected, choices) : {
      ...preview.vault, settings: { ...defaultSettings, ...preview.vault.settings }
    };
    vault.saveInboxKeyPair ??= await generateSaveInboxKeyPair();
    const key = mode === 'merge' ? session.key : preview.key;
    const encryptedVault = await encryptVaultWithExistingKey(key, mode === 'merge' ? current : preview.encrypted, vault);
    await snapshotEncryptedVault(current);
    await saveEncryptedVault(encryptedVault, vault, mode === 'replace');
    const next = { key, vault, encryptedVault, sessionId: mode === 'merge' ? session.sessionId : crypto.randomUUID() };
    await cacheVaultSession(next);
    return next;
  });
}
