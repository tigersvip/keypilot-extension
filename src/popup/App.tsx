import { useEffect, useMemo, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  Bug,
  Check,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  Clock3,
  Copy,
  Download,
  Edit3,
  ExternalLink,
  Eye,
  EyeOff,
  FileInput,
  Folder,
  Home,
  Import,
  IdCard,
  KeyRound,
  Library,
  Lock,
  MoreVertical,
  Plus,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Star,
  Trash2,
  Upload,
  UnlockKeyhole,
  UserRound,
  Wand2,
  X
} from 'lucide-react';
import { parseCredentialCsv, type ImportPreview, type ImportPreviewRow, type ImportSource } from '../shared/csvImport';
import { exportRoboFormCsv } from '../shared/csvExport';
import { generateRecoveryCode } from '../shared/crypto';
import { credentialMatchesUrl, domainsMatch, extractDomain, extractMatchDomain, normalizeMatchUrl, normalizeUrl } from '../shared/domain';
import { getIconCandidates, getRootFaviconUrl, toHttpIconUrl } from '../shared/icons';
import { defaultGeneratorOptions, generatePassword, measurePasswordStrength, type PasswordGeneratorOptions } from '../shared/passwordGenerator';
import { clearEncryptedVault, getEncryptedVault, saveEncryptedVault } from '../shared/storage';
import {
  addCredentialToVault,
  buildCredential,
  changeVaultMasterPassword,
  clearVaultSessionCache,
  createVaultSession,
  deleteCredentialFromVault,
  deleteFillProfileFromVault,
  disableVaultRecovery,
  enableVaultRecovery,
  persistVaultSession,
  resetVaultMasterPassword,
  restoreCachedVaultSession,
  touchCredentialInVault,
  unlockVaultWithRecoveryCode,
  unlockVaultSession,
  updateCredentialInVault,
  updateFillProfileInVault,
  upsertVaultSettings
} from '../shared/vault';
import type {
  Credential,
  CredentialAction,
  CredentialFormField,
  CredentialIconType,
  FillCredentialPayload,
  FillCredentialResult,
  FillField,
  FillProfile,
  FillProfileFillResult,
  FillProfilePayload,
  InlineDiagnosticsResult,
  PendingLoginCandidate,
  SiteRule,
  SiteRuleField,
  SubmitOutcome,
  SubmitRepairAction,
  UnlockedVaultSession,
  VaultPlain,
  VaultStatus
} from '../shared/types';

type NoticeKind = 'success' | 'error' | 'info';
type ViewKey = 'home' | 'vault' | 'generator' | 'import' | 'settings' | 'detail' | 'edit';
type ConflictImportAction = 'skip' | 'update' | 'keep';
type SaveLoginMode = 'save' | 'update' | 'new' | 'skip' | 'blacklist';
const DEFAULT_REPAIR_ACTIONS: SubmitRepairAction[] = ['commit-fields', 'wait-enabled-click', 'retry-click', 'click-nearby', 'enter-password', 'request-submit'];
const SITE_RULE_LIMIT = 120;

interface Notice {
  kind: NoticeKind;
  text: string;
}

interface CurrentTabInfo {
  id?: number;
  url: string;
  title: string;
  domain: string;
  iconUrl?: string;
  iconType?: CredentialIconType;
}

interface ConfirmRequest {
  title: string;
  body: string;
  actionLabel: string;
  tone?: 'danger' | 'primary';
  onConfirm: () => void | Promise<void>;
}

interface EditDraft {
  id?: string;
  title: string;
  url: string;
  matchUrl: string;
  username: string;
  password: string;
  notes: string;
  tags: string;
  folder: string;
  iconUrl?: string;
  iconType?: CredentialIconType;
  pinned?: boolean;
}

interface PageMetaResponse {
  ok?: boolean;
  title?: string;
  url?: string;
  domain?: string;
  iconUrl?: string;
  iconType?: CredentialIconType;
}

interface OpenTabResult {
  ok: boolean;
  error?: string;
  tabId?: number;
}

function getErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  if (message === 'CSV_FORMAT_ERROR') return 'CSV 格式错误，请检查表头和分隔符。';
  if (message === 'VAULT_NOT_FOUND') return '未找到本地密码库，请重新创建 Vault。';
  if (message === 'UNSUPPORTED_VAULT') return 'Vault 版本暂不兼容。';
  if (message === 'RECOVERY_NOT_ENABLED') return '这个 Vault 还没有启用恢复码，只能使用主密码解锁或重置。';
  if (message === 'UNSUPPORTED_RECOVERY') return '恢复码版本暂不兼容。';
  if (message === 'INVALID_RECOVERY_CODE') return '恢复码不正确，请检查后重新输入。';
  if (message === 'CORRUPTED_VAULT') return 'Vault 数据损坏，无法读取。';
  if (message === 'NO_LOGIN_FORM') return '当前页面没有检测到登录表单。';
  if (message === 'NO_USERNAME_FIELD') return '当前页面没有检测到用户名输入框。';
  if (message === 'NO_PASSWORD_FIELD') return '当前页面没有检测到密码输入框。';
  if (message === 'NO_FILL_PROFILE_FIELDS') return '当前页面没有匹配到可填写的身份资料字段。';
  if (message === 'INVALID_FILL_PROFILE') return '这条填表资料为空，请重新导入或编辑。';
  if (message === 'NO_ACTIVE_TAB') return '没有可填充的当前标签页。';
  if (message === 'NO_RESPONSE') return '页面没有响应填充请求，请刷新页面后重试。';
  if (message === 'INVALID_CREDENTIAL_URL') return '该账号没有有效网址，请先编辑账号并填写 http 或 https 开头的网站地址。';
  if (message === 'INVALID_CREDENTIAL_ACTION') return '未知的账号操作，请刷新插件后重试。';
  if (message === 'TAB_CREATE_FAILED') return '无法打开目标网站，请检查账号网址是否有效。';
  if (message === 'BINDING_START_FAILED') return '无法启动字段绑定，请刷新网页后重试。';
  if (message === 'FILL_BINDING_START_FAILED') return '无法启动身份字段绑定，请刷新网页后重试。';
  if (message === 'FILL_BINDING_SAVE_FAILED') return '身份字段绑定保存失败，请重新绑定。';
  if (message === 'BINDING_DOMAIN_MISMATCH') return '当前网页与该账号域名不匹配，不能保存绑定。';
  if (message === 'INVALID_BINDING') return '绑定信息不完整，请重新绑定用户名框、密码框和登录按钮。';
  if (message === 'INVALID_BINDING_DOMAIN') return '当前网页没有有效域名，不能保存身份字段绑定。';
  if (message.includes('message port closed')) return '浏览器切换页面时通信被中断，请再试一次。若目标页已打开，可在该页面点击“浏览并填写”。';
  if (message.includes('Receiving end does not exist')) return '当前页面无法注入填充脚本，请刷新页面或换一个普通网页测试。';
  if (message === 'INVALID_MASTER_PASSWORD' || message === 'The operation failed for an operation-specific reason') {
    return '主密码错误，请重新输入。';
  }

  return message || '操作失败，请稍后重试。';
}

function submitOutcomeNotice(outcome?: SubmitOutcome): Notice | null {
  if (!outcome) return null;

  if (outcome.status === 'checking') {
    return { kind: 'info', text: outcome.message };
  }

  if (outcome.status === 'errorVisible' || outcome.status === 'blocked' || outcome.status === 'stillOnLogin') {
    return { kind: 'error', text: outcome.message };
  }

  if (outcome.status === 'navigated' || outcome.status === 'successLikely') {
    return { kind: 'success', text: outcome.message };
  }

  return { kind: 'info', text: outcome.message };
}

function stripSiteRuleFieldValue(field: CredentialFormField): SiteRuleField {
  return {
    label: field.label,
    name: field.name,
    id: field.id,
    selector: field.selector,
    type: field.type,
    autocomplete: field.autocomplete,
    placeholder: field.placeholder,
    ariaLabel: field.ariaLabel,
    kind: field.kind,
    index: field.index
  };
}

function upsertSiteRuleFromCandidate(vault: VaultPlain, candidate: PendingLoginCandidate): VaultPlain {
  const domain = extractDomain(candidate.url || candidate.domain);
  const hasFieldSelectors = Boolean(candidate.formFields?.some((field) => field.selector || field.id || field.name));
  const hasProfile = Boolean(candidate.formProfile?.submit || candidate.formProfile?.selector);

  if (!domain || (!hasFieldSelectors && !hasProfile)) {
    return vault;
  }

  const siteRules = vault.settings.siteRules ?? [];
  const existing = siteRules.find((rule) => domainsMatch(rule.domain, domain));
  const now = Date.now();
  const nextRule: SiteRule = {
    id: existing?.id ?? crypto.randomUUID(),
    domain,
    formFields: candidate.formFields?.map(stripSiteRuleFieldValue).slice(0, 40),
    formProfile: candidate.formProfile ?? existing?.formProfile,
    repairActions: existing?.repairActions ?? DEFAULT_REPAIR_ACTIONS,
    source: 'save-prompt',
    successCount: existing?.successCount ?? 0,
    failureCount: existing?.failureCount ?? 0,
    lastOutcome: existing?.lastOutcome,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  };

  return upsertVaultSettings(vault, {
    siteRules: [nextRule, ...siteRules.filter((rule) => rule.id !== nextRule.id)].slice(0, SITE_RULE_LIMIT)
  });
}

function normalizedCredentialTitle(value: string): string {
  return value
    .replace(/[\t\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\/.*$/, '');
}

function isWeakCredentialTitle(title: string, domain: string): boolean {
  const normalized = normalizedCredentialTitle(title);
  const normalizedDomain = normalizedCredentialTitle(domain);

  if (!normalized) return true;
  if (normalized === normalizedDomain) return true;
  if (/^(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?(?:\s*[-–—|:：]\s*(?:password|passwd|pwd|login|sign in|登录|密码))?$/i.test(title.trim())) return true;
  if (/^(?:login|log in|sign in|signin|sign-in|password|passwd|pwd|登录|登陆|登入|密码|用户登录|后台登录)$/i.test(title.trim())) return true;
  return false;
}

function refreshDuplicateCredential(vault: VaultPlain, existing: Credential, candidate: PendingLoginCandidate): VaultPlain {
  const candidateTitle = candidate.title.trim();
  const shouldRefreshTitle = Boolean(
    candidateTitle &&
    candidateTitle !== existing.title &&
    !isWeakCredentialTitle(candidateTitle, candidate.domain) &&
    isWeakCredentialTitle(existing.title, existing.domain)
  );
  const shouldRefreshIcon = Boolean(
    existing.iconType !== 'custom' &&
    candidate.iconUrl &&
    candidate.iconUrl !== existing.iconUrl &&
    (!existing.iconUrl || existing.iconType === 'default' || /\/favicon\.ico(?:[?#].*)?$/i.test(existing.iconUrl))
  );

  if (!shouldRefreshTitle && !shouldRefreshIcon) {
    return vault;
  }

  return updateCredentialInVault(vault, {
    ...existing,
    title: shouldRefreshTitle ? candidateTitle : existing.title,
    url: candidate.url || existing.url,
    iconUrl: shouldRefreshIcon ? candidate.iconUrl : existing.iconUrl,
    iconType: shouldRefreshIcon ? candidate.iconType ?? 'favicon' : existing.iconType,
    updatedAt: Date.now()
  });
}

function formatTime(timestamp?: number): string {
  if (!timestamp) return '未使用';

  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (minutes < 2) return '刚刚使用';
  if (minutes < 60) return `${minutes} 分钟前`;
  if (hours < 24) return `${hours} 小时前`;
  if (days < 7) return `${days} 天前`;
  return `${Math.floor(days / 7)} 周前`;
}

function formatDateTime(timestamp?: number): string {
  if (!timestamp) return '未使用';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(timestamp);
}

function canUseExtensionApi(): boolean {
  return Boolean(globalThis.chrome?.runtime?.id);
}

function sendRuntimeMessage<T>(message: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    if (!canUseExtensionApi()) {
      reject(new Error('EXTENSION_API_UNAVAILABLE'));
      return;
    }

    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      resolve(response as T);
    });
  });
}

function isSupportedCredentialUrl(url: string): boolean {
  try {
    const parsed = new URL(normalizeUrl(url));
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function getPageMetaFromTab(tabId: number): Promise<PageMetaResponse | null> {
  return new Promise((resolve) => {
    if (!globalThis.chrome?.tabs?.sendMessage) {
      resolve(null);
      return;
    }

    chrome.tabs.sendMessage(tabId, { type: 'KEYPILOT_GET_PAGE_META' }, (response) => {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }

      resolve((response as PageMetaResponse | undefined) ?? null);
    });
  });
}

function sendActiveTabMessage<T>(tabId: number, message: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    if (!globalThis.chrome?.tabs?.sendMessage) {
      reject(new Error('EXTENSION_API_UNAVAILABLE'));
      return;
    }

    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      resolve(response as T);
    });
  });
}

