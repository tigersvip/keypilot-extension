import { validateAutoTotpOrigins, validateSiteLoginSettings } from './loginSettings';
import { normalizeLanguage } from './language';
import { readLanguagePreference } from './i18n';
import { applyReminderReceipts, syncReminderIndex } from './reminders';
import { validateCaptchaRules } from './captchaRules';
import { mergeVaultChanges } from './vaultMerge';
import { migrateFillProfilePrivacy } from './fillPrivacy';
import { createEmptyVault, defaultSettings } from './defaults';
import { domainsMatch, extractDomain, extractMatchDomain, normalizeMatchUrl, normalizeUrl } from './domain';
import { getRootFaviconUrl } from './icons';
import { capturePasswordChanges, rememberPreviousPassword } from './credentialSecurity';
import {
  attachRecoveryToEncryptedVault,
  createEncryptedVault,
  decryptVaultWithKey,
  encryptVaultWithExistingKey,
  exportVaultKey,
  importVaultKey,
  unlockEncryptedVault,
  unlockEncryptedVaultWithRecoveryCode
} from './crypto';
import {
  withVaultLock,
  getSessionState,
  isVaultSessionActive,
  clearUnlockedVaultCache,
  getEncryptedVault,
  getUnlockedVaultCache,
  saveEncryptedVault,
  saveUnlockedVaultCache
} from './storage';
import {
  decryptPendingSaveInboxItem,
  generateSaveInboxKeyPair,
  getPendingSaveInbox,
  getSaveInboxPublicKeyFromVault,
  removePendingSaveInboxItems
} from './saveInbox';
import type {
  Credential,
  DeletedVaultItem,
  FillProfile,
  IdentityProfile,
  PendingLoginCandidate,
  SecureNote,
  UnlockedVaultSession,
  VaultEncrypted,
  VaultFolder,
  VaultPlain
} from './types';

export async function hasVault(): Promise<boolean> {
  return Boolean(await getEncryptedVault());
}

export async function createVaultSession(masterPassword: string, recoveryCode?: string): Promise<UnlockedVaultSession> {
  return withVaultLock(async () => {
    if (masterPassword.length < 8) throw new Error('MASTER_PASSWORD_TOO_SHORT');
    if (await getEncryptedVault()) throw new Error('VAULT_ALREADY_EXISTS');
    const { vault } = await ensureSaveInboxKeyPair(createEmptyVault());
    vault.settings.language = await readLanguagePreference() ?? vault.settings.language;
    const { encryptedVault, key } = await createEncryptedVault(masterPassword, vault, recoveryCode);
    await saveEncryptedVault(encryptedVault, vault);
    const session = { key, vault, encryptedVault, sessionId: crypto.randomUUID() };
    await cacheVaultSession(session);
    return session;
  });
}

export async function unlockVaultSession(masterPassword: string, encryptedVault?: VaultEncrypted): Promise<UnlockedVaultSession> {
  return withVaultLock(async () => {
    const storedVault = encryptedVault ?? (await getEncryptedVault());

    if (!storedVault) {
      throw new Error('VAULT_NOT_FOUND');
    }

    const { vault: rawVault, key } = await unlockEncryptedVault(masterPassword, storedVault);
    return prepareUnlockedVaultSession(key, storedVault, rawVault);
  });
}

export async function unlockVaultWithRecoveryCode(recoveryCode: string, encryptedVault?: VaultEncrypted): Promise<UnlockedVaultSession> {
  return withVaultLock(async () => {
    const storedVault = encryptedVault ?? (await getEncryptedVault());

    if (!storedVault) {
      throw new Error('VAULT_NOT_FOUND');
    }

    const { vault: rawVault, key } = await unlockEncryptedVaultWithRecoveryCode(recoveryCode, storedVault);
    return prepareUnlockedVaultSession(key, storedVault, rawVault);
  });
}

