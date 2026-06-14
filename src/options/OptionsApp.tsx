import { useEffect, useMemo, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import {
  AlertTriangle,
  AppWindow,
  BadgeCheck,
  BellDot,
  CircleHelp,
  Clipboard,
  Database,
  Download,
  Gift,
  Globe,
  HardDrive,
  Import,
  Keyboard,
  KeyRound,
  Lock,
  MonitorSmartphone,
  RefreshCw,
  Save,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  Upload,
  UserCircle
} from 'lucide-react';
import { exportRoboFormCsv } from '../shared/csvExport';
import { generateRecoveryCode } from '../shared/crypto';
import {
  clearDiagnosticLogEntries,
  DEFAULT_DIAGNOSTIC_LOG_LIMIT,
  DEFAULT_DIAGNOSTIC_LOG_RETENTION_DAYS,
  getDiagnosticLogEntries
} from '../shared/diagnosticsLog';
import { clearEncryptedVault, getEncryptedVault, saveEncryptedVault } from '../shared/storage';
import type { DiagnosticLogEntry, UnlockedVaultSession, VaultEncrypted, VaultPlain } from '../shared/types';
import {
  changeVaultMasterPassword,
  clearVaultSessionCache,
  disableVaultRecovery,
  enableVaultRecovery,
  persistVaultSession,
  restoreCachedVaultSession,
  unlockVaultSession,
  upsertVaultSettings
} from '../shared/vault';

type SectionKey =
  | 'general'
  | 'account'
  | 'security'
  | 'device'
  | 'autofill'
  | 'autosave'
  | 'hotkeys'
  | 'domains'
  | 'advanced'
  | 'billing'
  | 'apps'
  | 'referral';

type NoticeKind = 'success' | 'error' | 'info';

interface Notice {
  kind: NoticeKind;
  text: string;
}

const SECTIONS: Array<{ key: SectionKey; label: string; icon: ReactNode }> = [
  { key: 'general', label: '一般', icon: <Settings size={20} aria-hidden="true" /> },
  { key: 'account', label: '账户&数据', icon: <UserCircle size={20} aria-hidden="true" /> },
  { key: 'security', label: '登录与安全', icon: <Lock size={20} aria-hidden="true" /> },
  { key: 'device', label: '设备&活动', icon: <MonitorSmartphone size={20} aria-hidden="true" /> },
  { key: 'autofill', label: '自动填表', icon: <SlidersHorizontal size={20} aria-hidden="true" /> },
  { key: 'autosave', label: '自动保存', icon: <Save size={20} aria-hidden="true" /> },
  { key: 'hotkeys', label: '快捷键', icon: <Keyboard size={20} aria-hidden="true" /> },
  { key: 'domains', label: '域名', icon: <Globe size={20} aria-hidden="true" /> },
  { key: 'advanced', label: '高级设置', icon: <RefreshCw size={20} aria-hidden="true" /> },
  { key: 'billing', label: '许可&版本', icon: <BadgeCheck size={20} aria-hidden="true" /> },
  { key: 'apps', label: '应用程序', icon: <AppWindow size={20} aria-hidden="true" /> },
  { key: 'referral', label: '分享', icon: <Gift size={20} aria-hidden="true" /> }
];

function getErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  if (message === 'VAULT_NOT_FOUND') return '未找到本地 Vault。';
  if (message === 'INVALID_MASTER_PASSWORD' || message === 'The operation failed for an operation-specific reason') return '主密码错误，请重新输入。';
  if (message === 'CORRUPTED_VAULT') return 'Vault 数据损坏，无法读取。';
  if (message === 'UNSUPPORTED_VAULT') return 'Vault 版本暂不兼容。';
  if (message === 'PASSWORD_MISMATCH') return '两次输入的新主密码不一致。';
  if (message === 'PASSWORD_TOO_SHORT') return '新主密码至少需要 8 位。';
  return message || '操作失败，请稍后重试。';
}

function extensionUrl(path: string): string {
  return globalThis.chrome?.runtime?.getURL?.(path) ?? path;
}

