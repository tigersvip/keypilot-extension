import { KDF_ITERATIONS } from './defaults';
import { getSaveInboxPublicKeyFromVault } from './saveInbox';
import type { VaultEncrypted, VaultPlain } from './types';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const VERIFIER_TEXT = 'keypilot-vault-verifier-v1';
const RECOVERY_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(new ArrayBuffer(length));
  crypto.getRandomValues(bytes);
  return bytes;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

async function deriveVaultKey(masterPassword: string, salt: Uint8Array): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(masterPassword),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: toArrayBuffer(salt),
      iterations: KDF_ITERATIONS
    },
    keyMaterial,
    {
      name: 'AES-GCM',
      length: 256
    },
    true,
    ['encrypt', 'decrypt']
  );
}

async function deriveRecoveryKey(recoveryCode: string, salt: Uint8Array): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(normalizeRecoveryCode(recoveryCode)),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: toArrayBuffer(salt),
      iterations: KDF_ITERATIONS
    },
    keyMaterial,
    {
      name: 'AES-GCM',
      length: 256
    },
    true,
    ['encrypt', 'decrypt']
  );
}

function normalizeRecoveryCode(value: string): string {
  const normalized = value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return normalized.startsWith('KP') ? normalized.slice(2) : normalized;
}

export function generateRecoveryCode(): string {
  const bytes = randomBytes(20);
  const chars = Array.from(bytes).map((byte) => RECOVERY_ALPHABET[byte % RECOVERY_ALPHABET.length]);
  const groups: string[] = [];

  for (let index = 0; index < chars.length; index += 4) {
    groups.push(chars.slice(index, index + 4).join(''));
  }

  return `KP-${groups.join('-')}`;
}

export async function exportVaultKey(key: CryptoKey): Promise<string> {
  const rawKey = await crypto.subtle.exportKey('raw', key);
  return bytesToBase64(new Uint8Array(rawKey));
}

export async function importVaultKey(value: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    toArrayBuffer(base64ToBytes(value)),
    {
      name: 'AES-GCM',
      length: 256
    },
    true,
    ['encrypt', 'decrypt']
  );
}

async function encryptStringWithKey(key: CryptoKey, value: string): Promise<{ iv: string; data: string }> {
  const iv = randomBytes(12);
  const encryptedBuffer = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: toArrayBuffer(iv)
    },
    key,
    toArrayBuffer(textEncoder.encode(value))
  );

  return {
    iv: bytesToBase64(iv),
    data: bytesToBase64(new Uint8Array(encryptedBuffer))
  };
}

async function decryptStringWithKey(key: CryptoKey, iv: string, data: string): Promise<string> {
  const decryptedBuffer = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: toArrayBuffer(base64ToBytes(iv))
    },
    key,
    toArrayBuffer(base64ToBytes(data))
  );

  return textDecoder.decode(decryptedBuffer);
}

function serializeVerifier(parts: { iv: string; data: string }): string {
  return `${parts.iv}.${parts.data}`;
}

function parseVerifier(value: string): { iv: string; data: string } {
  const [iv, data] = value.split('.');

  if (!iv || !data) {
    throw new Error('INVALID_VERIFIER');
  }

  return { iv, data };
}

function withSaveInboxPublicKey(encryptedVault: VaultEncrypted, vault: VaultPlain): VaultEncrypted {
  const saveInboxPublicKey = getSaveInboxPublicKeyFromVault(vault.saveInboxKeyPair);

  if (!saveInboxPublicKey) {
    const { saveInboxPublicKey: _saveInboxPublicKey, ...withoutPublicKey } = encryptedVault;
    return withoutPublicKey;
  }

  return {
    ...encryptedVault,
    saveInboxPublicKey
  };
}

export async function createEncryptedVault(
  masterPassword: string,
  vault: VaultPlain,
  recoveryCode?: string
): Promise<{ encryptedVault: VaultEncrypted; key: CryptoKey }> {
  const salt = randomBytes(16);
  const key = await deriveVaultKey(masterPassword, salt);
  const encryptedVaultData = await encryptStringWithKey(key, JSON.stringify(vault));
  const verifier = await encryptStringWithKey(key, VERIFIER_TEXT);
  let encryptedVault: VaultEncrypted = {
    version: 1,
    kdf: {
      name: 'PBKDF2',
      hash: 'SHA-256',
      iterations: KDF_ITERATIONS,
      salt: bytesToBase64(salt)
    },
    cipher: {
      name: 'AES-GCM',
      iv: encryptedVaultData.iv
    },
    encryptedData: encryptedVaultData.data,
    verifier: serializeVerifier(verifier)
  };

  encryptedVault = withSaveInboxPublicKey(encryptedVault, vault);

  if (recoveryCode?.trim()) {
    encryptedVault = await attachRecoveryToEncryptedVault(key, encryptedVault, recoveryCode);
  }

  return {
    key,
    encryptedVault
  };
}