export function normalizeVault(vault: VaultPlain): VaultPlain {
  const settings = {
    ...defaultSettings,
    ...vault.settings,
    language: normalizeLanguage(vault.settings.language),
    // Three-way setting merges represent removed map entries as undefined.
    ...(vault.settings.siteLoginSettings ? {siteLoginSettings: JSON.parse(JSON.stringify(vault.settings.siteLoginSettings))} : {}),
    captchaSiteRules: Object.fromEntries(Object.entries(vault.settings.captchaSiteRules??{}).filter(([,rule])=>rule!==undefined))
  };

  return {
    ...vault,
    totpAccounts: vault.totpAccounts ?? [],
    reminders: vault.reminders ?? [],
    secureNotes: vault.secureNotes ?? [],
    identities: vault.identities ?? [],
    fillProfiles: (vault.fillProfiles ?? []).map(migrateFillProfilePrivacy),
    folders: vault.folders ?? [],
    deletedItems: (vault.deletedItems ?? []).map(item => item.kind === 'fillProfile'
      ? { ...item, item: migrateFillProfilePrivacy(item.item) }
      : item),
    settings
  };
}

async function ensureSaveInboxKeyPair(vault: VaultPlain): Promise<{ vault: VaultPlain; changed: boolean }> {
  const normalizedVault = normalizeVault(vault);
  const keyPair = normalizedVault.saveInboxKeyPair;

  if (keyPair?.publicKey && keyPair.privateKey && keyPair.keyId) {
    return { vault: normalizedVault, changed: false };
  }

  return {
    vault: {
      ...normalizedVault,
      saveInboxKeyPair: await generateSaveInboxKeyPair()
    },
    changed: true
  };
}

function domainInList(domain: string, list: string[] | undefined): boolean {
  return Boolean(
    domain &&
      (list ?? []).some((item) => {
        const candidate = item.trim();
        return candidate === domain || domainsMatch(candidate, domain);
      })
  );
}

function samePendingCandidateAccount(credential: Credential, candidate: PendingLoginCandidate): boolean {
  const username = candidate.username.trim().toLowerCase();
  const credentialUsername = credential.username.trim().toLowerCase();

  if (!username || !credentialUsername || username !== credentialUsername) {
    return false;
  }

  return domainsMatch(credential.matchDomain || credential.domain, candidate.domain) || domainsMatch(credential.domain, candidate.domain);
}

function samePendingCandidatePassword(credential: Credential, candidate: PendingLoginCandidate): boolean {
  return samePendingCandidateAccount(credential, candidate) && credential.password === candidate.password;
}

function shouldRefreshDuplicateCredential(credential: Credential, candidate: PendingLoginCandidate): boolean {
  return Boolean(
    (candidate.formFields?.length && !credential.formFields?.length) ||
      (candidate.formProfile && !credential.formProfile) ||
      (candidate.iconUrl && (!credential.iconUrl || credential.iconType === 'default')) ||
      (candidate.title.trim() && (!credential.title.trim() || credential.title.trim() === credential.domain))
  );
}

function mergePendingSaveCandidateIntoVault(
  vault: VaultPlain,
  candidate: PendingLoginCandidate
): { vault: VaultPlain; changed: boolean; imported: boolean } {
  const exactDuplicate = vault.credentials.find((credential) => samePendingCandidatePassword(credential, candidate));

  if (exactDuplicate) {
    if (!shouldRefreshDuplicateCredential(exactDuplicate, candidate)) {
      return { vault, changed: false, imported: false };
    }

    return {
      vault: updateCredentialInVault(vault, {
        ...exactDuplicate,
        formFields: candidate.formFields?.length ? candidate.formFields : exactDuplicate.formFields,
        formProfile: candidate.formProfile ?? exactDuplicate.formProfile,
        iconUrl: candidate.iconUrl ?? exactDuplicate.iconUrl,
        iconType: candidate.iconType ?? exactDuplicate.iconType,
        title: candidate.title.trim() || exactDuplicate.title || candidate.domain
      }),
      changed: true,
      imported: false
    };
  }

  const existing = vault.credentials.find((credential) => samePendingCandidateAccount(credential, candidate));

  if (existing) {
    return {
      vault: updateCredentialInVault(vault, {
        ...existing,
        password: candidate.password,
        url: candidate.url,
        formFields: candidate.formFields?.length ? candidate.formFields : existing.formFields,
        formProfile: candidate.formProfile ?? existing.formProfile,
        iconUrl: candidate.iconUrl ?? existing.iconUrl,
        iconType: candidate.iconType ?? existing.iconType,
        title: candidate.title.trim() || existing.title || candidate.domain
      }),
      changed: true,
      imported: true
    };
  }

  return {
    vault: addCredentialToVault(
      vault,
      buildCredential({
        title: candidate.title,
        url: candidate.url,
        iconUrl: candidate.iconUrl,
        iconType: candidate.iconType,
        username: candidate.username,
        password: candidate.password,
        formFields: candidate.formFields,
        formProfile: candidate.formProfile,
        source: 'manual'
      })
    ),
    changed: true,
    imported: true
  };
}

