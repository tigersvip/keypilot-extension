import { t, getLanguage } from '../shared/i18n';
import { LanguagePicker } from '../shared/LanguagePicker';
import { vaultItemCount } from '../shared/credentialSecurity';
import { WebsiteFillSettings } from './WebsiteFillSettings';
import { saveCaptchaRule } from '../shared/captchaRuleStorage';
import { BackupStatus } from '../shared/BackupStatusPanel';
import { ReminderSettings } from '../shared/ReminderSettings';
import { BackupRestorePanel, InitialBackupRestore } from '../shared/BackupRestorePanel';
import { useSessionGuard } from '../shared/sessionGuard';
import { authorizeSensitiveAction } from '../shared/sensitiveActions';
import { useEffect, useMemo, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
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
import { exportSiteRulesFile, mergeSiteRules, parseSiteRulesFile } from '../shared/siteRulesFile';
import { clearEncryptedVault, getEncryptedVault } from '../shared/storage';
import type {
  DiagnosticLogEntry,
  InlineSilentRule,
  SiteRule,
  SiteRulePageMode,
  UnlockedVaultSession,
  VaultEncrypted,
  VaultPlain
} from '../shared/types';
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
  | 'reminders'
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
type SiteRuleModeFilter = 'all' | SiteRulePageMode;

interface Notice {
  kind: NoticeKind;
  text: string;
}

const SECTIONS: Array<{ key: SectionKey; label: string; icon: ReactNode }> = [
  { key: 'general', label: t("一般"), icon: <Settings size={20} aria-hidden="true" /> },
  { key: 'reminders', label: t("提醒"), icon: <BellDot size={20} aria-hidden="true" /> },
  { key: 'account', label: t("账户&数据"), icon: <UserCircle size={20} aria-hidden="true" /> },
  { key: 'security', label: t("登录与安全"), icon: <Lock size={20} aria-hidden="true" /> },
  { key: 'device', label: t("设备&活动"), icon: <MonitorSmartphone size={20} aria-hidden="true" /> },
  { key: 'autofill', label: t("自动填表"), icon: <SlidersHorizontal size={20} aria-hidden="true" /> },
  { key: 'autosave', label: t("自动保存"), icon: <Save size={20} aria-hidden="true" /> },
  { key: 'hotkeys', label: t("快捷键"), icon: <Keyboard size={20} aria-hidden="true" /> },
  { key: 'domains', label: t("域名"), icon: <Globe size={20} aria-hidden="true" /> },
  { key: 'advanced', label: t("高级设置"), icon: <RefreshCw size={20} aria-hidden="true" /> },
  { key: 'billing', label: t("许可&版本"), icon: <BadgeCheck size={20} aria-hidden="true" /> },
  { key: 'apps', label: t("应用程序"), icon: <AppWindow size={20} aria-hidden="true" /> },
  { key: 'referral', label: t("分享"), icon: <Gift size={20} aria-hidden="true" /> }
];

const SETTINGS_GROUPS: Array<{ key: SectionKey; label: string; sections: SectionKey[] }> = [
  { key: 'general', label: t("一般"), sections: ['general', 'hotkeys', 'reminders'] },
  { key: 'account', label: t("账户&数据"), sections: ['account'] },
  { key: 'security', label: t("登录与安全"), sections: ['security', 'device'] },
  { key: 'autofill', label: t("自动填表"), sections: ['autofill', 'autosave', 'domains'] },
  { key: 'advanced', label: t("高级设置"), sections: ['advanced'] },
  { key: 'billing', label: t("关于与工具"), sections: ['billing', 'apps', 'referral'] }
];

function sectionFromHash(): SectionKey {
  const hash = window.location.hash.slice(1);
  return SECTIONS.find(section => section.key === hash)?.key ?? 'general';
}

function getErrorMessage(error: unknown): string {
  const message = error instanceof Error ? t(error.message) : String(error);

  if (message === 'VAULT_NOT_FOUND') return t("未找到本地 Vault。");
  if (message === 'INVALID_MASTER_PASSWORD' || message === 'The operation failed for an operation-specific reason') return t("主密码错误，请重新输入。");
  if (message === 'CORRUPTED_VAULT') return t("Vault 数据损坏，无法读取。");
  if (message === 'UNSUPPORTED_VAULT') return t("Vault 版本暂不兼容。");
  if (message === 'PASSWORD_MISMATCH') return t("两次输入的新主密码不一致。");
  if (message === 'PASSWORD_TOO_SHORT') return t("新主密码至少需要 8 位。");
  if (message === 'VAULT_WRITE_CONFLICT') return t("这条记录已在另一个页面修改，请重新打开记录后再保存。");
  if (message === 'MASTER_PASSWORD_TOO_SHORT') return t("主密码至少需要 8 位。");
  if (message === 'VAULT_LOCKED') return t("密码库已锁定，请重新解锁。");
  return t(message) || t("操作失败，请稍后重试。");
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

export function OptionsApp() {
  const [status, setStatus] = useState<'checking' | 'empty' | 'locked' | 'unlocked'>('checking');
  const [activeSection, setActiveSection] = useState<SectionKey>(sectionFromHash);
  const activeGroup = SETTINGS_GROUPS.find(group => group.sections.includes(activeSection))!;
  function navigateSection(key: SectionKey) {
    setActiveSection(key);
    window.history.replaceState(null, "", "#" + key);
    document.querySelector(".settings-content")?.scrollTo({ top: 0 });
  }
  useEffect(() => {
    const sync = () => setActiveSection(sectionFromHash());
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);
  const [encryptedVault, setEncryptedVault] = useState<VaultEncrypted | null>(null);
  const [session, setSession] = useState<UnlockedVaultSession | null>(null);
  const [shortcuts,setShortcuts] = useState<chrome.commands.Command[]>([]);
  useEffect(() => {if(globalThis.chrome?.commands)void chrome.commands.getAll().then(setShortcuts);},[]);
  const shortcut = (name:string) => shortcuts.find(item=>item.name===name)?.shortcut || t("未设置");
  useSessionGuard(session, () => { setSession(null);setStatus('locked');setNotice({kind:'info',text:t("密码库已锁定，请重新解锁。")}); });
  const [notice, setNotice] = useState<Notice | null>(null);
  const [masterPassword, setMasterPassword] = useState('');
  const [unlocking, setUnlocking] = useState(false);
  const [blacklistDraft, setBlacklistDraft] = useState('');
  const [inlineBlacklistDraft, setInlineBlacklistDraft] = useState('');
  const [siteRuleQuery, setSiteRuleQuery] = useState('');
  const [siteRuleModeFilter, setSiteRuleModeFilter] = useState<SiteRuleModeFilter>('all');
  const [silentRuleQuery, setSilentRuleQuery] = useState('');
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
      silentRules: session.vault.settings.inlineSilentRules?.length ?? 0,
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
        setNotice({ kind: 'success', text: t("锁定态保存已启用。以后 Vault 锁定时也可以先加密暂存登录信息。") });
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
        text: nextSession.saveInboxJustEnabled ? t("Vault 已解锁，锁定态保存已启用。") : t("Vault 已解锁，可以修改设置。")
      });
    } catch (error) {
      setNotice({ kind: 'error', text: getErrorMessage(error) });
    } finally {
      setUnlocking(false);
    }
  }

  async function persist(vault: VaultPlain, message = t("设置已保存。")) {
    if (!session) return;

    const nextSession = await persistVaultSession(session, vault);
    setSession(nextSession);
    setEncryptedVault(nextSession.encryptedVault);
    setNotice({ kind: 'success', text: message });
  }

  async function updateSettings(settings: Partial<VaultPlain['settings']>, message = t("设置已保存。")) {
    if (!session) return;
    await persist(upsertVaultSettings(session.vault, settings), message);
  }
  async function removeCaptchaRule(origin:string){
    if(!session)return;
    try{
      const next=await saveCaptchaRule(session,origin,null);setSession(next);setEncryptedVault(next.encryptedVault);
      setNotice({kind:'success',text:t("此网站的验证码规则已清除。")});
    }catch(error){setNotice({kind:'error',text:getErrorMessage(error)});}
  }

  async function updateSiteRule(ruleId: string, patch: Partial<SiteRule>) {
    if (!session) return;

    const siteRules = (session.vault.settings.siteRules ?? []).map((rule) =>
      rule.id === ruleId
        ? {
            ...rule,
            ...patch,
            updatedAt: Date.now()
          }
        : rule
    );
    await updateSettings({ siteRules }, t("站点识别规则已更新。"));
  }

  async function removeSiteRule(ruleId: string) {
    if (!session) return;
    const rule = session.vault.settings.siteRules?.find((item) => item.id === ruleId);
    const confirmed = window.confirm(t("确定删除 {0} 站点识别规则吗？删除后该网站会重新学习表单结构。", [rule?.domain ?? t("这条")]));
    if (!confirmed) return;

    await updateSettings(
      {
        siteRules: (session.vault.settings.siteRules ?? []).filter((rule) => rule.id !== ruleId)
      },
      t("站点识别规则已删除。")
    );
  }

  async function clearSiteRules() {
    if (!session) return;
    const confirmed = window.confirm(t("确定清空全部站点识别规则吗？自动登录和填表会重新学习这些网站。"));
    if (!confirmed) return;

    await updateSettings({ siteRules: [] }, t("站点规则库已清空。"));
  }

  function exportSiteRules() {
    if (!session) return;
    const siteRules = session.vault.settings.siteRules ?? [];

    if (!siteRules.length) {
      setNotice({ kind: 'info', text: t("当前还没有可导出的站点识别规则。") });
      return;
    }

    const blob = new Blob([exportSiteRulesFile(siteRules)], { type: 'application/json;charset=utf-8' });
    downloadBlob(blob, `keypilot-site-rules-${timestampForFile()}.kprules`);
    setNotice({ kind: 'success', text: t("已导出 {0} 条站点识别规则。", [siteRules.length]) });
  }

  function pickSiteRulesFile() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.kprules,.json,application/json';
    input.addEventListener(
      'change',
      () => {
        void importSiteRules(input.files?.[0]);
      },
      { once: true }
    );
    input.click();
  }

  async function importSiteRules(file: File | undefined) {
    if (!session || !file) return;

    try {
      const importedRules = parseSiteRulesFile(await file.text());

      if (!importedRules.length) {
        setNotice({ kind: 'error', text: t("没有识别到可导入的站点规则。") });
        return;
      }

      const nextRules = mergeSiteRules(session.vault.settings.siteRules ?? [], importedRules);
      await updateSettings({ siteRules: nextRules }, t("已导入 {0} 条站点规则。", [importedRules.length]));
    } catch {
      setNotice({ kind: 'error', text: t("规则文件格式不正确，请选择 KeyPilot .kprules 文件。") });
    }
  }

  async function removeInlineSilentRule(ruleId: string) {
    if (!session) return;

    await updateSettings(
      {
        inlineSilentRules: (session.vault.settings.inlineSilentRules ?? []).filter((rule) => rule.id !== ruleId)
      },
      t("自动静默规则已删除。")
    );
  }

  async function clearInlineSilentRules() {
    if (!session) return;
    await updateSettings({ inlineSilentRules: [] }, t("自动静默规则已清空。"));
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
    const confirmed = window.confirm(t("确定清空本地识别诊断日志吗？这不会影响账号、密码和站点规则。"));
    if (!confirmed) return;

    await clearDiagnosticLogEntries();
    setDiagnosticLogs([]);
    setNotice({ kind: 'success', text: t("识别诊断日志已清空。") });
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
      checked ? t("高安全模式已开启，会话仅保留在后台内存；后台停止后需要重新解锁。") : t("高安全模式已关闭。")
    );
  }

  async function lockOptionsPage() {
    await clearVaultSessionCache();
    setSession(null);
    setStatus(encryptedVault ? 'locked' : 'empty');
    setNotice({ kind: 'info', text: t("Vault 已锁定。") });
  }

  async function resetVault() {
    const confirmed = window.confirm(t("确定删除本机加密 Vault？此操作无法撤销。"));
    if (!confirmed) return;

    await clearVaultSessionCache();
    await clearEncryptedVault();
    setEncryptedVault(null);
    setSession(null);
    setStatus('empty');
    setNotice({ kind: 'success', text: t("本地 Vault 已重置。") });
  }


  async function exportCsv() {
    if (!await authorizeSensitiveAction()) return;
    if (!session) return;
    const confirmed = window.confirm(t("RoboForm CSV 会包含明文密码。请只保存在可信位置，用完后及时删除。是否继续？"));
    if (!confirmed) return;

    const blob = new Blob([exportRoboFormCsv(session.vault.credentials)], { type: 'text/csv;charset=utf-8' });
    downloadBlob(blob, `keypilot-roboform-export-${timestampForFile()}.csv`);
    setNotice({ kind: 'success', text: t("已导出 RoboForm CSV。") });
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
      setNotice({ kind: 'success', text: t("主密码已修改。") });
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
    setNotice({ kind: 'success', text: t("恢复码已生成，请立即离线保存。") });
  }

  async function disableRecovery() {
    if (!session) return;
    const confirmed = window.confirm(t("关闭恢复码后，忘记主密码将无法恢复。确定关闭？"));
    if (!confirmed) return;

    const nextSession = await disableVaultRecovery(session);
    setSession(nextSession);
    setEncryptedVault(nextSession.encryptedVault);
    setRecoveryCodeToShow('');
    setNotice({ kind: 'success', text: t("恢复码已关闭。") });
  }

  async function copyRecoveryCode() {
    if (!recoveryCodeToShow) return;

    try {
      await navigator.clipboard.writeText(recoveryCodeToShow);
      setNotice({ kind: 'success', text: t("恢复码已复制。") });
    } catch {
      setNotice({ kind: 'error', text: t("复制失败，请手动保存恢复码。") });
    }
  }

  function renderContent() {
    if (status === 'checking') {
      return <LoadingPanel />;
    }

    if (status === 'empty') {
      return <><EmptyVaultPanel onOpenVault={() => openExtensionPage('vault.html')} /><InitialBackupRestore onRestored={next => {setSession(next);setEncryptedVault(next.encryptedVault);setStatus('unlocked');setActiveSection('account');setNotice({kind:'success',text:t("完整备份已恢复，包含 2FA 和插件设置。")});}} /></>;
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

    if (activeSection === 'reminders') return <SettingsSection title={t("提醒")} description={t("可选的浏览器声音提醒，默认关闭。")}><ReminderSettings session={session} onChange={setSession} /><button type="button" className="primary-action" onClick={() => openExtensionPage('vault.html#reminders')}>{t("打开提醒中心")}</button></SettingsSection>;

    if (activeSection === 'general') {
      return (
        <SettingsSection title={t("一般")} description={t("控制 KeyPilot 的默认入口、界面语言和工具栏行为。")}>
          <LanguagePicker session={session} />
          <SettingRow
            title={t("打开扩展和起始页时显示")}
            description={t("每次打开 KeyPilot 扩展或起始页时，默认使用选定的排序方式。")}
            control={
              <select value={settings.defaultHomeSort} onChange={(event) => void updateSettings({ defaultHomeSort: event.currentTarget.value as VaultPlain['settings']['defaultHomeSort'] })}>
                <option value="favorite">{t("常用登录名")}</option>
                <option value="recent">{t("最近使用")}</option>
                <option value="az">A-Z</option>
              </select>
            }
          />
          <ToggleRow title={t("登录 KeyPilot 时打开起始页")} checked={settings.openStartPageOnLogin} onChange={(checked) => void updateSettings({ openStartPageOnLogin: checked })} />
          <ToggleRow
            title={t("在空白标签页点击扩展时打开起始页")}
            description={t("如果当前是浏览器空白页，点击 KeyPilot 扩展按钮会打开 KeyPilot 起始页。")}
            checked={settings.openStartPageOnToolbarClick}
            onChange={(checked) => void updateSettings({ openStartPageOnToolbarClick: checked })}
          />
          <ToggleRow
            title={t("在浏览器右键菜单中显示 KeyPilot 指令")}
            description={t("KeyPilot 指令会出现在浏览器右键菜单中。")}
            checked={settings.showContextMenuCommands}
            onChange={(checked) => void updateSettings({ showContextMenuCommands: checked })}
          />
          <ToggleRow
            title={t("弹窗底部显示紧凑工具栏")}
            description={t("在扩展弹窗底部显示导入、新建、自动保存等常用操作。")}
            checked={settings.useCompactPopupToolbar}
            onChange={(checked) => void updateSettings({ useCompactPopupToolbar: checked })}
          />
        </SettingsSection>
      );
    }

    if (activeSection === 'account') {
      return (
        <SettingsSection title={t("账户&数据")} description={t("管理本地 Vault、导出备份和数据迁移。")}>
          <BackupStatus session={session} onChange={setSession} />
          <div className="metrics-grid">
            <Metric label={t("全部项目")} value={stats.items} />
            <Metric label={t("登录账号")} value={stats.credentials} />
            <Metric label={t("身份资料")} value={stats.fillProfiles} />
            <Metric label={t("文件夹")} value={stats.folders} />
          </div>
          <ActionRow
            icon={<Database size={20} aria-hidden="true" />}
            title={t("本地 Vault")}
            description={t("已检测到本机加密 Vault。明文密码只在解锁会话中存在。")}
            action={<span className="status-pill success">{t("已创建")}</span>}
          />
          <div className="action-grid">
            <button className="secondary-action" type="button" onClick={exportCsv}>
              <Download size={17} aria-hidden="true" />{t("导出 RoboForm CSV")}</button>
          </div>
          <BackupRestorePanel session={session!} onRestored={next => {setSession(next);setEncryptedVault(next.encryptedVault);}} />
          <DangerZone onReset={resetVault} />
        </SettingsSection>
      );
    }

    if (activeSection === 'security') {
      return (
        <SettingsSection title={t("登录与安全")} description={t("设置自动锁定、高安全模式、恢复码和主密码。")}>
          <SettingRow
            title={t("自动锁定时间")}
            description={t("超过该时间未操作后，KeyPilot 会清除解锁会话。")}
            control={
              <select value={settings.autoLockMinutes} onChange={(event) => void updateSettings({ autoLockMinutes: Number(event.currentTarget.value) })}>
                <option value={0}>{t("不自动锁定")}</option>
                <option value={5}>{t("5 分钟")}</option>
                <option value={15}>{t("15 分钟")}</option>
                <option value={30}>{t("30 分钟")}</option>
                <option value={60}>{t("1 小时")}</option>
              </select>
            }
          />
          <ToggleRow title={t("启动时自动锁定")} checked={settings.lockOnStartup} onChange={(checked) => void updateSettings({ lockOnStartup: checked, lockOnStartupUserSet: true })} />
          <ToggleRow
            title={t("高安全模式")}
            description={t("会话仅放在后台内存，不写入会话存储。后台休眠或浏览器重启后需要重新解锁。")}
            checked={settings.highSecurityMode}
            onChange={(checked) => void toggleHighSecurityMode(checked)}
          />
          <ToggleRow
            title={t("查看密码时要求主密码")}
            description={t("查看、复制密码或明文导出前验证主密码；显示的密码会在 30 秒后隐藏。")}
            checked={settings.requireMasterPasswordForReveal}
            onChange={(checked) => void updateSettings({ requireMasterPasswordForReveal: checked })}
          />
          <ActionRow
            icon={<KeyRound size={20} aria-hidden="true" />}
            title={session.encryptedVault.recovery ? t("恢复码已启用") : t("恢复码未启用")}
            description={session.encryptedVault.recovery ? t("忘记主密码时可用恢复码重置主密码。") : t("建议生成恢复码并离线保存，防止忘记主密码。")}
            action={
              <div className="inline-actions">
                <button className="secondary-action small" type="button" onClick={() => void generateRecovery()}>
                  {session.encryptedVault.recovery ? t("重新生成") : t("生成恢复码")}
                </button>
                {session.encryptedVault.recovery ? (
                  <button className="text-danger small" type="button" onClick={() => void disableRecovery()}>{t("关闭")}</button>
                ) : null}
              </div>
            }
          />
          {recoveryCodeToShow ? (
            <div className="recovery-card">
              <span>{t("请立即保存恢复码，KeyPilot 不会再次显示。")}</span>
              <code>{recoveryCodeToShow}</code>
              <button className="secondary-action small" type="button" onClick={() => void copyRecoveryCode()}>{t("复制恢复码")}</button>
            </div>
          ) : null}
          <form className="password-form" onSubmit={(event) => void changePassword(event)}>
            <h3>{t("修改主密码")}</h3>
            <div className="form-grid">
              <label className="field-block">
                <span>{t("当前主密码")}</span>
                <input type="password" value={passwordDraft.current} onChange={(event) => setPasswordDraft((draft) => ({ ...draft, current: event.currentTarget.value }))} />
              </label>
              <label className="field-block">
                <span>{t("新主密码")}</span>
                <input type="password" value={passwordDraft.next} onChange={(event) => setPasswordDraft((draft) => ({ ...draft, next: event.currentTarget.value }))} />
              </label>
              <label className="field-block">
                <span>{t("确认新主密码")}</span>
                <input type="password" value={passwordDraft.confirm} onChange={(event) => setPasswordDraft((draft) => ({ ...draft, confirm: event.currentTarget.value }))} />
              </label>
            </div>
            <button className="primary-action" type="submit">{t("保存主密码")}</button>
          </form>
        </SettingsSection>
      );
    }

    if (activeSection === 'device') {
      return (
        <SettingsSection title={t("设备&活动")} description={t("查看本机浏览器会话状态并管理当前设备。")}>
          <ActionRow
            icon={<HardDrive size={20} aria-hidden="true" />}
            title={t("当前设备")}
            description={t("{0} · 本地专业版 · {1}", [navigator.userAgent.includes('Edg') ? 'Microsoft Edge' : t("Chromium 浏览器"), new Date().toLocaleString(getLanguage())])}
            action={<span className="status-pill success">{t("已解锁")}</span>}
          />
          <ActionRow
            icon={<ShieldCheck size={20} aria-hidden="true" />}
            title={t("本地缓存会话")}
            description={t("锁定后会清除本机解锁密钥缓存，下次需要重新输入主密码。")}
            action={
              <button className="secondary-action small" type="button" onClick={() => void lockOptionsPage()}>{t("立即锁定")}</button>
            }
          />
          <ActionRow
            icon={<BellDot size={20} aria-hidden="true" />}
            title={t("最近活动")}
            description={t("账号 {0} 个，身份资料 {1} 条，站点规则 {2} 条。", [stats.credentials, stats.fillProfiles, stats.siteRules])}
            action={
              <button className="secondary-action small" type="button" onClick={() => void loadVault()}>{t("刷新")}</button>
            }
          />
        </SettingsSection>
      );
    }

    if (activeSection === 'autofill') {
      return (
        <SettingsSection title={t("自动填表")} description={t("控制账号、密码、身份 ID 在网页中的填充方式。")}>
          <button className="secondary-action" type="button" onClick={() => navigateSection('domains')}>{t("管理网站填写设置")}</button>
          <ToggleRow title={t("自动填充用户名和密码")} description={t("检测到匹配登录表单时允许 KeyPilot 填入账号密码。")} checked={settings.autoFill} onChange={(checked) => void updateSettings({ autoFill: checked })} />
          <ToggleRow title={t("允许一键登录自动点击登录按钮")} description={t("一键登录会填入账号密码，并尝试点击页面登录按钮。")} checked={settings.autoSubmit} onChange={(checked) => void updateSettings({ autoSubmit: checked })} />
          <ToggleRow title={t("本地验证码识别（实验功能）")} description={t("一键登录时自动识别图形验证码，填写首选结果并尝试登录一次，失败时交给你处理。单独点击识别仍可核对后按 Enter 填写；不需要的网站可单独关闭。")} checked={Boolean(settings.captchaAssistEnabled)} onChange={(checked) => void updateSettings({ captchaAssistEnabled: checked })} />
          <details className="captcha-rules-settings">
            <summary>{t("已记住的验证码网站规则（")}{Object.keys(settings.captchaSiteRules??{}).length}）</summary>
            <p>{t("规则按协议、域名和端口分别保存，随完整加密备份导出；合并备份时选择“站点识别规则”恢复。清除已关闭网站的规则后，该网站恢复自动提示。")}</p>
            {Object.entries(settings.captchaSiteRules??{}).map(([origin,rule])=><ActionRow key={origin} icon={<Globe size={20} aria-hidden="true" />} title={origin} description={rule.disabled?t("此网站已关闭验证码提示"):t("自动识别 · {0}", [rule.expectedLength?t("{0} 位", [rule.expectedLength]):t("自动判断位数")])} action={<button className="secondary-action small" type="button" aria-label={t("清除 {0} 的验证码规则", [origin])} onClick={()=>void removeCaptchaRule(origin)}>{t("清除规则")}</button>} />)}
          </details>
          <SettingRow
            title={t("复制后清空剪贴板")}
            description={t("复制密码后，KeyPilot 会在指定时间后尝试清空剪贴板。")}
            control={
              <select value={settings.clearClipboardSeconds} onChange={(event) => void updateSettings({ clearClipboardSeconds: Number(event.currentTarget.value) })}>
                <option value={0}>{t("不自动清空")}</option>
                <option value={10}>{t("10 秒")}</option>
                <option value={30}>{t("30 秒")}</option>
                <option value={60}>{t("60 秒")}</option>
              </select>
            }
          />
          <ActionRow
            icon={<Clipboard size={20} aria-hidden="true" />}
            title={t("身份资料填表")}
            description={t("身份 ID 资料会在网页注册/表单页面显示，可通过字段绑定提升准确率。")}
            action={
              <button className="secondary-action small" type="button" onClick={() => openExtensionPage('vault.html#identities')}>{t("管理资料")}</button>
            }
          />
        </SettingsSection>
      );
    }

    if (activeSection === 'autosave') {
      const saveInboxEnabled = Boolean(session.encryptedVault.saveInboxPublicKey?.keyId && session.vault.saveInboxKeyPair?.privateKey);

      return (
        <SettingsSection title={t("自动保存")} description={t("控制登录成功后的保存密码提示和不保存网站。")}>
          <ToggleRow title={t("自动提示保存登录信息")} checked={settings.autoPromptSave} onChange={(checked) => void updateSettings({ autoPromptSave: checked })} />
          <ActionRow
            icon={<ShieldCheck size={20} aria-hidden="true" />}
            title={t("锁定态保存")}
            description={saveInboxEnabled ? t("Vault 锁定时点击保存，会先在本地加密暂存；下次解锁后自动保存或更新到账号库。") : t("解锁一次 Vault 后会自动启用。启用前，锁定状态无法直接暂存新的登录信息。")}
            action={<span className={saveInboxEnabled ? 'status-pill success' : 'status-pill'}>{saveInboxEnabled ? t("已启用") : t("需初始化")}</span>}
          />
          <ActionRow
            icon={<KeyRound size={20} aria-hidden="true" />}
            title={t("密码变更检测")}
            description={t("同一网站和用户名已存在但新密码不同，会提示更新密码；没有匹配账号时会提示保存为新账号。")}
            action={<span className="status-pill success">{t("自动判断")}</span>}
          />
          <label className="field-block">
            <span>{t("不保存密码的网站")}</span>
            <textarea value={blacklistDraft} onChange={(event) => setBlacklistDraft(event.currentTarget.value)} rows={8} placeholder={t("每行一个域名，例如 example.com")} />
          </label>
          <button className="primary-action" type="button" onClick={() => void updateSettings({ blacklist: splitDomainList(blacklistDraft) }, t("不保存网站列表已更新。"))}>{t("保存域名列表")}</button>
        </SettingsSection>
      );
    }

    if (activeSection === 'hotkeys') {
      return (
        <SettingsSection title={t("快捷键")} description={t("填写快捷键会识别登录账号或个人资料表单。先点击目标输入框；多份资料先选择，资料填写先预览，已有值会保留。")}>
          <div className="shortcut-list">
            <ShortcutRow action={t("打开 KeyPilot 弹窗")} shortcut={shortcut("_execute_action")} />
            <ShortcutRow action={t("填写账号或个人资料")} shortcut={shortcut("fill-current")} />
            <ShortcutRow action={t("锁定密码库")} shortcut={shortcut("lock-vault")} /><ShortcutRow action={t("搜索密码库")} shortcut={shortcut("search-vault")} />
            <ShortcutRow action={t("浏览器级快捷键")} shortcut="chrome://extensions/shortcuts" />
          </div>
          <button className="secondary-action" type="button" onClick={() => window.open('chrome://extensions/shortcuts', '_blank', 'noopener,noreferrer')}>{t("打开快捷键设置")}</button>
        </SettingsSection>
      );
    }

    if (activeSection === 'domains') {
      return (
        <SettingsSection title={t("域名")} description={t("集中管理网站填写设置、字段绑定和图标隐藏域名。")}>
          <WebsiteFillSettings session={session} onChange={next => {setSession(next);setEncryptedVault(next.encryptedVault);}} />
          <div className="metrics-grid compact">
            <Metric label={t("不保存域名")} value={stats.saveBlockedDomains} />
            <Metric label={t("隐藏图标域名")} value={stats.hiddenDomains} />
            <Metric label={t("站点规则")} value={stats.siteRules} />
          </div>
          <label className="field-block">
            <span>{t("网页内图标隐藏域名")}</span>
            <textarea value={inlineBlacklistDraft} onChange={(event) => setInlineBlacklistDraft(event.currentTarget.value)} rows={8} placeholder={t("每行一个域名，例如 example.com")} />
          </label>
          <button className="primary-action" type="button" onClick={() => void updateSettings({ inlineBlacklist: splitDomainList(inlineBlacklistDraft) }, t("网页图标隐藏域名已更新。"))}>{t("保存隐藏域名")}</button>
        </SettingsSection>
      );
    }

    if (activeSection === 'advanced') {
      const diagnosticLimit = settings.diagnosticLogLimit ?? DEFAULT_DIAGNOSTIC_LOG_LIMIT;
      const diagnosticRetentionDays = settings.diagnosticLogRetentionDays ?? DEFAULT_DIAGNOSTIC_LOG_RETENTION_DAYS;
      const siteRules = settings.siteRules ?? [];
      const siteRuleStats = getSiteRuleStats(siteRules);
      const filteredSiteRules = filterSiteRules(siteRules, siteRuleQuery, siteRuleModeFilter);
      const inlineSilentRules = settings.inlineSilentRules ?? [];

      return (
        <SettingsSection title={t("高级设置")} description={t("维护站点规则、浏览器指令和本地诊断能力。")}>
          <ActionRow
            icon={<RefreshCw size={20} aria-hidden="true" />}
            title={t("站点规则库")}
            description={t("当前保存 {0} 条规则。清空后自动登录会重新学习表单结构。", [stats.siteRules])}
            action={
              <div className="row-actions">
                <button className="secondary-action small" type="button" onClick={exportSiteRules} disabled={!siteRules.length}>{t("导出规则")}</button>
                <button className="secondary-action small" type="button" onClick={pickSiteRulesFile}>{t("导入规则")}</button>
                <button className="secondary-action small danger" type="button" onClick={() => void clearSiteRules()} disabled={!siteRules.length}>{t("清空规则")}</button>
              </div>
            }
          />
          {siteRules.length ? (
            <>
              <SiteRuleOverview stats={siteRuleStats} active={siteRuleModeFilter} onChange={setSiteRuleModeFilter} />
              <RuleManager
                title={t("站点识别规则")}
                query={siteRuleQuery}
                onQuery={setSiteRuleQuery}
                placeholder={t("搜索域名、路径或规则来源")}
                meta={`${filteredSiteRules.length} / ${siteRules.length}`}
              >
              <SiteRuleList
                rules={filteredSiteRules}
                total={siteRules.length}
                onPageModeChange={(id, pageMode) => void updateSiteRule(id, { pageMode })}
                onPathPatternChange={(id, pathPattern) => void updateSiteRule(id, { pathPattern })}
                onPasswordGeneratorChange={(id, disabled) => void updateSiteRule(id, { disablePasswordGenerator: disabled })}
                onDelete={(id) => void removeSiteRule(id)}
              />
              </RuleManager>
            </>
          ) : (
            <RuleEmptyState title={t("暂无站点识别规则")} body={t("当你保存账号、绑定字段或手动标记页面后，这里会出现可管理的规则。")} />
          )}
          <ToggleRow
            title={t("在浏览器右键菜单中显示 KeyPilot 指令")}
            checked={settings.showContextMenuCommands}
            onChange={(checked) => void updateSettings({ showContextMenuCommands: checked })}
          />
          <ToggleRow
            title={t("自动静默普通页面")}
            description={t("页面没有登录框、注册密码框或真实填表上下文时，KeyPilot 会学习路径级静默规则，避免网页内图标误弹。")}
            checked={settings.autoSilentInline !== false}
            onChange={(checked) => void updateSettings({ autoSilentInline: checked }, checked ? t("自动静默已开启。") : t("自动静默已关闭。"))}
          />
          <ActionRow
            icon={<ShieldCheck size={20} aria-hidden="true" />}
            title={t("自动静默规则")}
            description={t("当前保存 {0} 条路径级规则，只影响网页内浮标，不影响插件弹窗。", [inlineSilentRules.length])}
            action={
              <button className="secondary-action small" type="button" onClick={() => void clearInlineSilentRules()} disabled={!inlineSilentRules.length}>{t("清空规则")}</button>
            }
          />
          {inlineSilentRules.length ? (
            <RuleManager
              title={t("自动静默规则")}
              query={silentRuleQuery}
              onQuery={setSilentRuleQuery}
              placeholder={t("搜索被静默的域名或路径")}
            >
              <InlineSilentRuleList rules={filterInlineSilentRules(inlineSilentRules, silentRuleQuery)} total={inlineSilentRules.length} onDelete={(id) => void removeInlineSilentRule(id)} />
            </RuleManager>
          ) : null}
          <ActionRow
            icon={<CircleHelp size={20} aria-hidden="true" />}
            title={t("识别调试面板")}
            description={t("只用于开发排查。普通客户默认不会看到这个入口。")}
            action={<span className="status-pill">{t("仅开发")}</span>}
          />
          <ToggleRow
            title={t("保存识别诊断日志")}
            description={t("默认关闭。开启后只记录最近的识别原因、域名和字段数量，不保存密码、用户名或完整表单内容。")}
            checked={Boolean(settings.diagnosticLogging)}
            onChange={(checked) => void updateSettings({ diagnosticLogging: checked }, checked ? t("识别诊断日志已开启。") : t("识别诊断日志已关闭。"))}
          />
          <SettingRow
            title={t("最多保存记录")}
            description={t("超过上限会自动删除最旧记录，避免长期占用空间。")}
            control={
              <select value={diagnosticLimit} onChange={(event) => void updateSettings({ diagnosticLogLimit: Number(event.currentTarget.value) }, t("诊断日志上限已更新。"))}>
                <option value={20}>{t("20 条")}</option>
                <option value={50}>{t("50 条")}</option>
                <option value={100}>{t("100 条")}</option>
              </select>
            }
          />
          <SettingRow
            title={t("自动清理周期")}
            description={t("超过保留时间的记录会在读取或写入时自动清理。")}
            control={
              <select
                value={diagnosticRetentionDays}
                onChange={(event) => void updateSettings({ diagnosticLogRetentionDays: Number(event.currentTarget.value) }, t("诊断日志保留时间已更新。"))}
              >
                <option value={1}>{t("1 天")}</option>
                <option value={7}>{t("7 天")}</option>
                <option value={14}>{t("14 天")}</option>
                <option value={30}>{t("30 天")}</option>
              </select>
            }
          />
          <ActionRow
            icon={<CircleHelp size={20} aria-hidden="true" />}
            title={t("最近诊断记录")}
            description={t("当前保留 {0} 条。仅用于开发排查，发布给客户时默认不会开启。", [diagnosticLogs.length])}
            action={
              <div className="inline-actions">
                <button className="secondary-action small" type="button" onClick={() => void loadDiagnosticLogs()}>{t("刷新")}</button>
                <button className="text-danger small" type="button" onClick={() => void clearDiagnosticLogs()}>{t("清空")}</button>
              </div>
            }
          />
          {settings.diagnosticLogging || diagnosticLogs.length ? <DiagnosticLogList logs={diagnosticLogs} /> : null}
        </SettingsSection>
      );
    }

    if (activeSection === 'billing') {
      return (
        <SettingsSection title={t("关于 KeyPilot")} description={t("管理本机密码、验证码和身份资料。")}>
          <ActionRow
            icon={<BadgeCheck size={20} aria-hidden="true" />}
            title={t("KeyPilot 浏览器扩展")}
            description={t("功能在本机运行，不依赖云端账号。")}
            action={<span className="status-pill">v{globalThis.chrome?.runtime?.getManifest?.().version ?? t("本地开发")}</span>}
          />
          <ActionRow
            icon={<ShieldCheck size={20} aria-hidden="true" />}
            title={t("隐私模式")}
            description={t("不会把保存的网站域名发送给第三方图标或 Logo 服务。")}
            action={<span className="status-pill success">{t("本地优先")}</span>}
          />
        </SettingsSection>
      );
    }

    if (activeSection === 'apps') {
      return (
        <SettingsSection title={t("快捷入口")} description={t("打开 KeyPilot 的独立页面和数据管理入口。")}>
          <div className="action-grid">
            <button className="secondary-action" type="button" onClick={() => openExtensionPage('vault.html')}>
              <AppWindow size={17} aria-hidden="true" />{t("打开主页")}</button>
            <button className="secondary-action" type="button" onClick={() => openExtensionPage('vault.html#generator')}>
              <KeyRound size={17} aria-hidden="true" />{t("密码生成器")}</button>
            <button className="secondary-action" type="button" onClick={() => openExtensionPage('vault.html#identities')}>
              <Import size={17} aria-hidden="true" />{t("身份资料")}</button>
          </div>
        </SettingsSection>
      );
    }

    return (
      <SettingsSection title={t("分享")} description={t("分享功能后续会和安全导出、授权分享流程一起完善。")}>
        <ActionRow
          icon={<Gift size={20} aria-hidden="true" />}
          title={t("本地分享建议")}
          description={t("如果需要把资料发给朋友，优先导出加密备份或 .kpfill 文件，不建议发送明文 CSV。")}
          action={
            <button className="secondary-action small" type="button" onClick={() => openExtensionPage('vault.html#identities')}>{t("去导出")}</button>
          }
        />
      </SettingsSection>
    );
  }

  return (
    <main className="settings-shell">
      <aside className="settings-sidebar" aria-label={t("设置分类")}>
        <header className="settings-sidebar-head">
          <a className="settings-back-link" href={extensionUrl('vault.html')}>
            <ArrowLeft size={20} aria-hidden="true" />
            <span>{t("返回密码库")}</span>
          </a>
          <div className="settings-title">{t("设置")}</div>
        </header>
        <nav>
          {SETTINGS_GROUPS.map((section) => (
            <button
              key={section.key}
              className={activeGroup.key === section.key ? 'active' : ''}
              aria-current={activeGroup.key === section.key ? 'page' : undefined}
              type="button"
              onClick={() => navigateSection(section.key)}
            >
              {SECTIONS.find(item => item.key === section.key)?.icon}
              <span>{section.label}</span>
            </button>
          ))}
        </nav>
        <div className="settings-sidebar-foot">
          <span>KeyPilot</span>
          <small>{t("本地密码库")}</small>
        </div>
      </aside>

      <section className="settings-content">
        {notice ? <NoticeToast notice={notice} onDismiss={() => setNotice(null)} /> : null}
        {activeGroup.sections.length > 1 && <nav className="settings-subnav" aria-label={activeGroup.label + t("子分类")}>
          {activeGroup.sections.map(key => <button type="button" key={key} aria-current={key === activeSection ? 'page' : undefined} className={key === activeSection ? 'active' : ''} onClick={() => navigateSection(key)}>
            {key === 'general' ? t("偏好设置") : key === 'security' ? t("密码与锁定") : key === 'autofill' ? t("填写与登录") : key === 'billing' ? t("关于 KeyPilot") : key === 'apps' ? t("快捷入口") : key === 'referral' ? t("分享说明") : SECTIONS.find(item => item.key === key)?.label}
          </button>)}
        </nav>}
        {renderContent()}
        {(status === 'locked' || status === 'empty') && <LanguagePicker />}
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
        <button className={checked ? 'switch on' : 'switch'} type="button" role="switch" aria-label={title} aria-checked={checked} onClick={() => onChange(!checked)}>
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

function normalizeRuleSearch(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeSiteRulePathDraft(value: string): string | undefined {
  const text = value.trim();
  if (!text || text === '*') return undefined;
  return text.startsWith('/') ? text : `/${text}`;
}

function getSiteRuleStats(rules: SiteRule[]) {
  return rules.reduce(
    (stats, rule) => {
      const mode = rule.pageMode ?? 'auto';
      stats.total += 1;
      stats[mode] += 1;
      stats.fields += rule.formFields?.length ?? 0;
      if (rule.formProfile?.submit) stats.withSubmit += 1;
      if (rule.disablePasswordGenerator) stats.generatorDisabled += 1;
      return stats;
    },
    {
      total: 0,
      auto: 0,
      login: 0,
      register: 0,
      'fill-profile': 0,
      withSubmit: 0,
      fields: 0,
      generatorDisabled: 0
    } satisfies Record<SiteRulePageMode | 'total' | 'withSubmit' | 'fields' | 'generatorDisabled', number>
  );
}

function filterSiteRules(rules: SiteRule[], query: string, modeFilter: SiteRuleModeFilter): SiteRule[] {
  const normalizedQuery = normalizeRuleSearch(query);
  const sorted = [...rules]
    .filter((rule) => modeFilter === 'all' || (rule.pageMode ?? 'auto') === modeFilter)
    .sort((left, right) => right.updatedAt - left.updatedAt);

  if (!normalizedQuery) return sorted;

  return sorted.filter((rule) =>
    [
      rule.domain,
      rule.pathPattern ?? '',
      rule.pageMode ?? 'auto',
      rule.source,
      rule.disablePasswordGenerator ? t("disable password generator 禁用密码生成器") : '',
      rule.lastOutcome ?? ''
    ].some((value) => value.toLowerCase().includes(normalizedQuery))
  );
}

function filterInlineSilentRules(rules: InlineSilentRule[], query: string): InlineSilentRule[] {
  const normalizedQuery = normalizeRuleSearch(query);
  const sorted = [...rules].sort((left, right) => right.updatedAt - left.updatedAt);

  if (!normalizedQuery) return sorted;

  return sorted.filter((rule) =>
    [
      rule.domain,
      rule.pathPattern ?? '',
      rule.title ?? '',
      rule.lastUrl ?? '',
      rule.source ?? 'auto',
      inlineSilentSourceText(rule.source),
      rule.reason,
      inlineSilentReasonText(rule.reason)
    ].some((value) =>
      value.toLowerCase().includes(normalizedQuery)
    )
  );
}

function siteRulePageModeText(pageMode?: SiteRulePageMode): string {
  if (pageMode === 'login') return t("登录页");
  if (pageMode === 'register') return t("注册页");
  if (pageMode === 'fill-profile') return t("填表页");
  return t("自动识别");
}

function siteRuleSourceText(source: SiteRule['source']): string {
  if (source === 'manual-binding') return t("手动校准");
  if (source === 'save-prompt') return t("保存账号");
  if (source === 'auto-repair') return t("自动修复");
  return source;
}

function siteRuleFieldKindText(kind: NonNullable<SiteRule['formFields']>[number]['kind']): string {
  if (kind === 'username') return t("账号");
  if (kind === 'password') return t("密码");
  return t("文本");
}

function siteRuleOutcomeText(outcome?: SiteRule['lastOutcome']): string {
  if (outcome === 'successLikely') return t("疑似成功");
  if (outcome === 'waitingVerification') return t("等待验证");
  if (outcome === 'navigated') return t("已跳转");
  if (outcome === 'stillOnLogin') return t("仍在登录页");
  if (outcome === 'errorVisible') return t("页面报错");
  if (outcome === 'blocked') return t("被拦截");
  if (outcome === 'checking') return t("检测中");
  return t("未记录");
}

function siteRuleHealth(rule: SiteRule): 'good' | 'warning' | 'neutral' {
  if ((rule.failureCount ?? 0) > (rule.successCount ?? 0)) return 'warning';
  if ((rule.successCount ?? 0) > 0 || rule.formProfile?.submit) return 'good';
  return 'neutral';
}

function SiteRuleOverview({
  stats,
  active,
  onChange
}: {
  stats: ReturnType<typeof getSiteRuleStats>;
  active: SiteRuleModeFilter;
  onChange: (filter: SiteRuleModeFilter) => void;
}) {
  const filters: Array<{ key: SiteRuleModeFilter; label: string; value: number; hint: string }> = [
    { key: 'all', label: t("全部"), value: stats.total, hint: t("所有规则") },
    { key: 'login', label: t("登录页"), value: stats.login, hint: t("一键登录") },
    { key: 'register', label: t("注册页"), value: stats.register, hint: t("密码生成") },
    { key: 'fill-profile', label: t("填表页"), value: stats['fill-profile'], hint: t("身份资料") },
    { key: 'auto', label: t("自动"), value: stats.auto, hint: t("默认判断") }
  ];

  return (
    <section className="site-rule-overview" aria-label={t("站点规则总览")}>
      <div className="site-rule-overview-copy">
        <strong>{t("规则总览")}</strong>
        <span>{stats.withSubmit}{t(" 条记录了登录按钮，")}{stats.fields}{t(" 个字段选择器，")}{stats.generatorDisabled}{t(" 条禁用密码生成器。")}</span>
      </div>
      <div className="site-rule-filter-grid" role="tablist" aria-label={t("站点规则筛选")}>
        {filters.map((filter) => (
          <button
            key={filter.key}
            className={active === filter.key ? 'active' : ''}
            type="button"
            role="tab"
            aria-selected={active === filter.key}
            onClick={() => onChange(filter.key)}
          >
            <strong>{filter.value}</strong>
            <span>{filter.label}</span>
            <small>{filter.hint}</small>
          </button>
        ))}
      </div>
    </section>
  );
}

function RuleManager({
  title,
  query,
  onQuery,
  placeholder,
  meta,
  children
}: {
  title: string;
  query: string;
  onQuery: (value: string) => void;
  placeholder: string;
  meta?: string;
  children: ReactNode;
}) {
  return (
    <section className="rule-manager" aria-label={title}>
      <div className="rule-manager-head">
        <div>
          <strong>{title}</strong>
          {meta ? <span>{meta}</span> : null}
        </div>
        <input value={query} onChange={(event) => onQuery(event.currentTarget.value)} placeholder={placeholder} />
      </div>
      {children}
    </section>
  );
}

function RuleEmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="rule-empty">
      <strong>{title}</strong>
      <span>{body}</span>
    </div>
  );
}

function SiteRuleList({
  rules,
  total,
  onPageModeChange,
  onPathPatternChange,
  onPasswordGeneratorChange,
  onDelete
}: {
  rules: SiteRule[];
  total: number;
  onPageModeChange: (id: string, pageMode: SiteRulePageMode) => void;
  onPathPatternChange: (id: string, pathPattern?: string) => void;
  onPasswordGeneratorChange: (id: string, disabled: boolean) => void;
  onDelete: (id: string) => void;
}) {
  if (!rules.length) {
    return <RuleEmptyState title={t("没有匹配的站点规则")} body={t("换一个域名、路径或来源关键词再试。")} />;
  }

  return (
    <div className="site-rule-list" role="list" aria-label={t("站点识别规则列表")}>
      <div className="rule-count">{t("显示 ")}{rules.length} / {total}{t(" 条")}</div>
      {rules.slice(0, 40).map((rule) => (
        <SiteRuleItem
          key={rule.id}
          rule={rule}
          onPageModeChange={onPageModeChange}
          onPathPatternChange={onPathPatternChange}
          onPasswordGeneratorChange={onPasswordGeneratorChange}
          onDelete={onDelete}
        />
      ))}
    </div>
  );
}

function SiteRuleItem({
  rule,
  onPageModeChange,
  onPathPatternChange,
  onPasswordGeneratorChange,
  onDelete
}: {
  rule: SiteRule;
  onPageModeChange: (id: string, pageMode: SiteRulePageMode) => void;
  onPathPatternChange: (id: string, pathPattern?: string) => void;
  onPasswordGeneratorChange: (id: string, disabled: boolean) => void;
  onDelete: (id: string) => void;
}) {
  const [pathDraft, setPathDraft] = useState(rule.pathPattern ?? '');
  const normalizedPath = normalizeSiteRulePathDraft(pathDraft);
  const pathChanged = (normalizedPath ?? '') !== (rule.pathPattern ?? '');
  const health = siteRuleHealth(rule);
  const fields = rule.formFields ?? [];
  const previewFields = fields.slice(0, 5);

  useEffect(() => {
    setPathDraft(rule.pathPattern ?? '');
  }, [rule.id, rule.pathPattern]);

  return (
    <article className={`site-rule-item ${health}`} role="listitem">
      <header className="site-rule-item-head">
        <span className={`site-rule-dot ${health}`} aria-hidden="true" />
        <div className="site-rule-main">
          <strong title={`${rule.domain}${rule.pathPattern ?? ''}`}>{rule.domain}</strong>
          <span>{rule.pathPattern || t("整站规则")} · {siteRuleSourceText(rule.source)} · {formatDiagnosticTime(rule.updatedAt)}</span>
        </div>
        <span className={`site-rule-mode ${rule.pageMode ?? 'auto'}`}>{siteRulePageModeText(rule.pageMode)}</span>
      </header>

      <div className="site-rule-metrics">
        <span>{fields.length}{t(" 字段")}</span>
        <span>{rule.formProfile?.submit ? t("已记录按钮") : t("未记录按钮")}</span>
        <span>{t("成功 ")}{rule.successCount ?? 0}</span>
        <span>{t("失败 ")}{rule.failureCount ?? 0}</span>
        <span>{siteRuleOutcomeText(rule.lastOutcome)}</span>
      </div>

      <div className="site-rule-path-editor">
        <label>
          <span>{t("匹配路径")}</span>
          <input
            value={pathDraft}
            onChange={(event) => setPathDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && pathChanged) {
                onPathPatternChange(rule.id, normalizedPath);
              }
            }}
            placeholder={t("整站，或输入 /login、/account/*")}
          />
        </label>
        <button className="secondary-action small" type="button" disabled={!pathChanged} onClick={() => onPathPatternChange(rule.id, normalizedPath)}>{t("保存路径")}</button>
      </div>

      <div className="site-rule-field-preview" aria-label={t("{0} 字段摘要", [rule.domain])}>
        {previewFields.length ? (
          previewFields.map((field, index) => (
            <span key={`${field.kind}-${field.selector ?? field.name ?? field.label}-${index}`}>
              {siteRuleFieldKindText(field.kind)} · {field.label || field.placeholder || field.name || field.selector || t("未命名")}
            </span>
          ))
        ) : (
          <span>{t("暂无字段结构，下一次成功填充后会自动补充。")}</span>
        )}
        {fields.length > previewFields.length ? <span>+{fields.length - previewFields.length}{t(" 个字段")}</span> : null}
      </div>

      <footer className="site-rule-controls">
        <select
          aria-label={t("设置 {0} 的页面类型", [rule.domain])}
          value={rule.pageMode ?? 'auto'}
          onChange={(event) => onPageModeChange(rule.id, event.currentTarget.value as SiteRulePageMode)}
        >
          <option value="auto">{t("自动识别")}</option>
          <option value="login">{t("登录页")}</option>
          <option value="register">{t("注册页")}</option>
          <option value="fill-profile">{t("填表页")}</option>
        </select>
        <button
          className={rule.disablePasswordGenerator ? 'rule-chip active' : 'rule-chip'}
          type="button"
          aria-pressed={Boolean(rule.disablePasswordGenerator)}
          onClick={() => onPasswordGeneratorChange(rule.id, !rule.disablePasswordGenerator)}
        >
          {rule.disablePasswordGenerator ? t("生成器已禁用") : t("允许密码生成器")}
        </button>
        <button className="text-danger small" type="button" onClick={() => onDelete(rule.id)}>{t("删除规则")}</button>
      </footer>
    </article>
  );
}