function openExtensionPage(path: string) {
  const url = extensionUrl(path);

  try {
    void chrome.tabs.create({ url, active: true });
    return;
  } catch {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

function timestampForFile(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function splitDomainList(value: string): string[] {
  return value
    .split(/\r?\n|,/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function vaultItemCount(vault: VaultPlain): number {
  return (
    vault.credentials.length +
    (vault.secureNotes?.length ?? 0) +
    (vault.identities?.length ?? 0) +
    (vault.fillProfiles?.length ?? 0)
  );
}

export function OptionsApp() {
  const [status, setStatus] = useState<'checking' | 'empty' | 'locked' | 'unlocked'>('checking');
  const [activeSection, setActiveSection] = useState<SectionKey>('general');
  const [encryptedVault, setEncryptedVault] = useState<VaultEncrypted | null>(null);
  const [session, setSession] = useState<UnlockedVaultSession | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [masterPassword, setMasterPassword] = useState('');
  const [unlocking, setUnlocking] = useState(false);
  const [blacklistDraft, setBlacklistDraft] = useState('');
  const [inlineBlacklistDraft, setInlineBlacklistDraft] = useState('');
  const [backupPassword, setBackupPassword] = useState('');
  const [recoveryCodeToShow, setRecoveryCodeToShow] = useState('');
  const [passwordDraft, setPasswordDraft] = useState({ current: '', next: '', confirm: '' });
  const [diagnosticLogs, setDiagnosticLogs] = useState<DiagnosticLogEntry[]>([]);

  useEffect(() => {
    void loadVault();
  }, []);

  useEffect(() => {
    if (!session) return;
    setBlacklistDraft(session.vault.settings.blacklist.join('\n'));
    setInlineBlacklistDraft((session.vault.settings.inlineBlacklist ?? []).join('\n'));
  }, [session]);

  useEffect(() => {
    if (activeSection === 'advanced' && session) {
      void loadDiagnosticLogs();
    }
  }, [
    activeSection,
    session?.vault.settings.diagnosticLogging,
    session?.vault.settings.diagnosticLogLimit,
    session?.vault.settings.diagnosticLogRetentionDays
  ]);

  const stats = useMemo(() => {
    if (!session) return null;

    return {
      items: vaultItemCount(session.vault),
      credentials: session.vault.credentials.length,
      fillProfiles: session.vault.fillProfiles?.length ?? 0,
      folders: session.vault.folders?.length ?? 0,
      siteRules: session.vault.settings.siteRules?.length ?? 0,
      hiddenDomains: session.vault.settings.inlineBlacklist?.length ?? 0,
      saveBlockedDomains: session.vault.settings.blacklist.length
    };
  }, [session]);

  async function loadVault() {
    setStatus('checking');
    const storedVault = await getEncryptedVault();
    setEncryptedVault(storedVault);

    if (!storedVault) {
      setSession(null);
      setStatus('empty');
      return;
    }

    const cachedSession = await restoreCachedVaultSession();

    if (cachedSession) {
      setSession(cachedSession);
      setEncryptedVault(cachedSession.encryptedVault);
      setStatus('unlocked');
      if (cachedSession.saveInboxJustEnabled) {
        setNotice({ kind: 'success', text: '锁定态保存已启用。以后 Vault 锁定时也可以先加密暂存登录信息。' });
      }
      return;
    }

    setSession(null);
    setStatus('locked');
  }

  async function handleUnlock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!masterPassword.trim()) return;

    setUnlocking(true);
    try {
      const nextSession = await unlockVaultSession(masterPassword, encryptedVault ?? undefined);
      setSession(nextSession);
      setEncryptedVault(nextSession.encryptedVault);
      setStatus('unlocked');
      setMasterPassword('');
      setNotice({
        kind: 'success',
        text: nextSession.saveInboxJustEnabled ? 'Vault 已解锁，锁定态保存已启用。' : 'Vault 已解锁，可以修改设置。'
      });
    } catch (error) {
      setNotice({ kind: 'error', text: getErrorMessage(error) });
    } finally {
      setUnlocking(false);
    }
  }

  async function persist(vault: VaultPlain, message = '设置已保存。') {
    if (!session) return;

    const nextSession = await persistVaultSession(session, vault);
    setSession(nextSession);
    setEncryptedVault(nextSession.encryptedVault);
    setNotice({ kind: 'success', text: message });
  }

  async function updateSettings(settings: Partial<VaultPlain['settings']>, message = '设置已保存。') {
    if (!session) return;
    await persist(upsertVaultSettings(session.vault, settings), message);
  }

  async function loadDiagnosticLogs() {
    const settings = session?.vault.settings;

    if (!settings) {
      setDiagnosticLogs([]);
      return;
    }

    const logs = await getDiagnosticLogEntries({
      limit: settings.diagnosticLogLimit,
      retentionDays: settings.diagnosticLogRetentionDays
    });
    setDiagnosticLogs(logs);
  }

  async function clearDiagnosticLogs() {
    const confirmed = window.confirm('确定清空本地识别诊断日志吗？这不会影响账号、密码和站点规则。');
    if (!confirmed) return;

    await clearDiagnosticLogEntries();
    setDiagnosticLogs([]);
    setNotice({ kind: 'success', text: '识别诊断日志已清空。' });
  }

  async function toggleHighSecurityMode(checked: boolean) {
    await updateSettings(
      checked
        ? {
            highSecurityMode: true,
            lockOnStartup: true,
            lockOnStartupUserSet: true
          }
        : {
            highSecurityMode: false
          },
      checked ? '高安全模式已开启，已清除解锁缓存。' : '高安全模式已关闭。'
    );
  }

  async function lockOptionsPage() {
    await clearVaultSessionCache();
    setSession(null);
    setStatus(encryptedVault ? 'locked' : 'empty');
    setNotice({ kind: 'info', text: 'Vault 已锁定。' });
  }

  async function resetVault() {
    const confirmed = window.confirm('确定删除本机加密 Vault？此操作无法撤销。');
    if (!confirmed) return;

    await clearVaultSessionCache();
    await clearEncryptedVault();
    setEncryptedVault(null);
    setSession(null);
    setStatus('empty');
    setNotice({ kind: 'success', text: '本地 Vault 已重置。' });
  }

  function exportEncryptedBackup() {
    if (!session) return;
    const blob = new Blob([JSON.stringify(session.encryptedVault, null, 2)], { type: 'application/json;charset=utf-8' });
    downloadBlob(blob, `keypilot-vault-backup-${timestampForFile()}.json`);
    setNotice({ kind: 'success', text: '已导出加密备份 JSON。' });
  }

  function exportCsv() {
    if (!session) return;
    const confirmed = window.confirm('RoboForm CSV 会包含明文密码。请只保存在可信位置，用完后及时删除。是否继续？');
    if (!confirmed) return;

    const blob = new Blob([exportRoboFormCsv(session.vault.credentials)], { type: 'text/csv;charset=utf-8' });
    downloadBlob(blob, `keypilot-roboform-export-${timestampForFile()}.csv`);
    setNotice({ kind: 'success', text: '已导出 RoboForm CSV。' });
  }

  async function importEncryptedBackup(file: File | undefined) {
    if (!file) return;

    if (!backupPassword) {
      setNotice({ kind: 'error', text: '请先输入该备份对应的主密码。' });
      return;
    }

    try {
      const backup = JSON.parse(await file.text()) as VaultEncrypted;
      const nextSession = await unlockVaultSession(backupPassword, backup);
      await saveEncryptedVault(backup);
      setSession(nextSession);
      setEncryptedVault(backup);
      setStatus('unlocked');
      setBackupPassword('');
      setNotice({ kind: 'success', text: '加密备份已导入并解锁。' });
    } catch (error) {
      setNotice({ kind: 'error', text: getErrorMessage(error) });
    }
  }

  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session) return;

    if (passwordDraft.next !== passwordDraft.confirm) {
      setNotice({ kind: 'error', text: getErrorMessage(new Error('PASSWORD_MISMATCH')) });
      return;
    }

    if (passwordDraft.next.length < 8) {
      setNotice({ kind: 'error', text: getErrorMessage(new Error('PASSWORD_TOO_SHORT')) });
      return;
    }

    try {
      const nextSession = await changeVaultMasterPassword(session, passwordDraft.current, passwordDraft.next);
      setSession(nextSession);
      setEncryptedVault(nextSession.encryptedVault);
      setPasswordDraft({ current: '', next: '', confirm: '' });
      setNotice({ kind: 'success', text: '主密码已修改。' });
    } catch (error) {
      setNotice({ kind: 'error', text: getErrorMessage(error) });
    }
  }

  async function generateRecovery() {
    if (!session) return;

    const code = generateRecoveryCode();
    const nextSession = await enableVaultRecovery(session, code);
    setSession(nextSession);
    setEncryptedVault(nextSession.encryptedVault);
    setRecoveryCodeToShow(code);
    setNotice({ kind: 'success', text: '恢复码已生成，请立即离线保存。' });
  }

  async function disableRecovery() {
    if (!session) return;
    const confirmed = window.confirm('关闭恢复码后，忘记主密码将无法恢复。确定关闭？');
    if (!confirmed) return;

    const nextSession = await disableVaultRecovery(session);
    setSession(nextSession);
    setEncryptedVault(nextSession.encryptedVault);
    setRecoveryCodeToShow('');
    setNotice({ kind: 'success', text: '恢复码已关闭。' });
  }

  async function copyRecoveryCode() {
    if (!recoveryCodeToShow) return;

    try {
      await navigator.clipboard.writeText(recoveryCodeToShow);
      setNotice({ kind: 'success', text: '恢复码已复制。' });
    } catch {
      setNotice({ kind: 'error', text: '复制失败，请手动保存恢复码。' });
    }
  }

  function renderContent() {
    if (status === 'checking') {
      return <LoadingPanel />;
    }

    if (status === 'empty') {
      return <EmptyVaultPanel onOpenVault={() => openExtensionPage('vault.html')} />;
    }

    if (status === 'locked' || !session || !stats) {
      return (
        <UnlockPanel
          password={masterPassword}
          unlocking={unlocking}
          onPasswordChange={setMasterPassword}
          onSubmit={handleUnlock}
          onOpenVault={() => openExtensionPage('vault.html')}
        />
      );
    }

    const settings = session.vault.settings;

    if (activeSection === 'general') {
      return (
        <SettingsSection title="一般" description="控制 KeyPilot 的默认入口、界面语言和工具栏行为。">
          <SettingRow
            title="语言"
            description="选择 KeyPilot 应用界面语言。"
            control={
              <select value={settings.language} onChange={(event) => void updateSettings({ language: event.currentTarget.value as VaultPlain['settings']['language'] })}>
                <option value="zh-CN">简体中文 (Simplified Chinese)</option>
                <option value="en-US">English (United States)</option>
              </select>
            }
          />
          <SettingRow
            title="打开扩展和起始页时显示"
            description="每次打开 KeyPilot 扩展或起始页时，默认使用选定的排序方式。"
            control={
              <select value={settings.defaultHomeSort} onChange={(event) => void updateSettings({ defaultHomeSort: event.currentTarget.value as VaultPlain['settings']['defaultHomeSort'] })}>
                <option value="favorite">常用登录名</option>
                <option value="recent">最近使用</option>
                <option value="az">A-Z</option>
              </select>
            }
          />
          <ToggleRow title="登录 KeyPilot 时打开起始页" checked={settings.openStartPageOnLogin} onChange={(checked) => void updateSettings({ openStartPageOnLogin: checked })} />
          <ToggleRow
            title="在空白标签页点击扩展时打开起始页"
            description="如果当前是浏览器空白页，点击 KeyPilot 扩展按钮会打开 KeyPilot 起始页。"
            checked={settings.openStartPageOnToolbarClick}
            onChange={(checked) => void updateSettings({ openStartPageOnToolbarClick: checked })}
          />
          <ToggleRow
            title="同时显示书签和登录信息"
            description="在登录名账户视图中同时显示书签类入口。"
            checked={settings.showLoginBookmarksTogether}
            onChange={(checked) => void updateSettings({ showLoginBookmarksTogether: checked })}
          />
          <ToggleRow
            title="在浏览器右键菜单中显示 KeyPilot 指令"
            description="KeyPilot 指令会出现在浏览器右键菜单中。"
            checked={settings.showContextMenuCommands}
            onChange={(checked) => void updateSettings({ showContextMenuCommands: checked })}
          />
          <ToggleRow
            title="弹窗底部显示紧凑工具栏"
            description="在扩展弹窗底部显示导入、新建、自动保存等常用操作。"
            checked={settings.useCompactPopupToolbar}
            onChange={(checked) => void updateSettings({ useCompactPopupToolbar: checked })}
          />
          <ToggleRow
            title="在网页底部显示 KeyPilot 工具栏"
            description="保留给后续完整网页工具栏使用；当前网页内仍优先使用字段旁浮层。"
            checked={settings.showWebBottomToolbar}
            onChange={(checked) => void updateSettings({ showWebBottomToolbar: checked })}
          />
        </SettingsSection>
      );
    }

    if (activeSection === 'account') {
      return (
        <SettingsSection title="账户&数据" description="管理本地 Vault、导出备份和数据迁移。">
          <div className="metrics-grid">
            <Metric label="全部项目" value={stats.items} />
            <Metric label="登录账号" value={stats.credentials} />
            <Metric label="身份资料" value={stats.fillProfiles} />
            <Metric label="文件夹" value={stats.folders} />
          </div>
          <ActionRow
            icon={<Database size={20} aria-hidden="true" />}
            title="本地 Vault"
            description="已检测到本机加密 Vault。明文密码只在解锁会话中存在。"
            action={<span className="status-pill success">已创建</span>}
          />
          <div className="action-grid">
            <button className="secondary-action" type="button" onClick={exportEncryptedBackup}>
              <Download size={17} aria-hidden="true" />
              导出加密备份
            </button>
            <button className="secondary-action" type="button" onClick={exportCsv}>
              <Download size={17} aria-hidden="true" />
              导出 RoboForm CSV
            </button>
          </div>
          <label className="field-block">
            <span>导入加密备份</span>
            <input type="password" value={backupPassword} onChange={(event) => setBackupPassword(event.currentTarget.value)} placeholder="备份对应主密码" />
          </label>
          <label className="file-action">
            <Upload size={17} aria-hidden="true" />
            选择 JSON 备份文件
            <input type="file" accept="application/json,.json" onChange={(event) => void importEncryptedBackup(event.currentTarget.files?.[0])} />
          </label>
          <DangerZone onReset={resetVault} />
        </SettingsSection>
      );
    }

    if (activeSection === 'security') {
      return (
        <SettingsSection title="登录与安全" description="设置自动锁定、高安全模式、恢复码和主密码。">
          <SettingRow
            title="自动锁定时间"
            description="超过该时间未操作后，KeyPilot 会清除解锁会话。"
            control={
              <select value={settings.autoLockMinutes} onChange={(event) => void updateSettings({ autoLockMinutes: Number(event.currentTarget.value) })}>
                <option value={0}>不自动锁定</option>
                <option value={5}>5 分钟</option>
                <option value={15}>15 分钟</option>
                <option value={30}>30 分钟</option>
                <option value={60}>1 小时</option>
              </select>
            }
          />
          <ToggleRow title="启动时自动锁定" checked={settings.lockOnStartup} onChange={(checked) => void updateSettings({ lockOnStartup: checked, lockOnStartupUserSet: true })} />
          <ToggleRow
            title="高安全模式"
            description="开启后不缓存明文 Vault 和解锁密钥。关闭弹窗、刷新后台页或浏览器重启后，需要重新输入主密码。"
            checked={settings.highSecurityMode}
            onChange={(checked) => void toggleHighSecurityMode(checked)}
          />
          <ToggleRow
            title="查看密码时要求主密码"
            description="复制密码仍可使用；查看明文密码时会提高安全门槛。"
            checked={settings.requireMasterPasswordForReveal}
            onChange={(checked) => void updateSettings({ requireMasterPasswordForReveal: checked })}
          />
          <ActionRow
            icon={<KeyRound size={20} aria-hidden="true" />}
            title={session.encryptedVault.recovery ? '恢复码已启用' : '恢复码未启用'}
            description={session.encryptedVault.recovery ? '忘记主密码时可用恢复码重置主密码。' : '建议生成恢复码并离线保存，防止忘记主密码。'}
            action={
              <div className="inline-actions">
                <button className="secondary-action small" type="button" onClick={() => void generateRecovery()}>
                  {session.encryptedVault.recovery ? '重新生成' : '生成恢复码'}
                </button>
                {session.encryptedVault.recovery ? (
                  <button className="text-danger small" type="button" onClick={() => void disableRecovery()}>
                    关闭
                  </button>
                ) : null}
              </div>
            }
          />
          {recoveryCodeToShow ? (
            <div className="recovery-card">
              <span>请立即保存恢复码，KeyPilot 不会再次显示。</span>
              <code>{recoveryCodeToShow}</code>
              <button className="secondary-action small" type="button" onClick={() => void copyRecoveryCode()}>
                复制恢复码
              </button>
            </div>
          ) : null}
          <form className="password-form" onSubmit={(event) => void changePassword(event)}>
            <h3>修改主密码</h3>
            <div className="form-grid">
              <label className="field-block">
                <span>当前主密码</span>
                <input type="password" value={passwordDraft.current} onChange={(event) => setPasswordDraft((draft) => ({ ...draft, current: event.currentTarget.value }))} />
              </label>
              <label className="field-block">
                <span>新主密码</span>
                <input type="password" value={passwordDraft.next} onChange={(event) => setPasswordDraft((draft) => ({ ...draft, next: event.currentTarget.value }))} />
              </label>
              <label className="field-block">
                <span>确认新主密码</span>
                <input type="password" value={passwordDraft.confirm} onChange={(event) => setPasswordDraft((draft) => ({ ...draft, confirm: event.currentTarget.value }))} />
              </label>
            </div>
            <button className="primary-action" type="submit">
              保存主密码
            </button>
          </form>
        </SettingsSection>
      );
    }

    if (activeSection === 'device') {
      return (
        <SettingsSection title="设备&活动" description="查看本机浏览器会话状态并管理当前设备。">
          <ActionRow
            icon={<HardDrive size={20} aria-hidden="true" />}
            title="当前设备"
            description={`${navigator.userAgent.includes('Edg') ? 'Microsoft Edge' : 'Chromium 浏览器'} · 本地专业版 · ${new Date().toLocaleString('zh-CN')}`}
            action={<span className="status-pill success">已解锁</span>}
          />
          <ActionRow
            icon={<ShieldCheck size={20} aria-hidden="true" />}
            title="本地缓存会话"
            description="锁定后会清除本机解锁密钥缓存，下次需要重新输入主密码。"
            action={
              <button className="secondary-action small" type="button" onClick={() => void lockOptionsPage()}>
                立即锁定
              </button>
            }
          />
          <ActionRow
            icon={<BellDot size={20} aria-hidden="true" />}
            title="最近活动"
            description={`账号 ${stats.credentials} 个，身份资料 ${stats.fillProfiles} 条，站点规则 ${stats.siteRules} 条。`}
            action={
              <button className="secondary-action small" type="button" onClick={() => void loadVault()}>
                刷新
              </button>
            }
          />
        </SettingsSection>
      );
    }

    if (activeSection === 'autofill') {
      return (
        <SettingsSection title="自动填表" description="控制账号、密码、身份 ID 在网页中的填充方式。">
          <ToggleRow title="自动填充用户名和密码" description="检测到匹配登录表单时允许 KeyPilot 填入账号密码。" checked={settings.autoFill} onChange={(checked) => void updateSettings({ autoFill: checked })} />
          <ToggleRow title="允许一键登录自动点击登录按钮" description="一键登录会填入账号密码，并尝试点击页面登录按钮。" checked={settings.autoSubmit} onChange={(checked) => void updateSettings({ autoSubmit: checked })} />
          <SettingRow
            title="复制后清空剪贴板"
            description="复制密码后，KeyPilot 会在指定时间后尝试清空剪贴板。"
            control={
              <select value={settings.clearClipboardSeconds} onChange={(event) => void updateSettings({ clearClipboardSeconds: Number(event.currentTarget.value) })}>
                <option value={0}>不自动清空</option>
                <option value={10}>10 秒</option>
                <option value={30}>30 秒</option>
                <option value={60}>60 秒</option>
              </select>
            }
          />
          <ActionRow
            icon={<Clipboard size={20} aria-hidden="true" />}
            title="身份资料填表"
            description="身份 ID 资料会在网页注册/表单页面显示，可通过字段绑定提升准确率。"
            action={
              <button className="secondary-action small" type="button" onClick={() => openExtensionPage('vault.html#identities')}>
                管理资料
              </button>
            }
          />
        </SettingsSection>
      );
    }

    if (activeSection === 'autosave') {
      const saveInboxEnabled = Boolean(session.encryptedVault.saveInboxPublicKey?.keyId && session.vault.saveInboxKeyPair?.privateKey);

      return (
        <SettingsSection title="自动保存" description="控制登录成功后的保存密码提示和不保存网站。">
          <ToggleRow title="自动提示保存登录信息" checked={settings.autoPromptSave} onChange={(checked) => void updateSettings({ autoPromptSave: checked })} />
          <ActionRow
            icon={<ShieldCheck size={20} aria-hidden="true" />}
            title="锁定态保存"
            description={saveInboxEnabled ? 'Vault 锁定时点击保存，会先在本地加密暂存；下次解锁后自动保存或更新到账号库。' : '解锁一次 Vault 后会自动启用。启用前，锁定状态无法直接暂存新的登录信息。'}
            action={<span className={saveInboxEnabled ? 'status-pill success' : 'status-pill'}>{saveInboxEnabled ? '已启用' : '需初始化'}</span>}
          />
          <ActionRow
            icon={<KeyRound size={20} aria-hidden="true" />}
            title="密码变更检测"
            description="同一网站和用户名已存在但新密码不同，会提示更新密码；没有匹配账号时会提示保存为新账号。"
            action={<span className="status-pill success">自动判断</span>}
          />
          <label className="field-block">
            <span>不保存密码的网站</span>
            <textarea value={blacklistDraft} onChange={(event) => setBlacklistDraft(event.currentTarget.value)} rows={8} placeholder="每行一个域名，例如 example.com" />
          </label>
          <button className="primary-action" type="button" onClick={() => void updateSettings({ blacklist: splitDomainList(blacklistDraft) }, '不保存网站列表已更新。')}>
            保存域名列表
          </button>
        </SettingsSection>
      );
    }

    if (activeSection === 'hotkeys') {
      return (
        <SettingsSection title="快捷键" description="查看 KeyPilot 常用操作，并打开浏览器扩展快捷键管理。">
          <div className="shortcut-list">
            <ShortcutRow action="打开 KeyPilot 弹窗" shortcut="浏览器工具栏按钮" />
            <ShortcutRow action="填写当前表单" shortcut="网页内图标或账号菜单" />
            <ShortcutRow action="生成并填写密码" shortcut="注册密码框旁生成器" />
            <ShortcutRow action="浏览器级快捷键" shortcut="chrome://extensions/shortcuts" />
          </div>
          <button className="secondary-action" type="button" onClick={() => window.open('chrome://extensions/shortcuts', '_blank', 'noopener,noreferrer')}>
            打开快捷键设置
          </button>
        </SettingsSection>
      );
    }

    if (activeSection === 'domains') {
      return (
        <SettingsSection title="域名" description="管理自动保存黑名单和网页内 KeyPilot 图标隐藏域名。">
          <div className="metrics-grid compact">
            <Metric label="不保存域名" value={stats.saveBlockedDomains} />
            <Metric label="隐藏图标域名" value={stats.hiddenDomains} />
            <Metric label="站点规则" value={stats.siteRules} />
          </div>
          <label className="field-block">
            <span>网页内图标隐藏域名</span>
            <textarea value={inlineBlacklistDraft} onChange={(event) => setInlineBlacklistDraft(event.currentTarget.value)} rows={8} placeholder="每行一个域名，例如 example.com" />
          </label>
          <button className="primary-action" type="button" onClick={() => void updateSettings({ inlineBlacklist: splitDomainList(inlineBlacklistDraft) }, '网页图标隐藏域名已更新。')}>
            保存隐藏域名
          </button>
        </SettingsSection>
      );
    }

    if (activeSection === 'advanced') {
      const diagnosticLimit = settings.diagnosticLogLimit ?? DEFAULT_DIAGNOSTIC_LOG_LIMIT;
      const diagnosticRetentionDays = settings.diagnosticLogRetentionDays ?? DEFAULT_DIAGNOSTIC_LOG_RETENTION_DAYS;

      return (
        <SettingsSection title="高级设置" description="维护站点规则、浏览器指令和本地诊断能力。">
          <ActionRow
            icon={<RefreshCw size={20} aria-hidden="true" />}
            title="站点规则库"
            description={`当前保存 ${stats.siteRules} 条规则。清空后自动登录会重新学习表单结构。`}
            action={
              <button className="secondary-action small" type="button" onClick={() => void updateSettings({ siteRules: [] }, '站点规则库已清空。')}>
                清空规则
              </button>
            }
          />
          <ToggleRow
            title="在浏览器右键菜单中显示 KeyPilot 指令"
            checked={settings.showContextMenuCommands}
            onChange={(checked) => void updateSettings({ showContextMenuCommands: checked })}
          />
          <ActionRow
            icon={<CircleHelp size={20} aria-hidden="true" />}
            title="识别调试面板"
            description="只用于开发排查。普通客户默认不会看到这个入口。"
            action={<span className="status-pill">仅开发</span>}
          />
          <ToggleRow
            title="保存识别诊断日志"
            description="默认关闭。开启后只记录最近的识别原因、域名和字段数量，不保存密码、用户名或完整表单内容。"
            checked={Boolean(settings.diagnosticLogging)}
            onChange={(checked) => void updateSettings({ diagnosticLogging: checked }, checked ? '识别诊断日志已开启。' : '识别诊断日志已关闭。')}
          />
          <SettingRow
            title="最多保存记录"
            description="超过上限会自动删除最旧记录，避免长期占用空间。"
            control={
              <select value={diagnosticLimit} onChange={(event) => void updateSettings({ diagnosticLogLimit: Number(event.currentTarget.value) }, '诊断日志上限已更新。')}>
                <option value={20}>20 条</option>
                <option value={50}>50 条</option>
                <option value={100}>100 条</option>
              </select>
            }
          />
          <SettingRow
            title="自动清理周期"
            description="超过保留时间的记录会在读取或写入时自动清理。"
            control={
              <select
                value={diagnosticRetentionDays}
                onChange={(event) => void updateSettings({ diagnosticLogRetentionDays: Number(event.currentTarget.value) }, '诊断日志保留时间已更新。')}
              >
                <option value={1}>1 天</option>
                <option value={7}>7 天</option>
                <option value={14}>14 天</option>
                <option value={30}>30 天</option>
              </select>
            }
          />
          <ActionRow
            icon={<CircleHelp size={20} aria-hidden="true" />}
            title="最近诊断记录"
            description={`当前保留 ${diagnosticLogs.length} 条。仅用于开发排查，发布给客户时默认不会开启。`}
            action={
              <div className="inline-actions">
                <button className="secondary-action small" type="button" onClick={() => void loadDiagnosticLogs()}>
                  刷新
                </button>
                <button className="text-danger small" type="button" onClick={() => void clearDiagnosticLogs()}>
                  清空
                </button>
              </div>
            }
          />
          {settings.diagnosticLogging || diagnosticLogs.length ? <DiagnosticLogList logs={diagnosticLogs} /> : null}
        </SettingsSection>
      );
    }

    if (activeSection === 'billing') {
      return (
        <SettingsSection title="许可&版本" description="当前版本为本地专业版，没有云端订阅和账单数据。">
          <ActionRow
            icon={<BadgeCheck size={20} aria-hidden="true" />}
            title="KeyPilot 本地专业版"
            description="功能在本机运行，不依赖云端账号。"
            action={<span className="status-pill success">已启用</span>}
          />
          <ActionRow
            icon={<ShieldCheck size={20} aria-hidden="true" />}
            title="隐私模式"
            description="不会把保存的网站域名发送给第三方图标或 Logo 服务。"
            action={<span className="status-pill success">本地优先</span>}
          />
        </SettingsSection>
      );
    }

    if (activeSection === 'apps') {
      return (
        <SettingsSection title="应用程序" description="打开 KeyPilot 的独立页面和数据管理入口。">
          <div className="action-grid">
            <button className="secondary-action" type="button" onClick={() => openExtensionPage('vault.html')}>
              <AppWindow size={17} aria-hidden="true" />
              打开主页
            </button>
            <button className="secondary-action" type="button" onClick={() => openExtensionPage('vault.html#generator')}>
              <KeyRound size={17} aria-hidden="true" />
              密码生成器
            </button>
            <button className="secondary-action" type="button" onClick={() => openExtensionPage('vault.html#identities')}>
              <Import size={17} aria-hidden="true" />
              身份资料
            </button>
          </div>
        </SettingsSection>
      );
    }

    return (
      <SettingsSection title="分享" description="分享功能后续会和安全导出、授权分享流程一起完善。">
        <ActionRow
          icon={<Gift size={20} aria-hidden="true" />}
          title="本地分享建议"
          description="如果需要把资料发给朋友，优先导出加密备份或 .kpfill 文件，不建议发送明文 CSV。"
          action={
            <button className="secondary-action small" type="button" onClick={() => openExtensionPage('vault.html#identities')}>
              去导出
            </button>
          }
        />
      </SettingsSection>
    );
  }

  return (
    <main className="settings-shell">
      <aside className="settings-sidebar" aria-label="设置分类">
        <div className="settings-title">设置</div>
        <nav>
          {SECTIONS.map((section) => (
            <button
              key={section.key}
              className={activeSection === section.key ? 'active' : ''}
              type="button"
              onClick={() => setActiveSection(section.key)}
            >
              {section.icon}
              <span>{section.label}</span>
            </button>
          ))}
        </nav>
        <div className="settings-sidebar-foot">
          <span>KeyPilot</span>
          <small>本地密码库</small>
        </div>
      </aside>

      <section className="settings-content">
        {notice ? <NoticeToast notice={notice} onDismiss={() => setNotice(null)} /> : null}
        {renderContent()}
      </section>
    </main>
  );
}

function SettingsSection({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <section className="settings-panel">
      <header className="settings-panel-head">
        <h1>{title}</h1>
        <p>{description}</p>
      </header>
      <div className="settings-list">{children}</div>
    </section>
  );
}

function SettingRow({ title, description, control }: { title: string; description?: string; control: ReactNode }) {
  return (
    <div className="setting-row">
      <div>
        <h2>{title}</h2>
        {description ? <p>{description}</p> : null}
      </div>
      <div className="setting-control">{control}</div>
    </div>
  );
}

function ToggleRow({ title, description, checked, onChange }: { title: string; description?: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <SettingRow
      title={title}
      description={description}
      control={
        <button className={checked ? 'switch on' : 'switch'} type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)}>
          <span />
        </button>
      }
    />
  );
}