async function importPendingSaveInbox(vault: VaultPlain): Promise<{
  vault: VaultPlain;
  changed: boolean;
  importedCount: number;
  consumedIds: string[];
}> {
  const keyPair = vault.saveInboxKeyPair;

  if (!keyPair?.privateKey || !keyPair.publicKey || !keyPair.keyId) {
    return { vault, changed: false, importedCount: 0, consumedIds: [] };
  }

  const items = await getPendingSaveInbox();
  let nextVault = vault;
  let changed = false;
  let importedCount = 0;
  const consumedIds: string[] = [];

  for (const item of items) {
    if (item.keyId !== keyPair.keyId) {
      continue;
    }

    let candidate: PendingLoginCandidate;

    try {
      candidate = await decryptPendingSaveInboxItem(item, keyPair);
    } catch {
      consumedIds.push(item.id);
      continue;
    }

    if (domainInList(candidate.domain, nextVault.settings.blacklist)) {
      consumedIds.push(item.id);
      continue;
    }

    const result = mergePendingSaveCandidateIntoVault(nextVault, candidate);
    nextVault = result.vault;
    changed = changed || result.changed;
    importedCount += result.imported ? 1 : 0;
    consumedIds.push(item.id);
  }

  return {
    vault: nextVault,
    changed,
    importedCount,
    consumedIds
  };
}

async function prepareUnlockedVaultSession(
  key: CryptoKey,
  encryptedVault: VaultEncrypted,
  rawVault: VaultPlain
): Promise<UnlockedVaultSession> {
  const receivedVault = await applyReminderReceipts(rawVault, encryptedVault.kdf.salt);
  const prepared = await ensureSaveInboxKeyPair(receivedVault);
  const language = await readLanguagePreference();
  const languageChanged = language !== undefined && language !== prepared.vault.settings.language;
  if (languageChanged) prepared.vault.settings.language = language;
  const pending = await importPendingSaveInbox(prepared.vault);
  const saveInboxPublicKey = getSaveInboxPublicKeyFromVault(pending.vault.saveInboxKeyPair);
  const publicKeyChanged = saveInboxPublicKey?.keyId !== encryptedVault.saveInboxPublicKey?.keyId;
  let nextEncryptedVault = encryptedVault;

  if (languageChanged || JSON.stringify(rawVault.reminders) !== JSON.stringify(receivedVault.reminders) || prepared.changed || pending.changed || publicKeyChanged) {
    nextEncryptedVault = await encryptVaultWithExistingKey(key, encryptedVault, pending.vault);
    await saveEncryptedVault(nextEncryptedVault, pending.vault);
  }

  if (pending.consumedIds.length) {
    await removePendingSaveInboxItems(pending.consumedIds);
  }

  const session = {
    sessionId: crypto.randomUUID(),
    key,
    vault: pending.vault,
    encryptedVault: nextEncryptedVault,
    pendingSaveImportCount: pending.importedCount,
    saveInboxJustEnabled: prepared.changed
  };
  await cacheVaultSession(session);
  return session;
}

