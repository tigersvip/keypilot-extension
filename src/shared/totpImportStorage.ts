import { decryptVaultWithKey, encryptVaultWithExistingKey } from './crypto';
import { getEncryptedVault, saveEncryptedVault, withVaultLock } from './storage';
import { assertVaultSession, cacheVaultSession, normalizeVault } from './vault';
import { totpFingerprint, validateImportAccount, type TotpImportAccount } from './totpImport';
import type { UnlockedVaultSession } from './types';

export async function importTotpAccounts(session: UnlockedVaultSession, input: TotpImportAccount[]) {
  if (!input.length || input.length > 1000) throw new Error('请选择 1–1000 个账号导入。');
  const accounts = input.map(validateImportAccount);
  return withVaultLock(async () => {
    await assertVaultSession(session);
    const current = await getEncryptedVault();
    if (!current || current.kdf.salt !== session.encryptedVault.kdf.salt) throw new Error('VAULT_LOCKED');
    const vault = normalizeVault(await decryptVaultWithKey(session.key, current));
    const known = new Set((vault.totpAccounts ?? []).filter(item => !item.deletedAt).map(totpFingerprint));
    const now = Date.now();
    const additions = accounts.flatMap(account => {
      const key = totpFingerprint(account);
      if (known.has(key)) return [];
      known.add(key);
      return [{ ...account, id: crypto.randomUUID(), createdAt: now, updatedAt: now }];
    });
    const nextVault = { ...vault, totpAccounts: [...(vault.totpAccounts ?? []), ...additions] };
    const encryptedVault = additions.length ? await encryptVaultWithExistingKey(session.key, current, nextVault) : current;
    if (additions.length) await saveEncryptedVault(encryptedVault, nextVault);
    const next = { ...session, vault: nextVault, encryptedVault };
    await cacheVaultSession(next);
    return { session: next, added: additions.length, skipped: accounts.length - additions.length };
  });
}
