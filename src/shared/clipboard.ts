import { authorizeSensitiveAction } from './sensitiveActions';
import { assertVaultSession, restoreCachedVaultSession } from './vault';

export async function copyProtectedText(input: string | (() => Promise<string>), sensitive = true): Promise<boolean> {
  const session = await restoreCachedVaultSession();
  if (!session) throw new Error('VAULT_LOCKED');
  if (sensitive && !await authorizeSensitiveAction()) return false;
  const value = typeof input === 'function' ? await input() : input;
  await assertVaultSession(session);
  const seconds = sensitive ? session.vault.settings.clearClipboardSeconds : 0;
  if (globalThis.chrome?.runtime?.id) {
    const response = await chrome.runtime.sendMessage({ type: 'KEYPILOT_COPY_TEXT', value, seconds });
    if (!response?.ok) throw new Error(response?.error || 'CLIPBOARD_UNAVAILABLE');
  } else {
    await navigator.clipboard.writeText(value);
    if (seconds > 0) window.setTimeout(async () => {
      if (await navigator.clipboard.readText().catch(() => null) === value) await navigator.clipboard.writeText('');
    }, seconds * 1000);
  }
  return true;
}