export async function assertVaultSession(session: UnlockedVaultSession): Promise<void> {
  const cache = await getUnlockedVaultCache();
  if (!session.sessionId || cache?.sessionId !== session.sessionId) throw new Error('VAULT_LOCKED');
}
export async function persistVaultSession(session: UnlockedVaultSession, vault: VaultPlain): Promise<UnlockedVaultSession> {
  return withVaultLock(async () => {
    await assertVaultSession(session);
    const currentEncrypted = await getEncryptedVault();
    if (!currentEncrypted || currentEncrypted.kdf.salt !== session.encryptedVault.kdf.salt) throw new Error('VAULT_LOCKED');
    const current = await decryptVaultWithKey(session.key, currentEncrypted);
    const merged = capturePasswordChanges(current, mergeVaultChanges(normalizeVault(session.vault), normalizeVault(vault), normalizeVault(current)));
    const prepared = await ensureSaveInboxKeyPair(await applyReminderReceipts(merged, currentEncrypted.kdf.salt));
    validateCaptchaRules(prepared.vault.settings.captchaSiteRules);
    validateAutoTotpOrigins(prepared.vault.settings.autoTotpOrigins);
    validateSiteLoginSettings(prepared.vault.settings.siteLoginSettings);
    const encryptedVault = await encryptVaultWithExistingKey(session.key, currentEncrypted, prepared.vault);
    await saveEncryptedVault(encryptedVault, prepared.vault);
    const nextSession = { ...session, vault: prepared.vault, encryptedVault };
    await cacheVaultSession(nextSession);
    return nextSession;
  });
}
export async function changeVaultMasterPassword(session: UnlockedVaultSession, currentMasterPassword: string, nextMasterPassword: string, recoveryCode?: string): Promise<UnlockedVaultSession> {
  await unlockEncryptedVault(currentMasterPassword, session.encryptedVault);
  return resetVaultMasterPassword(session, nextMasterPassword, recoveryCode);
}
export async function resetVaultMasterPassword(session: UnlockedVaultSession, nextMasterPassword: string, recoveryCode?: string): Promise<UnlockedVaultSession> {
  if (nextMasterPassword.length < 8) throw new Error('MASTER_PASSWORD_TOO_SHORT');
  return withVaultLock(async () => {
    await assertVaultSession(session);
    const current = await getEncryptedVault();
    if (!current || current.kdf.salt !== session.encryptedVault.kdf.salt) throw new Error('VAULT_LOCKED');
    const vault = normalizeVault(await applyReminderReceipts(await decryptVaultWithKey(session.key, current), current.kdf.salt));
    const { encryptedVault, key } = await createEncryptedVault(nextMasterPassword, vault, recoveryCode);
    await saveEncryptedVault(encryptedVault, vault);
    const nextSession = { key, vault, encryptedVault, sessionId: crypto.randomUUID() };
    await cacheVaultSession(nextSession);
    return nextSession;
  });
}
export async function enableVaultRecovery(session: UnlockedVaultSession, recoveryCode: string): Promise<UnlockedVaultSession> {
  return updateRecovery(session, recoveryCode);
}
export async function disableVaultRecovery(session: UnlockedVaultSession): Promise<UnlockedVaultSession> {
  return updateRecovery(session);
}
async function updateRecovery(session: UnlockedVaultSession, code?: string): Promise<UnlockedVaultSession> {
  return withVaultLock(async () => {
    await assertVaultSession(session);
    const current = await getEncryptedVault();
    if (!current || current.kdf.salt !== session.encryptedVault.kdf.salt) throw new Error('VAULT_LOCKED');
    const { recovery: _recovery, ...withoutRecovery } = current;
    const encryptedVault = code ? await attachRecoveryToEncryptedVault(session.key, current, code) : withoutRecovery;
    const nextSession = { ...session, encryptedVault, vault: normalizeVault(await decryptVaultWithKey(session.key, current)) };
    await saveEncryptedVault(encryptedVault, nextSession.vault);
    await cacheVaultSession(nextSession);
    return nextSession;
  });
}
export async function cacheVaultSession(session: UnlockedVaultSession): Promise<void> {
  await syncReminderIndex(session.vault, session.encryptedVault.kdf.salt);
  session.sessionId ??= crypto.randomUUID();
  await saveUnlockedVaultCache({
    vault: session.vault, encryptedVault: session.encryptedVault,
    exportedKey: await exportVaultKey(session.key), cachedAt: Date.now(), sessionId: session.sessionId
  });
}
export async function restoreCachedVaultSession(): Promise<UnlockedVaultSession | null> {
  return withVaultLock(async () => {
    const cache = await getUnlockedVaultCache();
    if (!cache) { await clearUnlockedVaultCache(); return null; }
    const encryptedVault = await getEncryptedVault();
    if (!encryptedVault || encryptedVault.kdf.salt !== cache.encryptedVault.kdf.salt) return null;
    const key = await importVaultKey(cache.exportedKey);
    const vault = encryptedVault.encryptedData === cache.encryptedVault.encryptedData ? cache.vault : await decryptVaultWithKey(key, encryptedVault);
    return { key, vault: normalizeVault(await applyReminderReceipts(vault, encryptedVault.kdf.salt)), encryptedVault, sessionId: cache.sessionId };
  });
}
export async function clearVaultSessionCache(): Promise<void> {
  await withVaultLock(clearUnlockedVaultCache);
}
export async function clearExpiredSession(sessionId: string): Promise<void> {
  await withVaultLock(async () => {
    const state = await getSessionState();
    if (state?.id === sessionId && !await isVaultSessionActive(sessionId)) await clearUnlockedVaultCache();
  });
}
export async function touchVaultActivity(sessionId: string): Promise<void> {
  await withVaultLock(async () => {
    const cache = await getUnlockedVaultCache();
    if (cache?.sessionId === sessionId) await saveUnlockedVaultCache({ ...cache, cachedAt: Date.now() });
  });
}