function ActionRow({ icon, title, description, action }: { icon: ReactNode; title: string; description: string; action: ReactNode }) {
  return (
    <div className="action-row">
      <span className="action-icon">{icon}</span>
      <div>
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      <div className="setting-control">{action}</div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="metric">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function ShortcutRow({ action, shortcut }: { action: string; shortcut: string }) {
  return (
    <div className="shortcut-row">
      <span>{action}</span>
      <kbd>{shortcut}</kbd>
    </div>
  );
}

function diagnosticOutcomeText(outcome: DiagnosticLogEntry['outcome']): string {
  if (outcome === 'success') return '成功';
  if (outcome === 'failure') return '失败';
  if (outcome === 'pending') return '等待';
  if (outcome === 'ignored') return '忽略';
  return '信息';
}

function formatDiagnosticTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
}

function DiagnosticLogList({ logs }: { logs: DiagnosticLogEntry[] }) {
  if (!logs.length) {
    return (
      <div className="diagnostic-log-empty">
        <strong>暂无诊断记录</strong>
        <span>开启后，KeyPilot 只会保留最近的识别判断摘要。</span>
      </div>
    );
  }

  return (
    <div className="diagnostic-log-list" role="list" aria-label="最近识别诊断记录">
      {logs.slice(0, 12).map((entry) => (
        <article className={`diagnostic-log-item ${entry.outcome}`} key={entry.id} role="listitem">
          <div>
            <strong>{entry.event}</strong>
            <span>{entry.domain}</span>
          </div>
          <p>{entry.reason || '没有记录原因。'}</p>
          <footer>
            <time dateTime={new Date(entry.createdAt).toISOString()}>{formatDiagnosticTime(entry.createdAt)}</time>
            <span>{diagnosticOutcomeText(entry.outcome)}</span>
            {entry.signal ? <span>{entry.signal}</span> : null}
            {entry.counts ? <span>{Object.entries(entry.counts).slice(0, 4).map(([key, value]) => `${key}:${String(value)}`).join(' · ')}</span> : null}
          </footer>
        </article>
      ))}
    </div>
  );
}

function DangerZone({ onReset }: { onReset: () => void }) {
  return (
    <div className="danger-zone">
      <div>
        <AlertTriangle size={18} aria-hidden="true" />
        <span>重置会删除本机加密 Vault，无法撤销。</span>
      </div>
      <button className="danger-action" type="button" onClick={onReset}>
        <Trash2 size={16} aria-hidden="true" />
        重置 Vault
      </button>
    </div>
  );
}

function NoticeToast({ notice, onDismiss }: { notice: Notice; onDismiss: () => void }) {
  return (
    <div className={`options-notice ${notice.kind}`}>
      <span>{notice.text}</span>
      <button type="button" aria-label="关闭提示" onClick={onDismiss}>
        ×
      </button>
    </div>
  );
}

function LoadingPanel() {
  return (
    <div className="state-panel">
      <div className="state-loader" />
      <h1>正在读取设置</h1>
      <p>KeyPilot 正在检查本地 Vault 状态。</p>
    </div>
  );
}

function EmptyVaultPanel({ onOpenVault }: { onOpenVault: () => void }) {
  return (
    <div className="state-panel">
      <Database size={34} aria-hidden="true" />
      <h1>还没有本地 Vault</h1>
      <p>先创建本地密码库后，设置项会保存到加密 Vault 中。</p>
      <button className="primary-action" type="button" onClick={onOpenVault}>
        创建 Vault
      </button>
    </div>
  );
}

function UnlockPanel({
  password,
  unlocking,
  onPasswordChange,
  onSubmit,
  onOpenVault
}: {
  password: string;
  unlocking: boolean;
  onPasswordChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onOpenVault: () => void;
}) {
  return (
    <form className="state-panel unlock-panel" onSubmit={onSubmit}>
      <Lock size={34} aria-hidden="true" />
      <h1>解锁设置</h1>
      <p>设置保存在本地加密 Vault 内，请先输入主密码。</p>
      <label className="field-block">
        <span>主密码</span>
        <input type="password" value={password} onChange={(event) => onPasswordChange(event.currentTarget.value)} autoFocus />
      </label>
      <button className="primary-action" type="submit" disabled={unlocking || !password.trim()}>
        {unlocking ? '正在解锁' : '解锁设置'}
      </button>
      <button className="text-action" type="button" onClick={onOpenVault}>
        打开 KeyPilot 主页
      </button>
    </form>
  );
}