function openVaultHomePage() {
  const url = globalThis.chrome?.runtime?.getURL?.('vault.html') ?? 'vault.html';

  try {
    void chrome.tabs.create({ url, active: true });
    return;
  } catch {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

function openOptionsPage() {
  const url = globalThis.chrome?.runtime?.getURL?.('options.html') ?? 'options.html';

  try {
    void chrome.tabs.create({ url, active: true });
    return;
  } catch {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

async function getActiveTabDiagnostics(): Promise<InlineDiagnosticsResult | null> {
  if (!canUseExtensionApi()) return null;

  try {
    const response = await sendRuntimeMessage<InlineDiagnosticsResult>({
      type: 'KEYPILOT_GET_ACTIVE_TAB_DIAGNOSTICS'
    });

    return response.ok ? response : null;
  } catch {
    return null;
  }
}

async function getCurrentTab(): Promise<CurrentTabInfo | null> {
  return new Promise((resolve) => {
    if (!globalThis.chrome?.tabs?.query) {
      resolve(null);
      return;
    }

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];

      if (!tab?.url) {
        resolve(null);
        return;
      }

      const rootIconUrl = getRootFaviconUrl(tab.url);
      const baseInfo: CurrentTabInfo = {
        id: tab.id,
        url: tab.url,
        title: tab.title ?? '',
        domain: extractDomain(tab.url),
        iconUrl: rootIconUrl,
        iconType: rootIconUrl ? 'favicon' : 'default'
      };

      if (!tab.id) {
        resolve(baseInfo);
        return;
      }

      void getPageMetaFromTab(tab.id).then((meta) => {
        const metaUrl = meta?.url || baseInfo.url;
        const iconUrl = toHttpIconUrl(meta?.iconUrl) ?? getRootFaviconUrl(metaUrl);

        resolve({
          ...baseInfo,
          url: metaUrl,
          title: meta?.title || baseInfo.title,
          domain: extractDomain(metaUrl),
          iconUrl,
          iconType: iconUrl ? 'favicon' : 'default'
        });
      });
    });
  });
}

function credentialToFillPayload(credential: Credential, autoSubmit: boolean): FillCredentialPayload {
  return {
    id: credential.id,
    url: credential.url,
    domain: credential.domain,
    username: credential.username,
    password: credential.password,
    formFields: credential.formFields,
    formProfile: credential.formProfile,
    autoSubmit
  };
}

function fillProfileToPayload(profile: FillProfile, onlyEmpty = true): FillProfilePayload {
  return {
    id: profile.id,
    title: profile.title,
    countryCode: profile.countryCode,
    category: profile.category,
    fields: profile.fields,
    onlyEmpty
  };
}

function fillFieldValue(fields: FillField[], key: string): string {
  return fields.find((field) => field.key === key)?.value ?? '';
}

function fillProfileSummary(profile: FillProfile): string {
  const fullName =
    fillFieldValue(profile.fields, 'fullName') ||
    [fillFieldValue(profile.fields, 'firstName'), fillFieldValue(profile.fields, 'lastName')].filter(Boolean).join(' ');
  const email = fillFieldValue(profile.fields, 'email');
  const phone = fillFieldValue(profile.fields, 'phone');
  const business = fillFieldValue(profile.fields, 'businessName') || fillFieldValue(profile.fields, 'dbaName');
  const loanAmount = fillFieldValue(profile.fields, 'loanAmount');
  const vehicle = [fillFieldValue(profile.fields, 'vehicleYear'), fillFieldValue(profile.fields, 'vehicleMake'), fillFieldValue(profile.fields, 'vehicleModel')]
    .filter(Boolean)
    .join(' ');

  return business || loanAmount || fullName || email || phone || vehicle || `${profile.fields.length} 个字段`;
}

type FillProfileTone = 'identity' | 'business' | 'payment' | 'tone-green' | 'tone-purple' | 'tone-amber' | 'tone-rose' | 'tone-blue' | 'tone-slate';

function stableHash(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function fillProfileTone(profile: FillProfile): FillProfileTone {
  if (profile.category === 'auto_insurance') {
    const autoTones = ['tone-green', 'tone-blue', 'tone-purple', 'tone-amber', 'tone-rose'] as const;
    return autoTones[stableHash(`${profile.id}:${profile.title}:${fillProfileSummary(profile)}`) % autoTones.length];
  }

  if (profile.category === 'payment') return 'payment';
  if (profile.category === 'business') return 'business';
  if (profile.category === 'loan') return 'tone-purple';

  const tones = ['tone-blue', 'tone-green', 'tone-purple', 'tone-amber', 'tone-rose', 'tone-slate'] as const;
  return tones[stableHash(`${profile.id}:${profile.title}:${profile.category}`) % tones.length];
}

function fillProfileBadgeText(profile: FillProfile): string {
  if (profile.category === 'auto_insurance') {
    return '车';
  }
  if (profile.category === 'loan') return '贷';
  if (profile.category === 'business') return '企';
  if (profile.category === 'payment') return '卡';
  return profile.title.trim().slice(0, 1).toUpperCase() || 'ID';
}

function fillProfileCategoryLabel(profile: FillProfile): string {
  if (profile.category === 'auto_insurance') return '车险资料';
  if (profile.category === 'shipping') return '地址资料';
  if (profile.category === 'payment') return '付款资料';
  if (profile.category === 'business') return '公司资料';
  if (profile.category === 'loan') return '贷款资料';
  if (profile.category === 'identity') return '身份资料';
  return '填表资料';
}

function fillFieldGroupLabel(group: FillField['group']): string {
  const labels: Record<FillField['group'], string> = {
    personal: '个人',
    contact: '联系方式',
    address: '所在地',
    driver: '驾驶资料',
    vehicle: '车辆',
    insurance: '保险',
    payment: '付款',
    business: '公司',
    loan: '贷款',
    employment: '工作',
    finance: '财务',
    sensitive: '敏感资料',
    custom: '其他'
  };

  return labels[group] ?? '其他';
}

function fillProfileCountryName(countryCode: string): string {
  const countries: Record<string, string> = {
    US: 'United States',
    CN: 'China',
    CA: 'Canada',
    GB: 'United Kingdom',
    UK: 'United Kingdom',
    AU: 'Australia'
  };
  return countries[countryCode.toUpperCase()] ?? countryCode.toUpperCase();
}

function withInferredCountryField(profile: FillProfile): FillField[] {
  const fields = profile.fields.filter((field) => field.value.trim());
  const hasCountry = fields.some((field) => field.key === 'country' || field.key === 'businessCountry');
  const hasAddressSignal = fields.some((field) =>
    field.group === 'address' ||
    ['address1', 'address2', 'city', 'state', 'postalCode', 'licensedState', 'businessState', 'businessPostalCode'].includes(field.key)
  );

  if (hasCountry || !hasAddressSignal || !profile.countryCode) {
    return fields;
  }

  return [
    ...fields,
    {
      key: 'country',
      label: '国家',
      value: fillProfileCountryName(profile.countryCode),
      group: 'address',
      sensitivity: 'normal',
      aliases: ['country', 'country code', 'country/region', 'nation', '国家', '国家/地区']
    }
  ];
}

function fillProfileFieldsByGroup(profile: FillProfile): Array<[FillField['group'], FillField[]]> {
  const groups = new Map<FillField['group'], FillField[]>();

  withInferredCountryField(profile)
    .forEach((field) => {
      groups.set(field.group, [...(groups.get(field.group) ?? []), field]);
    });

  const order: FillField['group'][] = [
    'personal',
    'contact',
    'address',
    'business',
    'loan',
    'employment',
    'finance',
    'driver',
    'vehicle',
    'insurance',
    'payment',
    'sensitive',
    'custom'
  ];

  return [...groups.entries()].sort((left, right) => order.indexOf(left[0]) - order.indexOf(right[0]));
}

function formatFillProfileForClipboard(profile: FillProfile): string {
  const lines = [`${profile.title}`, `${fillProfileCategoryLabel(profile)} · ${profile.countryCode}`];

  fillProfileFieldsByGroup(profile).forEach(([group, fields]) => {
    lines.push('', `[${fillFieldGroupLabel(group)}]`);
    fields.forEach((field) => {
      lines.push(`${field.label}: ${field.value}`);
    });
  });

  return lines.join('\n');
}

function createDraft(credential?: Credential, password = ''): EditDraft {
  return {
    id: credential?.id,
    title: credential?.title ?? '',
    url: credential?.url ?? '',
    matchUrl: credential?.matchUrl ?? '',
    username: credential?.username ?? '',
    password: credential?.password ?? password,
    notes: credential?.notes ?? '',
    tags: credential?.tags?.join(', ') ?? '',
    folder: credential?.folder ?? '',
    iconUrl: credential?.iconUrl,
    iconType: credential?.iconType ?? (credential?.iconUrl ? 'favicon' : 'default'),
    pinned: credential?.pinned ?? false
  };
}

export function App() {
  const [status, setStatus] = useState<VaultStatus>('checking');
  const [session, setSession] = useState<UnlockedVaultSession | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null);
  const [recoveryCodeToShow, setRecoveryCodeToShow] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;

    restoreCachedVaultSession()
      .then(async (cachedSession) => {
        if (!mounted) return;

        if (cachedSession) {
          setSession(cachedSession);
          setStatus('unlocked');
          return;
        }

        const vault = await getEncryptedVault();
        if (!mounted) return;
        setStatus(vault ? 'locked' : 'setup');
      })
      .catch(() => {
        if (!mounted) return;
        setStatus('setup');
        setNotice({ kind: 'error', text: '读取本地 Vault 状态失败。' });
      });

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (!session || session.vault.settings.autoLockMinutes <= 0) {
      return undefined;
    }

    const timer = window.setTimeout(
      () => {
        void clearVaultSessionCache();
        setSession(null);
        setStatus('locked');
        setNotice({ kind: 'info', text: '已按设置自动锁定 Vault。' });
      },
      session.vault.settings.autoLockMinutes * 60 * 1000
    );

    return () => window.clearTimeout(timer);
  }, [session]);

  function handleUnlocked(nextSession: UnlockedVaultSession, recoveryCode?: string) {
    setSession(nextSession);
    setStatus('unlocked');
    setNotice({ kind: 'success', text: 'Vault 已解锁。' });
    if (recoveryCode) {
      setRecoveryCodeToShow(recoveryCode);
    }
  }

  function handleLock() {
    void clearVaultSessionCache();
    setSession(null);
    setStatus('locked');
    setNotice({ kind: 'info', text: 'Vault 已锁定。' });
  }

  function requestResetVault() {
    setConfirmRequest({
      title: '重置本地 Vault',
      body: '这会删除本机保存的加密 Vault。忘记主密码时只能这样重新开始，此操作无法撤销。',
      actionLabel: '重置 Vault',
      tone: 'danger',
      onConfirm: async () => {
        await clearEncryptedVault();
        setSession(null);
        setStatus('setup');
        setNotice({ kind: 'info', text: '本地 Vault 已重置。' });
      }
    });
  }

  async function handleSessionChange(nextSession: UnlockedVaultSession, message: string) {
    setSession(nextSession);
    setNotice({ kind: 'success', text: message });
  }

  return (
    <div className="popup-shell">
      {status === 'checking' ? <CheckingState /> : null}
      {status === 'setup' ? (
        <AuthShell>
          <SetupPage onCreated={handleUnlocked} onError={(text) => setNotice({ kind: 'error', text })} />
        </AuthShell>
      ) : null}
      {status === 'locked' ? (
        <AuthShell>
          <UnlockPage
            onUnlocked={handleUnlocked}
            onReset={requestResetVault}
            onError={(text) => setNotice({ kind: 'error', text })}
          />
        </AuthShell>
      ) : null}
      {status === 'unlocked' && session ? (
        <PopupHome
          session={session}
          notice={notice}
          onDismissNotice={() => setNotice(null)}
          onLock={handleLock}
          onReset={requestResetVault}
          onNotice={setNotice}
          onConfirm={setConfirmRequest}
          onSessionChange={handleSessionChange}
          onShowRecoveryCode={setRecoveryCodeToShow}
        />
      ) : null}
      {status !== 'unlocked' && notice ? <NoticeToast notice={notice} onDismiss={() => setNotice(null)} /> : null}
      {confirmRequest ? <ConfirmDialog request={confirmRequest} onClose={() => setConfirmRequest(null)} /> : null}
      {recoveryCodeToShow ? (
        <RecoveryCodeDialog
          code={recoveryCodeToShow}
          onClose={() => setRecoveryCodeToShow(null)}
          onNotice={setNotice}
        />
      ) : null}
    </div>
  );
}

