import { createEmptyVault, defaultSettings } from './defaults';
import { extractDomain, extractMatchDomain, normalizeMatchUrl, normalizeUrl } from './domain';
import { getRootFaviconUrl } from './icons';
import {
  attachRecoveryToEncryptedVault,
  createEncryptedVault,
  encryptVaultWithExistingKey,
  exportVaultKey,
  importVaultKey,
  unlockEncryptedVault,
  unlockEncryptedVaultWithRecoveryCode
} from './crypto';
import {
  clearUnlockedVaultCache,
  getEncryptedVault,
  getUnlockedVaultCache,
  saveEncryptedVault,
  saveUnlockedVaultCache
} from './storage';
import type { Credential, DeletedVaultItem, FillProfile, IdentityProfile, SecureNote, UnlockedVaultSession, VaultEncrypted, VaultFolder, VaultPlain } from './types';

export async function hasVault(): Promise<boolean> {
  return Boolean(await getEncryptedVault());
}

export async function createVaultSession(masterPassword: string, recoveryCode?: string): Promise<UnlockedVaultSession> {
  const vault = createEmptyVault();
  const { encryptedVault, key } = await createEncryptedVault(masterPassword, vault, recoveryCode);
  await saveEncryptedVault(encryptedVault);
  const session = { key, vault, encryptedVault };
  await cacheVaultSession(session);
  return session;
}

export async function unlockVaultSession(masterPassword: string, encryptedVault?: VaultEncrypted): Promise<UnlockedVaultSession> {
  const storedVault = encryptedVault ?? (await getEncryptedVault());

  if (!storedVault) {
    throw new Error('VAULT_NOT_FOUND');
  }

  const { vault: rawVault, key } = await unlockEncryptedVault(masterPassword, storedVault);
  const vault = normalizeVault(rawVault);
  const session = {
    key,
    vault,
    encryptedVault: storedVault
  };
  await cacheVaultSession(session);
  return session;
}

export async function unlockVaultWithRecoveryCode(recoveryCode: string, encryptedVault?: VaultEncrypted): Promise<UnlockedVaultSession> {
  const storedVault = encryptedVault ?? (await getEncryptedVault());

  if (!storedVault) {
    throw new Error('VAULT_NOT_FOUND');
  }

  const { vault: rawVault, key } = await unlockEncryptedVaultWithRecoveryCode(recoveryCode, storedVault);
  const vault = normalizeVault(rawVault);
  const session = {
    key,
    vault,
    encryptedVault: storedVault
  };
  await cacheVaultSession(session);
  return session;
}

function normalizeVault(vault: VaultPlain): VaultPlain {
  const settings = {
    ...defaultSettings,
    ...vault.settings
  };

  if (settings.lockOnStartup && !settings.lockOnStartupUserSet) {
    settings.lockOnStartup = false;
    settings.autoLockMinutes = 0;
  }

  return {
    ...vault,
    secureNotes: vault.secureNotes ?? [],
    identities: vault.identities ?? [],
    fillProfiles: vault.fillProfiles ?? [],
    folders: vault.folders ?? [],
    deletedItems: vault.deletedItems ?? [],
    settings
  };
}

export async function persistVaultSession(session: UnlockedVaultSession, vault: VaultPlain): Promise<UnlockedVaultSession> {
  const encryptedVault = await encryptVaultWithExistingKey(session.key, session.encryptedVault, vault);
  await saveEncryptedVault(encryptedVault);
  const nextSession = {
    key: session.key,
    vault,
    encryptedVault
  };
  await cacheVaultSession(nextSession);
  return nextSession;
}

export async function changeVaultMasterPassword(
  session: UnlockedVaultSession,
  currentMasterPassword: string,
  nextMasterPassword: string,
  recoveryCode?: string
): Promise<UnlockedVaultSession> {
  await unlockEncryptedVault(currentMasterPassword, session.encryptedVault);
  return resetVaultMasterPassword(session, nextMasterPassword, recoveryCode);
}

export async function resetVaultMasterPassword(
  session: UnlockedVaultSession,
  nextMasterPassword: string,
  recoveryCode?: string
): Promise<UnlockedVaultSession> {
  const { encryptedVault, key } = await createEncryptedVault(nextMasterPassword, session.vault, recoveryCode);
  await saveEncryptedVault(encryptedVault);
  const nextSession = {
    key,
    vault: session.vault,
    encryptedVault
  };
  await cacheVaultSession(nextSession);
  return nextSession;
}

export async function enableVaultRecovery(session: UnlockedVaultSession, recoveryCode: string): Promise<UnlockedVaultSession> {
  const encryptedVault = await attachRecoveryToEncryptedVault(session.key, session.encryptedVault, recoveryCode);
  await saveEncryptedVault(encryptedVault);
  const nextSession = {
    ...session,
    encryptedVault
  };
  await cacheVaultSession(nextSession);
  return nextSession;
}

export async function disableVaultRecovery(session: UnlockedVaultSession): Promise<UnlockedVaultSession> {
  const { recovery: _recovery, ...encryptedVault } = session.encryptedVault;
  await saveEncryptedVault(encryptedVault);
  const nextSession = {
    ...session,
    encryptedVault
  };
  await cacheVaultSession(nextSession);
  return nextSession;
}

export async function cacheVaultSession(session: UnlockedVaultSession): Promise<void> {
  if (session.vault.settings.highSecurityMode || session.vault.settings.lockOnStartup) {
    await clearUnlockedVaultCache();
    return;
  }

  await saveUnlockedVaultCache({
    vault: session.vault,
    encryptedVault: session.encryptedVault,
    exportedKey: await exportVaultKey(session.key),
    cachedAt: Date.now()
  });
}

export async function restoreCachedVaultSession(): Promise<UnlockedVaultSession | null> {
  const cache = await getUnlockedVaultCache();

  if (!cache) {
    return null;
  }

  if (cache.vault.settings.highSecurityMode || cache.vault.settings.lockOnStartup) {
    await clearUnlockedVaultCache();
    return null;
  }

  const autoLockMinutes = cache.vault.settings.autoLockMinutes;

  if (autoLockMinutes > 0 && Date.now() - cache.cachedAt > autoLockMinutes * 60 * 1000) {
    await clearUnlockedVaultCache();
    return null;
  }

  const vault = normalizeVault(cache.vault);

  return {
    key: await importVaultKey(cache.exportedKey),
    vault,
    encryptedVault: cache.encryptedVault
  };
}

export async function clearVaultSessionCache(): Promise<void> {
  await clearUnlockedVaultCache();
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

export function deleteFillProfileFromVault(vault: VaultPlain, profileId: string): VaultPlain {
  const profile = (vault.fillProfiles ?? []).find((item) => item.id === profileId);
  if (!profile) return vault;

  return {
    ...vault,
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
            ...credential,
            domain: extractDomain(credential.url),
            matchUrl,
            matchDomain: matchUrl ? extractMatchDomain(matchUrl) : undefined,
            iconUrl: credential.iconUrl?.trim() || undefined,
            iconType: credential.iconType ?? (credential.iconUrl ? 'favicon' : 'default'),
            formFields: credential.formFields?.filter((field) => field.value).slice(0, 40),
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
