import { t, getLanguage } from './i18n';
import { useState } from 'react';
import { backupStatus, exportEncryptedBackup } from './backupStatus';
import { persistVaultSession, upsertVaultSettings } from './vault';
import type { UnlockedVaultSession } from './types';
import './shared-ui.css';
import { BackupContents } from './BackupContents';

export function BackupStatus({ session, onChange, reminderOnly = false }: {
  session: UnlockedVaultSession; onChange: (session: UnlockedVaultSession) => void; reminderOnly?: boolean;
}) {
  const status = backupStatus(session.vault);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [pendingReminder, setPendingReminder] = useState<boolean>();
  if (reminderOnly && !status.due) return null;
  async function backup() {
    setBusy(true); setMessage('');
    try { onChange(await exportEncryptedBackup()); setMessage(t("已发起加密备份下载，请保留下载的文件。")); }
    catch { setMessage(t("导出失败，请解锁密码库后重试。")); }
    finally { setBusy(false); }
  }
  async function toggle(enabled: boolean) {
    setPendingReminder(enabled);
    setBusy(true);
    try { onChange(await persistVaultSession(session, upsertVaultSettings(session.vault, {backupReminderEnabled: enabled}))); }
    catch { setMessage(t("提醒设置保存失败，请重试。")); }
    finally { setPendingReminder(undefined); setBusy(false); }
  }
  return <section className="kp-backup-status" aria-label={t("备份状态")}>
    <div><strong>{status.due ? t("建议备份密码库") : t("完整加密备份")}</strong>
      <p>{status.previous ? t("上次发起备份导出：{0}", [new Date(status.previous.requestedAt).toLocaleString(getLanguage())]) : t("还没有导出过加密备份。")}</p>
      {status.previous && <p>{t("此后新增 ")}{status.added}{t(" 条 · 修改 ")}{status.changed}{t(" 条 · 移除 ")}{status.removed}{t(" 条")}</p>}
      {status.settingsChanged && <p role="status">{t("设置或规则已变化，建议重新备份。")}</p>}
      {status.settingsUntracked && <p>{t("旧版备份未记录设置状态，建议重新备份一次。")}</p>}
    </div>
    <button type="button" disabled={busy} onClick={() => void backup()}>{t("导出完整加密备份")}</button>
    <label><input type="checkbox" checked={pendingReminder ?? session.vault.settings.backupReminderEnabled !== false} disabled={busy} onChange={event => void toggle(event.target.checked)} />{t("备份提醒")}</label>
    {message && <p role="status">{message}</p>}
    {!reminderOnly && <BackupContents vault={session.vault} />}
    {!reminderOnly && <p className="kp-backup-scope">{t("账号 CSV / 账号 JSON、.kpfill 和规则导出只包含对应类别，不能代替完整备份。")}</p>}
  </section>;
}