function PopupHome({
  session,
  notice,
  onDismissNotice,
  onLock,
  onReset,
  onNotice,
  onConfirm,
  onSessionChange,
  onShowRecoveryCode
}: {
  session: UnlockedVaultSession;
  notice: Notice | null;
  onDismissNotice: () => void;
  onLock: () => void;
  onReset: () => void;
  onNotice: (notice: Notice) => void;
  onConfirm: (request: ConfirmRequest) => void;
  onSessionChange: (session: UnlockedVaultSession, message: string) => void;
  onShowRecoveryCode: (code: string) => void;
}) {
  const [activeView, setActiveView] = useState<ViewKey>('home');
  const [previousView, setPreviousView] = useState<ViewKey>('home');
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(session.vault.credentials[0]?.id ?? null);
  const [editDraft, setEditDraft] = useState<EditDraft | null>(null);
  const [currentTab, setCurrentTab] = useState<CurrentTabInfo | null>(null);
  const [diagnostics, setDiagnostics] = useState<InlineDiagnosticsResult | null>(null);
  const [pendingCandidate, setPendingCandidate] = useState<PendingLoginCandidate | null>(null);
  const [launchHashHandled, setLaunchHashHandled] = useState(false);
  const [renameFillProfileTarget, setRenameFillProfileTarget] = useState<FillProfile | null>(null);

  useEffect(() => {
    void refreshCurrentTab();
  }, []);

  useEffect(() => {
    if (canUseExtensionApi()) {
      void sendRuntimeMessage({
        type: 'KEYPILOT_SET_SAVE_POLICY',
        autoPromptSave: session.vault.settings.autoPromptSave,
        blacklist: session.vault.settings.blacklist
      }).catch(() => undefined);

      void sendRuntimeMessage<{ ok: boolean; candidate?: PendingLoginCandidate | null }>({
        type: 'KEYPILOT_GET_SAVE_CANDIDATE'
      })
        .then((response) => {
          const candidate = response.candidate ?? null;

          if (candidate && (session.vault.settings.blacklist.includes(candidate.domain) || !session.vault.settings.autoPromptSave)) {
            void sendRuntimeMessage({ type: 'KEYPILOT_CLEAR_SAVE_CANDIDATE' }).catch(() => undefined);
            setPendingCandidate(null);
            return;
          }

          setPendingCandidate(candidate);
        })
        .catch(() => undefined);
    }
  }, [session.vault.settings.autoPromptSave, session.vault.settings.blacklist]);

  const filteredCredentials = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const sorted = [...session.vault.credentials].sort((left, right) => {
      if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
      return (right.lastUsedAt ?? right.updatedAt) - (left.lastUsedAt ?? left.updatedAt);
    });

    if (!normalizedQuery) return sorted;

    return sorted.filter((credential) =>
      [credential.title, credential.domain, credential.matchUrl ?? '', credential.username, credential.notes ?? '', credential.folder ?? '', credential.tags?.join(' ') ?? ''].some(
        (value) => value.toLowerCase().includes(normalizedQuery)
      )
    );
  }, [query, session.vault.credentials]);

  const currentMatches = useMemo(() => {
    if (!currentTab?.url) return [];
    return session.vault.credentials.filter((credential) => credentialMatchesUrl(credential, currentTab.url));
  }, [currentTab?.url, session.vault.credentials]);
  const currentDomainAutoSaveEnabled = useMemo(() => {
    if (!currentTab?.domain) return session.vault.settings.autoPromptSave;

    return (
      session.vault.settings.autoPromptSave &&
      !session.vault.settings.blacklist.some((domain) => domainsMatch(domain, currentTab.domain))
    );
  }, [currentTab?.domain, session.vault.settings.autoPromptSave, session.vault.settings.blacklist]);

  const selectedCredential = useMemo(
    () => session.vault.credentials.find((credential) => credential.id === selectedId) ?? null,
    [selectedId, session.vault.credentials]
  );

  useEffect(() => {
    if (launchHashHandled) return;

    const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const editId = params.get('edit') ?? params.get('rename');
    const detailId = params.get('credential') ?? params.get('detail');
    const targetId = editId ?? detailId;

    if (!targetId) {
      setLaunchHashHandled(true);
      return;
    }

    const credential = session.vault.credentials.find((item) => item.id === targetId);

    if (!credential) {
      setLaunchHashHandled(true);
      return;
    }

    setSelectedId(credential.id);
    setPreviousView('home');

    if (editId) {
      setEditDraft(createDraft(credential));
      setActiveView('edit');
    } else {
      setActiveView('detail');
    }

    setLaunchHashHandled(true);
  }, [launchHashHandled, session.vault.credentials]);

  async function refreshCurrentTab() {
    const [tab, nextDiagnostics] = await Promise.all([getCurrentTab(), getActiveTabDiagnostics()]);
    setCurrentTab(tab);
    setDiagnostics(nextDiagnostics);
  }

  async function handleToggleRecognitionDebug() {
    if (!currentTab?.id) {
      onNotice({ kind: 'error', text: '当前标签页无法打开识别调试面板，请切换到普通网页后再试。' });
      return;
    }

    try {
      const response = await sendActiveTabMessage<{ ok: boolean; open?: boolean; error?: string }>(currentTab.id, {
        type: 'KEYPILOT_TOGGLE_RECOGNITION_DEBUG'
      });

      if (!response?.ok) {
        throw new Error(response?.error ?? 'RECOGNITION_DEBUG_FAILED');
      }

      onNotice({
        kind: 'info',
        text: response.open ? '已在网页右上角打开识别调试面板。' : '已关闭网页识别调试面板。'
      });
      void refreshCurrentTab();
    } catch (error) {
      onNotice({ kind: 'error', text: getErrorMessage(error) });
    }
  }

  function refreshSubmitOutcomeNotice(delay = 1900, attempt = 0) {
    window.setTimeout(() => {
      void getActiveTabDiagnostics()
        .then((nextDiagnostics) => {
          setDiagnostics(nextDiagnostics);
          const notice = submitOutcomeNotice(nextDiagnostics?.submitOutcome);
          if (notice) onNotice(notice);
          if (nextDiagnostics?.submitOutcome?.status === 'checking' && attempt < 2) {
            refreshSubmitOutcomeNotice(1700, attempt + 1);
          }
        })
        .catch(() => undefined);
    }, delay);
  }

  async function persist(vault = session.vault, message = '已保存。') {
    const nextSession = await persistVaultSession(session, vault);
    await onSessionChange(nextSession, message);
    return nextSession;
  }

  function go(view: ViewKey) {
    if (view === 'settings') {
      openOptionsPage();
      return;
    }

    setPreviousView(activeView);
    setActiveView(view);
  }

  function goBack() {
    setActiveView(previousView === 'detail' || previousView === 'edit' ? 'home' : previousView);
  }

  function openDetail(credential: Credential) {
    setSelectedId(credential.id);
    setPreviousView(activeView === 'edit' ? 'home' : activeView);
    setActiveView('detail');
  }

  function openEdit(credential?: Credential, password = '') {
    const currentIconUrl = toHttpIconUrl(currentTab?.iconUrl) ?? getRootFaviconUrl(currentTab?.url);
    const draft: EditDraft = credential
      ? createDraft(credential, password)
      : {
          ...createDraft(undefined, password),
          title: currentTab?.title || currentTab?.domain || '',
          url: currentTab?.url || '',
          iconUrl: currentIconUrl,
          iconType: currentIconUrl ? 'favicon' : 'default'
        };

    setEditDraft(draft);
    setPreviousView(activeView === 'detail' ? 'detail' : activeView);
    setActiveView('edit');
  }

  async function handleSaveDraft(draft: EditDraft) {
    const existing = draft.id ? session.vault.credentials.find((item) => item.id === draft.id) : undefined;
    const normalizedUrl = normalizeUrl(draft.url);
    const normalizedDomain = extractDomain(normalizedUrl);
    const matchUrl = normalizeMatchUrl(draft.matchUrl);
    const matchDomain = matchUrl ? extractMatchDomain(matchUrl) : undefined;
    const draftIconUrl = toHttpIconUrl(draft.iconUrl);
    const shouldKeepDraftIcon = Boolean(draftIconUrl && (!existing || existing.domain === normalizedDomain || draft.iconType === 'custom'));
    const iconUrl = shouldKeepDraftIcon ? draftIconUrl : getRootFaviconUrl(normalizedUrl);
    const iconType = iconUrl ? draft.iconType ?? 'favicon' : 'default';
    const credential: Credential = existing
      ? {
          ...existing,
          title: draft.title.trim() || normalizedDomain || '未命名账号',
          url: normalizedUrl,
          domain: normalizedDomain,
          matchUrl,
          matchDomain,
          iconUrl,
          iconType,
          username: draft.username.trim(),
          password: draft.password,
          notes: draft.notes.trim() || undefined,
          tags: draft.tags.split(',').map((item) => item.trim()).filter(Boolean),
          folder: draft.folder.trim() || undefined,
          pinned: draft.pinned,
          updatedAt: Date.now()
        }
      : buildCredential({
          title: draft.title,
          url: draft.url,
          matchUrl,
          iconUrl,
          iconType,
          username: draft.username,
          password: draft.password,
          notes: draft.notes,
          tags: draft.tags.split(',').map((item) => item.trim()).filter(Boolean),
          folder: draft.folder,
          source: 'manual'
        });

    const nextVault = existing ? updateCredentialInVault(session.vault, credential) : addCredentialToVault(session.vault, credential);
    await persist(nextVault, existing ? '账号已更新。' : '账号已加密保存。');
    setSelectedId(credential.id);
    setEditDraft(null);
    setPreviousView('home');
    setActiveView('detail');
  }

  function requestDelete(credential: Credential) {
    onConfirm({
      title: '删除账号',
      body: `将“${credential.title}”移到回收站？之后可以在主页回收站恢复。`,
      actionLabel: '移到回收站',
      tone: 'danger',
      onConfirm: async () => {
        await persist(deleteCredentialFromVault(session.vault, credential.id), '账号已移到回收站。');
        setActiveView('home');
      }
    });
  }

  async function handleTogglePin(credential: Credential) {
    await persist(updateCredentialInVault(session.vault, { ...credential, pinned: !credential.pinned }), credential.pinned ? '已取消收藏。' : '已收藏。');
  }

  async function handleCopy(label: string, value: string, clearLater = false) {
    await navigator.clipboard.writeText(value);
    onNotice({ kind: 'success', text: label });

    if (clearLater) {
      window.setTimeout(() => {
        void navigator.clipboard.writeText('');
      }, session.vault.settings.clearClipboardSeconds * 1000);
    }
  }

  async function handleToggleCurrentDomainAutoSave() {
    const domain = currentTab?.domain;

    if (!domain) {
      await persist(upsertVaultSettings(session.vault, { autoPromptSave: !session.vault.settings.autoPromptSave }), '自动保存设置已更新。');
      return;
    }

    const enabled = currentDomainAutoSaveEnabled;
    const blacklist = enabled
      ? Array.from(new Set([...session.vault.settings.blacklist, domain]))
      : session.vault.settings.blacklist.filter((item) => !domainsMatch(item, domain));

    await persist(upsertVaultSettings(session.vault, { autoPromptSave: true, blacklist }), enabled ? '已在此域关闭自动保存。' : '已在此域启用自动保存。');
  }

  async function handleCredentialAction(action: CredentialAction, credential: Credential, activeTabOnly = false) {
    const payload = credentialToFillPayload(credential, session.vault.settings.autoSubmit);

    try {
      if (action === 'goto') {
        if (!isSupportedCredentialUrl(credential.url)) throw new Error('INVALID_CREDENTIAL_URL');
        await persist(touchCredentialInVault(session.vault, credential.id), '已打开网站。');
        const response = await sendRuntimeMessage<OpenTabResult>({ type: 'KEYPILOT_OPEN_TAB', action, credential: payload });
        if (!response.ok) throw new Error(response.error ?? 'TAB_CREATE_FAILED');
        return;
      } else if (activeTabOnly && currentTab?.id) {
        const response = await sendRuntimeMessage<FillCredentialResult>({
          type: 'KEYPILOT_FILL_ACTIVE_TAB',
          tabId: currentTab.id,
          credential: {
            ...payload,
            autoSubmit: action === 'login' ? payload.autoSubmit : false
          }
        });

        if (!response.ok) throw new Error(response.error ?? 'FILL_FAILED');

        if (response.stage === 'usernameOnly') {
          onNotice({
            kind: 'info',
            text: response.submitted ? '已填写用户名并进入下一步，密码框出现后会继续填写。' : '已填写用户名。该页面可能是分步登录。'
          });
        } else if (response.skippedSubmit) {
          onNotice({ kind: 'info', text: '已填充。检测到验证码或敏感字段，未自动提交。' });
        } else if (response.submitButtonMissing && action === 'login') {
          onNotice({ kind: 'info', text: '已填充账号密码，但没有找到可靠的登录按钮。可在网页诊断里点“手动绑定字段”。' });
        }

        const outcomeNotice = submitOutcomeNotice(response.submitOutcome);
        if (outcomeNotice) {
          onNotice(outcomeNotice);
        }
        if (action === 'login' && response.submitOutcome?.status === 'checking') {
          refreshSubmitOutcomeNotice();
        }
      } else {
        if (!isSupportedCredentialUrl(credential.url)) throw new Error('INVALID_CREDENTIAL_URL');
        await persist(touchCredentialInVault(session.vault, credential.id), '已发送填充指令。');
        const response = await sendRuntimeMessage<OpenTabResult>({ type: 'KEYPILOT_OPEN_TAB', action, credential: payload });
        if (!response.ok) throw new Error(response.error ?? 'TAB_CREATE_FAILED');
        return;
      }

      await persist(touchCredentialInVault(session.vault, credential.id), '已发送填充指令。');
    } catch (error) {
      onNotice({ kind: 'error', text: getErrorMessage(error).replace('EXTENSION_API_UNAVAILABLE', '请在已加载的浏览器插件中测试该功能。') });
    }
  }

  async function handleFillProfile(profile: FillProfile, onlyEmpty = true) {
    try {
      if (!currentTab?.id) throw new Error('NO_ACTIVE_TAB');

      const response = await sendRuntimeMessage<FillProfileFillResult>({
        type: 'KEYPILOT_FILL_PROFILE_ACTIVE_TAB',
        tabId: currentTab.id,
        profile: fillProfileToPayload(profile, onlyEmpty)
      });

      if (!response.ok) {
        const matched = response.matchedCount ?? 0;
        const totalFields = response.totalFields || profile.fields.length;
        onNotice({
          kind: 'error',
          text:
            matched > 0
              ? `检测到 ${matched}/${totalFields} 个候选字段，但没有成功填写。请点击资料右侧“绑定字段”校准这个网站。`
              : '当前页面没有匹配到可填写的身份资料字段，请点击资料右侧“绑定字段”手动校准。'
        });
        return;
      }

      const now = Date.now();
      const missingCount = response.diagnostics?.filter((item) => item.status === 'missing').length ?? 0;
      await persist(
        {
          ...session.vault,
          fillProfiles: (session.vault.fillProfiles ?? []).map((item) =>
            item.id === profile.id ? { ...item, lastUsedAt: now, updatedAt: now } : item
          )
        },
        missingCount > 0 ? `已填写 ${response.filledCount} 个字段，${missingCount} 个字段未匹配。` : `已填写 ${response.filledCount} 个字段。`
      );
    } catch (error) {
      onNotice({ kind: 'error', text: getErrorMessage(error).replace('EXTENSION_API_UNAVAILABLE', '请在已加载的浏览器插件中测试该功能。') });
    }
  }

  async function handleBindFillProfile(profile: FillProfile) {
    try {
      if (!currentTab?.id) throw new Error('NO_ACTIVE_TAB');

      const response = await sendRuntimeMessage<{ ok: boolean; error?: string; locked?: boolean }>({
        type: 'KEYPILOT_START_FILL_PROFILE_BINDING',
        tabId: currentTab.id,
        profileId: profile.id
      });

      if (!response.ok) {
        throw new Error(response.error ?? (response.locked ? 'VAULT_LOCKED' : 'FILL_BINDING_START_FAILED'));
      }

      onNotice({ kind: 'info', text: '已启动身份字段绑定。请回到网页，选择资料字段后点击对应输入框。' });
    } catch (error) {
      onNotice({ kind: 'error', text: getErrorMessage(error).replace('EXTENSION_API_UNAVAILABLE', '请在已加载的浏览器插件中测试该功能。') });
    }
  }

  async function handleRenameFillProfile(profile: FillProfile, title: string) {
    const nextTitle = title.trim();

    if (!nextTitle || nextTitle === profile.title) {
      setRenameFillProfileTarget(null);
      return;
    }

    const currentProfile = (session.vault.fillProfiles ?? []).find((item) => item.id === profile.id);

    if (!currentProfile) {
      setRenameFillProfileTarget(null);
      onNotice({ kind: 'error', text: '这条身份资料已经不存在。' });
      return;
    }

    await persist(updateFillProfileInVault(session.vault, { ...currentProfile, title: nextTitle }), '身份资料已重命名。');
    setRenameFillProfileTarget(null);
  }

  function requestDeleteFillProfile(profile: FillProfile) {
    onConfirm({
      title: '删除身份资料',
      body: `将“${profile.title}”移到回收站？之后可以在主页回收站恢复。`,
      actionLabel: '移到回收站',
      tone: 'danger',
      onConfirm: async () => {
        await persist(deleteFillProfileFromVault(session.vault, profile.id), '身份资料已移到回收站。');
      }
    });
  }

  async function handleBindCredential(credential: Credential) {
    try {
      if (!currentTab?.id) throw new Error('NO_ACTIVE_TAB');

      const response = await sendRuntimeMessage<{ ok: boolean; error?: string; locked?: boolean }>({
        type: 'KEYPILOT_START_MANUAL_BINDING',
        tabId: currentTab.id,
        credentialId: credential.id
      });

      if (!response.ok) {
        throw new Error(response.error ?? (response.locked ? 'VAULT_LOCKED' : 'BINDING_START_FAILED'));
      }

      onNotice({ kind: 'info', text: '已启动字段绑定。请回到网页，依次点击用户名框、密码框和登录按钮。' });
    } catch (error) {
      onNotice({ kind: 'error', text: getErrorMessage(error) });
    }
  }

  async function handleSaveCandidate(candidate: PendingLoginCandidate, mode: SaveLoginMode) {
    if (mode === 'skip') {
      setPendingCandidate(null);
      await sendRuntimeMessage({ type: 'KEYPILOT_CLEAR_SAVE_CANDIDATE' }).catch(() => undefined);
      return;
    }

    if (mode === 'blacklist') {
      const blacklist = Array.from(new Set([...session.vault.settings.blacklist, candidate.domain]));
      await persist(upsertVaultSettings(session.vault, { blacklist }), '已加入不保存网站列表。');
      setPendingCandidate(null);
      await sendRuntimeMessage({ type: 'KEYPILOT_CLEAR_SAVE_CANDIDATE' }).catch(() => undefined);
      return;
    }

    const existing = session.vault.credentials.find(
      (credential) => domainsMatch(credential.domain, candidate.domain) && credential.username === candidate.username
    );
    const exactDuplicate = session.vault.credentials.find(
      (credential) =>
        domainsMatch(credential.domain, candidate.domain) &&
        credential.username === candidate.username &&
        credential.password === candidate.password
    );

    if (exactDuplicate) {
      const refreshedVault = refreshDuplicateCredential(session.vault, exactDuplicate, candidate);
      const withRule = upsertSiteRuleFromCandidate(refreshedVault, candidate);
      if (withRule !== session.vault) {
        await persist(withRule, '该登录信息已经存在，已刷新站点信息。');
      } else {
        onNotice({ kind: 'info', text: '该登录信息已经存在，已跳过保存。' });
      }
      setPendingCandidate(null);
      await sendRuntimeMessage({ type: 'KEYPILOT_CLEAR_SAVE_CANDIDATE' }).catch(() => undefined);
      return;
    }

    const shouldUpdate = Boolean(existing && (mode === 'save' || mode === 'update'));
    const iconUrl = toHttpIconUrl(candidate.iconUrl) ?? (shouldUpdate ? existing?.iconUrl : undefined) ?? getRootFaviconUrl(candidate.url);
    const iconType = iconUrl ? candidate.iconType ?? existing?.iconType ?? 'favicon' : 'default';
    const credential = shouldUpdate && existing
      ? {
          ...existing,
          password: candidate.password,
          formFields: candidate.formFields?.length ? candidate.formFields : existing.formFields,
          formProfile: candidate.formProfile ?? existing.formProfile,
          url: candidate.url,
          iconUrl,
          iconType,
          title: candidate.title.trim() || existing.title || candidate.domain,
          updatedAt: Date.now()
        }
      : buildCredential({
          title: candidate.title,
          url: candidate.url,
          iconUrl,
          iconType,
          username: candidate.username,
          password: candidate.password,
          formFields: candidate.formFields,
          formProfile: candidate.formProfile,
          source: 'manual'
        });

    const vault = shouldUpdate ? updateCredentialInVault(session.vault, credential) : addCredentialToVault(session.vault, credential);
    const withRule = upsertSiteRuleFromCandidate(vault, candidate);
    const ruleRecorded = withRule !== vault;
    await persist(
      withRule,
      shouldUpdate
        ? ruleRecorded
          ? '已更新已存在账号的密码和站点规则。'
          : '已更新已存在账号的密码。'
        : ruleRecorded
          ? '登录信息已保存为新记录，并记录站点规则。'
          : '登录信息已保存为新记录。'
    );
    setSelectedId(credential.id);
    setPendingCandidate(null);
    await sendRuntimeMessage({ type: 'KEYPILOT_CLEAR_SAVE_CANDIDATE' }).catch(() => undefined);
  }

  const content = (() => {
    if (activeView === 'detail' && selectedCredential) {
      return (
        <CredentialDetailPage
          credential={selectedCredential}
          settings={session.vault.settings}
          onBack={goBack}
          onAction={handleCredentialAction}
          onCopy={handleCopy}
          onEdit={() => openEdit(selectedCredential)}
          onDelete={() => requestDelete(selectedCredential)}
          onTogglePin={() => void handleTogglePin(selectedCredential)}
        />
      );
    }

    if (activeView === 'edit' && editDraft) {
      return (
        <CredentialEditPage
          draft={editDraft}
          onBack={goBack}
          onSave={handleSaveDraft}
          onDelete={editDraft.id && selectedCredential ? () => requestDelete(selectedCredential) : undefined}
        />
      );
    }

    if (activeView === 'generator') {
      return <GeneratorPage onUsePassword={(password) => openEdit(undefined, password)} onCopy={handleCopy} />;
    }

    if (activeView === 'import') {
      return (
        <ImportPage
          credentials={session.vault.credentials}
          onImport={async (credentials, updates) => {
            const updatesById = new Map(updates.map((credential) => [credential.id, credential]));
            const nextVault = {
              ...session.vault,
              credentials: [
                ...credentials,
                ...session.vault.credentials.map((credential) => updatesById.get(credential.id) ?? credential)
              ]
            };
            await persist(
              nextVault,
              `已新增 ${credentials.length} 条账号，更新 ${updates.length} 条账号。请删除原始 CSV 文件。`
            );
            setActiveView('vault');
          }}
          onNotice={onNotice}
        />
      );
    }

    if (activeView === 'settings') {
      return (
        <SettingsPage
          session={session}
          onReset={onReset}
          onNotice={onNotice}
          onSessionChange={onSessionChange}
          onPersist={persist}
          onShowRecoveryCode={onShowRecoveryCode}
        />
      );
    }

    return (
      <HomePage
        view={activeView}
        query={query}
        onQuery={setQuery}
        currentTab={currentTab}
        diagnostics={diagnostics}
        currentMatches={currentMatches}
        credentials={filteredCredentials}
        fillProfiles={session.vault.fillProfiles ?? []}
        total={session.vault.credentials.length}
        defaultSort={session.vault.settings.defaultHomeSort}
        onRefreshCurrentTab={refreshCurrentTab}
        onOpenDetail={openDetail}
        onAdd={() => openEdit()}
        onImport={() => setActiveView('import')}
        onOpenVaultHome={openVaultHomePage}
        onSettings={openOptionsPage}
        onTogglePageDebug={handleToggleRecognitionDebug}
        onAction={handleCredentialAction}
        onFillProfile={(profile, onlyEmpty) => void handleFillProfile(profile, onlyEmpty)}
        onBindFillProfile={(profile) => void handleBindFillProfile(profile)}
        onRenameFillProfile={setRenameFillProfileTarget}
        onDeleteFillProfile={requestDeleteFillProfile}
        onBind={handleBindCredential}
        onCopy={handleCopy}
        onTogglePin={handleTogglePin}
        onDelete={requestDelete}
        onEdit={openEdit}
        autoSaveEnabled={currentDomainAutoSaveEnabled}
        onToggleAutoSave={() => void handleToggleCurrentDomainAutoSave()}
      />
    );
  })();

  return (
    <div className={activeView === 'home' ? 'compact-app home-app' : 'compact-app'}>
      {activeView === 'home' ? null : (
        <Header
          searchOpen={searchOpen}
          query={query}
          onQuery={setQuery}
          onSearchToggle={() => setSearchOpen((value) => !value)}
          onOpenVaultHome={openVaultHomePage}
          onLock={onLock}
          onRefresh={refreshCurrentTab}
        />
      )}
      {notice ? <NoticeToast notice={notice} onDismiss={onDismissNotice} /> : null}
      {pendingCandidate && activeView === 'home' ? (
        <SaveLoginPrompt
          candidate={pendingCandidate}
          existing={session.vault.credentials.find(
            (credential) => domainsMatch(credential.domain, pendingCandidate.domain) && credential.username === pendingCandidate.username
          )}
          exactDuplicate={session.vault.credentials.some(
            (credential) =>
              domainsMatch(credential.domain, pendingCandidate.domain) &&
              credential.username === pendingCandidate.username &&
              credential.password === pendingCandidate.password
          )}
          onSave={handleSaveCandidate}
        />
      ) : null}
      <main className="compact-content">{content}</main>
      {renameFillProfileTarget ? (
        <RenameFillProfileDialog
          profile={renameFillProfileTarget}
          onClose={() => setRenameFillProfileTarget(null)}
          onSave={(title) => handleRenameFillProfile(renameFillProfileTarget, title)}
        />
      ) : null}
      {!['detail', 'edit', 'home'].includes(activeView) ? <BottomNav active={activeView} onChange={go} /> : null}
    </div>
  );
}

function Header({
  searchOpen,
  query,
  onQuery,
  onSearchToggle,
  onOpenVaultHome,
  onLock,
  onRefresh
}: {
  searchOpen: boolean;
  query: string;
  onQuery: (value: string) => void;
  onSearchToggle: () => void;
  onOpenVaultHome: () => void;
  onLock: () => void;
  onRefresh: () => void;
}) {
  return (
    <header className="compact-header">
      <BrandHeader compact />
      <div className="header-actions">
        <button type="button" aria-label="打开 KeyPilot 主页" onClick={onOpenVaultHome}>
          <Home size={21} aria-hidden="true" />
        </button>
        <button type="button" aria-label="搜索" onClick={onSearchToggle}>
          <Search size={21} aria-hidden="true" />
        </button>
        <button type="button" aria-label="锁定 Vault" onClick={onLock}>
          <Lock size={20} aria-hidden="true" />
        </button>
        <button type="button" aria-label="刷新当前网站" onClick={onRefresh}>
          <RefreshCw size={20} aria-hidden="true" />
        </button>
      </div>
      {searchOpen ? (
        <label className="compact-search">
          <Search size={16} aria-hidden="true" />
          <input value={query} onChange={(event) => onQuery(event.target.value)} autoFocus placeholder="搜索账号、网站或备注" />
        </label>
      ) : null}
    </header>
  );
}

function BottomNav({ active, onChange }: { active: ViewKey; onChange: (view: ViewKey) => void }) {
  const items: Array<{ key: ViewKey; label: string; icon: ReactNode }> = [
    { key: 'home', label: '首页', icon: <Home size={21} /> },
    { key: 'vault', label: '密码库', icon: <Lock size={21} /> },
    { key: 'generator', label: '生成器', icon: <KeyRound size={21} /> },
    { key: 'import', label: '导入', icon: <Import size={21} /> },
    { key: 'settings', label: '设置', icon: <Settings size={21} /> }
  ];

  return (
    <nav className="bottom-nav" aria-label="KeyPilot 导航">
      {items.map((item) => (
        <button key={item.key} type="button" className={active === item.key ? 'active' : ''} onClick={() => onChange(item.key)}>
          {item.icon}
          <span>{item.label}</span>
        </button>
      ))}
    </nav>
  );
}

function BrandHeader({ compact }: { compact: boolean }) {
  return (
    <div className={compact ? 'brand compact' : 'brand'}>
      <div className="keypilot-logo" aria-hidden="true">
        <img src="icons/icon128.png" alt="" />
      </div>
      <div>
        <h1>钥航 <span>KeyPilot</span></h1>
        {!compact ? <p>自动登录，但密码只在本地。</p> : null}
      </div>
    </div>
  );
}