export async function unlockEncryptedVault(
  masterPassword: string,
  encryptedVault: VaultEncrypted
): Promise<{ vault: VaultPlain; key: CryptoKey }> {
  if (encryptedVault.version !== 1 || encryptedVault.kdf.name !== 'PBKDF2' || encryptedVault.cipher.name !== 'AES-GCM') {
    throw new Error('UNSUPPORTED_VAULT');
  }

  const key = await deriveVaultKey(masterPassword, base64ToBytes(encryptedVault.kdf.salt));
  const verifier = parseVerifier(encryptedVault.verifier);
  const verifierText = await decryptStringWithKey(key, verifier.iv, verifier.data);

  if (verifierText !== VERIFIER_TEXT) {
    throw new Error('INVALID_MASTER_PASSWORD');
  }

  const plainJson = await decryptStringWithKey(key, encryptedVault.cipher.iv, encryptedVault.encryptedData);
  const vault = JSON.parse(plainJson) as VaultPlain;

  if (vault.version !== 1 || !Array.isArray(vault.credentials)) {
    throw new Error('CORRUPTED_VAULT');
  }

  return { vault, key };
}

export async function attachRecoveryToEncryptedVault(
  key: CryptoKey,
  encryptedVault: VaultEncrypted,
  recoveryCode: string
): Promise<VaultEncrypted> {
  if (!normalizeRecoveryCode(recoveryCode)) {
    throw new Error('INVALID_RECOVERY_CODE');
  }

  const salt = randomBytes(16);
  const recoveryKey = await deriveRecoveryKey(recoveryCode, salt);
  const wrappedKey = await encryptStringWithKey(recoveryKey, await exportVaultKey(key));

  return {
    ...encryptedVault,
    recovery: {
      version: 1,
      kdf: {
        name: 'PBKDF2',
        hash: 'SHA-256',
        iterations: KDF_ITERATIONS,
        salt: bytesToBase64(salt)
      },
      cipher: {
        name: 'AES-GCM',
        iv: wrappedKey.iv
      },
      encryptedKey: wrappedKey.data,
      createdAt: Date.now()
    }
  };
}

export async function unlockEncryptedVaultWithRecoveryCode(
  recoveryCode: string,
  encryptedVault: VaultEncrypted
): Promise<{ vault: VaultPlain; key: CryptoKey }> {
  if (!encryptedVault.recovery) {
    throw new Error('RECOVERY_NOT_ENABLED');
  }

  if (encryptedVault.recovery.version !== 1 || encryptedVault.recovery.kdf.name !== 'PBKDF2' || encryptedVault.recovery.cipher.name !== 'AES-GCM') {
    throw new Error('UNSUPPORTED_RECOVERY');
  }

  const recoveryKey = await deriveRecoveryKey(recoveryCode, base64ToBytes(encryptedVault.recovery.kdf.salt));
  let exportedVaultKey: string;

  try {
    exportedVaultKey = await decryptStringWithKey(
      recoveryKey,
      encryptedVault.recovery.cipher.iv,
      encryptedVault.recovery.encryptedKey
    );
  } catch {
    throw new Error('INVALID_RECOVERY_CODE');
  }

  const key = await importVaultKey(exportedVaultKey);
  const verifier = parseVerifier(encryptedVault.verifier);
  let verifierText: string;

  try {
    verifierText = await decryptStringWithKey(key, verifier.iv, verifier.data);
  } catch {
    throw new Error('INVALID_RECOVERY_CODE');
  }

  if (verifierText !== VERIFIER_TEXT) {
    throw new Error('INVALID_RECOVERY_CODE');
  }

  const plainJson = await decryptStringWithKey(key, encryptedVault.cipher.iv, encryptedVault.encryptedData);
  const vault = JSON.parse(plainJson) as VaultPlain;

  if (vault.version !== 1 || !Array.isArray(vault.credentials)) {
    throw new Error('CORRUPTED_VAULT');
  }

  return { vault, key };
}

export async function encryptVaultWithExistingKey(
  key: CryptoKey,
  previousEncryptedVault: VaultEncrypted,
  vault: VaultPlain
): Promise<VaultEncrypted> {
  const encryptedVaultData = await encryptStringWithKey(key, JSON.stringify(vault));

  return withSaveInboxPublicKey({
    ...previousEncryptedVault,
    cipher: {
      name: 'AES-GCM',
      iv: encryptedVaultData.iv
    },
    encryptedData: encryptedVaultData.data
  }, vault);
}