export function buildCredential(input: {
  title: string;
  url: string;
  matchUrl?: string;
  iconUrl?: string;
  iconType?: Credential['iconType'];
  username: string;
  password: string;
  notes?: string;
  tags?: string[];
  folder?: string;
  formFields?: Credential['formFields'];
  formProfile?: Credential['formProfile'];
  source?: Credential['source'];
}): Credential {
  const now = Date.now();
  const normalizedUrl = normalizeUrl(input.url);
  const domain = extractDomain(normalizedUrl);
  const iconUrl = input.iconUrl?.trim() || getRootFaviconUrl(normalizedUrl);
  const matchUrl = normalizeMatchUrl(input.matchUrl);
  const matchDomain = matchUrl ? extractMatchDomain(matchUrl) : undefined;

  return {
    id: crypto.randomUUID(),
    title: input.title.trim() || domain || '未命名账号',
    url: normalizedUrl,
    domain,
    matchUrl,
    matchDomain,
    iconUrl,
    iconType: input.iconType ?? (iconUrl ? 'favicon' : 'default'),
    username: input.username.trim(),
    password: input.password,
    notes: input.notes?.trim() || undefined,
    tags: input.tags?.filter(Boolean),
    folder: input.folder?.trim() || undefined,
    formFields: input.formFields?.filter((field) => field.value).slice(0, 40),
    formProfile: input.formProfile,
    pinned: false,
    source: input.source ?? 'manual',
    createdAt: now,
    updatedAt: now
  };
}

export function addCredentialToVault(vault: VaultPlain, credential: Credential): VaultPlain {
  return {
    ...vault,
    credentials: [credential, ...vault.credentials]
  };
}

function normalizeFolderName(name: string): string {
  return name.trim().replace(/\s+/g, ' ') || '主目录';
}

function isRootFolderName(name: string): boolean {
  return normalizeFolderName(name) === '主目录';
}

function folderExists(folders: VaultFolder[] | undefined, name: string): boolean {
  const normalized = normalizeFolderName(name).toLowerCase();
  return Boolean((folders ?? []).some((folder) => normalizeFolderName(folder.name).toLowerCase() === normalized));
}

function folderNameEquals(left: string | undefined, right: string): boolean {
  return normalizeFolderName(left ?? '主目录').toLowerCase() === normalizeFolderName(right).toLowerCase();
}

function storedFolderName(name: string): string | undefined {
  const normalized = normalizeFolderName(name);
  return isRootFolderName(normalized) ? undefined : normalized;
}

export function createFolderInVault(vault: VaultPlain, name: string): VaultPlain {
  const normalized = normalizeFolderName(name);

  if (isRootFolderName(normalized) || folderExists(vault.folders, normalized)) {
    return vault;
  }

  const now = Date.now();
  return {
    ...vault,
    folders: [
      ...(vault.folders ?? []),
      {
        id: crypto.randomUUID(),
        name: normalized,
        createdAt: now,
        updatedAt: now
      }
    ]
  };
}

