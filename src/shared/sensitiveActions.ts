import { useEffect, useRef, useState, type SetStateAction } from 'react';
import { unlockEncryptedVault } from './crypto';
import { assertVaultSession, restoreCachedVaultSession } from './vault';

let pendingAuthorization: Promise<boolean> | null = null;
let cancelAuthorization: (() => void) | null = null;
export function cancelSensitiveActions() { cancelAuthorization?.(); }

export async function authorizeSensitiveAction(force = false): Promise<boolean> {
  const session = await restoreCachedVaultSession();
  if (!session) throw new Error('VAULT_LOCKED');
  if (!force && !session.vault.settings.requireMasterPasswordForReveal) return true;
  if (pendingAuthorization) return pendingAuthorization;
  pendingAuthorization = new Promise<boolean>((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.setAttribute('aria-label', '验证主密码');
    dialog.style.cssText = 'border:1px solid #dbe3ee;border-radius:12px;padding:24px;max-width:360px;width:calc(100% - 32px);color:#111827;background:white;font:14px var(--kp-font-ui, system-ui);z-index:2147483647';
    dialog.innerHTML = '<form><h2 style="margin:0 0 12px;font-size:18px">验证主密码</h2><p>查看或复制敏感内容前，请验证主密码。</p><input aria-label="主密码" type="password" autocomplete="current-password" required style="box-sizing:border-box;width:100%;padding:10px"><p role="alert"></p><div style="display:flex;justify-content:flex-end;gap:12px"><button type="button">取消</button><button type="submit">验证</button></div></form>';
    document.body.append(dialog);
    const finish = (ok: boolean) => { cancelAuthorization = null; dialog.close(); dialog.remove(); resolve(ok); };
    cancelAuthorization = () => finish(false);
    dialog.addEventListener('cancel', event => { event.preventDefault(); finish(false); });
    dialog.querySelector('button')!.onclick = () => finish(false);
    dialog.querySelector('form')!.onsubmit = event => {
      event.preventDefault();
      const input = dialog.querySelector('input')!;
      const password = input.value;
      input.value = '';
      void unlockEncryptedVault(password, session.encryptedVault).then(async () => {
        await assertVaultSession(session);
        finish(true);
      }).catch(() => { if (dialog.isConnected) dialog.querySelector('[role="alert"]')!.textContent = '主密码错误或会话已锁定，请重试。'; });
    };
    dialog.showModal();
    dialog.querySelector('input')!.focus();
  });
  try { return await pendingAuthorization; } finally { pendingAuthorization = null; }
}

export function useSecretVisibility(): [boolean, (value: SetStateAction<boolean>) => void] {
  const [visible, setVisible] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!visible) return;
    const timer = window.setTimeout(() => setVisible(false), 30000);
    return () => clearTimeout(timer);
  }, [visible]);
  const toggle = (value: SetStateAction<boolean>) => {
    const next = typeof value === 'function' ? value(visible) : value;
    if (!next) { setVisible(false); return; }
    void authorizeSensitiveAction().then(ok => { if (ok && alive.current) setVisible(true); }).catch(() => setVisible(false));
  };
  return [visible, toggle];
}
