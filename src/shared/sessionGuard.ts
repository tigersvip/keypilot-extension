import { useEffect, useRef } from 'react';
import { isVaultSessionActive, SESSION_STATE_KEY, withVaultLock } from './storage';
import { clearExpiredSession, touchVaultActivity } from './vault';
import type { UnlockedVaultSession } from './types';
import { cancelSensitiveActions } from './sensitiveActions';

export function useSessionGuard(session: UnlockedVaultSession | null, onLock: () => void) {
  const callback = useRef(onLock);
  const currentId = useRef(session?.sessionId);
  callback.current = onLock;
  currentId.current = session?.sessionId;
  useEffect(() => {
    if (!session?.sessionId) return;
    let disposed = false;
    let lastActivity = 0;
    const check = async () => {
      // A restore can rotate the session while its encrypted data/cache are being written.
      // Check after that transaction, and discard results belonging to the previous render.
      const active = await withVaultLock(() => isVaultSessionActive(session.sessionId!)).catch(() => false);
      if (!disposed && currentId.current === session.sessionId && !active) {
        cancelSensitiveActions(); callback.current();
        void clearExpiredSession(session.sessionId!).catch(() => undefined);
      }
    };
    const changed = (changes: Record<string, chrome.storage.StorageChange>) => {
      if (SESSION_STATE_KEY in changes) void check();
    };
    const activity = (event: Event) => {
      if (!event.isTrusted || Date.now() - lastActivity < 15000) return;
      lastActivity = Date.now();
      void touchVaultActivity(session.sessionId!).catch(() => {
        if (!disposed && currentId.current === session.sessionId) callback.current();
      });
    };
    const rejection = (event: PromiseRejectionEvent) => {
      const message = event.reason instanceof Error ? event.reason.message : '';
      if (message === 'VAULT_WRITE_CONFLICT') {
        event.preventDefault();window.alert('这条记录已在另一个页面修改。本次保存已取消，请重新打开记录后再保存。');
      } else if (message === 'VAULT_LOCKED') { event.preventDefault();callback.current(); }
    };
    window.addEventListener('unhandledrejection', rejection);
    const timer = window.setInterval(() => void check(), 1000);
    globalThis.chrome?.storage?.onChanged?.addListener(changed);
    window.addEventListener('storage', check);
    window.addEventListener('focus', check);
    document.addEventListener('pointerdown', activity);
    document.addEventListener('keydown', activity);
    void check();
    return () => {
      disposed = true;
      window.removeEventListener('unhandledrejection', rejection);
      clearInterval(timer);
      globalThis.chrome?.storage?.onChanged?.removeListener(changed);
      window.removeEventListener('storage', check);
      window.removeEventListener('focus', check);
      document.removeEventListener('pointerdown', activity);
      document.removeEventListener('keydown', activity);
    };
  }, [session?.sessionId]);
}