export function renameFolderInVault(vault: VaultPlain, currentName: string, nextName: string): VaultPlain {
  const current = normalizeFolderName(currentName);
  const next = normalizeFolderName(nextName);

  if (isRootFolderName(current) || current.toLowerCase() === next.toLowerCase()) {
    return vault;
  }

  if (!isRootFolderName(next) && folderExists(vault.folders, next)) {
    return vault;
  }

  const now = Date.now();
  const nextStoredFolder = storedFolderName(next);
  const currentFolder = (vault.folders ?? []).find((folder) => folderNameEquals(folder.name, current));
  const foldersWithoutCurrent = (vault.folders ?? []).filter((folder) => !folderNameEquals(folder.name, current));
  const folders = nextStoredFolder
    ? [
        ...foldersWithoutCurrent,
        {
          id: currentFolder?.id ?? crypto.randomUUID(),
          name: nextStoredFolder,
          createdAt: currentFolder?.createdAt ?? now,
          updatedAt: now
        }
      ]
    : foldersWithoutCurrent;

  return {
    ...vault,
    folders,
    credentials: vault.credentials.map((credential) =>
      folderNameEquals(credential.folder, current)
        ? {
            ...credential,
            folder: nextStoredFolder,
            updatedAt: now
          }
        : credential
    ),
    secureNotes: (vault.secureNotes ?? []).map((note) =>
      folderNameEquals(note.folder, current)
        ? {
            ...note,
            folder: nextStoredFolder,
            updatedAt: now
          }
        : note
    ),
    identities: (vault.identities ?? []).map((identity) =>
      folderNameEquals(identity.folder, current)
        ? {
            ...identity,
            folder: nextStoredFolder,
            updatedAt: now
          }
        : identity
    ),
    fillProfiles: (vault.fillProfiles ?? []).map((profile) =>
      folderNameEquals(profile.folder, current)
        ? {
            ...profile,
            folder: nextStoredFolder,
            updatedAt: now
          }
        : profile
    )
  };
}

export function moveFolderContentsInVault(vault: VaultPlain, currentName: string, targetName: string): VaultPlain {
  const current = normalizeFolderName(currentName);
  const target = normalizeFolderName(targetName);

  if (isRootFolderName(current) || current.toLowerCase() === target.toLowerCase()) {
    return vault;
  }

  const now = Date.now();
  const targetStoredFolder = storedFolderName(target);
  const withTargetFolder = targetStoredFolder ? createFolderInVault(vault, targetStoredFolder) : vault;
  const folders = (withTargetFolder.folders ?? []).filter((folder) => !folderNameEquals(folder.name, current));

  return {
    ...withTargetFolder,
    folders,
    credentials: withTargetFolder.credentials.map((credential) =>
      folderNameEquals(credential.folder, current)
        ? {
            ...credential,
            folder: targetStoredFolder,
            updatedAt: now
          }
        : credential
    ),
    secureNotes: (withTargetFolder.secureNotes ?? []).map((note) =>
      folderNameEquals(note.folder, current)
        ? {
            ...note,
            folder: targetStoredFolder,
            updatedAt: now
          }
        : note
    ),
    identities: (withTargetFolder.identities ?? []).map((identity) =>
      folderNameEquals(identity.folder, current)
        ? {
            ...identity,
            folder: targetStoredFolder,
            updatedAt: now
          }
        : identity
    ),
    fillProfiles: (withTargetFolder.fillProfiles ?? []).map((profile) =>
      folderNameEquals(profile.folder, current)
        ? {
            ...profile,
            folder: targetStoredFolder,
            updatedAt: now
          }
        : profile
    )
  };
}

export function deleteFolderFromVault(vault: VaultPlain, folderName: string): VaultPlain {
  return moveFolderContentsInVault(vault, folderName, '主目录');
}