function HomePage({
  view,
  query,
  onQuery,
  currentTab,
  diagnostics,
  currentMatches,
  credentials,
  fillProfiles,
  total,
  defaultSort,
  onRefreshCurrentTab,
  onOpenDetail,
  onAdd,
  onImport,
  onOpenVaultHome,
  onSettings,
  onTogglePageDebug,
  onAction,
  onFillProfile,
  onBindFillProfile,
  onRenameFillProfile,
  onDeleteFillProfile,
  onBind,
  onCopy,
  onTogglePin,
  onDelete,
  onEdit,
  autoSaveEnabled,
  onToggleAutoSave
}: {
  view: ViewKey;
  query: string;
  onQuery: (value: string) => void;
  currentTab: CurrentTabInfo | null;
  diagnostics: InlineDiagnosticsResult | null;
  currentMatches: Credential[];
  credentials: Credential[];
  fillProfiles: FillProfile[];
  total: number;
  defaultSort: 'favorite' | 'recent' | 'az';
  onRefreshCurrentTab: () => void;
  onOpenDetail: (credential: Credential) => void;
  onAdd: () => void;
  onImport: () => void;
  onOpenVaultHome: () => void;
  onSettings: () => void;
  onTogglePageDebug: () => void;
  onAction: (action: CredentialAction, credential: Credential, activeTabOnly?: boolean) => void;
  onFillProfile: (profile: FillProfile, onlyEmpty?: boolean) => void;
  onBindFillProfile: (profile: FillProfile) => void;
  onRenameFillProfile: (profile: FillProfile) => void;
  onDeleteFillProfile: (profile: FillProfile) => void;
  onBind: (credential: Credential) => void;
  onCopy: (label: string, value: string, clearLater?: boolean) => void;
  onTogglePin: (credential: Credential) => void;
  onDelete: (credential: Credential) => void;
  onEdit: (credential: Credential) => void;
  autoSaveEnabled: boolean;
  onToggleAutoSave: () => void;
}) {
  const [mode, setMode] = useState<'login' | 'username' | 'identity'>('login');
  const [sortMode, setSortMode] = useState<'favorite' | 'recent' | 'az'>(defaultSort);
  const [loginNameScope, setLoginNameScope] = useState<'matched' | 'domain' | 'all'>('matched');
  const [identityScope, setIdentityScope] = useState<'matched' | 'all'>('all');
  const [identityListExpanded, setIdentityListExpanded] = useState(false);
  const [selectedFillProfileId, setSelectedFillProfileId] = useState<string | null>(null);
  const [profilePickerOpen, setProfilePickerOpen] = useState(false);
  const [identityOnlyEmpty, setIdentityOnlyEmpty] = useState(false);

  useEffect(() => {
    setSortMode(defaultSort);
  }, [defaultSort]);

  const normalizedQuery = query.trim().toLowerCase();
  const matchesQuery = (credential: Credential) =>
    !normalizedQuery ||
    [credential.title, credential.domain, credential.matchUrl ?? '', credential.username, credential.notes ?? '', credential.folder ?? '', credential.tags?.join(' ') ?? ''].some(
      (value) => value.toLowerCase().includes(normalizedQuery)
    );
  const matchesFillProfile = (profile: FillProfile) =>
    !normalizedQuery ||
    [
      profile.title,
      profile.countryCode,
      profile.folder ?? '',
      profile.tags?.join(' ') ?? '',
      fillProfileCategoryLabel(profile),
      ...profile.fields.flatMap((field) => [field.label, field.value, field.sourceColumn ?? ''])
    ].some((value) => value.toLowerCase().includes(normalizedQuery));
  const filteredCredentials = credentials.filter(matchesQuery);
  const filteredFillProfiles = fillProfiles.filter(matchesFillProfile);
  const matchedLoginNames = currentMatches.filter(matchesQuery);
  const sameDomainLoginNames = currentTab?.domain
    ? credentials.filter((credential) => domainsMatch(credential.domain, currentTab.domain)).filter(matchesQuery)
    : matchedLoginNames;
  const allLoginNames = credentials.filter(matchesQuery);
  const loginNameCredentials =
    loginNameScope === 'matched'
      ? matchedLoginNames
      : loginNameScope === 'domain'
        ? sameDomainLoginNames
        : allLoginNames;
  const activeCredentials = mode === 'identity' ? [] : mode === 'username' ? loginNameCredentials : filteredCredentials;
  const sortCredentials = (items: Credential[]) =>
    [...items].sort((left, right) => {
      if (sortMode === 'az') return left.title.localeCompare(right.title, 'zh-CN');
      if (sortMode === 'recent') return (right.lastUsedAt ?? right.updatedAt) - (left.lastUsedAt ?? left.updatedAt);
      if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
      return (right.lastUsedAt ?? right.updatedAt) - (left.lastUsedAt ?? left.updatedAt);
    });
  const loginNameShownCredentials = sortCredentials(loginNameCredentials);
  const loginNameGroups = groupLoginNameCredentials(loginNameShownCredentials);
  const shownCredentials = view === 'home' ? sortCredentials(activeCredentials).slice(0, 24) : credentials;
  const sortFillProfiles = (items: FillProfile[], modeOverride = sortMode) =>
    [...items].sort((left, right) => {
      if (modeOverride === 'az') return left.title.localeCompare(right.title, 'zh-CN');
      if (modeOverride === 'favorite') {
        if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
      }
      return (right.lastUsedAt ?? right.updatedAt) - (left.lastUsedAt ?? left.updatedAt);
    });
  const matchedFillProfiles = currentTab?.domain
    ? sortFillProfiles(
        filteredFillProfiles.filter((profile) =>
          profile.siteBindings?.some((binding) => domainsMatch(binding.domain, currentTab.domain))
        )
      )
    : [];
  const allIdentityProfiles = sortFillProfiles(filteredFillProfiles, 'az');
  const identityListBaseProfiles = identityScope === 'matched' ? matchedFillProfiles : allIdentityProfiles;
  const identityListProfiles = normalizedQuery || identityListExpanded
    ? identityListBaseProfiles
    : identityListBaseProfiles.slice(0, 8);
  const identityPickerProfiles = [...fillProfiles]
    .sort((left, right) => {
      return (right.lastUsedAt ?? right.updatedAt) - (left.lastUsedAt ?? left.updatedAt);
    });
  const selectedFillProfile = fillProfiles.find((profile) => profile.id === selectedFillProfileId) ?? null;
  const homeClassName = [
    'kp-home',
    mode === 'username' ? 'login-name-mode' : '',
    mode === 'identity' && selectedFillProfile ? 'detail-mode' : '',
    mode === 'identity' && !selectedFillProfile ? 'identity-list-mode' : ''
  ].filter(Boolean).join(' ');
  useEffect(() => {
    if (mode !== 'identity') {
      setSelectedFillProfileId(null);
      setProfilePickerOpen(false);
      return;
    }

    if (selectedFillProfileId && !fillProfiles.some((profile) => profile.id === selectedFillProfileId)) {
      setSelectedFillProfileId(null);
    }
  }, [fillProfiles, mode, selectedFillProfileId]);
  useEffect(() => {
    setIdentityListExpanded(false);
  }, [identityScope, normalizedQuery]);
  const sectionTitle = mode === 'identity' ? '身份ID' : mode === 'username' ? '登录名' : query ? '搜索结果' : '账号';
  const sectionCount = mode === 'identity'
    ? `${filteredFillProfiles.length} 条资料`
    : query
      ? `${activeCredentials.length} 条匹配`
      : mode === 'username'
        ? `${activeCredentials.length} 条登录名`
        : `${total} 条保存`;
  const primaryMatch = currentMatches[0];

  if (view === 'home') {
    return (
      <div className={homeClassName}>
        <header className="kp-topbar">
          <div className="kp-brand">
            <img src="icons/icon128.png" alt="" />
            <div>
              <strong>KeyPilot</strong>
              <span>本地密码库</span>
            </div>
          </div>
          <button className="kp-icon-button" type="button" aria-label="打开 KeyPilot 主页" onClick={onOpenVaultHome}>
            <Home size={18} aria-hidden="true" />
          </button>
          <button className="kp-icon-button" type="button" aria-label="刷新当前网站" onClick={onRefreshCurrentTab}>
            <RefreshCw size={18} aria-hidden="true" />
          </button>
          <button className="kp-icon-button" type="button" aria-label="打开网页识别调试面板" title="打开网页识别调试面板" onClick={onTogglePageDebug}>
            <Bug size={18} aria-hidden="true" />
          </button>
          <button className="kp-icon-button" type="button" aria-label="打开设置" onClick={onSettings}>
            <SlidersHorizontal size={19} aria-hidden="true" />
          </button>
        </header>

        <label className="kp-search">
          <Search size={18} aria-hidden="true" />
          <input value={query} onChange={(event) => onQuery(event.target.value)} placeholder="搜索账号、网站或备注" />
        </label>

        <div className="kp-tool-row">
          <div className="kp-mode-chips" role="tablist" aria-label="填充模式">
            <HomeModeButton active={mode === 'login'} icon={<Lock size={15} />} label="登录" onClick={() => setMode('login')} />
            <HomeModeButton active={mode === 'username'} icon={<UserRound size={15} />} label="登录名" onClick={() => setMode('username')} />
            <IdentityProfilePicker
              active={mode === 'identity'}
              open={profilePickerOpen}
              selected={selectedFillProfile}
              profiles={identityPickerProfiles}
              total={fillProfiles.length}
              onOpenChange={setProfilePickerOpen}
              onMode={() => setMode('identity')}
              onSelect={(profile) => {
                setSelectedFillProfileId(profile.id);
                setMode('identity');
                setProfilePickerOpen(false);
              }}
              onFill={(profile) => onFillProfile(profile, identityOnlyEmpty)}
              onViewEdit={(profile) => {
                setSelectedFillProfileId(profile.id);
                setMode('identity');
                setProfilePickerOpen(false);
              }}
              onRename={onRenameFillProfile}
              onDelete={onDeleteFillProfile}
              onOpenHome={onOpenVaultHome}
            />
          </div>
        </div>

        {mode === 'login' ? (
          <section className="kp-site-panel">
            <SiteIcon domain={currentTab?.domain ?? ''} url={currentTab?.url} iconUrl={currentTab?.iconUrl} />
            <div>
              <span>当前网站</span>
              <strong>{currentTab?.domain || '未检测到网站'}</strong>
              <small>匹配 {currentMatches.length} 条账号</small>
            </div>
            <button type="button" disabled={!primaryMatch} onClick={() => primaryMatch && onAction('login', primaryMatch, true)}>
              登录
            </button>
          </section>
        ) : null}

        {mode === 'username' ? (
          <LoginNameSurface
            scope={loginNameScope}
            onScopeChange={setLoginNameScope}
            query={query}
            onQuery={onQuery}
            currentTab={currentTab}
            groups={loginNameGroups}
            resultCount={loginNameShownCredentials.length}
            onFill={(credential) => onAction('fill', credential, true)}
            onOpenDetail={onOpenDetail}
          />
        ) : (
        <section className="kp-list-shell" aria-label="账号列表">
          <div className="kp-list-head">
            <div>
              <strong>{sectionTitle}</strong>
              <span>{sectionCount}</span>
            </div>
            {mode === 'login' ? (
              <div className="kp-sort" role="tablist" aria-label="排序">
                <button className={sortMode === 'favorite' ? 'active' : ''} type="button" onClick={() => setSortMode('favorite')}>
                  常用
                </button>
                <button className={sortMode === 'recent' ? 'active' : ''} type="button" onClick={() => setSortMode('recent')}>
                  最近
                </button>
                <button className={sortMode === 'az' ? 'active' : ''} type="button" onClick={() => setSortMode('az')}>
                  A-Z
                </button>
              </div>
            ) : (
              <span className="kp-section-badge">资料</span>
            )}
          </div>

          {mode === 'identity' ? (
            selectedFillProfile ? (
              <IdentityFillSurface
                profile={selectedFillProfile}
                onlyEmpty={identityOnlyEmpty}
                onOnlyEmptyChange={setIdentityOnlyEmpty}
                onBack={() => setSelectedFillProfileId(null)}
                onFill={() => onFillProfile(selectedFillProfile, identityOnlyEmpty)}
                onBind={() => onBindFillProfile(selectedFillProfile)}
                onCopy={onCopy}
              />
            ) : (
              <IdentityProfileListSurface
                scope={identityScope}
                onScopeChange={setIdentityScope}
                query={query}
                onQuery={onQuery}
                profiles={identityListProfiles}
                total={identityListBaseProfiles.length}
                allTotal={filteredFillProfiles.length}
                hiddenCount={Math.max(0, identityListBaseProfiles.length - identityListProfiles.length)}
                expanded={identityListExpanded || Boolean(normalizedQuery)}
                currentDomain={currentTab?.domain}
                onShowAll={() => setIdentityListExpanded(true)}
                onSelect={(profile) => setSelectedFillProfileId(profile.id)}
                onFill={(profile) => onFillProfile(profile, identityOnlyEmpty)}
                onBind={onBindFillProfile}
                onRename={onRenameFillProfile}
                onDelete={onDeleteFillProfile}
                onOpenHome={onOpenVaultHome}
              />
            )
          ) : shownCredentials.length ? (
            <div className="kp-account-list">
              {shownCredentials.map((credential) => (
                <HomeAccountRow
                  key={credential.id}
                  credential={credential}
                  mode={mode}
                  onOpen={() => onOpenDetail(credential)}
                  onAction={() => onAction(mode === 'login' ? 'login' : 'fill', credential)}
                />
              ))}
            </div>
          ) : (
            <div className="kp-empty">
              <strong>还没有账号</strong>
              <span>新建账号后会在这里显示。</span>
            </div>
          )}
        </section>
        )}

        <footer className="kp-dock">
          <div className="kp-lock-state">
            <UnlockKeyhole size={19} aria-hidden="true" />
            <span>Vault 已解锁</span>
          </div>
          <button
            className={autoSaveEnabled ? 'kp-save-toggle active' : 'kp-save-toggle'}
            type="button"
            aria-pressed={autoSaveEnabled}
            onClick={onToggleAutoSave}
          >
            <span>自动保存</span>
            <i aria-hidden="true" />
          </button>
          <button className="kp-dock-action" type="button" onClick={onImport}>
            <Download size={18} aria-hidden="true" />
            <span>导入</span>
          </button>
          <button className="kp-dock-action primary" type="button" onClick={onAdd}>
            <Plus size={19} aria-hidden="true" />
            <span>新建</span>
          </button>
        </footer>
      </div>
    );
  }

  return (
    <div className="home-view">
      <section className="current-site-card">
        <div className="current-site-top">
          <SiteIcon domain={currentTab?.domain ?? ''} url={currentTab?.url} iconUrl={currentTab?.iconUrl} size="large" />
          <div>
            <span>当前网站</span>
            <h2>{currentTab?.domain || '未检测到网站'}</h2>
            <p>匹配到 {currentMatches.length} 条账号</p>
          </div>
          <strong>{currentMatches.length} 条记录</strong>
        </div>
        <div className="security-line">
          <ShieldCheck size={16} aria-hidden="true" />
          <span>本地加密 · 已解锁</span>
        </div>
        <InlineDiagnosticsPanel diagnostics={diagnostics} fallbackMatchedCount={currentMatches.length} primaryMatch={primaryMatch} />
        <div className="current-actions">
          <button className="button primary" type="button" disabled={!primaryMatch} onClick={() => primaryMatch && onAction('login', primaryMatch, true)}>
            <CircleCheck size={16} aria-hidden="true" />
            一键登录
          </button>
          <button className="button secondary" type="button" disabled={!primaryMatch} onClick={() => primaryMatch && onAction('fill', primaryMatch, true)}>
            <ExternalLink size={16} aria-hidden="true" />
            浏览并填写
          </button>
          <button className="button secondary" type="button" disabled={!primaryMatch || !currentTab?.id} onClick={() => primaryMatch && onBind(primaryMatch)}>
            <KeyRound size={16} aria-hidden="true" />
            绑定字段
          </button>
        </div>
        {!currentTab ? (
          <button className="inline-refresh" type="button" onClick={onRefreshCurrentTab}>
            刷新当前网站
          </button>
        ) : null}
      </section>

      <section className="saved-section">
        <div className="section-title">
          <div>
            <h2>{view === 'vault' ? '密码库' : '保存的账号'}</h2>
            <p>{query ? `${credentials.length} 条匹配` : `${total} 条账号`}</p>
          </div>
          <button className="button primary compact" type="button" onClick={onAdd}>
            <Plus size={16} aria-hidden="true" />
            新建
          </button>
        </div>

        {shownCredentials.length ? (
          <div className="account-list">
            {shownCredentials.map((credential) => (
              <CredentialRow
                key={credential.id}
                credential={credential}
                onOpen={() => onOpenDetail(credential)}
                onAction={onAction}
                onCopy={onCopy}
                onTogglePin={onTogglePin}
                onDelete={onDelete}
                onEdit={onEdit}
              />
            ))}
          </div>
        ) : (
          <EmptyState title="还没有账号" body="新增账号后，KeyPilot 会加密保存到本地 Vault。" actionLabel="新建账号" onAction={onAdd} />
        )}
      </section>
    </div>
  );
}

function HomeModeButton({
  active,
  icon,
  label,
  onClick
}: {
  active: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button className={active ? 'active' : ''} type="button" role="tab" aria-selected={active} onClick={onClick}>
      {icon}
      <span>{label}</span>
    </button>
  );
}