function diagnosticOutcomeText(outcome: DiagnosticLogEntry['outcome']): string {
  if (outcome === 'success') return t("成功");
  if (outcome === 'failure') return t("失败");
  if (outcome === 'pending') return t("等待");
  if (outcome === 'ignored') return t("忽略");
  return t("信息");
}

function formatDiagnosticTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString(getLanguage(), {
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
        <strong>{t("暂无诊断记录")}</strong>
        <span>{t("开启后，KeyPilot 只会保留最近的识别判断摘要。")}</span>
      </div>
    );
  }

  return (
    <div className="diagnostic-log-list" role="list" aria-label={t("最近识别诊断记录")}>
      {logs.slice(0, 12).map((entry) => (
        <article className={`diagnostic-log-item ${entry.outcome}`} key={entry.id} role="listitem">
          <div>
            <strong>{entry.event}</strong>
            <span>{entry.domain}</span>
          </div>
          <p>{entry.reason || t("没有记录原因。")}</p>
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

function inlineSilentReasonText(reason: InlineSilentRule['reason']): string {
  if (reason === 'empty-page') return t("空页面");
  if (reason === 'passive-form') return t("营销/留言表单");
  if (reason === 'manual-hide') return t("用户手动隐藏");
  if (reason === 'no-form-context') return t("没有填表上下文");
  return t("没有登录锚点");
}

function inlineSilentSourceText(source?: InlineSilentRule['source']): string {
  return source === 'manual' ? t("手动添加") : t("自动学习");
}

function InlineSilentRuleList({ rules, total, onDelete }: { rules: InlineSilentRule[]; total: number; onDelete: (id: string) => void }) {
  if (!rules.length) {
    return <RuleEmptyState title={t("没有匹配的静默规则")} body={t("换一个域名或路径关键词再试。")} />;
  }

  return (
    <div className="diagnostic-log-list" role="list" aria-label={t("自动静默规则")}>
      <div className="rule-count">{t("显示 ")}{rules.length} / {total}{t(" 条")}</div>
      {rules.slice(0, 12).map((rule) => (
        <article className="diagnostic-log-item ignored" key={rule.id} role="listitem">
          <div>
            <strong>{rule.title || `${rule.domain}${rule.pathPattern ? rule.pathPattern : ''}`}</strong>
            <span>{inlineSilentSourceText(rule.source)} · {inlineSilentReasonText(rule.reason)}</span>
          </div>
          <p>
            {rule.domain}{rule.pathPattern ? rule.pathPattern : ''}{t(" · 置信度 ")}{Math.round(rule.confidence * 100)}{t("%，命中 ")}{rule.matchCount}{t(" 次。 规则只隐藏网页内浮标，不影响插件弹窗。")}</p>
          <footer>
            <time dateTime={new Date(rule.updatedAt).toISOString()}>{formatDiagnosticTime(rule.updatedAt)}</time>
            {rule.lastMatchedAt ? <span>{t("最后命中 ")}{formatDiagnosticTime(rule.lastMatchedAt)}</span> : null}
            {rule.expiresAt ? <span>{Math.max(1, Math.ceil((rule.expiresAt - Date.now()) / 86400000))}{t(" 天后过期")}</span> : null}
            <button className="text-danger small" type="button" onClick={() => onDelete(rule.id)}>{t("删除")}</button>
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
        <span>{t("重置会删除本机加密 Vault，无法撤销。")}</span>
      </div>
      <button className="danger-action" type="button" onClick={onReset}>
        <Trash2 size={16} aria-hidden="true" />{t("重置 Vault")}</button>
    </div>
  );
}

function NoticeToast({ notice, onDismiss }: { notice: Notice; onDismiss: () => void }) {
  return (
    <div className={`options-notice ${notice.kind}`}>
      <span>{notice.text}</span>
      <button type="button" aria-label={t("关闭提示")} onClick={onDismiss}>
        ×
      </button>
    </div>
  );
}

function LoadingPanel() {
  return (
    <div className="state-panel">
      <div className="state-loader" />
      <h1>{t("正在读取设置")}</h1>
      <p>{t("KeyPilot 正在检查本地 Vault 状态。")}</p>
    </div>
  );
}

function EmptyVaultPanel({ onOpenVault }: { onOpenVault: () => void }) {
  return (
    <div className="state-panel">
      <Database size={34} aria-hidden="true" />
      <h1>{t("还没有本地 Vault")}</h1>
      <p>{t("先创建本地密码库后，设置项会保存到加密 Vault 中。")}</p>
      <button className="primary-action" type="button" onClick={onOpenVault}>{t("创建 Vault")}</button>
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
      <h1>{t("解锁设置")}</h1>
      <p>{t("设置保存在本地加密 Vault 内，请先输入主密码。")}</p>
      <label className="field-block">
        <span>{t("主密码")}</span>
        <input type="password" value={password} onChange={(event) => onPasswordChange(event.currentTarget.value)} autoFocus />
      </label>
      <button className="primary-action" type="submit" disabled={unlocking || !password.trim()}>
        {unlocking ? t("正在解锁") : t("解锁设置")}
      </button>
      <button className="text-action" type="button" onClick={onOpenVault}>{t("打开 KeyPilot 主页")}</button>
    </form>
  );
}