export function moveVaultEntryToFolder(
  vault: VaultPlain,
  kind: 'credential' | 'secureNote' | 'identity' | 'fillProfile',
  id: string,
  folderName: string
): VaultPlain {
  const normalizedFolder = normalizeFolderName(folderName);
  const storedFolder = isRootFolderName(normalizedFolder) ? undefined : normalizedFolder;
  const withFolder = storedFolder ? createFolderInVault(vault, storedFolder) : vault;
  const now = Date.now();

  if (kind === 'credential') {
    return {
      ...withFolder,
      credentials: withFolder.credentials.map((credential) =>
        credential.id === id
          ? {
              ...credential,
              folder: storedFolder,
              updatedAt: now
            }
          : credential
      )
    };
  }

  if (kind === 'secureNote') {
    return {
      ...withFolder,
      secureNotes: (withFolder.secureNotes ?? []).map((note) =>
        note.id === id
          ? {
              ...note,
              folder: storedFolder,
              updatedAt: now
            }
          : note
      )
    };
  }

  if (kind === 'identity') {
    return {
      ...withFolder,
      identities: (withFolder.identities ?? []).map((identity) =>
        identity.id === id
          ? {
              ...identity,
              folder: storedFolder,
              updatedAt: now
            }
          : identity
      )
    };
  }

  return {
    ...withFolder,
    fillProfiles: (withFolder.fillProfiles ?? []).map((profile) =>
      profile.id === id
        ? {
            ...profile,
            folder: storedFolder,
            updatedAt: now
          }
        : profile
    )
  };
}

export function addFillProfilesToVault(vault: VaultPlain, profiles: FillProfile[]): VaultPlain {
  return {
    ...vault,
    fillProfiles: [...profiles, ...(vault.fillProfiles ?? [])]
  };
}

export function updateFillProfileInVault(vault: VaultPlain, profile: FillProfile): VaultPlain {
  return {
    ...vault,
    fillProfiles: (vault.fillProfiles ?? []).map((item) =>
      item.id === profile.id
        ? {
            ...profile,
            fields: profile.fields.filter((field) => field.value).slice(0, 120),
            updatedAt: Date.now()
          }
        : item
    )
  };
}

export function touchFillProfileInVault(vault:VaultPlain,profileId:string):VaultPlain {
  return {...vault,fillProfiles:(vault.fillProfiles??[]).map(profile=>profile.id===profileId?{...profile,lastUsedAt:Date.now()}:profile)};
}

export function deleteFillProfileFromVault(vault: VaultPlain, profileId: string): VaultPlain {
  const profile = (vault.fillProfiles ?? []).find((item) => item.id === profileId);
  if (!profile) return vault;

  return {
    ...vault,
    settings: {...vault.settings, ...(vault.settings.siteLoginSettings ? {
      siteLoginSettings: Object.fromEntries(Object.entries(vault.settings.siteLoginSettings).map(([origin,rule])=>{
        const next={...rule};
        if(next.defaultFillProfileId===profileId)delete next.defaultFillProfileId;
        return [origin,next];
      }))
    } : {})},
    fillProfiles: (vault.fillProfiles ?? []).filter((item) => item.id !== profileId),
    deletedItems: addDeletedItem(vault.deletedItems, {
      id: crypto.randomUUID(),
      kind: 'fillProfile',
      deletedAt: Date.now(),
      item: profile
    })
  };
}

export function updateCredentialInVault(vault: VaultPlain, credential: Credential): VaultPlain {
  const matchUrl = normalizeMatchUrl(credential.matchUrl);

  return {
    ...vault,
    credentials: vault.credentials.map((item) =>
      item.id === credential.id
        ? {
            ...rememberPreviousPassword(item, {
              ...credential,
              formFields: credential.formFields?.filter((field) => field.value).slice(0, 40)
            }),
            domain: extractDomain(credential.url),
            matchUrl,
            matchDomain: matchUrl ? extractMatchDomain(matchUrl) : undefined,
            iconUrl: credential.iconUrl?.trim() || undefined,
            iconType: credential.iconType ?? (credential.iconUrl ? 'favicon' : 'default'),
            formProfile: credential.formProfile,
            updatedAt: Date.now()
          }
        : item
    )
  };
}

export function deleteCredentialFromVault(vault: VaultPlain, credentialId: string): VaultPlain {
  const credential = vault.credentials.find((item) => item.id === credentialId);
  if (!credential) return vault;

  return {
    ...vault,
    credentials: vault.credentials.filter((item) => item.id !== credentialId),
    deletedItems: addDeletedItem(vault.deletedItems, {
      id: crypto.randomUUID(),
      kind: 'credential',
      deletedAt: Date.now(),
      item: credential
    })
  };
}