function IdentityProfilePicker({
  active,
  open,
  selected,
  profiles,
  total,
  onOpenChange,
  onMode,
  onSelect,
  onFill,
  onViewEdit,
  onRename,
  onDelete,
  onOpenHome
}: {
  active: boolean;
  open: boolean;
  selected: FillProfile | null;
  profiles: FillProfile[];
  total: number;
  onOpenChange: (open: boolean) => void;
  onMode: () => void;
  onSelect: (profile: FillProfile) => void;
  onFill: (profile: FillProfile) => void;
  onViewEdit: (profile: FillProfile) => void;
  onRename: (profile: FillProfile) => void;
  onDelete: (profile: FillProfile) => void;
  onOpenHome: () => void;
}) {
  const tone = selected ? fillProfileTone(selected) : 'identity';
  const [actionProfileId, setActionProfileId] = useState<string | null>(null);
  const [showAllProfiles, setShowAllProfiles] = useState(false);
  const recentProfiles = profiles.slice(0, 5);
  const recentIds = new Set(recentProfiles.map((profile) => profile.id));
  const otherProfiles = showAllProfiles
    ? profiles
        .filter((profile) => !recentIds.has(profile.id))
        .sort((left, right) => left.title.localeCompare(right.title, 'zh-CN'))
        .slice(0, 40)
    : [];

  useEffect(() => {
    if (!open) {
      setActionProfileId(null);
      setShowAllProfiles(false);
    }
  }, [open]);

  function closeMenu() {
    setActionProfileId(null);
    onOpenChange(false);
  }

  function selectProfile(profile: FillProfile) {
    setActionProfileId(null);
    onSelect(profile);
  }

  function runProfileAction(profile: FillProfile, action: () => void) {
    action();
    closeMenu();
  }

  function renderProfileRow(profile: FillProfile) {
    const profileTone = fillProfileTone(profile);
    const menuOpen = actionProfileId === profile.id;

    return (
      <div key={profile.id} className={selected?.id === profile.id ? 'kp-identity-menu-row selected' : 'kp-identity-menu-row'} role="option" aria-selected={selected?.id === profile.id}>
        <button className="kp-identity-option" type="button" onClick={() => selectProfile(profile)}>
          <span className={`kp-profile-dot ${profileTone}`}>{fillProfileBadgeText(profile)}</span>
          <span className="kp-identity-option-text">
            <strong>{profile.title}</strong>
            <small>{fillProfileSummary(profile)}</small>
          </span>
        </button>
        <button
          className={menuOpen ? 'kp-identity-row-more active' : 'kp-identity-row-more'}
          type="button"
          aria-label={`${profile.title} 更多操作`}
          aria-expanded={menuOpen}
          onClick={(event) => {
            event.stopPropagation();
            setActionProfileId((value) => (value === profile.id ? null : profile.id));
          }}
        >
          <MoreVertical size={16} aria-hidden="true" />
        </button>
        {menuOpen ? (
          <div className="kp-identity-action-menu" role="menu" aria-label={`${profile.title} 操作`}>
            <button type="button" className="kp-identity-action-item primary" role="menuitem" onClick={() => runProfileAction(profile, () => onFill(profile))}>
              <FileInput size={16} aria-hidden="true" />
              <span>填表</span>
            </button>
            <button type="button" className="kp-identity-action-item" role="menuitem" onClick={() => runProfileAction(profile, () => onViewEdit(profile))}>
              <Edit3 size={16} aria-hidden="true" />
              <span>查看/编辑</span>
            </button>
            <button type="button" className="kp-identity-action-item" role="menuitem" onClick={() => runProfileAction(profile, () => onRename(profile))}>
              <SlidersHorizontal size={16} aria-hidden="true" />
              <span>重命名</span>
            </button>
            <button type="button" className="kp-identity-action-item danger" role="menuitem" onClick={() => runProfileAction(profile, () => onDelete(profile))}>
              <Trash2 size={16} aria-hidden="true" />
              <span>删除</span>
            </button>
            <span className="kp-identity-action-divider" aria-hidden="true" />
            <button type="button" className="kp-identity-action-item" role="menuitem" onClick={() => runProfileAction(profile, onOpenHome)}>
              <Home size={16} aria-hidden="true" />
              <span>打开主页</span>
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className={active ? 'kp-identity-picker active' : 'kp-identity-picker'}>
      <button
        className="kp-identity-picker-main"
        type="button"
        role="tab"
        aria-selected={active}
        onClick={() => {
          onMode();
          onOpenChange(false);
        }}
      >
        <span className={`kp-profile-dot ${tone}`}>{selected ? fillProfileBadgeText(selected) : <IdCard size={14} aria-hidden="true" />}</span>
        <span className="kp-identity-picker-label">{selected ? selected.title : '填写身份ID'}</span>
      </button>
      <button
        className="kp-identity-picker-arrow"
        type="button"
        aria-label="选择身份资料"
        aria-haspopup="listbox"
        aria-expanded={active && open}
        onClick={(event) => {
          event.stopPropagation();
          onMode();
          onOpenChange(!open);
        }}
      >
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {active && open ? (
        <div className="kp-identity-menu" role="listbox" aria-label="选择身份资料">
          {profiles.length ? (
            <>
              <div className="kp-identity-menu-section">
                <span className="kp-identity-menu-title">最近使用的身份信息：</span>
                {recentProfiles.map(renderProfileRow)}
              </div>
              {otherProfiles.length ? (
                <>
                  <span className="kp-identity-menu-divider" aria-hidden="true" />
                  <div className="kp-identity-menu-section">
                    <span className="kp-identity-menu-title">其他身份信息（A-Z 排序）：</span>
                    {otherProfiles.map(renderProfileRow)}
                  </div>
                </>
              ) : null}
            </>
          ) : (
            <div className="kp-identity-menu-empty">还没有身份资料</div>
          )}
          {profiles.length && !showAllProfiles && total > recentProfiles.length ? (
            <button className="kp-identity-menu-foot" type="button" onClick={() => setShowAllProfiles(true)}>
              显示所有个人信息（{total}）
            </button>
          ) : null}
          {showAllProfiles && total > recentProfiles.length + otherProfiles.length ? (
            <button className="kp-identity-menu-foot" type="button" onClick={onOpenHome}>
              打开主页查看更多
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

const ROOT_FOLDER_LABEL = '主目录';

function groupLoginNameCredentials(items: Credential[]): Array<{ folder: string; items: Credential[] }> {
  const groups = new Map<string, Credential[]>();

  items.forEach((credential) => {
    const folder = credential.folder?.trim() || ROOT_FOLDER_LABEL;
    const existing = groups.get(folder) ?? [];
    existing.push(credential);
    groups.set(folder, existing);
  });

  return Array.from(groups.entries())
    .map(([folder, groupItems]) => ({ folder, items: groupItems }))
    .sort((left, right) => {
      if (left.folder === ROOT_FOLDER_LABEL && right.folder !== ROOT_FOLDER_LABEL) return -1;
      if (right.folder === ROOT_FOLDER_LABEL && left.folder !== ROOT_FOLDER_LABEL) return 1;
      return left.folder.localeCompare(right.folder, 'zh-CN');
    });
}

function loginNameScopeCopy(scope: 'matched' | 'domain' | 'all', currentTab: CurrentTabInfo | null) {
  if (scope === 'matched') return currentTab?.domain ? `搜索 ${currentTab.domain} 匹配项` : '搜索匹配登录名';
  if (scope === 'domain') return currentTab?.domain ? `搜索 ${currentTab.domain} 同域账号` : '搜索同域账号';
  return '搜索所有登录名';
}

function LoginNameSurface({
  scope,
  onScopeChange,
  query,
  onQuery,
  currentTab,
  groups,
  resultCount,
  onFill,
  onOpenDetail
}: {
  scope: 'matched' | 'domain' | 'all';
  onScopeChange: (scope: 'matched' | 'domain' | 'all') => void;
  query: string;
  onQuery: (value: string) => void;
  currentTab: CurrentTabInfo | null;
  groups: Array<{ folder: string; items: Credential[] }>;
  resultCount: number;
  onFill: (credential: Credential) => void;
  onOpenDetail: (credential: Credential) => void;
}) {
  return (
    <section className="kp-loginname-shell" aria-label="填写登录名">
      <div className="kp-loginname-tabs" role="tablist" aria-label="登录名范围">
        <button className={scope === 'matched' ? 'active' : ''} type="button" role="tab" aria-selected={scope === 'matched'} onClick={() => onScopeChange('matched')}>
          匹配登录名
        </button>
        <button className={scope === 'domain' ? 'active' : ''} type="button" role="tab" aria-selected={scope === 'domain'} onClick={() => onScopeChange('domain')}>
          相同域
        </button>
        <button className={scope === 'all' ? 'active' : ''} type="button" role="tab" aria-selected={scope === 'all'} onClick={() => onScopeChange('all')}>
          所有
        </button>
      </div>

      <label className="kp-loginname-search">
        <Search size={16} aria-hidden="true" />
        <input value={query} onChange={(event) => onQuery(event.target.value)} placeholder={loginNameScopeCopy(scope, currentTab)} />
      </label>

      {groups.length ? (
        <div className="kp-loginname-list">
          <div className="kp-loginname-summary">
            <span>{resultCount} 条登录名</span>
            {currentTab?.domain ? <small>当前网站：{currentTab.domain}</small> : null}
          </div>
          {groups.map((group) => (
            <div className="kp-loginname-group" key={group.folder}>
              <div className="kp-loginname-folder">
                <Folder size={18} aria-hidden="true" />
                <span>{group.folder}</span>
                <small>{group.items.length}</small>
              </div>
              {group.items.map((credential) => (
                <LoginNameRow key={credential.id} credential={credential} onFill={() => onFill(credential)} onOpenDetail={() => onOpenDetail(credential)} />
              ))}
            </div>
          ))}
        </div>
      ) : (
        <div className="kp-loginname-empty">
          <UserRound size={26} aria-hidden="true" />
          <strong>没有可填写的登录名</strong>
          <span>{scope === 'matched' ? '切换到“相同域”或“所有”查看其他账号。' : '换个关键词试试，或先新建一个登录账号。'}</span>
        </div>
      )}
    </section>
  );
}

function LoginNameRow({
  credential,
  onFill,
  onOpenDetail
}: {
  credential: Credential;
  onFill: () => void;
  onOpenDetail: () => void;
}) {
  const status = !credential.username ? 'warn' : credential.formProfile?.submit ? 'good' : credential.formFields?.length ? 'muted' : 'warn';
  const statusTitle = status === 'good' ? '已记录登录规则' : status === 'muted' ? '已记录部分字段' : '建议绑定字段';

  return (
    <article className="kp-loginname-row">
      <button className="kp-loginname-main" type="button" aria-label={`填写 ${credential.title}`} onClick={onFill}>
        <SiteIcon domain={credential.domain} url={credential.url} iconUrl={credential.iconUrl} />
        <span>
          <strong>{credential.title}</strong>
          <small>{credential.username || '无用户名'}</small>
        </span>
      </button>
      <span className={`kp-loginname-status ${status}`} title={statusTitle}>
        {status === 'warn' ? <AlertTriangle size={16} aria-hidden="true" /> : <ShieldCheck size={16} aria-hidden="true" />}
      </span>
      <button className="kp-loginname-detail" type="button" aria-label={`查看 ${credential.title}`} onClick={onOpenDetail}>
        <MoreVertical size={17} aria-hidden="true" />
      </button>
    </article>
  );
}

function IdentityProfileListSurface({
  scope,
  onScopeChange,
  query,
  onQuery,
  profiles,
  total,
  allTotal,
  hiddenCount,
  expanded,
  currentDomain,
  onShowAll,
  onSelect,
  onFill,
  onBind,
  onRename,
  onDelete,
  onOpenHome
}: {
  scope: 'matched' | 'all';
  onScopeChange: (scope: 'matched' | 'all') => void;
  query: string;
  onQuery: (value: string) => void;
  profiles: FillProfile[];
  total: number;
  allTotal: number;
  hiddenCount: number;
  expanded: boolean;
  currentDomain?: string;
  onShowAll: () => void;
  onSelect: (profile: FillProfile) => void;
  onFill: (profile: FillProfile) => void;
  onBind: (profile: FillProfile) => void;
  onRename: (profile: FillProfile) => void;
  onDelete: (profile: FillProfile) => void;
  onOpenHome: () => void;
}) {
  const [actionProfileId, setActionProfileId] = useState<string | null>(null);
  const scopeHint = scope === 'matched'
    ? currentDomain
      ? `当前网站匹配：${currentDomain}`
      : '当前页没有可匹配的域名'
    : `${allTotal} 条身份信息`;

  function runProfileAction(action: () => void) {
    action();
    setActionProfileId(null);
  }

  function renderProfileRow(profile: FillProfile) {
    const profileTone = fillProfileTone(profile);
    const menuOpen = actionProfileId === profile.id;

    return (
      <article className="kp-identity-list-row" key={profile.id}>
        <button className="kp-identity-list-main" type="button" onClick={() => onSelect(profile)}>
          <span className={`kp-profile-dot ${profileTone}`}>{fillProfileBadgeText(profile)}</span>
          <span>
            <strong>{profile.title}</strong>
            <small>{fillProfileCategoryLabel(profile)} · {fillProfileSummary(profile)}</small>
          </span>
        </button>
        <button
          className={menuOpen ? 'kp-identity-list-more active' : 'kp-identity-list-more'}
          type="button"
          aria-label={`${profile.title} 更多操作`}
          aria-expanded={menuOpen}
          onClick={() => setActionProfileId((value) => (value === profile.id ? null : profile.id))}
        >
          <MoreVertical size={17} aria-hidden="true" />
        </button>
        {menuOpen ? (
          <div className="kp-identity-list-action-menu" role="menu" aria-label={`${profile.title} 操作`}>
            <button type="button" className="primary" role="menuitem" onClick={() => runProfileAction(() => onFill(profile))}>
              <FileInput size={15} aria-hidden="true" />
              <span>填表</span>
            </button>
            <button type="button" role="menuitem" onClick={() => runProfileAction(() => onSelect(profile))}>
              <Eye size={15} aria-hidden="true" />
              <span>查看</span>
            </button>
            <button type="button" role="menuitem" onClick={() => runProfileAction(() => onBind(profile))}>
              <SlidersHorizontal size={15} aria-hidden="true" />
              <span>校准字段</span>
            </button>
            <button type="button" role="menuitem" onClick={() => runProfileAction(() => onRename(profile))}>
              <Edit3 size={15} aria-hidden="true" />
              <span>重命名</span>
            </button>
            <button type="button" className="danger" role="menuitem" onClick={() => runProfileAction(() => onDelete(profile))}>
              <Trash2 size={15} aria-hidden="true" />
              <span>删除</span>
            </button>
          </div>
        ) : null}
      </article>
    );
  }

  return (
    <section className="kp-identity-list-surface" aria-label="填写身份ID">
      <div className="kp-identity-scope-tabs" role="tablist" aria-label="身份资料范围">
        <button className={scope === 'matched' ? 'active' : ''} type="button" role="tab" aria-selected={scope === 'matched'} onClick={() => onScopeChange('matched')}>
          匹配
        </button>
        <button className={scope === 'all' ? 'active' : ''} type="button" role="tab" aria-selected={scope === 'all'} onClick={() => onScopeChange('all')}>
          所有
        </button>
      </div>

      <label className="kp-identity-list-search">
        <Search size={16} aria-hidden="true" />
        <input value={query} onChange={(event) => onQuery(event.target.value)} placeholder={scope === 'matched' ? '搜索匹配身份信息' : '搜索所有身份信息'} />
      </label>

      <div className="kp-identity-list-meta">
        <span>{scopeHint}</span>
        <small>{total ? `${Math.min(profiles.length, total)} / ${total}` : '0'}</small>
      </div>

      {profiles.length ? (
        <div className="kp-identity-list-body">
          {profiles.map(renderProfileRow)}
          {hiddenCount > 0 && !expanded ? (
            <button className="kp-identity-list-show-all" type="button" onClick={onShowAll}>
              显示所有个人信息（{total}）
            </button>
          ) : null}
        </div>
      ) : (
        <div className="kp-identity-list-empty">
          <IdCard size={28} aria-hidden="true" />
          <strong>{scope === 'matched' ? '没有匹配身份资料' : '还没有身份资料'}</strong>
          <span>{scope === 'matched' ? '切换到“所有”查看资料库里的其他身份信息。' : '先导入 Excel/CSV，再回到这里填写注册表单。'}</span>
          <button type="button" onClick={scope === 'matched' ? () => onScopeChange('all') : onOpenHome}>
            {scope === 'matched' ? '查看所有身份信息' : '打开主页导入'}
          </button>
        </div>
      )}
    </section>
  );
}

function fillProfileGroupIcon(group: FillField['group']) {
  if (group === 'personal' || group === 'contact') return <UserRound size={17} aria-hidden="true" />;
  if (group === 'address') return <Home size={17} aria-hidden="true" />;
  if (group === 'business' || group === 'loan' || group === 'finance' || group === 'employment') return <Library size={17} aria-hidden="true" />;
  if (group === 'vehicle' || group === 'insurance' || group === 'driver') return <ShieldCheck size={17} aria-hidden="true" />;
  if (group === 'payment' || group === 'sensitive') return <KeyRound size={17} aria-hidden="true" />;
  return <IdCard size={17} aria-hidden="true" />;
}

function IdentityFillSurface({
  profile,
  onlyEmpty,
  onOnlyEmptyChange,
  onBack,
  onFill,
  onBind,
  onCopy
}: {
  profile: FillProfile;
  onlyEmpty: boolean;
  onOnlyEmptyChange: (value: boolean) => void;
  onBack: () => void;
  onFill: () => void;
  onBind: () => void;
  onCopy: (label: string, value: string, clearLater?: boolean) => void;
}) {
  const groups = fillProfileFieldsByGroup(profile);
  const [fieldQuery, setFieldQuery] = useState('');
  const query = fieldQuery.trim().toLowerCase();
  const visibleGroups = groups
    .map(([group, fields]) => [
      group,
      query
        ? fields.filter((field) =>
            [field.label, field.value, field.sourceColumn ?? '', field.key].some((value) => value.toLowerCase().includes(query))
          )
        : fields
    ] as [FillField['group'], FillField[]])
    .filter(([, fields]) => fields.length > 0);
  const totalFieldCount = groups.reduce((sum, [, fields]) => sum + fields.length, 0);
  const selectedSummary = fillProfileSummary(profile);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);

  return (
    <section className="kp-identity-fill" aria-label="填写身份资料">
      <div className="kp-identity-fill-head">
        <button className="kp-identity-fill-back" type="button" aria-label="返回身份资料列表" title="返回列表" onClick={onBack}>
          <ArrowLeft size={16} aria-hidden="true" />
        </button>
        <div>
          <strong>通过本身份信息进行填写，拖放或复制/粘贴</strong>
          <span>{profile.title} · {selectedSummary}</span>
        </div>
        <button type="button" aria-label="更多身份资料操作" title="更多操作" onClick={() => setProfileMenuOpen((value) => !value)}>
          <MoreVertical size={17} aria-hidden="true" />
        </button>
        {profileMenuOpen ? (
          <div className="kp-identity-fill-menu" role="menu" aria-label="身份资料操作">
            <button type="button" role="menuitem" onClick={() => {
              setProfileMenuOpen(false);
              onCopy(`${profile.title} 全部资料`, formatFillProfileForClipboard(profile));
            }}>
              <Copy size={15} aria-hidden="true" />
              <span>复制全部</span>
            </button>
            <button type="button" role="menuitem" onClick={() => {
              setProfileMenuOpen(false);
              onBind();
            }}>
              <SlidersHorizontal size={15} aria-hidden="true" />
              <span>校准字段</span>
            </button>
          </div>
        ) : null}
      </div>

      <div className="kp-identity-fill-actions">
        <button className="primary" type="button" onClick={onFill}>
          <FileInput size={16} aria-hidden="true" />
          填写表单
        </button>
        <button type="button" title="把资料字段和当前网页输入框对应起来" onClick={onBind}>
          <Edit3 size={16} aria-hidden="true" />
          编辑
        </button>
      </div>

      <label className="kp-identity-empty-toggle">
        <input type="checkbox" checked={onlyEmpty} onChange={(event) => onOnlyEmptyChange(event.target.checked)} />
        <span>只填写空白字段</span>
        <small>{totalFieldCount} 个字段</small>
      </label>

      <label className="kp-identity-field-search">
        <Search size={15} aria-hidden="true" />
        <input value={fieldQuery} onChange={(event) => setFieldQuery(event.target.value)} placeholder="搜索此资料里的字段" />
      </label>

      <div className="kp-identity-field-list">
        {visibleGroups.length ? (
          visibleGroups.map(([group, fields]) => (
            <section className="kp-identity-field-group" key={group}>
              <header>
                <span>{fillProfileGroupIcon(group)}</span>
                <strong>{fillFieldGroupLabel(group)}</strong>
                <button
                  type="button"
                  aria-label={`复制${fillFieldGroupLabel(group)}`}
                  title={`复制${fillFieldGroupLabel(group)}`}
                  onClick={() => onCopy(fillFieldGroupLabel(group), fields.map((field) => `${field.label}: ${field.value}`).join('\n'))}
                >
                  <Copy size={13} aria-hidden="true" />
                </button>
              </header>
              {fields.map((field) => (
                <div className="kp-identity-field" key={`${field.key}-${field.label}`}>
                  <span>{field.label}</span>
                  <strong title={field.value}>{field.value}</strong>
                  {field.sensitivity !== 'normal' ? <em>{field.sensitivity === 'secret' ? '敏感' : '私密'}</em> : null}
                  <button type="button" aria-label={`复制 ${field.label}`} title={`复制 ${field.label}`} onClick={() => onCopy(field.label, field.value)}>
                    <Copy size={13} aria-hidden="true" />
                  </button>
                </div>
              ))}
            </section>
          ))
        ) : (
          <div className="kp-identity-field-empty">
            <Search size={22} aria-hidden="true" />
            <strong>没有匹配字段</strong>
            <span>换个关键词继续找。</span>
          </div>
        )}
      </div>
    </section>
  );
}

function FillProfileRow({
  profile,
  onFill,
  onBind,
  onView
}: {
  profile: FillProfile;
  onFill: () => void;
  onBind: () => void;
  onView: () => void;
}) {
  const summary = fillProfileSummary(profile);
  const category = fillProfileCategoryLabel(profile);
  const fieldCount = profile.fields.length;
  const tone =
    profile.category === 'auto_insurance'
      ? 'auto'
      : profile.category === 'payment'
        ? 'payment'
        : profile.category === 'business' || profile.category === 'loan'
          ? 'business'
          : 'identity';
  const icon =
    profile.category === 'auto_insurance' ? (
      <ShieldCheck size={17} aria-hidden="true" />
    ) : profile.category === 'business' || profile.category === 'loan' ? (
      <Library size={17} aria-hidden="true" />
    ) : (
      <IdCard size={17} aria-hidden="true" />
    );

  return (
    <article className="kp-fillprofile-row">
      <button className="kp-fillprofile-main" type="button" aria-label={`填写 ${profile.title}`} onClick={onFill}>
        <span className={`kp-fillprofile-icon ${tone}`}>{icon}</span>
        <span className="kp-fillprofile-copy">
          <strong>{profile.title}</strong>
          <small>{summary}</small>
        </span>
      </button>
      <span className="kp-fillprofile-meta" title={`${category} · ${fieldCount} 字段`}>
        <small>{profile.countryCode}</small>
        <strong>{fieldCount}</strong>
      </span>
      <button className="kp-fillprofile-bind" type="button" aria-label={`绑定 ${profile.title} 的网页字段`} title="绑定网页字段" onClick={onBind}>
        <SlidersHorizontal size={16} aria-hidden="true" />
      </button>
      <button className="kp-account-open" type="button" aria-label={`查看 ${profile.title}`} title="查看资料" onClick={onView}>
        <Eye size={17} aria-hidden="true" />
      </button>
    </article>
  );
}

function FillProfileDetail({
  profile,
  onBack,
  onFill,
  onBind,
  onCopy
}: {
  profile: FillProfile;
  onBack: () => void;
  onFill: () => void;
  onBind: () => void;
  onCopy: (label: string, value: string, clearLater?: boolean) => void;
}) {
  const groups = fillProfileFieldsByGroup(profile);
  const category = fillProfileCategoryLabel(profile);
  const summary = fillProfileSummary(profile);
  const [fieldQuery, setFieldQuery] = useState('');
  const [activeGroup, setActiveGroup] = useState<FillField['group'] | 'all'>('all');
  const totalFieldCount = groups.reduce((sum, [, fields]) => sum + fields.length, 0);
  const normalizedFieldQuery = fieldQuery.trim().toLowerCase();
  const visibleGroups = groups
    .filter(([group]) => activeGroup === 'all' || group === activeGroup)
    .map(([group, fields]) => [
      group,
      normalizedFieldQuery
        ? fields.filter((field) =>
            [field.label, field.value, field.sourceColumn ?? '', field.key].some((value) =>
              value.toLowerCase().includes(normalizedFieldQuery)
            )
          )
        : fields
    ] as [FillField['group'], FillField[]])
    .filter(([, fields]) => fields.length > 0);
  const visibleFieldCount = visibleGroups.reduce((sum, [, fields]) => sum + fields.length, 0);
  const tone =
    profile.category === 'auto_insurance'
      ? 'auto'
      : profile.category === 'payment'
        ? 'payment'
        : profile.category === 'business' || profile.category === 'loan'
          ? 'business'
          : 'identity';
  const icon =
    profile.category === 'auto_insurance' ? (
      <ShieldCheck size={17} aria-hidden="true" />
    ) : profile.category === 'business' || profile.category === 'loan' ? (
      <Library size={17} aria-hidden="true" />
    ) : (
      <IdCard size={17} aria-hidden="true" />
    );

  return (
    <div className="kp-fillprofile-detail">
      <span className="kp-fillprofile-detail-motion" aria-hidden="true" />
      <header className="kp-fillprofile-detail-head">
        <button className="kp-fillprofile-back" type="button" aria-label="返回身份资料列表" onClick={onBack}>
          <ArrowLeft size={17} aria-hidden="true" />
        </button>
        <span className={`kp-fillprofile-icon ${tone} detail`}>{icon}</span>
        <div className="kp-fillprofile-detail-title">
          <span>{category}</span>
          <strong>{profile.title}</strong>
          <small>{summary}</small>
        </div>
        <span className="kp-fillprofile-detail-count">
          <strong>{totalFieldCount}</strong>
          <small>字段</small>
        </span>
      </header>

      <div className="kp-fillprofile-detail-actions">
        <button className="primary" type="button" onClick={onFill}>
          <FileInput size={15} aria-hidden="true" />
          填写表单
        </button>
        <button type="button" onClick={() => onCopy(`${profile.title} 全部资料`, formatFillProfileForClipboard(profile))}>
          <Copy size={15} aria-hidden="true" />
          复制全部
        </button>
        <button type="button" onClick={onBind}>
          <SlidersHorizontal size={15} aria-hidden="true" />
          绑定字段
        </button>
      </div>

      <div className="kp-fillprofile-detail-summary">
        <span>
          <strong>{profile.countryCode}</strong>
          <small>国家/地区</small>
        </span>
        <span>
          <strong>{visibleFieldCount}</strong>
          <small>当前可见</small>
        </span>
        <span>
          <strong>{groups.length}</strong>
          <small>资料分组</small>
        </span>
      </div>

      <label className="kp-fillprofile-filter">
        <Search size={15} aria-hidden="true" />
        <input
          value={fieldQuery}
          onChange={(event) => setFieldQuery(event.target.value)}
          placeholder="搜索字段或内容"
          autoComplete="off"
        />
      </label>

      <div className="kp-fillprofile-group-tabs" aria-label="资料分组">
        <button className={activeGroup === 'all' ? 'active' : ''} type="button" onClick={() => setActiveGroup('all')}>
          全部
          <span>{totalFieldCount}</span>
        </button>
        {groups.map(([group, fields]) => (
          <button
            key={group}
            className={activeGroup === group ? 'active' : ''}
            type="button"
            onClick={() => setActiveGroup(group)}
          >
            {fillFieldGroupLabel(group)}
            <span>{fields.length}</span>
          </button>
        ))}
      </div>

      <div className="kp-fillprofile-fields">
        {visibleGroups.length ? (
          visibleGroups.map(([group, fields]) => (
            <section key={group} className="kp-fillprofile-field-group">
              <h4>{fillFieldGroupLabel(group)}</h4>
              {fields.map((field) => (
                <div className="kp-fillprofile-field" key={`${field.key}-${field.label}`}>
                  <span className="kp-fillprofile-field-main">
                    <span>{field.label}</span>
                    <strong title={field.value}>{field.value}</strong>
                  </span>
                  {field.sensitivity !== 'normal' ? <em>{field.sensitivity === 'secret' ? '敏感' : '私密'}</em> : null}
                  <button type="button" aria-label={`复制 ${field.label}`} title={`复制 ${field.label}`} onClick={() => onCopy(field.label, field.value)}>
                    <Copy size={14} aria-hidden="true" />
                  </button>
                </div>
              ))}
            </section>
          ))
        ) : (
          <div className="kp-fillprofile-no-fields">
            <Search size={22} aria-hidden="true" />
            <strong>没有匹配字段</strong>
            <span>换个关键词，或切回“全部”。</span>
          </div>
        )}
      </div>
    </div>
  );
}

function HomeAccountRow({
  credential,
  mode,
  onOpen,
  onAction
}: {
  credential: Credential;
  mode: 'login' | 'username' | 'identity';
  onOpen: () => void;
  onAction: () => void;
}) {
  const status = credential.formProfile?.submit ? 'good' : credential.formFields?.length ? 'muted' : 'warn';
  const actionLabel = mode === 'login' ? `登录 ${credential.title}` : `填写 ${credential.title}`;

  return (
    <article className="kp-account-row">
      <button className="kp-account-main" type="button" aria-label={actionLabel} onClick={onAction}>
        <SiteIcon domain={credential.domain} url={credential.url} iconUrl={credential.iconUrl} />
        <span className="kp-account-copy">
          <strong>{credential.title}</strong>
          {credential.username ? <small>{credential.username}</small> : null}
        </span>
      </button>
      <span className={`kp-account-health ${status}`} title={status === 'good' ? '已记录登录规则' : status === 'muted' ? '已记录部分字段' : '建议绑定字段'}>
        {status === 'warn' ? <AlertTriangle size={16} aria-hidden="true" /> : <ShieldCheck size={17} aria-hidden="true" />}
      </span>
      <button className="kp-account-open" type="button" aria-label={`查看 ${credential.title}`} onClick={onOpen}>
        <ChevronRight size={20} aria-hidden="true" />
      </button>
    </article>
  );
}

function InlineDiagnosticsPanel({
  diagnostics,
  fallbackMatchedCount,
  primaryMatch
}: {
  diagnostics: InlineDiagnosticsResult | null;
  fallbackMatchedCount: number;
  primaryMatch?: Credential;
}) {
  const frames = diagnostics?.frames ?? [];
  const loginFrames = frames.filter((frame) => frame.hasLoginForm);
  const displayedFrames = (loginFrames.length ? loginFrames : frames).slice(0, 3);
  const hasLoginForm = diagnostics?.hasLoginForm ?? false;
  const matchedCount = diagnostics?.matchedCount ?? fallbackMatchedCount;
  const submitOutcome = diagnostics?.submitOutcome;
  const bindingStatus = primaryMatch?.formProfile?.submit
    ? '已绑定字段和登录按钮'
    : primaryMatch
      ? '未绑定登录按钮'
      : '无可绑定账号';
  const diagnosis = !diagnostics
    ? '还没有诊断结果，刷新当前网站后再试。'
    : diagnostics.locked
      ? 'Vault 已锁定，先解锁后再诊断自动登录。'
      : !hasLoginForm
        ? '没有检测到登录框。如果页面已经显示登录框，请使用手动绑定。'
        : matchedCount === 0
          ? '检测到登录框，但当前域名没有匹配账号。'
          : primaryMatch?.formProfile?.submit
            ? '已记录绑定规则，自动登录会优先使用保存的字段和按钮。'
            : '建议绑定字段和登录按钮，特殊网站会更稳定。';

  return (
    <details className="diagnostic-panel">
      <summary>
        <span>网页诊断</span>
        <strong>{hasLoginForm ? '检测到登录框' : '未检测到登录框'} · 匹配 {matchedCount} 条</strong>
      </summary>
      <div className="diagnostic-grid">
        <span>Vault</span>
        <strong>{diagnostics?.locked ? '已锁定' : '已解锁'}</strong>
        <span>登录框</span>
        <strong>{hasLoginForm ? '已检测' : '未检测'}</strong>
        <span>匹配账号</span>
        <strong>{matchedCount} 条</strong>
        <span>Frame</span>
        <strong>{frames.length || 1} 个</strong>
        <span>绑定状态</span>
        <strong>{bindingStatus}</strong>
      </div>
      {displayedFrames.length ? (
        <ul className="diagnostic-frames">
          {displayedFrames.map((frame) => (
            <li key={`${frame.frameId ?? 0}-${frame.url}`}>
              <span>{frame.hasLoginForm ? '登录框' : '页面'}</span>
              <strong>{frame.domain || frame.url || '未知域名'}</strong>
              <small>匹配 {frame.matchedCount} 条{frame.unsafeReason ? ` · 敏感字段 ${frame.unsafeReason}` : ''}</small>
            </li>
          ))}
        </ul>
      ) : (
        <p>刷新当前网页后会显示更详细的 frame 诊断。</p>
      )}
      <p>{submitOutcome ? `上次提交：${submitOutcome.message}` : diagnosis}</p>
    </details>
  );
}

function DefaultSiteIcon() {
  return (
    <img className="default-site-image" src="icons/default-site-128.png" alt="" />
  );
}

function SiteIcon({
  domain,
  url,
  iconUrl,
  size = 'normal'
}: {
  domain: string;
  url?: string;
  iconUrl?: string;
  size?: 'normal' | 'large';
}) {
  const className = size === 'large' ? 'site-icon large' : 'site-icon';
  const candidates = useMemo(() => getIconCandidates(iconUrl, url || domain), [domain, iconUrl, url]);
  const [candidateIndex, setCandidateIndex] = useState(0);
  const resolvedIconUrl = candidates[candidateIndex];

  useEffect(() => {
    setCandidateIndex(0);
  }, [domain, iconUrl, url]);

  return (
    <div className={className}>
      <DefaultSiteIcon />
      {domain && resolvedIconUrl ? (
        <img
          className="site-favicon"
          src={resolvedIconUrl}
          alt=""
          referrerPolicy="no-referrer"
          onLoad={(event) => {
            const image = event.currentTarget;
            if (image.naturalWidth <= 1 && image.naturalHeight <= 1) {
              setCandidateIndex((index) => index + 1);
            }
          }}
          onError={() => setCandidateIndex((index) => index + 1)}
        />
      ) : null}
    </div>
  );
}

function CredentialRow({
  credential,
  onOpen,
  onAction,
  onCopy,
  onTogglePin,
  onDelete,
  onEdit
}: {
  credential: Credential;
  onOpen: () => void;
  onAction: (action: CredentialAction, credential: Credential) => void;
  onCopy: (label: string, value: string, clearLater?: boolean) => void;
  onTogglePin: (credential: Credential) => void;
  onDelete: (credential: Credential) => void;
  onEdit: (credential: Credential) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <article className="account-row">
      <button className="favorite-button" type="button" aria-label={credential.pinned ? '取消收藏' : '收藏'} onClick={() => onTogglePin(credential)}>
        <Star size={18} fill={credential.pinned ? 'currentColor' : 'none'} aria-hidden="true" />
      </button>
      <button className="account-main" type="button" onClick={onOpen}>
        <SiteIcon domain={credential.domain} url={credential.url} iconUrl={credential.iconUrl} />
        <div>
          <strong>{credential.title}</strong>
          <span>{credential.username}</span>
        </div>
        <div className="account-meta">
          <span>{credential.domain}</span>
          <small>{formatTime(credential.lastUsedAt)}</small>
        </div>
      </button>
      <div className="menu-wrap">
        <button className="more-button" type="button" aria-label="打开账号菜单" onClick={() => setOpen((value) => !value)}>
          <MoreVertical size={19} aria-hidden="true" />
        </button>
        {open ? (
          <div className="action-menu">
            <MenuItem icon={<CircleCheck size={15} />} label="登录" onClick={() => onAction('login', credential)} />
            <MenuItem icon={<ExternalLink size={15} />} label="浏览并填写" onClick={() => onAction('fill', credential)} />
            <MenuItem icon={<ExternalLink size={15} />} label="转到" onClick={() => onAction('goto', credential)} />
            <MenuItem icon={<Copy size={15} />} label="复制用户名" onClick={() => onCopy('已复制用户名。', credential.username)} />
            <MenuItem icon={<KeyRound size={15} />} label="复制密码" onClick={() => onCopy('已复制密码，稍后会清空剪贴板。', credential.password, true)} />
            <MenuItem icon={<Edit3 size={15} />} label="编辑" onClick={() => onEdit(credential)} />
            <MenuItem danger icon={<Trash2 size={15} />} label="删除" onClick={() => onDelete(credential)} />
          </div>
        ) : null}
      </div>
    </article>
  );
}

function MenuItem({
  icon,
  label,
  danger,
  onClick
}: {
  icon: ReactNode;
  label: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button className={danger ? 'menu-item danger' : 'menu-item'} type="button" onClick={onClick}>
      {icon}
      <span>{label}</span>
    </button>
  );
}

function CredentialDetailPage({
  credential,
  settings,
  onBack,
  onAction,
  onCopy,
  onEdit,
  onDelete,
  onTogglePin
}: {
  credential: Credential;
  settings: UnlockedVaultSession['vault']['settings'];
  onBack: () => void;
  onAction: (action: CredentialAction, credential: Credential) => void;
  onCopy: (label: string, value: string, clearLater?: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
  onTogglePin: () => void;
}) {
  const [revealed, setRevealed] = useState(false);
  const strength = measurePasswordStrength(credential.password);
  const formStructureLabel = credential.formProfile?.submit
    ? `已记录 ${credential.formProfile.fieldCount ?? credential.formFields?.length ?? 0} 个字段和登录按钮`
    : credential.formFields?.length
      ? `已记录 ${credential.formFields.length} 个字段`
      : '未记录';

  function handleReveal() {
    if (!revealed && !window.confirm('显示明文密码前，请确认周围环境安全。')) return;
    setRevealed((value) => !value);
  }

  return (
    <div className="page-view">
      <PageHeader title="账号详情" onBack={onBack}>
        <button type="button" aria-label="收藏" onClick={onTogglePin}>
          <Star size={18} fill={credential.pinned ? 'currentColor' : 'none'} aria-hidden="true" />
        </button>
        <button type="button" aria-label="编辑" onClick={onEdit}>
          <Edit3 size={18} aria-hidden="true" />
        </button>
      </PageHeader>
      <section className="detail-hero">
        <SiteIcon domain={credential.domain} url={credential.url} iconUrl={credential.iconUrl} size="large" />
        <div>
          <h2>{credential.title}</h2>
          <a href={credential.url} target="_blank" rel="noreferrer">{credential.domain}</a>
        </div>
      </section>
      <section className="detail-card">
        <DetailRow label="用户名" value={credential.username} onAction={() => onCopy('已复制用户名。', credential.username)} />
        <div className="detail-field">
          <span>密码</span>
          <div>
            <code>{revealed ? credential.password : '••••••••••••••'}</code>
            <button type="button" aria-label={revealed ? '隐藏密码' : '显示密码'} onClick={handleReveal}>
              {revealed ? <EyeOff size={17} /> : <Eye size={17} />}
            </button>
            <button type="button" aria-label="复制密码" onClick={() => onCopy('已复制密码，稍后会清空剪贴板。', credential.password, true)}>
              <Copy size={17} />
            </button>
          </div>
          <StrengthMeter value={strength.score} label={strength.label} />
        </div>
        <DetailRow label="网站" value={credential.url} onAction={() => onAction('goto', credential)} actionIcon="external" />
        <DetailRow label="匹配 URL" value={credential.matchUrl || '自动使用网站域名'} />
        <div className="note-block">
          <span>备注</span>
          <p>{credential.notes || '无备注'}</p>
        </div>
        <div className="tag-row">
          {(credential.tags?.length ? credential.tags : ['开发', '工具']).map((tag) => (
            <span key={tag}>{tag}</span>
          ))}
          {credential.folder ? <span>{credential.folder}</span> : null}
        </div>
      </section>
      <dl className="meta-list">
        <div><dt>创建时间</dt><dd>{formatDateTime(credential.createdAt)}</dd></div>
        <div><dt>更新时间</dt><dd>{formatDateTime(credential.updatedAt)}</dd></div>
        <div><dt>最近使用</dt><dd>{formatDateTime(credential.lastUsedAt)}</dd></div>
        <div><dt>自动提交</dt><dd>{settings.autoSubmit ? '已开启' : '关闭'}</dd></div>
        <div><dt>表单结构</dt><dd>{formStructureLabel}</dd></div>
      </dl>
      <div className="detail-actions">
        <button className="button primary" type="button" onClick={() => onAction('login', credential)}>登录</button>
        <button className="button secondary" type="button" onClick={() => onAction('fill', credential)}>浏览并填写</button>
        <button className="button secondary" type="button" onClick={() => onAction('goto', credential)}>转到</button>
      </div>
      <button className="danger-text" type="button" onClick={onDelete}>
        <Trash2 size={15} aria-hidden="true" />
        删除账号
      </button>
    </div>
  );
}

function DetailRow({ label, value, actionIcon, onAction }: { label: string; value: string; actionIcon?: 'external'; onAction?: () => void }) {
  return (
    <div className="detail-field">
      <span>{label}</span>
      <div>
        <p>{value}</p>
        {onAction ? (
          <button type="button" onClick={onAction} aria-label={actionIcon === 'external' ? '打开网站' : '复制'}>
            {actionIcon === 'external' ? <ExternalLink size={17} /> : <Copy size={17} />}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function CredentialEditPage({
  draft,
  onBack,
  onSave,
  onDelete
}: {
  draft: EditDraft;
  onBack: () => void;
  onSave: (draft: EditDraft) => void;
  onDelete?: () => void;
}) {
  const [localDraft, setLocalDraft] = useState(draft);
  const [passwordVisible, setPasswordVisible] = useState(false);
  const strength = measurePasswordStrength(localDraft.password);

  function update<K extends keyof EditDraft>(key: K, value: EditDraft[K]) {
    setLocalDraft((current) => ({ ...current, [key]: value }));
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSave(localDraft);
  }

  return (
    <form className="page-view edit-view" onSubmit={handleSubmit}>
      <PageHeader title={localDraft.id ? '编辑账号' : '新增账号'} onBack={onBack}>
        {onDelete ? (
          <button className="danger-icon" type="button" aria-label="删除账号" onClick={onDelete}>
            <Trash2 size={18} aria-hidden="true" />
          </button>
        ) : null}
      </PageHeader>
      <Field label="名称">
        <input value={localDraft.title} onChange={(event) => update('title', event.target.value)} placeholder="GitHub" required />
      </Field>
      <Field label="用户名">
        <input value={localDraft.username} onChange={(event) => update('username', event.target.value)} placeholder="leon@example.com" required />
      </Field>
      <Field label="密码">
        <div className="input-with-action">
          <input
            value={localDraft.password}
            onChange={(event) => update('password', event.target.value)}
            type={passwordVisible ? 'text' : 'password'}
            autoComplete="new-password"
            placeholder="输入密码"
            required
          />
          <button
            type="button"
            aria-label={passwordVisible ? '隐藏密码' : '显示密码'}
            title={passwordVisible ? '隐藏密码' : '显示密码'}
            onClick={() => setPasswordVisible((value) => !value)}
          >
            {passwordVisible ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
          </button>
          <button type="button" aria-label="生成密码" onClick={() => update('password', generatePassword(defaultGeneratorOptions))}>
            <RefreshCw size={16} aria-hidden="true" />
          </button>
        </div>
      </Field>
      <StrengthMeter value={strength.score} label={strength.label} />
      <Field label="网站">
        <input value={localDraft.url} onChange={(event) => update('url', event.target.value)} placeholder="https://github.com" required />
      </Field>
      <Field label="匹配 URL" hint="可留空沿用网站域名；支持 *.example.com/* 或带路径的登录页前缀。">
        <input value={localDraft.matchUrl} onChange={(event) => update('matchUrl', event.target.value)} placeholder="*.example.com/*" />
      </Field>
      <Field label="备注">
        <textarea value={localDraft.notes} onChange={(event) => update('notes', event.target.value)} rows={4} placeholder="个人 GitHub 账号" />
      </Field>
      <Field label="标签">
        <input value={localDraft.tags} onChange={(event) => update('tags', event.target.value)} placeholder="开发, 工具" />
      </Field>
      <Field label="文件夹">
        <input value={localDraft.folder} onChange={(event) => update('folder', event.target.value)} placeholder="工作" />
      </Field>
      <div className="form-actions">
        <button className="button secondary" type="button" onClick={onBack}>取消</button>
        <button className="button primary" type="submit">保存</button>
      </div>
    </form>
  );
}

function GeneratorPage({ onUsePassword, onCopy }: { onUsePassword: (password: string) => void; onCopy: (label: string, value: string) => void }) {
  const [options, setOptions] = useState<PasswordGeneratorOptions>(defaultGeneratorOptions);
  const [password, setPassword] = useState(() => generatePassword(defaultGeneratorOptions));
  const strength = measurePasswordStrength(password);

  function refresh(nextOptions = options) {
    setPassword(generatePassword(nextOptions));
  }

  function updateOptions(nextOptions: PasswordGeneratorOptions) {
    setOptions(nextOptions);
    refresh(nextOptions);
  }

  return (
    <section className="page-view">
      <div className="section-title simple">
        <div><h2>密码生成器</h2><p>生成强密码后可复制或用于新增账号</p></div>
      </div>
      <div className="generated-password">
        <code>{password}</code>
        <button type="button" aria-label="复制密码" onClick={() => onCopy('已复制生成的密码。', password)}><Copy size={17} /></button>
        <button type="button" aria-label="刷新密码" onClick={() => refresh()}><RefreshCw size={17} /></button>
      </div>
      <StrengthMeter value={strength.score} label={strength.label} />
      <Field label="密码长度">
        <div className="range-row">
          <input type="range" min={4} max={132} value={options.length} onChange={(event) => updateOptions({ ...options, length: Number(event.target.value) })} />
          <strong>{options.length}</strong>
        </div>
      </Field>
      <div className="check-list">
        <CheckOption label="包含大写字母 A-Z" checked={options.uppercase} onChange={(checked) => updateOptions({ ...options, uppercase: checked })} />
        <CheckOption label="包含小写字母 a-z" checked={options.lowercase} onChange={(checked) => updateOptions({ ...options, lowercase: checked })} />
        <CheckOption label="包含数字 0-9" checked={options.numbers} onChange={(checked) => updateOptions({ ...options, numbers: checked })} />
        <CheckOption label="包含符号" checked={options.symbols} onChange={(checked) => updateOptions({ ...options, symbols: checked })} />
        <CheckOption label="排除相似字符" checked={options.excludeSimilar} onChange={(checked) => updateOptions({ ...options, excludeSimilar: checked })} />
        <CheckOption label="每类至少包含 1 个字符" checked={options.requireEveryType !== false} onChange={(checked) => updateOptions({ ...options, requireEveryType: checked })} />
      </div>
      <Field label="必须包含字符" hint="生成结果会强制包含这些字符，排除字符优先生效。">
        <input value={options.requiredCharacters ?? ''} onChange={(event) => updateOptions({ ...options, requiredCharacters: event.target.value })} placeholder="@#A9" />
      </Field>
      <Field label="排除字符" hint="适合网站不允许某些符号时使用。">
        <input value={options.excludeCharacters ?? ''} onChange={(event) => updateOptions({ ...options, excludeCharacters: event.target.value })} placeholder="{}[]&quot;" />
      </Field>
      <div className="form-actions">
        <button className="button secondary" type="button" onClick={() => refresh()}>刷新密码</button>
        <button className="button primary" type="button" onClick={() => onUsePassword(password)}>使用此密码</button>
      </div>
    </section>
  );
}

function ImportPage({
  credentials,
  onImport,
  onNotice
}: {
  credentials: Credential[];
  onImport: (credentials: Credential[], updates: Credential[]) => Promise<void>;
  onNotice: (notice: Notice) => void;
}) {
  const [source, setSource] = useState<ImportSource>('roboform');
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [fileName, setFileName] = useState('');
  const [conflictActions, setConflictActions] = useState<Record<number, ConflictImportAction>>({});
  const [busy, setBusy] = useState(false);

  const importPlan = useMemo(() => {
    const additions: Credential[] = [];
    const updates: Credential[] = [];

    if (!preview) {
      return { additions, updates };
    }

    for (const row of preview.rows) {
      if (!row.credential) continue;

      if (row.status === 'ready') {
        additions.push(row.credential);
        continue;
      }

      if (row.status !== 'conflict') continue;

      const action = conflictActions[row.rowNumber] ?? 'skip';

      if (action === 'keep') {
        additions.push(row.credential);
        continue;
      }

      if (action === 'update' && row.existingCredentialId) {
        const existing = credentials.find((credential) => credential.id === row.existingCredentialId);
        if (existing) {
          updates.push(mergeImportedCredential(existing, row.credential));
        }
      }
    }

    return { additions, updates };
  }, [conflictActions, credentials, preview]);

  async function handleFile(file: File | undefined) {
    if (!file) return;
    try {
      const text = await file.text();
      const nextPreview = parseCredentialCsv(text, source, credentials);
      setFileName(file.name);
      setPreview(nextPreview);
      setConflictActions(
        Object.fromEntries(
          nextPreview.rows
            .filter((row) => row.status === 'conflict')
            .map((row) => [row.rowNumber, 'skip' as ConflictImportAction])
        )
      );
    } catch (error) {
      onNotice({ kind: 'error', text: getErrorMessage(error) });
    }
  }

  async function handleImport() {
    if (!preview) return;
    if (!importPlan.additions.length && !importPlan.updates.length) {
      onNotice({ kind: 'info', text: '没有选中可导入或可更新的记录。' });
      return;
    }

    setBusy(true);
    try {
      await onImport(importPlan.additions, importPlan.updates);
      setPreview(null);
      setFileName('');
      setConflictActions({});
    } finally {
      setBusy(false);
    }
  }

  function handleSourceChange(nextSource: ImportSource) {
    setSource(nextSource);
    setPreview(null);
    setFileName('');
    setConflictActions({});
  }

  const readyRows = preview?.rows.filter((row) => row.status === 'ready').length ?? 0;
  const selectedCount = importPlan.additions.length + importPlan.updates.length;

  return (
    <section className="page-view">
      <div className="section-title simple">
        <div><h2>导入账号</h2><p>CSV 只会在本机解析</p></div>
      </div>
      <div className="source-list">
        {(['roboform', 'chrome', 'edge', 'generic'] as ImportSource[]).map((item) => (
          <label key={item} className={source === item ? 'source-item active' : 'source-item'}>
            <input type="radio" name="source" checked={source === item} onChange={() => handleSourceChange(item)} />
            <span>{item === 'roboform' ? 'RoboForm CSV (.csv)' : item === 'chrome' ? 'Chrome CSV (.csv)' : item === 'edge' ? 'Edge CSV (.csv)' : '通用 CSV (.csv)'}</span>
          </label>
        ))}
      </div>
      <label className="file-drop">
        <Upload size={21} aria-hidden="true" />
        <strong>{fileName || '选择 CSV 文件'}</strong>
        <span>所有数据仅在本地处理</span>
        <input type="file" accept=".csv,text/csv" onChange={(event) => void handleFile(event.target.files?.[0])} />
      </label>
      {preview ? (
        <>
          <div className="import-preview">
            <PreviewMetric label="总记录" value={preview.total} />
            <PreviewMetric label="可直接导入" value={readyRows} />
            <PreviewMetric label="将新增" value={importPlan.additions.length} />
            <PreviewMetric label="将更新" value={importPlan.updates.length} />
            <PreviewMetric label="重复" value={preview.duplicates} />
            <PreviewMetric label="冲突" value={preview.conflicts} />
            <PreviewMetric label="缺少网址" value={preview.missingUrl} />
            <PreviewMetric label="无效" value={preview.invalid} />
          </div>
          <ImportRowList
            rows={preview.rows}
            conflictActions={conflictActions}
            onConflictAction={(rowNumber, action) => setConflictActions((current) => ({ ...current, [rowNumber]: action }))}
          />
        </>
      ) : null}
      <div className="security-note"><ShieldCheck size={16} /><p>导入完成后，请立即删除原始 CSV 文件。</p></div>
      <div className="form-actions">
        <button className="button secondary" type="button" onClick={() => { setPreview(null); setFileName(''); setConflictActions({}); }}>取消</button>
        <button className="button primary" type="button" disabled={!preview || selectedCount === 0 || busy} onClick={handleImport}>
          {busy ? '正在导入...' : selectedCount ? `确认处理 ${selectedCount} 条` : '确认导入'}
        </button>
      </div>
    </section>
  );
}

function mergeImportedCredential(existing: Credential, imported: Credential): Credential {
  return {
    ...existing,
    title: imported.title || existing.title,
    url: imported.url || existing.url,
    domain: imported.domain || existing.domain,
    matchUrl: imported.matchUrl ?? existing.matchUrl,
    matchDomain: imported.matchDomain ?? existing.matchDomain,
    username: imported.username || existing.username,
    password: imported.password,
    notes: imported.notes ?? existing.notes,
    tags: imported.tags?.length ? imported.tags : existing.tags,
    folder: imported.folder ?? existing.folder,
    iconUrl: imported.iconUrl ?? existing.iconUrl,
    iconType: imported.iconType ?? existing.iconType,
    formFields: imported.formFields?.length ? imported.formFields : existing.formFields,
    formProfile: imported.formProfile ?? existing.formProfile,
    source: imported.source ?? existing.source,
    updatedAt: Date.now()
  };
}

function ImportRowList({
  rows,
  conflictActions,
  onConflictAction
}: {
  rows: ImportPreviewRow[];
  conflictActions: Record<number, ConflictImportAction>;
  onConflictAction: (rowNumber: number, action: ConflictImportAction) => void;
}) {
  return (
    <div className="import-row-list">
      {rows.map((row) => (
        <article key={row.rowNumber} className={`import-row ${row.status}`}>
          <div className="import-row-main">
            <span className={`import-status ${row.status}`}>{getImportStatusLabel(row.status)}</span>
            <div>
              <strong>第 {row.rowNumber} 行 · {row.title || row.domain || row.url || row.username || '未命名记录'}</strong>
              <small>{[row.username || '无用户名', row.domain || row.url || '无网址'].join(' · ')}</small>
            </div>
          </div>
          {row.issues.length ? (
            <ul className="import-issues">
              {row.issues.map((issue) => (
                <li key={`${row.rowNumber}-${issue.code}`} className={issue.severity}>{issue.message}</li>
              ))}
            </ul>
          ) : null}
          {row.status === 'conflict' ? (
            <div className="conflict-actions" aria-label={`第 ${row.rowNumber} 行冲突处理`}>
              <button type="button" className={(conflictActions[row.rowNumber] ?? 'skip') === 'skip' ? 'active' : ''} onClick={() => onConflictAction(row.rowNumber, 'skip')}>跳过</button>
              <button type="button" className={conflictActions[row.rowNumber] === 'update' ? 'active' : ''} onClick={() => onConflictAction(row.rowNumber, 'update')}>更新现有</button>
              <button type="button" className={conflictActions[row.rowNumber] === 'keep' ? 'active' : ''} onClick={() => onConflictAction(row.rowNumber, 'keep')}>保留新记录</button>
            </div>
          ) : null}
        </article>
      ))}
    </div>
  );
}

function getImportStatusLabel(status: ImportPreviewRow['status']): string {
  if (status === 'ready') return '可导入';
  if (status === 'conflict') return '冲突';
  if (status === 'duplicate') return '重复';
  return '无效';
}

function SettingsPage({
  session,
  onReset,
  onNotice,
  onSessionChange,
  onPersist,
  onShowRecoveryCode
}: {
  session: UnlockedVaultSession;
  onReset: () => void;
  onNotice: (notice: Notice) => void;
  onSessionChange: (session: UnlockedVaultSession, message: string) => void;
  onPersist: (vault: UnlockedVaultSession['vault'], message: string) => Promise<UnlockedVaultSession>;
  onShowRecoveryCode: (code: string) => void;
}) {
  const [backupPassword, setBackupPassword] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [nextPassword, setNextPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [securityBusy, setSecurityBusy] = useState(false);

  async function updateSetting(nextSettings: Partial<UnlockedVaultSession['vault']['settings']>) {
    await onPersist(upsertVaultSettings(session.vault, nextSettings), '设置已保存。');
  }

  async function handleChangeMasterPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (nextPassword.length < 8) {
      onNotice({ kind: 'error', text: '新主密码至少需要 8 位。' });
      return;
    }

    if (nextPassword !== confirmPassword) {
      onNotice({ kind: 'error', text: '两次输入的新主密码不一致。' });
      return;
    }

    setSecurityBusy(true);
    try {
      const nextRecoveryCode = session.encryptedVault.recovery ? generateRecoveryCode() : undefined;
      const nextSession = await changeVaultMasterPassword(session, currentPassword, nextPassword, nextRecoveryCode);
      setCurrentPassword('');
      setNextPassword('');
      setConfirmPassword('');
      onSessionChange(nextSession, nextRecoveryCode ? '主密码已修改，并已生成新的恢复码。' : '主密码已修改。');
      if (nextRecoveryCode) {
        onShowRecoveryCode(nextRecoveryCode);
      }
    } catch (error) {
      onNotice({ kind: 'error', text: getErrorMessage(error) });
    } finally {
      setSecurityBusy(false);
    }
  }

  async function handleGenerateRecoveryCode() {
    setSecurityBusy(true);
    try {
      const recoveryCode = generateRecoveryCode();
      const nextSession = await enableVaultRecovery(session, recoveryCode);
      onSessionChange(nextSession, '恢复码已生成，请立即保存。');
      onShowRecoveryCode(recoveryCode);
    } catch (error) {
      onNotice({ kind: 'error', text: getErrorMessage(error) });
    } finally {
      setSecurityBusy(false);
    }
  }

  async function handleDisableRecovery() {
    setSecurityBusy(true);
    try {
      const nextSession = await disableVaultRecovery(session);
      onSessionChange(nextSession, '已关闭恢复码。');
    } catch (error) {
      onNotice({ kind: 'error', text: getErrorMessage(error) });
    } finally {
      setSecurityBusy(false);
    }
  }

  function exportBackup() {
    const blob = new Blob([JSON.stringify(session.encryptedVault, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    const timestamp = new Intl.DateTimeFormat('sv-SE', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    }).format(new Date()).replace(/[-: ]/g, '').slice(0, 12);
    anchor.href = url;
    anchor.download = `keypilot-vault-backup-${timestamp}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    onNotice({ kind: 'success', text: '已导出加密备份 JSON。' });
  }

  function exportRoboFormFormatCsv() {
    const blob = new Blob([`\uFEFF${exportRoboFormCsv(session.vault.credentials)}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    const timestamp = new Intl.DateTimeFormat('sv-SE', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    }).format(new Date()).replace(/[-: ]/g, '').slice(0, 12);
    anchor.href = url;
    anchor.download = `keypilot-roboform-export-${timestamp}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
    onNotice({ kind: 'info', text: '已导出 RoboForm 格式 CSV。此文件包含明文密码，请用完立即删除。' });
  }

  async function importBackup(file: File | undefined) {
    if (!file || !backupPassword) {
      onNotice({ kind: 'error', text: '请选择备份文件并输入对应主密码。' });
      return;
    }

    try {
      const encryptedVault = JSON.parse(await file.text());
      const nextSession = await unlockVaultSession(backupPassword, encryptedVault);
      await saveEncryptedVault(encryptedVault);
      await onSessionChange(nextSession, '已导入并解锁加密备份。');
      setBackupPassword('');
    } catch (error) {
      onNotice({ kind: 'error', text: getErrorMessage(error) });
    }
  }

  return (
    <section className="page-view settings-view">
      <div className="section-title simple"><div><h2>设置</h2><p>锁定、填充、备份和黑名单</p></div></div>
      <section className="settings-card security-settings-card">
        <div className="settings-card-head">
          <ShieldCheck size={18} />
          <div>
            <strong>主密码与恢复</strong>
            <span>主密码不会被保存。恢复码只显示一次，请离线保存。</span>
          </div>
        </div>
        <form className="password-change-form" onSubmit={handleChangeMasterPassword}>
          <Field label="当前主密码">
            <input type="password" value={currentPassword} autoComplete="current-password" onChange={(event) => setCurrentPassword(event.target.value)} placeholder="用于确认是本人操作" />
          </Field>
          <Field label="新主密码">
            <input type="password" value={nextPassword} autoComplete="new-password" onChange={(event) => setNextPassword(event.target.value)} placeholder="至少 8 位" />
          </Field>
          <Field label="确认新主密码">
            <input type="password" value={confirmPassword} autoComplete="new-password" onChange={(event) => setConfirmPassword(event.target.value)} placeholder="再次输入新主密码" />
          </Field>
          <button className="button primary full" type="submit" disabled={securityBusy || !currentPassword || !nextPassword || !confirmPassword}>
            {securityBusy ? '处理中...' : '修改主密码'}
          </button>
        </form>
        <div className="recovery-actions">
          <div>
            <strong>{session.encryptedVault.recovery ? '恢复码已启用' : '尚未启用恢复码'}</strong>
            <span>{session.encryptedVault.recovery ? '如果忘记主密码，可用恢复码设置新的主密码。' : '建议现在生成一份恢复码，防止忘记主密码。'}</span>
          </div>
          <button className="button secondary" type="button" onClick={handleGenerateRecoveryCode} disabled={securityBusy}>
            <KeyRound size={16} />
            {session.encryptedVault.recovery ? '重新生成' : '生成恢复码'}
          </button>
          {session.encryptedVault.recovery ? (
            <button className="text-danger" type="button" onClick={handleDisableRecovery} disabled={securityBusy}>关闭恢复码</button>
          ) : null}
        </div>
      </section>
      <SettingRow label="自动锁定时间" description="超过该时间后清空内存中的明文 Vault。">
        <select value={session.vault.settings.autoLockMinutes} onChange={(event) => void updateSetting({ autoLockMinutes: Number(event.target.value) })}>
          <option value={0}>不自动锁定</option>
          <option value={5}>5 分钟</option>
          <option value={10}>10 分钟</option>
          <option value={30}>30 分钟</option>
        </select>
      </SettingRow>
      <ToggleRow label="启动时自动锁定" checked={session.vault.settings.lockOnStartup} onChange={(checked) => void updateSetting({ lockOnStartup: checked, lockOnStartupUserSet: true })} />
      <ToggleRow
        label="高安全模式"
        checked={session.vault.settings.highSecurityMode}
        onChange={(checked) =>
          void updateSetting(
            checked
              ? {
                  highSecurityMode: true,
                  lockOnStartup: true,
                  lockOnStartupUserSet: true
                }
              : { highSecurityMode: false }
          )
        }
      />
      <ToggleRow label="自动填充用户名和密码" checked={session.vault.settings.autoFill} onChange={(checked) => void updateSetting({ autoFill: checked })} />
      <ToggleRow label="允许一键登录自动点击登录按钮" checked={session.vault.settings.autoSubmit} onChange={(checked) => void updateSetting({ autoSubmit: checked })} />
      <ToggleRow label="自动提示保存登录信息" checked={session.vault.settings.autoPromptSave} onChange={(checked) => void updateSetting({ autoPromptSave: checked })} />
      <SettingRow label="复制密码后清空剪贴板" description="降低误粘贴和泄露风险。">
        <select value={session.vault.settings.clearClipboardSeconds} onChange={(event) => void updateSetting({ clearClipboardSeconds: Number(event.target.value) })}>
          <option value={15}>15 秒</option>
          <option value={30}>30 秒</option>
          <option value={60}>60 秒</option>
        </select>
      </SettingRow>
      <Field label="网站黑名单" hint="每行一个域名。">
        <textarea value={session.vault.settings.blacklist.join('\n')} onChange={(event) => void updateSetting({ blacklist: event.target.value.split('\n').map((line) => line.trim()).filter(Boolean) })} rows={4} />
      </Field>
      <Field label="网页内图标隐藏域名" hint="每行一个域名。用于恢复或管理“不在此域中显示”。">
        <textarea value={(session.vault.settings.inlineBlacklist ?? []).join('\n')} onChange={(event) => void updateSetting({ inlineBlacklist: event.target.value.split('\n').map((line) => line.trim()).filter(Boolean) })} rows={3} />
      </Field>
      <div className="backup-actions">
        <button className="button secondary" type="button" onClick={exportBackup}><Download size={16} />导出加密备份</button>
        <button className="button secondary" type="button" onClick={exportRoboFormFormatCsv}><Download size={16} />导出 RoboForm CSV</button>
        <label className="backup-import"><Upload size={16} />导入加密备份<input type="file" accept="application/json,.json" onChange={(event) => void importBackup(event.target.files?.[0])} /></label>
      </div>
      <Field label="备份主密码" hint="导入加密备份前，输入该备份对应的主密码。">
        <input type="password" value={backupPassword} onChange={(event) => setBackupPassword(event.target.value)} placeholder="备份对应主密码" />
      </Field>
      <button className="danger-text" type="button" onClick={onReset}><Trash2 size={15} />重置 Vault</button>
    </section>
  );
}

function AuthShell({ children }: { children: ReactNode }) {
  return <main className="auth-shell"><section className="auth-card"><BrandHeader compact={false} />{children}</section></main>;
}

function SetupPage({ onCreated, onError }: { onCreated: (session: UnlockedVaultSession, recoveryCode?: string) => void; onError: (text: string) => void }) {
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const strength = measurePasswordStrength(password);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (password.length < 8) {
      onError('主密码至少需要 8 位。');
      return;
    }
    if (password !== confirmPassword) {
      onError('两次输入的主密码不一致。');
      return;
    }
    setSubmitting(true);
    try {
      const recoveryCode = generateRecoveryCode();
      const session = await createVaultSession(password, recoveryCode);
      setPassword('');
      setConfirmPassword('');
      onCreated(session, recoveryCode);
    } catch (error) {
      onError(getErrorMessage(error));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="auth-form" onSubmit={handleSubmit}>
      <div className="security-panel"><ShieldCheck size={20} /><div><h2>创建本地密码库</h2><p>主密码不会被保存，也无法找回。</p></div></div>
      <Field label="主密码"><input autoFocus value={password} type="password" autoComplete="new-password" onChange={(event) => setPassword(event.target.value)} placeholder="输入主密码" /></Field>
      <Field label="确认主密码"><input value={confirmPassword} type="password" autoComplete="new-password" onChange={(event) => setConfirmPassword(event.target.value)} placeholder="再次输入主密码" /></Field>
      <StrengthMeter value={strength.score} label={strength.label} />
      <button className="button primary full" type="submit" disabled={submitting}>{submitting ? '正在创建...' : '创建 Vault'}</button>
    </form>
  );
}

function UnlockPage({ onUnlocked, onReset, onError }: { onUnlocked: (session: UnlockedVaultSession, recoveryCode?: string) => void; onReset: () => void; onError: (text: string) => void }) {
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<'password' | 'recovery'>('password');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [nextPassword, setNextPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    try {
      if (mode === 'password') {
        const session = await unlockVaultSession(password);
        setPassword('');
        onUnlocked(session);
        return;
      }

      if (nextPassword.length < 8) {
        onError('新主密码至少需要 8 位。');
        return;
      }

      if (nextPassword !== confirmPassword) {
        onError('两次输入的新主密码不一致。');
        return;
      }

      const recoveredSession = await unlockVaultWithRecoveryCode(recoveryCode);
      const nextRecoveryCode = generateRecoveryCode();
      const session = await resetVaultMasterPassword(recoveredSession, nextPassword, nextRecoveryCode);
      setRecoveryCode('');
      setNextPassword('');
      setConfirmPassword('');
      onUnlocked(session, nextRecoveryCode);
    } catch (error) {
      onError(getErrorMessage(error));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="auth-form" onSubmit={handleSubmit}>
      <div className="security-panel"><Lock size={20} /><div><h2>解锁 Vault</h2><p>{mode === 'password' ? '输入主密码后，当前浏览器会话内保持解锁。' : '用恢复码验证身份，并立即设置新的主密码。'}</p></div></div>
      <div className="auth-tabs" role="tablist" aria-label="解锁方式">
        <button type="button" className={mode === 'password' ? 'active' : ''} onClick={() => setMode('password')}>主密码</button>
        <button type="button" className={mode === 'recovery' ? 'active' : ''} onClick={() => setMode('recovery')}>恢复码</button>
      </div>
      {mode === 'password' ? (
        <>
          <Field label="主密码"><input autoFocus value={password} type="password" autoComplete="current-password" onChange={(event) => setPassword(event.target.value)} placeholder="输入主密码" /></Field>
          <button className="button primary full" type="submit" disabled={submitting || !password}>{submitting ? '正在解锁...' : '解锁 Vault'}</button>
          <button className="text-danger" type="button" onClick={() => setMode('recovery')}>忘记主密码，使用恢复码</button>
        </>
      ) : (
        <>
          <Field label="恢复码" hint="格式类似 KP-XXXX-XXXX，大小写和横线不敏感。"><input autoFocus value={recoveryCode} type="text" autoComplete="one-time-code" onChange={(event) => setRecoveryCode(event.target.value)} placeholder="KP-XXXX-XXXX-XXXX-XXXX-XXXX" /></Field>
          <Field label="新的主密码"><input value={nextPassword} type="password" autoComplete="new-password" onChange={(event) => setNextPassword(event.target.value)} placeholder="至少 8 位" /></Field>
          <Field label="确认新的主密码"><input value={confirmPassword} type="password" autoComplete="new-password" onChange={(event) => setConfirmPassword(event.target.value)} placeholder="再次输入新主密码" /></Field>
          <button className="button primary full" type="submit" disabled={submitting || !recoveryCode || !nextPassword || !confirmPassword}>{submitting ? '正在恢复...' : '设置新主密码并解锁'}</button>
          <button className="text-button" type="button" onClick={() => setMode('password')}>返回主密码解锁</button>
        </>
      )}
      <button className="text-danger" type="button" onClick={onReset}>没有恢复码，重置 Vault</button>
    </form>
  );
}

function PageHeader({ title, onBack, children }: { title: string; onBack: () => void; children?: ReactNode }) {
  return (
    <header className="page-header">
      <button type="button" aria-label="返回" onClick={onBack}><ArrowLeft size={20} /></button>
      <h2>{title}</h2>
      <div>{children}</div>
    </header>
  );
}

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <label className="field"><span>{label}</span>{children}{hint ? <small>{hint}</small> : null}</label>;
}

function StrengthMeter({ value, label }: { value: number; label: string }) {
  return (
    <div className="strength-meter" aria-live="polite">
      <div>{Array.from({ length: 5 }, (_, index) => <span key={index} className={index < value ? 'active' : ''} />)}</div>
      <strong>{label}</strong>
    </div>
  );
}

function RecoveryCodeDialog({ code, onClose, onNotice }: { code: string; onClose: () => void; onNotice: (notice: Notice) => void }) {
  async function copyCode() {
    try {
      await navigator.clipboard.writeText(code);
      onNotice({ kind: 'success', text: '恢复码已复制。请保存到浏览器外的安全位置。' });
    } catch {
      onNotice({ kind: 'error', text: '复制失败，请手动选中恢复码保存。' });
    }
  }

  return (
    <div className="dialog-backdrop" role="presentation">
      <section className="confirm-dialog recovery-dialog" role="dialog" aria-modal="true" aria-labelledby="recovery-code-title">
        <div className="dialog-icon"><KeyRound size={20} /></div>
        <h2 id="recovery-code-title">保存你的恢复码</h2>
        <p>如果以后忘记主密码，只能用这个恢复码设置新的主密码。KeyPilot 不会再次显示它。</p>
        <code className="recovery-code">{code}</code>
        <div className="recovery-warning">
          <AlertTriangle size={16} />
          <span>不要截图发给别人，不要保存到同一个浏览器密码库里。建议写在纸上，或放入离线加密文件。</span>
        </div>
        <div className="dialog-actions">
          <button type="button" className="button secondary" onClick={copyCode}><Copy size={15} />复制恢复码</button>
          <button type="button" className="button primary" onClick={onClose}>我已保存</button>
        </div>
      </section>
    </div>
  );
}

function SaveLoginPrompt({
  candidate,
  existing,
  exactDuplicate,
  onSave
}: {
  candidate: PendingLoginCandidate;
  existing?: Credential;
  exactDuplicate: boolean;
  onSave: (candidate: PendingLoginCandidate, mode: SaveLoginMode) => void;
}) {
  const hasConflict = Boolean(existing && !exactDuplicate);
  const [mode, setMode] = useState<SaveLoginMode>(hasConflict ? 'update' : 'save');
  const [title, setTitle] = useState((existing?.title || candidate.title || candidate.domain).trim());

  useEffect(() => {
    setMode(hasConflict ? 'update' : 'save');
    setTitle((existing?.title || candidate.title || candidate.domain).trim());
  }, [candidate.id, candidate.title, candidate.domain, existing?.id, existing?.title, hasConflict]);

  const normalizedTitle = title.trim() || candidate.title || candidate.domain;
  const candidateToSave: PendingLoginCandidate = {
    ...candidate,
    title: normalizedTitle
  };
  const existingLabel = `${existing?.title || candidate.domain}${candidate.username ? ` (${candidate.username})` : ''}`;
  const newLabel = `${normalizedTitle}${candidate.username ? ` (${candidate.username})` : ''}`;
  const primaryMode: SaveLoginMode = hasConflict ? mode : 'save';
  const primaryLabel = primaryMode === 'update' ? '更新已有账号' : primaryMode === 'new' ? '保存为新账号' : '保存';

  return (
    <section className="save-prompt">
      <button className="prompt-close" type="button" aria-label="关闭保存提示" onClick={() => onSave(candidate, 'skip')}><X size={15} /></button>
      <div className="prompt-hero"><ShieldCheck size={42} /></div>
      <h2>{exactDuplicate ? '登录信息已存在' : hasConflict ? '检测到密码变化' : '检测到新的登录信息'}</h2>
      <p>{exactDuplicate ? '该账号已保存，无需重复保存。' : hasConflict ? '同一网站和用户名已存在，选择如何处理。' : '是否保存到钥航 KeyPilot？'}</p>
      <div className="candidate-card">
        <SiteIcon domain={candidate.domain} url={candidate.url} iconUrl={candidate.iconUrl} />
        <div><strong>{candidate.domain}</strong><span>{candidate.username || '未识别用户名'}</span><code>••••••••••••</code></div>
        <Eye size={15} />
      </div>
      {exactDuplicate ? (
        <button className="button primary full" type="button" onClick={() => onSave(candidate, 'skip')}>知道了</button>
      ) : (
        <>
          <div className="save-fields">
            <label className="save-field">
              <span>保存名称</span>
              <input
                type="text"
                value={title}
                onChange={(event) => setTitle(event.currentTarget.value)}
                placeholder={candidate.domain}
              />
            </label>
            <label className="save-field">
              <span>保存方式</span>
              <select value={primaryMode} onChange={(event) => setMode(event.currentTarget.value as SaveLoginMode)}>
                {hasConflict ? <option value="update">更新已有账号：{existingLabel}</option> : null}
                <option value={hasConflict ? 'new' : 'save'}>保存为新账号：{newLabel}</option>
              </select>
            </label>
          </div>
          <button className="button primary full" type="button" onClick={() => onSave(candidateToSave, primaryMode)}>{primaryLabel}</button>
        </>
      )}
      <div className="prompt-actions">
        {hasConflict ? <button type="button" onClick={() => onSave(candidateToSave, 'new')}>直接保存为新记录</button> : null}
        <button type="button" onClick={() => onSave(candidate, 'skip')}>{hasConflict ? '跳过' : '暂不保存'}</button>
        <button type="button" onClick={() => onSave(candidate, 'blacklist')}>从不保存此网站</button>
      </div>
    </section>
  );
}

function NoticeToast({ notice, onDismiss }: { notice: Notice; onDismiss: () => void }) {
  return <div className={`notice-toast ${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}><span>{notice.text}</span><button type="button" onClick={onDismiss} aria-label="关闭提示"><X size={14} /></button></div>;
}

function RenameFillProfileDialog({
  profile,
  onClose,
  onSave
}: {
  profile: FillProfile;
  onClose: () => void;
  onSave: (title: string) => void | Promise<void>;
}) {
  const [title, setTitle] = useState(profile.title);
  const [busy, setBusy] = useState(false);
  const nextTitle = title.trim();

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!nextTitle) return;

    setBusy(true);
    try {
      await onSave(nextTitle);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="dialog-backdrop" role="presentation">
      <form className="confirm-dialog rename-dialog" role="dialog" aria-modal="true" aria-labelledby="rename-fill-profile-title" onSubmit={handleSubmit}>
        <div className="dialog-icon">
          <Edit3 size={20} aria-hidden="true" />
        </div>
        <h2 id="rename-fill-profile-title">重命名身份资料</h2>
        <label className="rename-field">
          <span>名称</span>
          <input value={title} onChange={(event) => setTitle(event.target.value)} autoFocus maxLength={80} placeholder="例如：车险_US020" />
        </label>
        <div className="dialog-actions">
          <button type="button" className="button secondary" onClick={onClose} disabled={busy}>取消</button>
          <button type="submit" className="button primary" disabled={busy || !nextTitle}>{busy ? '保存中...' : '保存'}</button>
        </div>
      </form>
    </div>
  );
}

function ConfirmDialog({ request, onClose }: { request: ConfirmRequest; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  async function handleConfirm() {
    setBusy(true);
    try {
      await request.onConfirm();
      onClose();
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="dialog-backdrop" role="presentation">
      <section className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title">
        <div className={request.tone === 'danger' ? 'dialog-icon danger' : 'dialog-icon'}><AlertTriangle size={20} /></div>
        <h2 id="confirm-title">{request.title}</h2>
        <p>{request.body}</p>
        <div className="dialog-actions">
          <button type="button" className="button secondary" onClick={onClose} disabled={busy}>取消</button>
          <button type="button" className={request.tone === 'danger' ? 'button danger' : 'button primary'} onClick={handleConfirm} disabled={busy}>{busy ? '处理中...' : request.actionLabel}</button>
        </div>
      </section>
    </div>
  );
}

function CheckingState() {
  return <main className="checking-state"><div className="skeleton-panel" /><p>正在检查本地 Vault...</p></main>;
}

function EmptyState({ title, body, actionLabel, onAction }: { title: string; body: string; actionLabel: string; onAction: () => void }) {
  return <section className="empty-state"><KeyRound size={28} /><h2>{title}</h2><p>{body}</p><button className="button primary" type="button" onClick={onAction}><Plus size={15} />{actionLabel}</button></section>;
}

function CheckOption({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return <label className="check-option"><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /><span>{label}</span></label>;
}

function PreviewMetric({ label, value }: { label: string; value: number }) {
  return <div><strong>{value}</strong><span>{label}</span></div>;
}

function SettingRow({ label, description, children }: { label: string; description: string; children: ReactNode }) {
  return <div className="setting-row"><div><strong>{label}</strong><span>{description}</span></div>{children}</div>;
}

function ToggleRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return <label className="toggle-row"><span>{label}</span><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /></label>;
}
