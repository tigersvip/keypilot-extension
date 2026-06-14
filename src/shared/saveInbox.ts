import { getEncryptedVault } from './storage';
import type { PendingLoginCandidate, PendingSaveInboxItem, SaveInboxKeyPair, SaveInboxPublicKey } from './types';

const PENDING_SAVE_INBOX_KEY = 'keypilot.pendingSaveInbox';
const MAX_PENDING_SAVE_INBOX_ITEMS = 50;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function hasChromeStorage(): boolean {
  return Boolean(globalThis.chrome?.storage?.local);
}

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

function base64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function stableJson(value: unknown): string {
  if (!value || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(',')}]`;
  }

  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
    .join(',')}}`;
}

async function computeKeyId(publicKey: JsonWebKey): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(stableJson(publicKey)));
  return base64Url(new Uint8Array(digest)).slice(0, 32);
}

async function importPublicKey(publicKey: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'jwk',
    publicKey,
    {
      name: 'RSA-OAEP',
      hash: 'SHA-256'
    },
    false,
    ['encrypt']
  );
}

async function importPrivateKey(privateKey: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'jwk',
    privateKey,
    {
      name: 'RSA-OAEP',
      hash: 'SHA-256'
    },
    false,
    ['decrypt']
  );
}

export async function generateSaveInboxKeyPair(): Promise<SaveInboxKeyPair> {
  const keys = await crypto.subtle.generateKey(
    {
      name: 'RSA-OAEP',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256'
    },
    true,
    ['encrypt', 'decrypt']
  );
  const publicKey = await crypto.subtle.exportKey('jwk', keys.publicKey);
  const privateKey = await crypto.subtle.exportKey('jwk', keys.privateKey);

  return {
    version: 1,
    algorithm: 'RSA-OAEP-256',
    keyId: await computeKeyId(publicKey),
    publicKey,
    privateKey,
    createdAt: Date.now()
  };
}

export function getSaveInboxPublicKeyFromVault(keyPair?: SaveInboxKeyPair): SaveInboxPublicKey | undefined {
  if (!keyPair?.publicKey || !keyPair.privateKey || !keyPair.keyId) {
    return undefined;
  }

  return {
    version: 1,
    algorithm: 'RSA-OAEP-256',
    keyId: keyPair.keyId,
    publicKey: keyPair.publicKey,
    createdAt: keyPair.createdAt
  };
}

export async function getPendingSaveInbox(): Promise<PendingSaveInboxItem[]> {
  if (hasChromeStorage()) {
    const result = await chrome.storage.local.get(PENDING_SAVE_INBOX_KEY);
    return Array.isArray(result[PENDING_SAVE_INBOX_KEY]) ? (result[PENDING_SAVE_INBOX_KEY] as PendingSaveInboxItem[]) : [];
  }

  const value = window.localStorage.getItem(PENDING_SAVE_INBOX_KEY);
  return value ? (JSON.parse(value) as PendingSaveInboxItem[]) : [];
}

async function savePendingSaveInbox(items: PendingSaveInboxItem[]): Promise<void> {
  if (hasChromeStorage()) {
    await chrome.storage.local.set({ [PENDING_SAVE_INBOX_KEY]: items });
    return;
  }

  window.localStorage.setItem(PENDING_SAVE_INBOX_KEY, JSON.stringify(items));
}

export async function removePendingSaveInboxItems(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const idSet = new Set(ids);
  const items = (await getPendingSaveInbox()).filter((item) => !idSet.has(item.id));
  await savePendingSaveInbox(items);
}

export async function clearPendingSaveInbox(): Promise<void> {
  if (hasChromeStorage()) {
    await chrome.storage.local.remove(PENDING_SAVE_INBOX_KEY);
    return;
  }

  window.localStorage.removeItem(PENDING_SAVE_INBOX_KEY);
}

export async function appendPendingSaveCandidate(candidate: PendingLoginCandidate): Promise<PendingSaveInboxItem> {
  const encryptedVault = await getEncryptedVault();
  const publicKey = encryptedVault?.saveInboxPublicKey;

  if (!publicKey?.publicKey || !publicKey.keyId) {
    throw new Error('SAVE_INBOX_NOT_READY');
  }

  const rsaKey = await importPublicKey(publicKey.publicKey);
  const aesKey = await crypto.subtle.generateKey(
    {
      name: 'AES-GCM',
      length: 256
    },
    true,
    ['encrypt', 'decrypt']
  );
  const iv = randomBytes(12);
  const encryptedPayload = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: toArrayBuffer(iv)
    },
    aesKey,
    toArrayBuffer(textEncoder.encode(JSON.stringify(candidate)))
  );
  const rawAesKey = await crypto.subtle.exportKey('raw', aesKey);
  const encryptedKey = await crypto.subtle.encrypt(
    {
      name: 'RSA-OAEP'
    },
    rsaKey,
    rawAesKey
  );
  const item: PendingSaveInboxItem = {
    version: 1,
    id: crypto.randomUUID(),
    algorithm: 'RSA-OAEP-256/AES-GCM',
    keyId: publicKey.keyId,
    candidateId: candidate.id,
    domain: '',
    title: '',
    usernameHint: '',
    encryptedKey: bytesToBase64(new Uint8Array(encryptedKey)),
    iv: bytesToBase64(iv),
    data: bytesToBase64(new Uint8Array(encryptedPayload)),
    createdAt: Date.now()
  };
  const items = (await getPendingSaveInbox()).filter((existing) => existing.candidateId !== candidate.id);
  await savePendingSaveInbox([item, ...items].slice(0, MAX_PENDING_SAVE_INBOX_ITEMS));

  return item;
}

export async function decryptPendingSaveInboxItem(
  item: PendingSaveInboxItem,
  keyPair: SaveInboxKeyPair
): Promise<PendingLoginCandidate> {
  if (item.keyId !== keyPair.keyId) {
    throw new Error('SAVE_INBOX_KEY_MISMATCH');
  }

  const rsaKey = await importPrivateKey(keyPair.privateKey);
  const rawAesKey = await crypto.subtle.decrypt(
    {
      name: 'RSA-OAEP'
    },
    rsaKey,
    toArrayBuffer(base64ToBytes(item.encryptedKey))
  );
  const aesKey = await crypto.subtle.importKey(
    'raw',
    rawAesKey,
    {
      name: 'AES-GCM',
      length: 256
    },
    false,
    ['decrypt']
  );
  const decryptedPayload = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: toArrayBuffer(base64ToBytes(item.iv))
    },
    aesKey,
    toArrayBuffer(base64ToBytes(item.data))
  );

  return JSON.parse(textDecoder.decode(decryptedPayload)) as PendingLoginCandidate;
}