export function deleteSecureNoteFromVault(vault: VaultPlain, noteId: string): VaultPlain {
  const note = (vault.secureNotes ?? []).find((item) => item.id === noteId);
  if (!note) return vault;

  return {
    ...vault,
    secureNotes: (vault.secureNotes ?? []).filter((item) => item.id !== noteId),
    deletedItems: addDeletedItem(vault.deletedItems, {
      id: crypto.randomUUID(),
      kind: 'secureNote',
      deletedAt: Date.now(),
      item: note
    })
  };
}

export function deleteIdentityFromVault(vault: VaultPlain, identityId: string): VaultPlain {
  const identity = (vault.identities ?? []).find((item) => item.id === identityId);
  if (!identity) return vault;

  return {
    ...vault,
    identities: (vault.identities ?? []).filter((item) => item.id !== identityId),
    deletedItems: addDeletedItem(vault.deletedItems, {
      id: crypto.randomUUID(),
      kind: 'identity',
      deletedAt: Date.now(),
      item: identity
    })
  };
}

export function restoreDeletedItemToVault(vault: VaultPlain, deletedItemId: string): VaultPlain {
  const deletedItem = (vault.deletedItems ?? []).find((item) => item.id === deletedItemId);
  if (!deletedItem) return vault;

  const deletedItems = (vault.deletedItems ?? []).filter((item) => item.id !== deletedItemId);

  if (deletedItem.kind === 'credential') {
    return {
      ...vault,
      credentials: [restoreCredential(deletedItem.item, vault.credentials), ...vault.credentials],
      deletedItems
    };
  }

  if (deletedItem.kind === 'secureNote') {
    const secureNotes = vault.secureNotes ?? [];

    return {
      ...vault,
      secureNotes: [restoreSecureNote(deletedItem.item, secureNotes), ...secureNotes],
      deletedItems
    };
  }

  if (deletedItem.kind === 'identity') {
    const identities = vault.identities ?? [];

    return {
      ...vault,
      identities: [restoreIdentity(deletedItem.item, identities), ...identities],
      deletedItems
    };
  }

  const fillProfiles = vault.fillProfiles ?? [];

  return {
    ...vault,
    fillProfiles: [restoreFillProfile(deletedItem.item, fillProfiles), ...fillProfiles],
    deletedItems
  };
}

export function purgeDeletedItemFromVault(vault: VaultPlain, deletedItemId: string): VaultPlain {
  return {
    ...vault,
    deletedItems: (vault.deletedItems ?? []).filter((item) => item.id !== deletedItemId)
  };
}

function addDeletedItem(items: DeletedVaultItem[] | undefined, item: DeletedVaultItem): DeletedVaultItem[] {
  return [item, ...(items ?? [])].slice(0, 500);
}

function restoreCredential(credential: Credential, existing: Credential[]): Credential {
  const nextId = existing.some((item) => item.id === credential.id) ? crypto.randomUUID() : credential.id;

  return {
    ...credential,
    id: nextId,
    updatedAt: Date.now()
  };
}

function restoreSecureNote(note: SecureNote, existing: SecureNote[]): SecureNote {
  const nextId = existing.some((item) => item.id === note.id) ? crypto.randomUUID() : note.id;

  return {
    ...note,
    id: nextId,
    updatedAt: Date.now()
  };
}

function restoreIdentity(identity: IdentityProfile, existing: IdentityProfile[]): IdentityProfile {
  const nextId = existing.some((item) => item.id === identity.id) ? crypto.randomUUID() : identity.id;

  return {
    ...identity,
    id: nextId,
    updatedAt: Date.now()
  };
}

function restoreFillProfile(profile: FillProfile, existing: FillProfile[]): FillProfile {
  const nextId = existing.some((item) => item.id === profile.id) ? crypto.randomUUID() : profile.id;

  return {
    ...profile,
    id: nextId,
    updatedAt: Date.now()
  };
}

export function touchCredentialInVault(vault: VaultPlain, credentialId: string): VaultPlain {
  return {
    ...vault,
    credentials: vault.credentials.map((item) =>
      item.id === credentialId
        ? {
            ...item,
            lastUsedAt: Date.now(),
            updatedAt: Date.now()
          }
        : item
    )
  };
}

export function upsertVaultSettings(vault: VaultPlain, settings: Partial<VaultPlain['settings']>): VaultPlain {
  return {
    ...vault,
    settings: {
      ...vault.settings,
      ...settings
    }
  };
}
