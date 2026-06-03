import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, FormEvent, MouseEvent, ReactNode } from 'react';
import {
  AlertTriangle,
  ArrowUpRight,
  Check,
  CirclePlay,
  Copy,
  Download,
  Eye,
  EyeOff,
  FileText,
  FolderPlus,
  FolderOpen,
  Grid3X3,
  HelpCircle,
  Home,
  IdCard,
  KeyRound,
  LayoutList,
  List,
  Lock,
  MoreVertical,
  MoveRight,
  NotebookText,
  Pencil,
  Pin,
  Plus,
  Printer,
  RefreshCw,
  Search,
  Send,
  Settings2,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Share2,
  SlidersHorizontal,
  Trash2,
  Undo2,
  Upload,
  UserCircle,
  Users,
  Wand2,
  X
} from 'lucide-react';
import { exportRoboFormCsv } from '../shared/csvExport';
import { exportFillProfilesKpFill, parseFillProfileImportFile, type FillProfileImportPreview } from '../shared/fillProfiles';
import { getEncryptedVault } from '../shared/storage';
import { extractDomain, extractMatchDomain, normalizeMatchUrl, normalizeUrl } from '../shared/domain';
import { getIconCandidates, getRootFaviconUrl, toHttpIconUrl } from '../shared/icons';
import { defaultGeneratorOptions, generatePassword, measurePasswordStrength, type PasswordGeneratorOptions } from '../shared/passwordGenerator';
import {
  addCredentialToVault,
  addFillProfilesToVault,
  buildCredential,
  createFolderInVault,
  createVaultSession,
  deleteCredentialFromVault,
  deleteFillProfileFromVault,
  deleteFolderFromVault,
  deleteIdentityFromVault,
  deleteSecureNoteFromVault,
  moveFolderContentsInVault,
  moveVaultEntryToFolder,
  persistVaultSession,
  purgeDeletedItemFromVault,
  renameFolderInVault,
  restoreCachedVaultSession,
  restoreDeletedItemToVault,
  touchCredentialInVault,
  unlockVaultSession,
  updateCredentialInVault,
  updateFillProfileInVault
} from '../shared/vault';
import type {
  BindingTestResult,
  Credential,
  CredentialAction,
  CredentialFormField,
  CredentialFormFieldKind,
  CredentialIconType,
  DeletedVaultItem,
  FillCredentialPayload,
  FillField,
  FillImportBatchRecord,
  FillProfile,
  IdentityProfile,
  SecureNote,
  SiteMetadataResult,
  UnlockedVaultSession,
  VaultFolder,
  VaultPlain,
  VaultStatus
} from '../shared/types';

type DashboardSection =
  | 'all'
  | 'folder'
  | 'logins'
  | 'notes'
  | 'identities'
  | 'generator'
  | 'authenticator'
  | 'security'
  | 'sharing'
  | 'emergency'
  | 'trash';
type SortMode = 'popular' | 'recent' | 'az';
type ViewMode = 'table' | 'compact' | 'grid';
type DetailMode = 'view' | 'edit';
type FillImportOrder = FillImportBatchRecord['order'];
type VaultUiState = {
  section: DashboardSection;
  selectedFolder: string | null;
  sortMode: SortMode;
  viewMode: ViewMode;
};

interface FillImportOptions {
  offset: number;
  count: number;
  prefix: string;
  numberStart: number;
  numberPadding: number;
  order: FillImportOrder;
}

type ModalState =
  | { type: 'login'; credential?: Credential; folder?: string }
  | { type: 'note'; note?: SecureNote }
  | { type: 'identity'; identity?: IdentityProfile }
  | { type: 'contact'; identity?: IdentityProfile }
  | { type: 'folder'; folder?: VaultFolder }
  | { type: 'move'; item: VaultItem }
  | { type: 'moveFolder'; folderName: string }
  | null;

type FolderContextMenuState = {
  folderName: string;
  x: number;
  y: number;
} | null;

type ItemContextMenuState = {
  item: VaultItem;
  x: number;
  y: number;
} | null;

type VaultItem =
  | { kind: 'login'; id: string; updatedAt: number; pinned?: boolean; credential: Credential }
  | { kind: 'note'; id: string; updatedAt: number; pinned?: boolean; note: SecureNote }
  | { kind: 'identity'; id: string; updatedAt: number; pinned?: boolean; identity: IdentityProfile }
  | { kind: 'fillProfile'; id: string; updatedAt: number; pinned?: boolean; fillProfile: FillProfile };

const VAULT_UI_STATE_KEY = 'keypilot:vault-ui-state';
const DASHBOARD_SECTIONS: DashboardSection[] = [
  'all',
  'folder',
  'logins',
  'notes',
  'identities',
  'generator',
  'authenticator',
  'security',
  'sharing',
  'emergency',
  'trash'
];
const SORT_MODES: SortMode[] = ['popular', 'recent', 'az'];
const VIEW_MODES: ViewMode[] = ['table', 'compact', 'grid'];
const HASH_SECTIONS: string[] = DASHBOARD_SECTIONS.filter((item) => item !== 'folder');

interface CredentialDraft {
  title: string;
  url: string;
  matchUrl: string;
  iconUrl?: string;
  iconType?: CredentialIconType;
  username: string;
  password: string;
  folder: string;
  notes: string;
  formFields: CredentialFormField[];
}

interface NoteDraft {
  title: string;
  folder: string;
  note: string;
}

interface IdentityDraft {
  title: string;
  folder: string;
  fullName: string;
  email: string;
  phone: string;
  company: string;
  address: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
  notes: string;
}

interface OpenTabResult {
  ok: boolean;
  queued?: boolean;
  error?: string;
}

const SECTION_LABELS: Record<DashboardSection, string> = {
  all: '所有',
  folder: '文件夹',
  logins: '登录',
  notes: '保密笔记本',
  identities: '个人信息',
  generator: '密码生成器',
  authenticator: '身份验证器',
  security: '安全中心',
  sharing: '共享中心',
  emergency: '紧急访问',
  trash: '回收站'
};
const ROOT_FOLDER_NAME = '主目录';
const resolvedIconCache = new Map<string, string | null>();
const failedIconUrls = new Set<string>();

function normalizeFolderLabel(value: string | undefined): string {
  return value?.trim().replace(/\s+/g, ' ') || ROOT_FOLDER_NAME;
}

function isRootFolder(value: string | undefined): boolean {
  return normalizeFolderLabel(value) === ROOT_FOLDER_NAME;
}

function emptyCredentialDraft(folder = ROOT_FOLDER_NAME): CredentialDraft {
  return {
    title: '',
    url: '',
    matchUrl: '',
    iconUrl: undefined,
    iconType: 'default',
    username: '',
    password: '',
    folder,
    notes: '',
    formFields: []
  };
}

function credentialToDraft(credential?: Credential): CredentialDraft {
  if (!credential) return emptyCredentialDraft();

  return {
    title: credential.title,
    url: credential.url,
    matchUrl: credential.matchUrl ?? '',
    iconUrl: credential.iconUrl,
    iconType: credential.iconType ?? (credential.iconUrl ? 'favicon' : 'default'),
    username: credential.username,
    password: credential.password,
    folder: normalizeFolderLabel(credential.folder),
    notes: credential.notes ?? '',
    formFields: (credential.formFields ?? []).map((field, index) => ({ ...field, index: field.index ?? index }))
  };
}

function emptyNoteDraft(folder = ROOT_FOLDER_NAME): NoteDraft {
  return { title: '', folder, note: '' };
}

function noteToDraft(note?: SecureNote): NoteDraft {
  if (!note) return emptyNoteDraft();
  return { title: note.title, folder: normalizeFolderLabel(note.folder), note: note.note };
}

function emptyIdentityDraft(folder = ROOT_FOLDER_NAME): IdentityDraft {
  return {
    title: '',
    folder,
    fullName: '',
    email: '',
    phone: '',
    company: '',
    address: '',
    city: '',
    region: '',
    postalCode: '',
    country: '',
    notes: ''
  };
}

function identityToDraft(identity?: IdentityProfile): IdentityDraft {
  if (!identity) return emptyIdentityDraft();

  return {
    title: identity.title,
    folder: normalizeFolderLabel(identity.folder),
    fullName: identity.fullName ?? '',
    email: identity.email ?? '',
    phone: identity.phone ?? '',
    company: identity.company ?? '',
    address: identity.address ?? '',
    city: identity.city ?? '',
    region: identity.region ?? '',
    postalCode: identity.postalCode ?? '',
    country: identity.country ?? '',
    notes: identity.notes ?? ''
  };
}

function itemName(item: VaultItem): string {
  if (item.kind === 'login') return item.credential.title;
  if (item.kind === 'note') return item.note.title;
  if (item.kind === 'fillProfile') return item.fillProfile.title;
  return item.identity.title;
}

function itemFolder(item: VaultItem): string {
  if (item.kind === 'login') return normalizeFolderLabel(item.credential.folder);
  if (item.kind === 'note') return normalizeFolderLabel(item.note.folder);
  if (item.kind === 'fillProfile') return normalizeFolderLabel(item.fillProfile.folder);
  return normalizeFolderLabel(item.identity.folder);
}

function buildFolderOptions(folders: VaultFolder[], items: VaultItem[]): string[] {
  const names = new Map<string, string>();
  names.set(ROOT_FOLDER_NAME.toLowerCase(), ROOT_FOLDER_NAME);

  folders.forEach((folder) => {
    const name = normalizeFolderLabel(folder.name);
    if (!isRootFolder(name)) {
      names.set(name.toLowerCase(), name);
    }
  });

  items.forEach((item) => {
    const name = itemFolder(item);
    if (!isRootFolder(name)) {
      names.set(name.toLowerCase(), name);
    }
  });

  return Array.from(names.values()).sort((left, right) => {
    if (left === ROOT_FOLDER_NAME) return -1;
    if (right === ROOT_FOLDER_NAME) return 1;
    return left.localeCompare(right, 'zh-Hans-CN');
  });
}

function vaultItemToMoveKind(item: VaultItem): 'credential' | 'secureNote' | 'identity' | 'fillProfile' {
  if (item.kind === 'login') return 'credential';
  if (item.kind === 'note') return 'secureNote';
  if (item.kind === 'fillProfile') return 'fillProfile';
  return 'identity';
}

function folderItemCount(folderName: string, items: VaultItem[]): number {
  return items.filter((item) => itemFolder(item) === folderName).length;
}

function itemSubtitle(item: VaultItem): string {
  if (item.kind === 'login') return item.credential.username || item.credential.domain || '无用户名';
  if (item.kind === 'note') return item.note.note.slice(0, 40) || '空笔记';
  if (item.kind === 'fillProfile') return fillProfileSummary(item.fillProfile);
  return item.identity.email || item.identity.phone || item.identity.fullName || '身份资料';
}

function itemWebsite(item: VaultItem): string {
  if (item.kind === 'login') return item.credential.domain;
  if (item.kind === 'fillProfile') {
    return `${item.fillProfile.countryCode} · ${fillProfileCategoryLabel(item.fillProfile.category)} · ${item.fillProfile.fields.length} 字段`;
  }
  return '';
}

function vaultTableLabels(section: DashboardSection): [string, string, string, string, string] {
  if (section === 'identities') {
    return ['名字', '文件夹', '联系方式', '资料类型', '国家/字段'];
  }

  if (section === 'notes') {
    return ['名字', '文件夹', '摘要', '类型', '状态'];
  }

  if (section === 'logins') {
    return ['名字', '文件夹', '用户名', '密码强度', '网址地址'];
  }

  return ['名字', '文件夹', '登录名/联系信息', '类型/强度', '网站/字段'];
}

function itemPrimaryData(item: VaultItem): string {
  if (item.kind === 'login') return item.credential.username;
  if (item.kind === 'identity') return item.identity.email ?? item.identity.phone ?? item.identity.fullName ?? '';
  if (item.kind === 'fillProfile') {
    return (
      fillFieldValue(item.fillProfile.fields, 'email') ||
      fillFieldValue(item.fillProfile.fields, 'phone') ||
      fillFieldValue(item.fillProfile.fields, 'fullName') ||
      [fillFieldValue(item.fillProfile.fields, 'firstName'), fillFieldValue(item.fillProfile.fields, 'lastName')].filter(Boolean).join(' ')
    );
  }

  return item.note.note.slice(0, 60);
}

function itemTypeLabel(item: VaultItem): string {
  if (item.kind === 'login') return '';
  if (item.kind === 'fillProfile') return fillProfileCategoryLabel(item.fillProfile.category);
  if (item.kind === 'identity') return '身份资料';
  return '保密笔记';
}

function itemTableEndpoint(item: VaultItem): string {
  if (item.kind === 'login') return itemWebsite(item);
  if (item.kind === 'fillProfile') {
    return `${item.fillProfile.countryCode || '未设置国家'} · ${item.fillProfile.fields.length} 字段`;
  }
  if (item.kind === 'identity') {
    return [item.identity.country, item.identity.region, item.identity.city].filter(Boolean).join(' · ') || '本地资料';
  }

  return item.note.pinned ? '已固定' : '本地加密';
}

function vaultItemClipboardText(item: VaultItem): string {
  if (item.kind === 'login') {
    return [
      `名称: ${item.credential.title}`,
      `URL: ${item.credential.url}`,
      item.credential.matchUrl ? `Match URL: ${item.credential.matchUrl}` : '',
      `域名: ${item.credential.domain}`,
      `用户名: ${item.credential.username}`,
      `密码: ${item.credential.password}`,
      item.credential.notes ? `备注: ${item.credential.notes}` : '',
      item.credential.tags?.length ? `标签: ${item.credential.tags.join(', ')}` : ''
    ]
      .filter(Boolean)
      .join('\n');
  }

  if (item.kind === 'fillProfile') {
    return formatFillProfileForClipboard(item.fillProfile);
  }

  if (item.kind === 'identity') {
    return [
      `名称: ${item.identity.title}`,
      item.identity.fullName ? `姓名: ${item.identity.fullName}` : '',
      item.identity.email ? `邮箱: ${item.identity.email}` : '',
      item.identity.phone ? `电话: ${item.identity.phone}` : '',
      item.identity.company ? `公司: ${item.identity.company}` : '',
      item.identity.address ? `地址: ${item.identity.address}` : '',
      item.identity.city ? `城市: ${item.identity.city}` : '',
      item.identity.region ? `州/省: ${item.identity.region}` : '',
      item.identity.postalCode ? `邮编: ${item.identity.postalCode}` : '',
      item.identity.country ? `国家: ${item.identity.country}` : '',
      item.identity.notes ? `备注: ${item.identity.notes}` : ''
    ]
      .filter(Boolean)
      .join('\n');
  }

  return [`标题: ${item.note.title}`, `内容: ${item.note.note}`].join('\n');
}

function fillProfileSummary(profile: FillProfile): string {
  const name = fillFieldValue(profile.fields, 'fullName') || [fillFieldValue(profile.fields, 'firstName'), fillFieldValue(profile.fields, 'lastName')].filter(Boolean).join(' ');
  const email = fillFieldValue(profile.fields, 'email');
  const phone = fillFieldValue(profile.fields, 'phone');
  const business = fillFieldValue(profile.fields, 'businessName') || fillFieldValue(profile.fields, 'dbaName');
  const loanAmount = fillFieldValue(profile.fields, 'loanAmount');
  const vehicle = [fillFieldValue(profile.fields, 'vehicleYear'), fillFieldValue(profile.fields, 'vehicleMake'), fillFieldValue(profile.fields, 'vehicleModel')].filter(Boolean).join(' ');
  return business || loanAmount || name || email || phone || vehicle || `${profile.fields.length} 个字段`;
}

function fillProfileBadgeText(profile: FillProfile): string {
  if (profile.category === 'auto_insurance') return '车';
  if (profile.category === 'loan') return '贷';
  if (profile.category === 'business') return '企';
  if (profile.category === 'payment') return '卡';

  const words = profile.title.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    return `${words[0].slice(0, 1)}${words[1].slice(0, 1)}`.toUpperCase();
  }

  const compactTitle = profile.title.replace(/[\s_-]+/g, '').trim();
  return compactTitle.slice(0, Math.min(2, compactTitle.length)).toUpperCase() || 'ID';
}

function identityBadgeText(identity: IdentityProfile): string {
  const source = identity.fullName || identity.title || identity.email || 'ID';
  const words = source.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    return `${words[0].slice(0, 1)}${words[1].slice(0, 1)}`.toUpperCase();
  }

  const compactSource = source.replace(/[\s_-]+/g, '').trim();
  return compactSource.slice(0, Math.min(2, compactSource.length)).toUpperCase() || 'ID';
}

function identityTone(identity: IdentityProfile): 'tone-green' | 'tone-purple' | 'tone-amber' | 'tone-rose' | 'tone-blue' | 'tone-slate' {
  const tones = ['tone-purple', 'tone-green', 'tone-amber', 'tone-rose', 'tone-blue', 'tone-slate'] as const;
  return tones[stableHash(`${identity.id}:${identity.title}:${identity.email ?? ''}`) % tones.length];
}

function fillProfileTone(profile: FillProfile): 'tone-green' | 'tone-purple' | 'tone-amber' | 'tone-rose' | 'tone-blue' | 'tone-slate' {
  if (profile.category === 'auto_insurance') {
    const autoTones = ['tone-green', 'tone-purple', 'tone-amber', 'tone-rose'] as const;
    return autoTones[stableHash(`${profile.id}:${profile.title}`) % autoTones.length];
  }

  if (profile.category === 'payment') return 'tone-amber';
  if (profile.category === 'business') return 'tone-blue';
  if (profile.category === 'loan') return 'tone-purple';

  const tones = ['tone-purple', 'tone-green', 'tone-blue', 'tone-amber', 'tone-rose', 'tone-slate'] as const;
  return tones[stableHash(`${profile.id}:${profile.title}:${profile.category}`) % tones.length];
}

function stableHash(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function fillProfileCategoryLabel(category: FillProfile['category']): string {
  if (category === 'auto_insurance') return '车险填表';
  if (category === 'shipping') return '收货地址';
  if (category === 'billing') return '账单资料';
  if (category === 'payment') return '付款资料';
  if (category === 'business') return '公司资料';
  if (category === 'loan') return '贷款资料';
  if (category === 'identity') return '身份资料';
  return '自定义资料';
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

function fillFieldGroupIcon(group: FillField['group']): ReactNode {
  if (group === 'personal' || group === 'contact') return <UserCircle size={18} />;
  if (group === 'address') return <Home size={18} />;
  if (group === 'business' || group === 'loan' || group === 'employment' || group === 'finance') return <FolderPlus size={18} />;
  if (group === 'vehicle' || group === 'insurance' || group === 'driver') return <ShieldCheck size={18} />;
  if (group === 'payment' || group === 'sensitive') return <KeyRound size={18} />;
  return <IdCard size={18} />;
}

function fillProfileFieldsByGroup(profile: FillProfile): Array<[FillField['group'], FillField[]]> {
  const groups = new Map<FillField['group'], FillField[]>();

  profile.fields
    .filter((field) => field.value.trim() || field.label.trim())
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
  const lines = [`${profile.title}`, `${profile.countryCode} · ${fillProfileCategoryLabel(profile.category)} · ${profile.fields.length} 字段`];

  fillProfileFieldsByGroup(profile).forEach(([group, fields]) => {
    lines.push('', `[${fillFieldGroupLabel(group)}]`);
    fields.forEach((field) => {
      lines.push(`${field.label}: ${field.value}`);
    });
  });

  return lines.join('\n');
}

function defaultFillImportPrefix(category: FillProfile['category']): string {
  if (category === 'auto_insurance') return '车险';
  if (category === 'business') return '公司';
  if (category === 'loan') return '贷款';
  if (category === 'payment') return '付款';
  if (category === 'shipping' || category === 'billing') return '地址';
  if (category === 'identity') return '身份';
  return '资料';
}

function fillImportSourceKey(preview: FillProfileImportPreview): string {
  const headerKey = preview.headers.map((header) => `${header.column}:${header.key}`).join('|');
  return [preview.sourceName, preview.sourceType, preview.totalRows, preview.importableRows, preview.fieldCount, preview.category, preview.countryCode, headerKey]
    .join('::')
    .toLowerCase();
}

function sortFillImportProfiles(profiles: FillProfile[], order: FillImportOrder): FillProfile[] {
  const items = [...profiles];
  if (order === 'reverse') return items.reverse();
  if (order === 'titleAsc') return items.sort((left, right) => left.title.localeCompare(right.title, 'zh-CN'));
  if (order === 'titleDesc') return items.sort((left, right) => right.title.localeCompare(left.title, 'zh-CN'));
  return items;
}

function applyFillImportOptions(preview: FillProfileImportPreview, options: FillImportOptions): FillProfile[] {
  const offset = Math.max(0, Math.min(options.offset, preview.profiles.length));
  const count = Math.max(0, Math.min(options.count, preview.profiles.length - offset));
  const prefix = options.prefix.trim();
  const padding = Math.max(1, Math.min(8, options.numberPadding));
  const start = Math.max(0, options.numberStart);

  return sortFillImportProfiles(preview.profiles, options.order)
    .slice(offset, offset + count)
    .map((profile, index) => ({
      ...profile,
      id: crypto.randomUUID(),
      title: prefix ? `${prefix}${String(start + index).padStart(padding, '0')}` : profile.title,
      updatedAt: Date.now()
    }));
}

function upsertFillImportBatchRecord(
  records: FillImportBatchRecord[] | undefined,
  preview: FillProfileImportPreview,
  options: FillImportOptions,
  importedCount: number
): FillImportBatchRecord[] {
  const sourceKey = fillImportSourceKey(preview);
  const now = Date.now();
  const existing = (records ?? []).find((record) => record.sourceKey === sourceKey);
  const nextOffset = Math.min(preview.importableRows, options.offset + importedCount);
  const nextRecord: FillImportBatchRecord = {
    sourceKey,
    sourceName: preview.sourceName,
    sourceType: preview.sourceType,
    category: preview.category,
    countryCode: preview.countryCode,
    totalRows: preview.importableRows,
    importedCount: Math.max(existing?.importedCount ?? 0, nextOffset),
    nextOffset,
    prefix: options.prefix.trim(),
    numberStart: options.numberStart + importedCount,
    numberPadding: options.numberPadding,
    order: options.order,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  };

  return [nextRecord, ...(records ?? []).filter((record) => record.sourceKey !== sourceKey)].slice(0, 40);
}

function fillFieldValue(fields: FillField[], key: string): string {
  return fields.find((field) => field.key === key)?.value ?? '';
}

function matchesSearch(item: VaultItem, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;

  const values =
    item.kind === 'login'
      ? [item.credential.title, item.credential.domain, item.credential.matchUrl ?? '', item.credential.username, item.credential.notes ?? '', item.credential.folder ?? '']
      : item.kind === 'note'
        ? [item.note.title, item.note.note, item.note.folder ?? '']
        : item.kind === 'fillProfile'
          ? [
              item.fillProfile.title,
              item.fillProfile.countryCode,
              item.fillProfile.folder ?? '',
              item.fillProfile.category,
              ...item.fillProfile.fields.flatMap((field) => [field.label, field.value])
            ]
        : [
            item.identity.title,
            item.identity.fullName ?? '',
            item.identity.email ?? '',
            item.identity.phone ?? '',
            item.identity.company ?? '',
            item.identity.address ?? '',
            item.identity.folder ?? ''
          ];

  return values.some((value) => value.toLowerCase().includes(normalized));
}

function sortItems(items: VaultItem[], sort: SortMode): VaultItem[] {
  return [...items].sort((left, right) => {
    if (sort === 'az') return itemName(left).localeCompare(itemName(right), 'zh-Hans-CN');
    if (sort === 'popular') {
      if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
    }
    return right.updatedAt - left.updatedAt;
  });
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.message === 'The operation failed for an operation-specific reason') return '主密码错误，请重新输入。';
    if (error.message === 'VAULT_NOT_FOUND') return '没有找到本地 Vault。';
    if (error.message === 'VAULT_LOCKED') return 'Vault 已锁定，请先解锁后再绑定。';
    if (error.message === 'BINDING_START_FAILED') return '无法启动网页点选绑定，请刷新目标网页后重试。';
    if (error.message === 'BINDING_TEST_FAILED') return '无法启动绑定测试，请刷新目标网页后重试。';
    if (error.message === 'NO_MATCHING_CREDENTIAL') return '当前网页和账号域名不匹配，不能绑定。';
    if (error.message === 'INVALID_CREDENTIAL_URL') return '账号网址无效，无法打开网页绑定。';
    return error.message;
  }

  return String(error || '操作失败');
}

function openExtensionUrl(path: string) {
  const url = chrome.runtime?.getURL ? chrome.runtime.getURL(path) : path;

  if (chrome.tabs?.create) {
    void chrome.tabs.create({ url, active: true });
    return;
  }

  window.open(url, '_blank', 'noopener,noreferrer');
}

function sendRuntimeMessage<T>(message: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    if (!globalThis.chrome?.runtime?.sendMessage) {
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

async function fetchSiteMetadata(url: string): Promise<SiteMetadataResult> {
  return sendRuntimeMessage<SiteMetadataResult>({
    type: 'KEYPILOT_FETCH_SITE_METADATA',
    url
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

async function copyText(value: string, label: string, setNotice: (value: string) => void) {
  if (!value) {
    setNotice(`${label}为空。`);
    return;
  }

  await navigator.clipboard.writeText(value);
  setNotice(`已复制${label}。`);
}

function timestampForFile(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');

  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function normalizeDraftFormFields(fields: CredentialFormField[], username: string, password: string): CredentialFormField[] | undefined {
  const normalized = fields
    .map((field, index) => {
      const kind = field.kind || 'text';
      const label = field.label.trim() || (kind === 'password' ? 'Password' : kind === 'username' ? 'User ID' : `Field ${index + 1}`);
      const value = kind === 'username' ? username.trim() : kind === 'password' ? password : field.value.trim();
      const name = field.name?.trim() || label;

      return {
        ...field,
        label,
        name,
        type: kind === 'password' ? 'password' : field.type || 'text',
        value,
        kind,
        index
      };
    })
    .filter((field, index) => {
      const original = fields[index];
      return Boolean(field.value || original.label.trim() || original.name?.trim() || original.selector || original.id);
    })
    .slice(0, 40);

  return normalized.length ? normalized : undefined;
}

function deletedItemName(item: DeletedVaultItem): string {
  if (item.kind === 'credential') return item.item.title;
  if (item.kind === 'secureNote') return item.item.title;
  return item.item.title;
}

function deletedItemSubtitle(item: DeletedVaultItem): string {
  if (item.kind === 'credential') return item.item.username || item.item.domain || '无用户名';
  if (item.kind === 'secureNote') return item.item.note.slice(0, 48) || '空笔记';
  if (item.kind === 'fillProfile') return fillProfileSummary(item.item);
  return item.item.email || item.item.phone || item.item.fullName || '身份资料';
}

function deletedItemWebsite(item: DeletedVaultItem): string {
  if (item.kind === 'credential') return item.item.domain;
  if (item.kind === 'fillProfile') return `${item.item.countryCode} · ${fillProfileCategoryLabel(item.item.category)}`;
  return '';
}

function deletedItemKindLabel(item: DeletedVaultItem): string {
  if (item.kind === 'credential') return '登录';
  if (item.kind === 'secureNote') return '保密笔记';
  if (item.kind === 'fillProfile') return '填表资料';
  return '个人信息';
}

function deletedItemMatchesSearch(item: DeletedVaultItem, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;

  const values =
    item.kind === 'credential'
      ? [item.item.title, item.item.domain, item.item.username, item.item.notes ?? '', item.item.folder ?? '']
      : item.kind === 'secureNote'
        ? [item.item.title, item.item.note, item.item.folder ?? '']
        : item.kind === 'fillProfile'
          ? [item.item.title, item.item.countryCode, item.item.folder ?? '', ...item.item.fields.flatMap((field) => [field.label, field.value])]
        : [item.item.title, item.item.fullName ?? '', item.item.email ?? '', item.item.phone ?? '', item.item.company ?? '', item.item.folder ?? ''];

  return values.some((value) => value.toLowerCase().includes(normalized));
}

function decodeHashSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function readVaultHashState(hash: string): Pick<VaultUiState, 'section' | 'selectedFolder'> | null {
  const cleanHash = hash.replace(/^#/, '').trim();
  if (!cleanHash) return null;

  const [rawSection, ...rawFolderParts] = cleanHash.split('/');
  const section = rawSection.toLowerCase();

  if (section === 'folder') {
    const folderName = decodeHashSegment(rawFolderParts.join('/')).trim();
    return {
      section: 'folder',
      selectedFolder: normalizeFolderLabel(folderName || ROOT_FOLDER_NAME)
    };
  }

  if (HASH_SECTIONS.includes(section as DashboardSection)) {
    return {
      section: section as DashboardSection,
      selectedFolder: null
    };
  }

  return null;
}

function vaultStateHash(state: VaultUiState): string {
  if (state.section === 'folder') {
    const folderName = normalizeFolderLabel(state.selectedFolder ?? ROOT_FOLDER_NAME);
    return `#folder/${encodeURIComponent(folderName)}`;
  }

  return `#${state.section}`;
}

function syncVaultHash(state: VaultUiState) {
  if (typeof window === 'undefined') return;

  const nextHash = vaultStateHash(state);
  if (window.location.hash === nextHash) return;

  window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${nextHash}`);
}

function readVaultUiState(): VaultUiState {
  const fallback: VaultUiState = {
    section: 'all',
    selectedFolder: null,
    sortMode: 'popular',
    viewMode: 'table'
  };

  if (typeof window === 'undefined') return fallback;

  try {
    const parsed = JSON.parse(window.localStorage.getItem(VAULT_UI_STATE_KEY) ?? '{}') as Partial<VaultUiState>;
    const section = parsed.section && DASHBOARD_SECTIONS.includes(parsed.section) ? parsed.section : fallback.section;
    const selectedFolder = typeof parsed.selectedFolder === 'string' && parsed.selectedFolder.trim() ? parsed.selectedFolder : null;
    const sortMode = parsed.sortMode && SORT_MODES.includes(parsed.sortMode) ? parsed.sortMode : fallback.sortMode;
    const viewMode = parsed.viewMode && VIEW_MODES.includes(parsed.viewMode) ? parsed.viewMode : fallback.viewMode;
    const hashState = readVaultHashState(window.location.hash);
    const nextSection = hashState?.section ?? section;
    const nextSelectedFolder = hashState ? hashState.selectedFolder : selectedFolder;

    return {
      section: nextSection,
      selectedFolder: nextSection === 'folder' ? nextSelectedFolder ?? ROOT_FOLDER_NAME : null,
      sortMode,
      viewMode
    };
  } catch {
    return fallback;
  }
}

function writeVaultUiState(state: VaultUiState) {
  if (typeof window === 'undefined') return;

  try {
    window.localStorage.setItem(VAULT_UI_STATE_KEY, JSON.stringify(state));
  } catch {
    // Non-critical UI memory; ignore private-mode or storage quota failures.
  }
}

export function VaultApp() {
  const initialUiState = useMemo(readVaultUiState, []);
  const [status, setStatus] = useState<VaultStatus>('checking');
  const [session, setSession] = useState<UnlockedVaultSession | null>(null);
  const [masterPassword, setMasterPassword] = useState('');
  const [notice, setNotice] = useState('');
  const [query, setQuery] = useState('');
  const [section, setSection] = useState<DashboardSection>(initialUiState.section);
  const [selectedFolder, setSelectedFolder] = useState<string | null>(initialUiState.selectedFolder);
  const [sortMode, setSortMode] = useState<SortMode>(initialUiState.sortMode);
  const [viewMode, setViewMode] = useState<ViewMode>(initialUiState.viewMode);
  const [modal, setModal] = useState<ModalState>(null);
  const [quickCreateOpen, setQuickCreateOpen] = useState(false);
  const [folderContextMenu, setFolderContextMenu] = useState<FolderContextMenuState>(null);
  const [itemContextMenu, setItemContextMenu] = useState<ItemContextMenuState>(null);
  const [detailCredentialId, setDetailCredentialId] = useState<string | null>(null);
  const [detailMode, setDetailMode] = useState<DetailMode>('view');
  const [detailFillProfileId, setDetailFillProfileId] = useState<string | null>(null);
  const [detailFillProfileMode, setDetailFillProfileMode] = useState<DetailMode>('view');
  const [detailMoreOpen, setDetailMoreOpen] = useState(false);
  const [fillImportPreview, setFillImportPreview] = useState<FillProfileImportPreview | null>(null);
  const [fillImportBusy, setFillImportBusy] = useState(false);
  const [credentialExportOpen, setCredentialExportOpen] = useState(false);
  const [fillExportOpen, setFillExportOpen] = useState(false);
  const fillImportInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    void boot();
  }, []);

  useEffect(() => {
    if (!notice) return undefined;

    const timer = window.setTimeout(() => {
      setNotice('');
    }, 2600);

    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    const nextState: VaultUiState = {
      section,
      selectedFolder: section === 'folder' ? normalizeFolderLabel(selectedFolder ?? ROOT_FOLDER_NAME) : null,
      sortMode,
      viewMode
    };

    writeVaultUiState(nextState);
    syncVaultHash(nextState);
  }, [section, selectedFolder, sortMode, viewMode]);

  useEffect(() => {
    function handleHashChange() {
      const hashState = readVaultHashState(window.location.hash);
      if (!hashState) return;

      setFolderContextMenu(null);
      setItemContextMenu(null);
      setDetailMoreOpen(false);
      setSection(hashState.section);
      setSelectedFolder(hashState.section === 'folder' ? hashState.selectedFolder ?? ROOT_FOLDER_NAME : null);
    }

    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  async function boot() {
    const cached = await restoreCachedVaultSession();
    if (cached) {
      setSession(cached);
      setStatus('unlocked');
      return;
    }

    setStatus((await getEncryptedVault()) ? 'locked' : 'setup');
  }

  async function handleAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    try {
      const nextSession = status === 'setup' ? await createVaultSession(masterPassword) : await unlockVaultSession(masterPassword);
      setSession(nextSession);
      setStatus('unlocked');
      setMasterPassword('');
      setNotice(status === 'setup' ? 'Vault 已创建。' : 'Vault 已解锁。');
    } catch (error) {
      setNotice(getErrorMessage(error));
    }
  }

  async function persist(nextVault: VaultPlain, message: string) {
    if (!session) return;
    const nextSession = await persistVaultSession(session, nextVault);
    setSession(nextSession);
    setNotice(message);
  }

  const credentials = session?.vault.credentials ?? [];
  const notes = session?.vault.secureNotes ?? [];
  const identities = session?.vault.identities ?? [];
  const fillProfiles = session?.vault.fillProfiles ?? [];
  const folders = session?.vault.folders ?? [];
  const deletedItems = session?.vault.deletedItems ?? [];
  const detailCredential = credentials.find((credential) => credential.id === detailCredentialId) ?? null;
  const detailFillProfile = fillProfiles.find((profile) => profile.id === detailFillProfileId) ?? null;
  const detailOpen = Boolean(detailCredential || detailFillProfile);

  useEffect(() => {
    if (detailCredentialId && !credentials.some((credential) => credential.id === detailCredentialId)) {
      setDetailCredentialId(null);
      setDetailMode('view');
      setDetailMoreOpen(false);
    }
  }, [credentials, detailCredentialId]);

  useEffect(() => {
    if (detailFillProfileId && !fillProfiles.some((profile) => profile.id === detailFillProfileId)) {
      setDetailFillProfileId(null);
      setDetailFillProfileMode('view');
    }
  }, [fillProfiles, detailFillProfileId]);

  useEffect(() => {
    if (!folderContextMenu) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setFolderContextMenu(null);
      }
    }

    function closeMenu() {
      setFolderContextMenu(null);
    }

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', closeMenu);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', closeMenu);
    };
  }, [folderContextMenu]);

  useEffect(() => {
    if (!itemContextMenu) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setItemContextMenu(null);
      }
    }

    function closeMenu() {
      setItemContextMenu(null);
    }

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', closeMenu);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', closeMenu);
    };
  }, [itemContextMenu]);

  useEffect(() => {
    const hasClosableLayer =
      folderContextMenu || itemContextMenu || detailMoreOpen || quickCreateOpen || modal || fillImportPreview || credentialExportOpen || fillExportOpen || detailOpen;
    if (!hasClosableLayer) return;

    function handleEscape(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      event.preventDefault();

      if (folderContextMenu) {
        setFolderContextMenu(null);
        return;
      }

      if (itemContextMenu) {
        setItemContextMenu(null);
        return;
      }

      if (detailMoreOpen) {
        setDetailMoreOpen(false);
        return;
      }

      if (quickCreateOpen) {
        setQuickCreateOpen(false);
        return;
      }

      if (modal) {
        setModal(null);
        return;
      }

      if (fillImportPreview) {
        setFillImportPreview(null);
        return;
      }

      if (credentialExportOpen) {
        setCredentialExportOpen(false);
        return;
      }

      if (fillExportOpen) {
        setFillExportOpen(false);
        return;
      }

      if (detailOpen) {
        setDetailCredentialId(null);
        setDetailMode('view');
        setDetailFillProfileId(null);
        setDetailFillProfileMode('view');
        setDetailMoreOpen(false);
      }
    }

    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [folderContextMenu, itemContextMenu, detailMoreOpen, quickCreateOpen, modal, fillImportPreview, credentialExportOpen, fillExportOpen, detailOpen]);

  const allItems: VaultItem[] = useMemo(
    () => [
      ...credentials.map((credential) => ({
        kind: 'login' as const,
        id: credential.id,
        updatedAt: credential.lastUsedAt ?? credential.updatedAt,
        pinned: credential.pinned,
        credential
      })),
      ...notes.map((note) => ({
        kind: 'note' as const,
        id: note.id,
        updatedAt: note.lastUsedAt ?? note.updatedAt,
        pinned: note.pinned,
        note
      })),
      ...identities.map((identity) => ({
        kind: 'identity' as const,
        id: identity.id,
        updatedAt: identity.lastUsedAt ?? identity.updatedAt,
        pinned: identity.pinned,
        identity
      })),
      ...fillProfiles.map((fillProfile) => ({
        kind: 'fillProfile' as const,
        id: fillProfile.id,
        updatedAt: fillProfile.lastUsedAt ?? fillProfile.updatedAt,
        pinned: fillProfile.pinned,
        fillProfile
      }))
    ],
    [credentials, notes, identities, fillProfiles]
  );
  const folderOptions = useMemo(() => buildFolderOptions(folders, allItems), [folders, allItems]);
  const scopedItems = useMemo(() => {
    const items =
      section === 'folder'
        ? allItems.filter((item) => itemFolder(item) === normalizeFolderLabel(selectedFolder ?? ROOT_FOLDER_NAME))
        : section === 'logins'
        ? allItems.filter((item) => item.kind === 'login')
        : section === 'notes'
          ? allItems.filter((item) => item.kind === 'note')
          : section === 'identities'
            ? allItems.filter((item) => item.kind === 'identity' || item.kind === 'fillProfile')
            : section === 'all'
              ? allItems
              : [];

    return sortItems(items.filter((item) => matchesSearch(item, query)), sortMode);
  }, [allItems, query, section, selectedFolder, sortMode]);
  const scopedDeletedItems = useMemo(
    () => deletedItems.filter((item) => deletedItemMatchesSearch(item, query)).sort((left, right) => right.deletedAt - left.deletedAt),
    [deletedItems, query]
  );
  const security = useMemo(() => analyzeSecurity(credentials), [credentials]);

  function openSection(nextSection: DashboardSection) {
    setFolderContextMenu(null);
    setItemContextMenu(null);
    setSection(nextSection);
    if (nextSection !== 'folder') {
      setSelectedFolder(null);
    }
  }

  function openFolder(folderName: string) {
    setFolderContextMenu(null);
    setItemContextMenu(null);
    setSelectedFolder(normalizeFolderLabel(folderName));
    setSection('folder');
  }

  function openQuickModal(nextModal: NonNullable<ModalState>) {
    setFolderContextMenu(null);
    setItemContextMenu(null);
    setQuickCreateOpen(false);
    setModal(nextModal);
  }

  function folderRecordForName(folderName: string): VaultFolder {
    const normalized = normalizeFolderLabel(folderName);
    return (
      folders.find((folder) => normalizeFolderLabel(folder.name).toLowerCase() === normalized.toLowerCase()) ?? {
        id: `virtual-${normalized}`,
        name: normalized,
        createdAt: Date.now(),
        updatedAt: Date.now()
      }
    );
  }

  function openFolderContextMenu(event: MouseEvent<HTMLButtonElement>, folderName: string) {
    event.preventDefault();
    event.stopPropagation();

    const width = 208;
    const height = 248;
    setItemContextMenu(null);
    setFolderContextMenu({
      folderName: normalizeFolderLabel(folderName),
      x: Math.max(8, Math.min(window.innerWidth - width - 8, event.clientX)),
      y: Math.max(8, Math.min(window.innerHeight - height - 8, event.clientY))
    });
  }

  function openItemContextMenu(event: MouseEvent<HTMLElement>, item: VaultItem) {
    event.preventDefault();
    event.stopPropagation();

    const width = 224;
    const height = item.kind === 'login' ? 424 : 390;
    setFolderContextMenu(null);
    setItemContextMenu({
      item,
      x: Math.max(8, Math.min(window.innerWidth - width - 8, event.clientX)),
      y: Math.max(8, Math.min(window.innerHeight - height - 8, event.clientY))
    });
  }

  function ensureFolderInVault(vault: VaultPlain, folderName: string | undefined): VaultPlain {
    const normalized = normalizeFolderLabel(folderName);
    return isRootFolder(normalized) ? vault : createFolderInVault(vault, normalized);
  }

  async function saveCredential(draft: CredentialDraft, existing?: Credential) {
    if (!session) return;
    const normalizedDraftUrl = normalizeUrl(draft.url);
    const matchUrl = normalizeMatchUrl(draft.matchUrl);
    const matchDomain = matchUrl ? extractMatchDomain(matchUrl) : undefined;
    const iconUrl = toHttpIconUrl(draft.iconUrl) ?? (existing?.url === normalizedDraftUrl ? toHttpIconUrl(existing.iconUrl) : undefined) ?? getRootFaviconUrl(draft.url);
    const iconType = iconUrl ? draft.iconType ?? existing?.iconType ?? 'favicon' as const : 'default' as const;
    const formFields = normalizeDraftFormFields(draft.formFields, draft.username, draft.password);
    const nextCredential = existing
      ? {
          ...existing,
          title: draft.title.trim() || extractDomain(draft.url) || '未命名账号',
          url: normalizedDraftUrl,
          domain: extractDomain(draft.url),
          matchUrl,
          matchDomain,
          iconUrl,
          iconType,
          username: draft.username.trim(),
          password: draft.password,
          folder: draft.folder.trim() || undefined,
          notes: draft.notes.trim() || undefined,
          formFields,
          updatedAt: Date.now()
        }
      : buildCredential({
          title: draft.title.trim() || extractDomain(draft.url) || '未命名账号',
          url: draft.url,
          matchUrl,
          iconUrl,
          iconType,
          username: draft.username,
          password: draft.password,
          folder: draft.folder,
          notes: draft.notes,
          formFields,
          source: 'manual'
        });
    const nextVault = existing ? updateCredentialInVault(session.vault, nextCredential) : addCredentialToVault(session.vault, nextCredential);
    await persist(ensureFolderInVault(nextVault, draft.folder), existing ? '登录项已更新。' : '登录项已创建。');
    setModal(null);
  }

  async function saveNote(draft: NoteDraft, existing?: SecureNote) {
    if (!session) return;
    const note: SecureNote = existing
      ? { ...existing, title: draft.title.trim() || '未命名笔记', note: draft.note, folder: draft.folder.trim() || undefined, updatedAt: Date.now() }
      : {
          id: crypto.randomUUID(),
          title: draft.title.trim() || '未命名笔记',
          note: draft.note,
          folder: draft.folder.trim() || undefined,
          createdAt: Date.now(),
          updatedAt: Date.now()
        };
    const nextVault = {
        ...session.vault,
        secureNotes: existing ? notes.map((item) => (item.id === existing.id ? note : item)) : [note, ...notes]
      };
    await persist(ensureFolderInVault(nextVault, draft.folder), existing ? '保密笔记已更新。' : '保密笔记已创建。');
    setModal(null);
  }

  async function saveIdentity(draft: IdentityDraft, existing?: IdentityProfile) {
    if (!session) return;
    const identity: IdentityProfile = existing
      ? {
          ...existing,
          ...draft,
          title: draft.title.trim() || draft.fullName.trim() || '未命名身份',
          folder: draft.folder.trim() || undefined,
          updatedAt: Date.now()
        }
      : {
          id: crypto.randomUUID(),
          ...draft,
          title: draft.title.trim() || draft.fullName.trim() || '未命名身份',
          folder: draft.folder.trim() || undefined,
          createdAt: Date.now(),
          updatedAt: Date.now()
        };
    const nextVault = {
        ...session.vault,
        identities: existing ? identities.map((item) => (item.id === existing.id ? identity : item)) : [identity, ...identities]
      };
    await persist(ensureFolderInVault(nextVault, draft.folder), existing ? '个人信息已更新。' : '个人信息已创建。');
    setModal(null);
  }

  async function saveFolder(name: string, currentName?: string) {
    if (!session) return;
    const normalizedName = normalizeFolderLabel(name);
    const normalizedCurrentName = currentName ? normalizeFolderLabel(currentName) : '';

    if (currentName) {
      if (isRootFolder(normalizedCurrentName)) {
        setModal(null);
        setNotice('主目录不能重命名。');
        return;
      }

      if (normalizedName.toLowerCase() === normalizedCurrentName.toLowerCase()) {
        setModal(null);
        openFolder(normalizedCurrentName);
        return;
      }

      const nameTaken = folderOptions.some((folderName) => folderName.toLowerCase() === normalizedName.toLowerCase());
      if (nameTaken) {
        setNotice('文件夹已经存在。');
        return;
      }

      const nextVault = renameFolderInVault(session.vault, normalizedCurrentName, normalizedName);
      await persist(nextVault, isRootFolder(normalizedName) ? '文件夹内容已移动到主目录。' : '文件夹已重命名。');
      setModal(null);
      openFolder(normalizedName);
      return;
    }

    if (isRootFolder(normalizedName)) {
      setModal(null);
      openFolder(ROOT_FOLDER_NAME);
      setNotice('主目录已经存在。');
      return;
    }

    const nextVault = createFolderInVault(session.vault, normalizedName);
    await persist(nextVault, nextVault === session.vault ? '文件夹已经存在。' : '文件夹已创建。');
    setModal(null);
    openFolder(normalizedName);
  }

  async function moveFolder(folderName: string, targetFolderName: string) {
    if (!session) return;
    const source = normalizeFolderLabel(folderName);
    const target = normalizeFolderLabel(targetFolderName);

    if (isRootFolder(source)) {
      setModal(null);
      setNotice('主目录不能移动。');
      return;
    }

    if (source.toLowerCase() === target.toLowerCase()) {
      setModal(null);
      openFolder(source);
      return;
    }

    const nextVault = moveFolderContentsInVault(session.vault, source, target);
    await persist(nextVault, isRootFolder(target) ? '文件夹内容已移动到主目录。' : `文件夹内容已移动到“${target}”。`);
    setModal(null);
    openFolder(target);
  }

  async function deleteFolder(folderName: string) {
    if (!session) return;
    const normalizedFolder = normalizeFolderLabel(folderName);
    if (isRootFolder(normalizedFolder)) return;

    const count = folderItemCount(normalizedFolder, allItems);
    const message = count
      ? `删除文件夹“${normalizedFolder}”？里面的 ${count} 个项目会移回主目录，不会删除账号密码。`
      : `删除空文件夹“${normalizedFolder}”？`;

    if (!window.confirm(message)) return;

    const nextVault = deleteFolderFromVault(session.vault, normalizedFolder);
    await persist(nextVault, count ? '文件夹已删除，项目已移回主目录。' : '文件夹已删除。');
    setFolderContextMenu(null);

    if (section === 'folder' && normalizeFolderLabel(selectedFolder ?? ROOT_FOLDER_NAME).toLowerCase() === normalizedFolder.toLowerCase()) {
      openFolder(ROOT_FOLDER_NAME);
    }
  }

  async function moveItemToFolder(item: VaultItem, folderName: string) {
    if (!session) return;
    const normalizedFolder = normalizeFolderLabel(folderName);
    const nextVault = moveVaultEntryToFolder(session.vault, vaultItemToMoveKind(item), item.id, normalizedFolder);
    await persist(nextVault, `已移动到“${normalizedFolder}”。`);
    setModal(null);
    openFolder(normalizedFolder);
  }

  async function deleteItem(item: VaultItem) {
    if (!session) return;
    if (!window.confirm(`将“${itemName(item)}”移到回收站？之后可以在回收站恢复。`)) return;

    setItemContextMenu(null);
    const nextVault =
      item.kind === 'login'
        ? deleteCredentialFromVault(session.vault, item.id)
        : item.kind === 'note'
          ? deleteSecureNoteFromVault(session.vault, item.id)
          : item.kind === 'fillProfile'
            ? deleteFillProfileFromVault(session.vault, item.id)
            : deleteIdentityFromVault(session.vault, item.id);
    await persist(nextVault, '项目已移到回收站。');
  }

  function viewVaultItem(item: VaultItem) {
    setItemContextMenu(null);
    if (item.kind === 'login') openCredentialDetail(item.credential);
    if (item.kind === 'fillProfile') openFillProfileDetail(item.fillProfile);
    if (item.kind === 'identity') setModal({ type: 'identity', identity: item.identity });
    if (item.kind === 'note') setModal({ type: 'note', note: item.note });
  }

  function editVaultItem(item: VaultItem) {
    setItemContextMenu(null);
    if (item.kind === 'login') openCredentialDetail(item.credential, 'edit');
    if (item.kind === 'note') setModal({ type: 'note', note: item.note });
    if (item.kind === 'identity') setModal({ type: 'identity', identity: item.identity });
    if (item.kind === 'fillProfile') openFillProfileDetail(item.fillProfile, 'edit');
  }

  function copyAllVaultItemFields(item: VaultItem) {
    setItemContextMenu(null);
    void copyText(vaultItemClipboardText(item), itemName(item), setNotice);
  }

  async function cloneVaultItem(item: VaultItem) {
    if (!session) return;
    setItemContextMenu(null);

    if (item.kind === 'login') {
      await cloneCredential(item.credential);
      return;
    }

    const now = Date.now();
    if (item.kind === 'fillProfile') {
      const clonedProfile: FillProfile = {
        ...item.fillProfile,
        id: crypto.randomUUID(),
        title: `${item.fillProfile.title} - 副本`,
        pinned: false,
        createdAt: now,
        updatedAt: now,
        lastUsedAt: undefined,
        fields: item.fillProfile.fields.map((field) => ({ ...field })),
        siteBindings: item.fillProfile.siteBindings?.map((binding) => ({
          ...binding,
          id: crypto.randomUUID(),
          fields: binding.fields.map((field) => ({ ...field })),
          createdAt: now,
          updatedAt: now
        }))
      };
      await persist(ensureFolderInVault({ ...session.vault, fillProfiles: [clonedProfile, ...fillProfiles] }, clonedProfile.folder), '个人信息副本已创建。');
      openFillProfileDetail(clonedProfile);
      return;
    }

    if (item.kind === 'identity') {
      const clonedIdentity: IdentityProfile = {
        ...item.identity,
        id: crypto.randomUUID(),
        title: `${item.identity.title} - 副本`,
        pinned: false,
        createdAt: now,
        updatedAt: now,
        lastUsedAt: undefined
      };
      await persist(ensureFolderInVault({ ...session.vault, identities: [clonedIdentity, ...identities] }, clonedIdentity.folder), '个人信息副本已创建。');
      setModal({ type: 'identity', identity: clonedIdentity });
      return;
    }

    const clonedNote: SecureNote = {
      ...item.note,
      id: crypto.randomUUID(),
      title: `${item.note.title} - 副本`,
      pinned: false,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: undefined
    };
    await persist(ensureFolderInVault({ ...session.vault, secureNotes: [clonedNote, ...notes] }, clonedNote.folder), '保密笔记副本已创建。');
    setModal({ type: 'note', note: clonedNote });
  }

  async function togglePinnedVaultItem(item: VaultItem) {
    if (!session) return;
    setItemContextMenu(null);

    if (item.kind === 'login') {
      await togglePinnedCredential(item.credential);
      return;
    }

    const pinned = !item.pinned;
    const updatedAt = Date.now();
    const message = pinned ? '已添加到固定栏。' : '已从固定栏移除。';

    if (item.kind === 'fillProfile') {
      await persist(updateFillProfileInVault(session.vault, { ...item.fillProfile, pinned, updatedAt }), message);
      return;
    }

    if (item.kind === 'identity') {
      await persist({ ...session.vault, identities: identities.map((identity) => (identity.id === item.id ? { ...identity, pinned, updatedAt } : identity)) }, message);
      return;
    }

    await persist({ ...session.vault, secureNotes: notes.map((note) => (note.id === item.id ? { ...note, pinned, updatedAt } : note)) }, message);
  }

  function openCredentialDetail(credential: Credential, mode: DetailMode = 'view') {
    setDetailCredentialId(credential.id);
    setDetailMode(mode);
    setDetailFillProfileId(null);
    setDetailFillProfileMode('view');
    setDetailMoreOpen(false);
  }

  function openFillProfileDetail(profile: FillProfile, mode: DetailMode = 'view') {
    setDetailFillProfileId(profile.id);
    setDetailFillProfileMode(mode);
    setDetailCredentialId(null);
    setDetailMode('view');
    setDetailMoreOpen(false);
  }

  function closeDetailPane() {
    setDetailCredentialId(null);
    setDetailMode('view');
    setDetailFillProfileId(null);
    setDetailFillProfileMode('view');
    setDetailMoreOpen(false);
    setItemContextMenu(null);
  }

  async function saveCredentialNotes(credential: Credential, noteText: string) {
    if (!session) return;
    const nextCredential = {
      ...credential,
      notes: noteText.trim() || undefined,
      updatedAt: Date.now()
    };
    await persist(updateCredentialInVault(session.vault, nextCredential), '备注已更新。');
  }

  async function saveFillProfile(profile: FillProfile) {
    if (!session) return;
    const nextProfile = {
      ...profile,
      title: profile.title.trim() || fillProfileSummary(profile) || '未命名个人信息',
      countryCode: profile.countryCode.trim().toUpperCase() || 'US',
      folder: profile.folder?.trim() || undefined,
      updatedAt: Date.now()
    };
    await persist(ensureFolderInVault(updateFillProfileInVault(session.vault, nextProfile), nextProfile.folder), '个人信息已更新。');
    setDetailFillProfileMode('view');
  }

  async function cloneCredential(credential: Credential) {
    if (!session) return;
    const clonedCredential = buildCredential({
      title: `${credential.title} - 副本`,
      url: credential.url,
      matchUrl: credential.matchUrl,
      iconUrl: credential.iconUrl,
      iconType: credential.iconType,
      username: credential.username,
      password: credential.password,
      notes: credential.notes,
      tags: credential.tags,
      folder: credential.folder,
      formFields: credential.formFields,
      formProfile: credential.formProfile,
      source: credential.source ?? 'manual'
    });

    await persist(addCredentialToVault(session.vault, clonedCredential), '账号副本已创建。');
    openCredentialDetail(clonedCredential);
  }

  async function togglePinnedCredential(credential: Credential) {
    if (!session) return;
    await persist(
      updateCredentialInVault(session.vault, {
        ...credential,
        pinned: !credential.pinned,
        updatedAt: Date.now()
      }),
      credential.pinned ? '已从固定栏移除。' : '已添加到固定栏。'
    );
    setDetailMoreOpen(false);
  }

  async function deleteCredentialFromDetail(credential: Credential) {
    if (!session) return;
    if (!window.confirm(`将“${credential.title}”移到回收站？之后可以在回收站恢复。`)) return;
    await persist(deleteCredentialFromVault(session.vault, credential.id), '账号已移到回收站。');
    setDetailCredentialId(null);
    setDetailMode('view');
    setDetailMoreOpen(false);
  }

  async function deleteFillProfileFromDetail(profile: FillProfile) {
    if (!session) return;
    if (!window.confirm(`将“${profile.title}”移到回收站？之后可以在回收站恢复。`)) return;
    await persist(deleteFillProfileFromVault(session.vault, profile.id), '个人信息已移到回收站。');
    setDetailFillProfileId(null);
    setDetailFillProfileMode('view');
  }

  async function restoreDeletedItem(item: DeletedVaultItem) {
    if (!session) return;
    const nextVault = restoreDeletedItemToVault(session.vault, item.id);
    await persist(nextVault, '项目已恢复。');

    if (item.kind === 'credential') {
      openCredentialDetail(item.item);
    }
  }

  async function purgeDeletedItem(item: DeletedVaultItem) {
    if (!session) return;
    if (!window.confirm(`永久删除“${deletedItemName(item)}”？此操作无法撤销。`)) return;
    await persist(purgeDeletedItemFromVault(session.vault, item.id), '项目已永久删除。');
  }

  async function runCredentialAction(action: CredentialAction, credential: Credential) {
    if (!session) return;

    try {
      const payload = credentialToFillPayload(credential, action === 'login');
      const response = await sendRuntimeMessage<OpenTabResult>({
        type: 'KEYPILOT_OPEN_TAB',
        action,
        credential: payload
      });

      if (!response.ok) {
        throw new Error(response.error ?? 'TAB_CREATE_FAILED');
      }

      const actionText = action === 'login' ? '已发送一键登录指令。' : action === 'fill' ? '已发送浏览并填写指令。' : '已打开网站。';
      await persist(touchCredentialInVault(session.vault, credential.id), actionText);
    } catch (error) {
      setNotice(getErrorMessage(error).replace('EXTENSION_API_UNAVAILABLE', '请在已加载的浏览器插件中测试该功能。'));
    }
  }

  async function previewFillProfileImport(file: File | undefined) {
    if (!file) return;

    setFillImportBusy(true);
    try {
      const preview = await parseFillProfileImportFile(file);
      setFillImportPreview(preview);
    } catch (error) {
      setNotice(getErrorMessage(error).replace('UNSUPPORTED_FILL_IMPORT_FILE', '仅支持 .xlsx、.csv 或 .kpfill 文件。'));
    } finally {
      setFillImportBusy(false);
      if (fillImportInputRef.current) {
        fillImportInputRef.current.value = '';
      }
    }
  }

  async function confirmFillProfileImport(preview: FillProfileImportPreview, options: FillImportOptions) {
    if (!session) return;
    const selectedProfiles = applyFillImportOptions(preview, options);
    if (!selectedProfiles.length) {
      setNotice('没有选择可导入的填表资料。');
      return;
    }

    const nextVault = addFillProfilesToVault(session.vault, selectedProfiles);
    const withFolder = selectedProfiles.reduce((vault, profile) => ensureFolderInVault(vault, profile.folder), nextVault);
    const withBatchRecord: VaultPlain = {
      ...withFolder,
      settings: {
        ...withFolder.settings,
        fillImportBatches: upsertFillImportBatchRecord(withFolder.settings.fillImportBatches, preview, options, selectedProfiles.length)
      }
    };
    await persist(withBatchRecord, `已导入 ${selectedProfiles.length} 条填表资料。下次会从第 ${options.offset + selectedProfiles.length + 1} 条继续建议。`);
    setFillImportPreview(null);
    openSection('identities');
  }

  async function startCredentialBinding(credential: Credential) {
    try {
      const response = await sendRuntimeMessage<OpenTabResult & { locked?: boolean }>({
        type: 'KEYPILOT_OPEN_AND_BIND',
        credentialId: credential.id
      });

      if (!response.ok) {
        throw new Error(response.error ?? (response.locked ? 'VAULT_LOCKED' : 'BINDING_START_FAILED'));
      }

      setNotice('已打开网站。请在网页里依次点击用户名框、密码框和登录按钮。');
    } catch (error) {
      setNotice(getErrorMessage(error).replace('EXTENSION_API_UNAVAILABLE', '请在已加载的浏览器插件中测试该功能。'));
    }
  }

  async function testCredentialBinding(credential: Credential) {
    try {
      const response = await sendRuntimeMessage<OpenTabResult & { locked?: boolean; result?: BindingTestResult }>({
        type: 'KEYPILOT_OPEN_AND_TEST_BINDING',
        credentialId: credential.id
      });

      if (!response.ok) {
        throw new Error(response.error ?? (response.locked ? 'VAULT_LOCKED' : 'BINDING_TEST_FAILED'));
      }

      setNotice('已打开网站并开始测试绑定。网页会高亮已识别的字段和登录按钮。');
    } catch (error) {
      setNotice(getErrorMessage(error).replace('EXTENSION_API_UNAVAILABLE', '请在已加载的浏览器插件中测试该功能。'));
    }
  }

  function openCredentialExportDialog() {
    if (!credentials.length) {
      setNotice('当前没有可导出的账号。');
      return;
    }

    setCredentialExportOpen(true);
  }

  function exportCredentialsCsv(selectedCredentials: Credential[]) {
    if (!selectedCredentials.length) {
      setNotice('请选择至少 1 条账号再导出。');
      return;
    }

    const confirmed = window.confirm(
      `即将导出 ${selectedCredentials.length} 条账号为 RoboForm CSV。\n\n这个 CSV 会包含明文账号和密码，请只保存在可信位置，用完后及时删除。是否继续？`
    );

    if (!confirmed) return;

    const blob = new Blob([`\uFEFF${exportRoboFormCsv(selectedCredentials)}`], { type: 'text/csv;charset=utf-8' });
    downloadBlob(blob, `keypilot-roboform-export-${timestampForFile()}.csv`);
    setCredentialExportOpen(false);
    setNotice(`已导出 ${selectedCredentials.length} 条账号。CSV 包含明文密码，请妥善处理。`);
  }

  function openFillProfileExportDialog() {
    if (!fillProfiles.length) {
      setNotice('当前没有可导出的填表资料。');
      return;
    }

    setFillExportOpen(true);
  }

  function exportFillProfilesFile(selectedProfiles: FillProfile[]) {
    if (!selectedProfiles.length) {
      setNotice('请选择至少 1 条资料再导出。');
      return;
    }

    const confirmed = window.confirm(
      `即将导出 ${selectedProfiles.length} 条身份ID/填表资料为 KeyPilot .kpfill 文件。\n\n这个文件会包含资料字段值，可能包括 SSN、CVV、EIN、银行账号等敏感信息。请只发给可信的人，是否继续？`
    );

    if (!confirmed) return;

    const blob = new Blob([exportFillProfilesKpFill(selectedProfiles)], { type: 'application/json;charset=utf-8' });
    downloadBlob(blob, `keypilot-fill-profiles-${timestampForFile()}.kpfill`);
    setFillExportOpen(false);
    setNotice(`已导出 ${selectedProfiles.length} 条填表资料为 .kpfill 文件。`);
  }

  if (status !== 'unlocked' || !session) {
    return (
      <main className="vault-auth">
        <form onSubmit={handleAuth}>
          <img src="icons/icon128.png" alt="" />
          <h1>{status === 'setup' ? '创建 KeyPilot Vault' : status === 'locked' ? '解锁 KeyPilot Vault' : '正在检查 Vault'}</h1>
          <p>本地加密保存账号、笔记和身份资料。</p>
          {status !== 'checking' ? (
            <>
              <label>
                <span>主密码</span>
                <input
                  type="password"
                  value={masterPassword}
                  onChange={(event) => setMasterPassword(event.target.value)}
                  autoFocus
                  minLength={6}
                  required
                />
              </label>
              <button type="submit">{status === 'setup' ? '创建 Vault' : '解锁'}</button>
            </>
          ) : null}
          {notice ? <strong>{notice}</strong> : null}
        </form>
      </main>
    );
  }

  return (
    <main className={detailOpen ? 'vault-shell detail-open' : 'vault-shell'}>
      <aside className="vault-sidebar">
        <div className="vault-brand">
          <img src="icons/icon128.png" alt="" />
          <strong>KeyPilot</strong>
        </div>
        <SidebarButton
          icon={<Home size={18} />}
          label="主目录"
          count={folderItemCount(ROOT_FOLDER_NAME, allItems)}
          active={section === 'folder' && selectedFolder === ROOT_FOLDER_NAME}
          onClick={() => openFolder(ROOT_FOLDER_NAME)}
        />
        <div className="sidebar-group">
          <SidebarButton icon={<List size={18} />} label="所有" count={allItems.length} active={section === 'all'} onClick={() => openSection('all')} />
          <SidebarButton icon={<Lock size={18} />} label="登录" count={credentials.length} active={section === 'logins'} onClick={() => openSection('logins')} />
          <SidebarButton icon={<NotebookText size={18} />} label="保密笔记本" count={notes.length} active={section === 'notes'} onClick={() => openSection('notes')} />
        </div>
        <div className="sidebar-folder-group">
          <header>
            <span>文件夹</span>
            <button type="button" aria-label="新建文件夹" title="新建文件夹" onClick={() => openQuickModal({ type: 'folder' })}>
              <Plus size={15} />
            </button>
          </header>
          <div>
            {folderOptions
              .filter((folderName) => folderName !== ROOT_FOLDER_NAME)
              .map((folderName) => (
                <SidebarButton
                  key={folderName}
                  icon={<FolderOpen size={18} />}
                  label={folderName}
                  count={folderItemCount(folderName, allItems)}
                  active={section === 'folder' && selectedFolder === folderName}
                  onClick={() => openFolder(folderName)}
                  onContextMenu={(event) => openFolderContextMenu(event, folderName)}
                />
              ))}
          </div>
        </div>
        <div className="sidebar-group">
          <SidebarButton icon={<IdCard size={18} />} label="个人信息" count={identities.length + fillProfiles.length} active={section === 'identities'} onClick={() => openSection('identities')} />
          <SidebarButton icon={<Wand2 size={18} />} label="密码生成器" active={section === 'generator'} onClick={() => openSection('generator')} />
          <SidebarButton icon={<ShieldCheck size={18} />} label="身份验证器" active={section === 'authenticator'} onClick={() => openSection('authenticator')} />
          <SidebarButton icon={<Shield size={18} />} label="安全中心" active={section === 'security'} onClick={() => openSection('security')} />
          <SidebarButton icon={<Users size={18} />} label="共享中心" active={section === 'sharing'} onClick={() => openSection('sharing')} />
          <SidebarButton icon={<ShieldAlert size={18} />} label="紧急访问" active={section === 'emergency'} onClick={() => openSection('emergency')} />
          <SidebarButton icon={<Trash2 size={18} />} label="回收站" count={deletedItems.length} active={section === 'trash'} onClick={() => openSection('trash')} />
        </div>
        <button className="sidebar-help" type="button" onClick={() => openExtensionUrl('options.html')}>
          <HelpCircle size={18} />
          <span>设置与帮助</span>
        </button>
      </aside>

      {folderContextMenu ? (
        <FolderContextMenu
          menu={folderContextMenu}
          count={folderItemCount(folderContextMenu.folderName, allItems)}
          onClose={() => setFolderContextMenu(null)}
          onNewFolder={() => openQuickModal({ type: 'folder' })}
          onRename={() => openQuickModal({ type: 'folder', folder: folderRecordForName(folderContextMenu.folderName) })}
          onMove={() => openQuickModal({ type: 'moveFolder', folderName: folderContextMenu.folderName })}
          onDelete={() => {
            const { folderName } = folderContextMenu;
            setFolderContextMenu(null);
            void deleteFolder(folderName);
          }}
          onShare={() => {
            setFolderContextMenu(null);
            setNotice('共享文件夹需要同步和权限能力，后续版本会支持。');
          }}
        />
      ) : null}

      {itemContextMenu ? (
        <VaultItemContextMenu
          menu={itemContextMenu}
          onClose={() => setItemContextMenu(null)}
          onView={viewVaultItem}
          onEdit={editVaultItem}
          onMove={(item) => openQuickModal({ type: 'move', item })}
          onClone={(item) => void cloneVaultItem(item)}
          onCopyAll={copyAllVaultItemFields}
          onTogglePinned={(item) => void togglePinnedVaultItem(item)}
          onDelete={(item) => void deleteItem(item)}
          onCredentialAction={(action, credential) => void runCredentialAction(action, credential)}
          onOpenTrash={() => openSection('trash')}
          onShare={(item) => setNotice(`“${itemName(item)}”的分享功能需要同步与权限能力，后续版本会支持。`)}
          onSend={(item) => setNotice(`“${itemName(item)}”的发送功能需要安全导出流程，后续版本会支持。`)}
        />
      ) : null}

      <section className="vault-workspace">
        <header className="vault-topbar">
          <label className="vault-search">
            <Search size={18} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="在 KeyPilot 中搜索" />
            <SlidersHorizontal size={18} />
          </label>
          <button type="button" aria-label="选择导出账号 CSV" title="选择导出账号 CSV" onClick={openCredentialExportDialog}>
            <Download size={19} />
          </button>
          <button type="button" aria-label="刷新" onClick={() => void boot()}>
            <RefreshCw size={19} />
          </button>
          <button type="button" aria-label="帮助" onClick={() => openExtensionUrl('options.html')}>
            <HelpCircle size={19} />
          </button>
          <div className="vault-user">
            <UserCircle size={21} />
            <span>leon@local</span>
          </div>
          <input
            ref={fillImportInputRef}
            className="vault-hidden-file"
            type="file"
            accept=".xlsx,.csv,.kpfill,.json"
            onChange={(event) => void previewFillProfileImport(event.currentTarget.files?.[0])}
          />
        </header>

        {section === 'generator' ? (
          <GeneratorPanel onCopy={(password) => void copyText(password, '密码', setNotice)} />
        ) : section === 'security' ? (
          <SecurityPanel security={security} />
        ) : section === 'trash' ? (
          <TrashPanel items={scopedDeletedItems} onRestore={(item) => void restoreDeletedItem(item)} onPurge={(item) => void purgeDeletedItem(item)} />
        ) : section === 'authenticator' || section === 'sharing' || section === 'emergency' ? (
          <PlaceholderPanel section={section} />
        ) : (
          <VaultList
            section={section}
            title={section === 'folder' ? normalizeFolderLabel(selectedFolder ?? ROOT_FOLDER_NAME) : SECTION_LABELS[section]}
            items={scopedItems}
            sortMode={sortMode}
            viewMode={viewMode}
            onSort={setSortMode}
            onViewMode={setViewMode}
            onNewLogin={() => openQuickModal({ type: 'login', folder: section === 'folder' ? normalizeFolderLabel(selectedFolder ?? ROOT_FOLDER_NAME) : undefined })}
            onNewNote={() => openQuickModal({ type: 'note' })}
            onNewIdentity={() => openQuickModal({ type: 'identity' })}
            onImportFillProfiles={section === 'identities' ? () => fillImportInputRef.current?.click() : undefined}
            onExportFillProfiles={section === 'identities' ? openFillProfileExportDialog : undefined}
            importingFillProfiles={fillImportBusy}
            activeContextItemId={itemContextMenu ? `${itemContextMenu.item.kind}-${itemContextMenu.item.id}` : null}
            onItemContextMenu={openItemContextMenu}
            onEdit={editVaultItem}
            onDelete={(item) => void deleteItem(item)}
            onMove={(item) => openQuickModal({ type: 'move', item })}
            onCopy={(label, value) => void copyText(value, label, setNotice)}
            onCredentialAction={(action, credential) => void runCredentialAction(action, credential)}
            onOpenDetail={viewVaultItem}
          />
        )}
      </section>

      {detailCredential && detailMode === 'edit' ? (
        <CredentialEditPane
          credential={detailCredential}
          onClose={() => {
            setDetailCredentialId(null);
            setDetailMode('view');
            setDetailMoreOpen(false);
          }}
          onCancel={() => {
            setDetailMode('view');
            setDetailMoreOpen(false);
          }}
          onSave={(draft, existing) => {
            void saveCredential(draft, existing)
              .then(() => {
                setDetailMode('view');
                setDetailMoreOpen(false);
              })
              .catch((error) => setNotice(getErrorMessage(error)));
          }}
          onBindFromWeb={(credential) => void startCredentialBinding(credential)}
        />
      ) : detailCredential ? (
        <CredentialDetailPane
          credential={detailCredential}
          moreOpen={detailMoreOpen}
          onClose={() => {
            setDetailCredentialId(null);
            setDetailMode('view');
            setDetailMoreOpen(false);
          }}
          onEdit={(credential) => openCredentialDetail(credential, 'edit')}
          onToggleMore={() => setDetailMoreOpen((open) => !open)}
          onAction={(action, credential) => void runCredentialAction(action, credential)}
          onSaveNotes={(credential, notesText) => void saveCredentialNotes(credential, notesText)}
          onCopy={(label, value) => void copyText(value, label, setNotice)}
          onClone={(credential) => void cloneCredential(credential)}
          onTogglePinned={(credential) => void togglePinnedCredential(credential)}
          onDelete={(credential) => void deleteCredentialFromDetail(credential)}
          onBindFromWeb={(credential) => void startCredentialBinding(credential)}
          onTestBinding={(credential) => void testCredentialBinding(credential)}
          onMoveToFolder={(credential) => {
            setDetailMoreOpen(false);
            openQuickModal({ type: 'move', item: { kind: 'login', id: credential.id, updatedAt: credential.updatedAt, pinned: credential.pinned, credential } });
          }}
          onOpenTrash={() => {
            openSection('trash');
            setDetailMoreOpen(false);
          }}
        />
      ) : detailFillProfile && detailFillProfileMode === 'edit' ? (
        <FillProfileEditPane
          profile={detailFillProfile}
          folders={folderOptions}
          onClose={closeDetailPane}
          onCancel={() => setDetailFillProfileMode('view')}
          onSave={(profile) => void saveFillProfile(profile)}
        />
      ) : detailFillProfile ? (
        <FillProfileDetailPane
          profile={detailFillProfile}
          onClose={closeDetailPane}
          onEdit={(profile) => openFillProfileDetail(profile, 'edit')}
          onCopy={(label, value) => void copyText(value, label, setNotice)}
          onDelete={(profile) => void deleteFillProfileFromDetail(profile)}
        />
      ) : null}

      {fillImportPreview ? (
        <FillImportPreviewDialog
          preview={fillImportPreview}
          batchRecord={session.vault.settings.fillImportBatches?.find((record) => record.sourceKey === fillImportSourceKey(fillImportPreview))}
          onClose={() => setFillImportPreview(null)}
          onConfirm={(options) => void confirmFillProfileImport(fillImportPreview, options)}
        />
      ) : null}

      {credentialExportOpen ? (
        <CredentialExportDialog
          credentials={credentials}
          onClose={() => setCredentialExportOpen(false)}
          onConfirm={exportCredentialsCsv}
        />
      ) : null}

      {fillExportOpen ? (
        <FillProfileExportDialog
          profiles={fillProfiles}
          onClose={() => setFillExportOpen(false)}
          onConfirm={exportFillProfilesFile}
        />
      ) : null}

      {section !== 'trash' ? (
        <QuickCreateMenu
          open={quickCreateOpen}
          onToggle={() => setQuickCreateOpen((open) => !open)}
          onClose={() => setQuickCreateOpen(false)}
          onNewFolder={() => openQuickModal({ type: 'folder' })}
          onNewIdentity={() => openQuickModal({ type: 'identity' })}
          onNewContact={() => openQuickModal({ type: 'contact' })}
          onNewNote={() => openQuickModal({ type: 'note' })}
          onNewLogin={() => openQuickModal({ type: 'login' })}
        />
      ) : null}
      {notice ? (
        <button className="vault-toast" type="button" onClick={() => setNotice('')}>
          {notice}
          <X size={16} />
        </button>
      ) : null}
      {modal ? (
        <ItemModal
          modal={modal}
          onClose={() => setModal(null)}
          folders={folderOptions}
          onSaveCredential={(draft, existing) => void saveCredential(draft, existing)}
          onSaveNote={(draft, existing) => void saveNote(draft, existing)}
          onSaveIdentity={(draft, existing) => void saveIdentity(draft, existing)}
          onSaveFolder={(name, currentName) => void saveFolder(name, currentName)}
          onMoveItem={(item, folderName) => void moveItemToFolder(item, folderName)}
          onMoveFolder={(folderName, targetFolderName) => void moveFolder(folderName, targetFolderName)}
        />
      ) : null}
    </main>
  );
}

function QuickCreateMenu({
  open,
  onToggle,
  onClose,
  onNewFolder,
  onNewIdentity,
  onNewContact,
  onNewNote,
  onNewLogin
}: {
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  onNewFolder: () => void;
  onNewIdentity: () => void;
  onNewContact: () => void;
  onNewNote: () => void;
  onNewLogin: () => void;
}) {
  return (
    <div className={open ? 'quick-create open' : 'quick-create'}>
      {open ? <button className="quick-create-scrim" type="button" aria-label="关闭新建菜单" onClick={onClose} /> : null}
      {open ? (
        <div className="quick-create-menu" role="menu" aria-label="新建项目">
          <button type="button" role="menuitem" onClick={onNewFolder}>
            <FolderOpen size={22} />
            <span>文件夹</span>
          </button>
          <button type="button" role="menuitem" onClick={onNewIdentity}>
            <IdCard size={22} />
            <span>个人信息</span>
          </button>
          <button type="button" role="menuitem" onClick={onNewContact}>
            <Users size={22} />
            <span>联系人</span>
          </button>
          <button type="button" role="menuitem" onClick={onNewNote}>
            <FileText size={22} />
            <span>保密笔记本</span>
          </button>
          <button type="button" role="menuitem" onClick={onNewLogin}>
            <Lock size={22} />
            <span>登录</span>
          </button>
        </div>
      ) : null}
      <button className="vault-fab" type="button" aria-label={open ? '关闭新建菜单' : '新建'} aria-expanded={open} onClick={onToggle}>
        {open ? <X size={30} /> : <Plus size={30} />}
      </button>
    </div>
  );
}

function SidebarButton({
  icon,
  label,
  count,
  active,
  onClick,
  onContextMenu
}: {
  icon: ReactNode;
  label: string;
  count?: number;
  active: boolean;
  onClick: () => void;
  onContextMenu?: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button className={active ? 'active' : ''} type="button" onClick={onClick} onContextMenu={onContextMenu}>
      {icon}
      <span>{label}</span>
      {typeof count === 'number' ? <small>{count}</small> : null}
    </button>
  );
}

function FolderContextMenu({
  menu,
  count,
  onClose,
  onNewFolder,
  onRename,
  onMove,
  onDelete,
  onShare
}: {
  menu: NonNullable<FolderContextMenuState>;
  count: number;
  onClose: () => void;
  onNewFolder: () => void;
  onRename: () => void;
  onMove: () => void;
  onDelete: () => void;
  onShare: () => void;
}) {
  function run(action: () => void) {
    action();
  }

  return (
    <div className="folder-context-layer" role="presentation">
      <button className="folder-context-scrim" type="button" aria-label="关闭文件夹菜单" onClick={onClose} />
      <div className="folder-context-menu" role="menu" aria-label={`${menu.folderName} 文件夹操作`} style={{ left: menu.x, top: menu.y }}>
        <button type="button" role="menuitem" onClick={() => run(onNewFolder)}>
          <FolderPlus size={18} />
          <span>新建文件夹</span>
        </button>
        <button type="button" role="menuitem" onClick={() => run(onRename)}>
          <Pencil size={18} />
          <span>重命名</span>
        </button>
        <button type="button" role="menuitem" onClick={() => run(onMove)}>
          <MoveRight size={18} />
          <span>移动</span>
        </button>
        <button className="danger" type="button" role="menuitem" onClick={() => run(onDelete)}>
          <Trash2 size={18} />
          <span>{count ? '删除并移回主目录' : '删除'}</span>
        </button>
        <hr />
        <button type="button" role="menuitem" onClick={() => run(onShare)}>
          <Share2 size={18} />
          <span>共享文件夹</span>
        </button>
      </div>
    </div>
  );
}

function VaultItemContextMenu({
  menu,
  onClose,
  onView,
  onEdit,
  onMove,
  onClone,
  onCopyAll,
  onTogglePinned,
  onDelete,
  onCredentialAction,
  onOpenTrash,
  onShare,
  onSend
}: {
  menu: NonNullable<ItemContextMenuState>;
  onClose: () => void;
  onView: (item: VaultItem) => void;
  onEdit: (item: VaultItem) => void;
  onMove: (item: VaultItem) => void;
  onClone: (item: VaultItem) => void | Promise<void>;
  onCopyAll: (item: VaultItem) => void;
  onTogglePinned: (item: VaultItem) => void | Promise<void>;
  onDelete: (item: VaultItem) => void | Promise<void>;
  onCredentialAction: (action: CredentialAction, credential: Credential) => void;
  onOpenTrash: () => void;
  onShare: (item: VaultItem) => void;
  onSend: (item: VaultItem) => void;
}) {
  const item = menu.item;

  function run(action: () => void | Promise<void>) {
    onClose();
    void action();
  }

  return (
    <div className="folder-context-layer" role="presentation">
      <button className="folder-context-scrim" type="button" aria-label="关闭项目菜单" onClick={onClose} />
      <div className="vault-item-context-menu" role="menu" aria-label={`${itemName(item)} 操作菜单`} style={{ left: menu.x, top: menu.y }}>
        {item.kind === 'login' ? (
          <>
            <button className="primary" type="button" role="menuitem" onClick={() => run(() => onCredentialAction('login', item.credential))}>
              <CirclePlay size={18} />
              <span>登录</span>
            </button>
            <button type="button" role="menuitem" onClick={() => run(() => onCredentialAction('fill', item.credential))}>
              <FileText size={18} />
              <span>浏览并填写</span>
            </button>
            <button type="button" role="menuitem" onClick={() => run(() => onCredentialAction('goto', item.credential))}>
              <ArrowUpRight size={18} />
              <span>转到</span>
            </button>
            <hr />
          </>
        ) : null}
        <button type="button" role="menuitem" onClick={() => run(() => onView(item))}>
          <Eye size={18} />
          <span>查看</span>
        </button>
        <button type="button" role="menuitem" onClick={() => run(() => onEdit(item))}>
          <Pencil size={18} />
          <span>重命名/编辑</span>
        </button>
        <button type="button" role="menuitem" onClick={() => run(() => onMove(item))}>
          <MoveRight size={18} />
          <span>移动</span>
        </button>
        <button type="button" role="menuitem" onClick={() => run(() => onClone(item))}>
          <Copy size={18} />
          <span>克隆</span>
        </button>
        <button type="button" role="menuitem" onClick={() => run(() => onCopyAll(item))}>
          <Copy size={18} />
          <span>复制所有字段</span>
        </button>
        <button type="button" role="menuitem" onClick={() => run(() => onTogglePinned(item))}>
          <Pin size={18} />
          <span>{item.pinned ? '从固定栏移除' : '添加到固定栏'}</span>
        </button>
        <button className="danger" type="button" role="menuitem" onClick={() => run(() => onDelete(item))}>
          <Trash2 size={18} />
          <span>删除</span>
        </button>
        <hr />
        <button type="button" role="menuitem" onClick={() => run(() => onShare(item))}>
          <Share2 size={18} />
          <span>分享</span>
        </button>
        <button type="button" role="menuitem" onClick={() => run(() => onSend(item))}>
          <Send size={18} />
          <span>发送</span>
        </button>
        <button type="button" role="menuitem" onClick={() => run(onOpenTrash)}>
          <Undo2 size={18} />
          <span>打开回收站</span>
        </button>
      </div>
    </div>
  );
}

function VaultList({
  section,
  title,
  items,
  sortMode,
  viewMode,
  onSort,
  onViewMode,
  onNewLogin,
  onNewNote,
  onNewIdentity,
  onImportFillProfiles,
  onExportFillProfiles,
  importingFillProfiles,
  activeContextItemId,
  onItemContextMenu,
  onEdit,
  onDelete,
  onMove,
  onCopy,
  onCredentialAction,
  onOpenDetail
}: {
  section: DashboardSection;
  title: string;
  items: VaultItem[];
  sortMode: SortMode;
  viewMode: ViewMode;
  onSort: (mode: SortMode) => void;
  onViewMode: (mode: ViewMode) => void;
  onNewLogin: () => void;
  onNewNote: () => void;
  onNewIdentity: () => void;
  onImportFillProfiles?: () => void;
  onExportFillProfiles?: () => void;
  importingFillProfiles?: boolean;
  activeContextItemId?: string | null;
  onItemContextMenu: (event: MouseEvent<HTMLElement>, item: VaultItem) => void;
  onEdit: (item: VaultItem) => void;
  onDelete: (item: VaultItem) => void;
  onMove: (item: VaultItem) => void;
  onCopy: (label: string, value: string) => void;
  onCredentialAction: (action: CredentialAction, credential: Credential) => void;
  onOpenDetail: (item: VaultItem) => void;
}) {
  const newAction = section === 'notes' ? onNewNote : section === 'identities' ? onNewIdentity : onNewLogin;
  const tableLabels = vaultTableLabels(section);
  const emptyActionLabel = section === 'folder' ? '新建登录' : '新建';

  return (
    <div className="vault-list-area">
      <div className="vault-tabs">
        <button className={sortMode === 'popular' ? 'active' : ''} type="button" onClick={() => onSort('popular')}>
          热门
        </button>
        <button className={sortMode === 'recent' ? 'active' : ''} type="button" onClick={() => onSort('recent')}>
          最近使用
        </button>
        <button className={sortMode === 'az' ? 'active' : ''} type="button" onClick={() => onSort('az')}>
          A-Z
        </button>
        <div className="vault-tab-actions">
          {section === 'identities' && onImportFillProfiles ? (
            <button className="vault-tab-action" type="button" onClick={onImportFillProfiles} disabled={importingFillProfiles}>
              <Upload size={16} />
              {importingFillProfiles ? '解析中' : '导入填表资料'}
            </button>
          ) : null}
          {section === 'identities' && onExportFillProfiles ? (
            <button className="vault-tab-action subtle" type="button" onClick={onExportFillProfiles}>
              <Download size={16} />
              选择导出 .kpfill
            </button>
          ) : null}
          <div className="view-switcher">
          <button className={viewMode === 'grid' ? 'active' : ''} type="button" aria-label="网格视图" onClick={() => onViewMode('grid')}>
            <Grid3X3 size={17} />
          </button>
          <button className={viewMode === 'compact' ? 'active' : ''} type="button" aria-label="紧凑视图" onClick={() => onViewMode('compact')}>
            <LayoutList size={17} />
          </button>
          <button className={viewMode === 'table' ? 'active' : ''} type="button" aria-label="表格视图" onClick={() => onViewMode('table')}>
            <List size={17} />
          </button>
          </div>
        </div>
      </div>
      <div className={`vault-items ${viewMode} ${section}-items`}>
        {viewMode === 'table' ? (
          <div className="vault-table-head">
            {tableLabels.map((label) => (
              <span key={label}>{label}</span>
            ))}
            <span />
          </div>
        ) : null}
        {items.length ? (
          items.map((item, index) => (
            <VaultItemRow
              key={`${item.kind}-${item.id}`}
              item={item}
              index={index}
              viewMode={viewMode}
              active={activeContextItemId === `${item.kind}-${item.id}`}
              onContextMenu={onItemContextMenu}
              onEdit={onEdit}
              onDelete={onDelete}
              onMove={onMove}
              onCopy={onCopy}
              onCredentialAction={onCredentialAction}
              onView={onOpenDetail}
            />
          ))
        ) : (
          <div className="vault-empty">
            <FileText size={34} />
            <strong>{title} 里还没有项目</strong>
            <p>创建后会加密保存到本地 Vault。</p>
            <button type="button" onClick={newAction}>
              <Plus size={17} />
              {emptyActionLabel}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function VaultItemRow({
  item,
  index,
  viewMode,
  active,
  onContextMenu,
  onEdit,
  onDelete,
  onMove,
  onCopy,
  onCredentialAction,
  onView
}: {
  item: VaultItem;
  index: number;
  viewMode: ViewMode;
  active: boolean;
  onContextMenu: (event: MouseEvent<HTMLElement>, item: VaultItem) => void;
  onEdit: (item: VaultItem) => void;
  onDelete: (item: VaultItem) => void;
  onMove: (item: VaultItem) => void;
  onCopy: (label: string, value: string) => void;
  onCredentialAction: (action: CredentialAction, credential: Credential) => void;
  onView: (item: VaultItem) => void;
}) {
  const strength = item.kind === 'login' ? measurePasswordStrength(item.credential.password) : null;
  const primaryData = itemPrimaryData(item);
  const endpoint = itemTableEndpoint(item);
  const typeLabel = itemTypeLabel(item);

  return (
    <article
      className={`vault-row ${viewMode} ${item.kind}-row${active ? ' context-active' : ''}`}
      style={{ '--row-delay': `${(index % 12) * 14}ms` } as CSSProperties}
      onContextMenu={(event) => onContextMenu(event, item)}
      onClick={(event) => {
        if ((event.target as HTMLElement).closest('button,a')) return;
        onView(item);
      }}
      onDoubleClick={() => {
        onView(item);
      }}
    >
      <span className="item-name">
        <ItemIcon item={item} />
        <span>
          <strong>{itemName(item)}</strong>
          {viewMode !== 'table' ? <small>{itemSubtitle(item)}</small> : null}
        </span>
      </span>
      <span>{itemFolder(item)}</span>
      <span title={primaryData}>{primaryData || (item.kind === 'login' ? '无用户名' : '未填写')}</span>
      <span>
        {strength ? (
          <span className={`strength s${strength.score}`}>
            <Shield size={15} />
            {strength.label}
          </span>
        ) : item.kind === 'fillProfile' ? (
          <span className="profile-type-label">{typeLabel}</span>
        ) : (
          <span className="profile-type-label subtle">{typeLabel}</span>
        )}
      </span>
      <span className="website">{endpoint}</span>
      <span className="row-actions">
        {item.kind === 'login' ? (
          <>
            <button className="login-action" type="button" title="一键登录" onClick={() => onCredentialAction('login', item.credential)}>
              <CirclePlay size={16} />
            </button>
            <button className="view-action" type="button" title="查看" onClick={() => onView(item)}>
              <Eye size={16} />
            </button>
            <button type="button" title="浏览并填写" onClick={() => onCredentialAction('fill', item.credential)}>
              <FileText size={15} />
            </button>
            <button type="button" title="复制用户名" onClick={() => onCopy('用户名', item.credential.username)}>
              <Copy size={15} />
            </button>
            <button type="button" title="复制密码" onClick={() => onCopy('密码', item.credential.password)}>
              <KeyRound size={15} />
            </button>
            <button type="button" title="仅打开网站" onClick={() => onCredentialAction('goto', item.credential)}>
              <ArrowUpRight size={15} />
            </button>
          </>
        ) : item.kind === 'note' ? (
          <button type="button" title="复制笔记" onClick={() => onCopy('笔记', item.note.note)}>
            <Copy size={15} />
          </button>
        ) : item.kind === 'fillProfile' ? (
          <>
            <button className="view-action" type="button" title="查看" onClick={() => onView(item)}>
              <Eye size={16} />
            </button>
            <button type="button" title="复制资料摘要" onClick={() => onCopy('资料摘要', fillProfileSummary(item.fillProfile))}>
              <Copy size={15} />
            </button>
          </>
        ) : (
          <button type="button" title="复制邮箱" onClick={() => onCopy('邮箱', item.identity.email ?? '')}>
            <Copy size={15} />
          </button>
        )}
        <button type="button" title="移动到文件夹" onClick={() => onMove(item)}>
          <FolderOpen size={15} />
        </button>
        <button type="button" title="编辑" onClick={() => onEdit(item)}>
          <Settings2 size={15} />
        </button>
        <button type="button" title="删除" onClick={() => onDelete(item)}>
          <Trash2 size={15} />
        </button>
      </span>
    </article>
  );
}

function ItemIcon({ item }: { item: VaultItem }) {
  if (item.kind === 'login') {
    return <SiteIcon domain={item.credential.domain} url={item.credential.url} iconUrl={item.credential.iconUrl} />;
  }

  if (item.kind === 'fillProfile') {
    return <span className={`item-kind fill ${fillProfileTone(item.fillProfile)}`}>{fillProfileBadgeText(item.fillProfile)}</span>;
  }

  if (item.kind === 'identity') {
    return <span className={`item-kind person ${identityTone(item.identity)}`}>{identityBadgeText(item.identity)}</span>;
  }

  return <span className="item-kind note"><NotebookText size={17} /></span>;
}

function DeletedItemIcon({ item }: { item: DeletedVaultItem }) {
  if (item.kind === 'credential') {
    return <SiteIcon domain={item.item.domain} url={item.item.url} iconUrl={item.item.iconUrl} />;
  }

  if (item.kind === 'fillProfile') {
    return <span className={`item-kind fill ${fillProfileTone(item.item)}`}>{fillProfileBadgeText(item.item)}</span>;
  }

  if (item.kind === 'identity') {
    return <span className={`item-kind person ${identityTone(item.item)}`}>{identityBadgeText(item.item)}</span>;
  }

  return <span className="item-kind note"><NotebookText size={17} /></span>;
}

function FillImportPreviewDialog({
  preview,
  batchRecord,
  onClose,
  onConfirm
}: {
  preview: FillProfileImportPreview;
  batchRecord?: FillImportBatchRecord;
  onClose: () => void;
  onConfirm: (options: FillImportOptions) => void;
}) {
  const recommendedCount = preview.importableRows > 1000 ? Math.min(500, preview.importableRows) : preview.importableRows;
  const initialOffset = Math.min(batchRecord?.nextOffset ?? 0, preview.importableRows);
  const initialPrefix = batchRecord?.prefix || defaultFillImportPrefix(preview.category);
  const initialNumberStart = batchRecord?.numberStart ?? initialOffset + 1;
  const [importCount, setImportCount] = useState(Math.min(recommendedCount, Math.max(0, preview.importableRows - initialOffset)));
  const [importOffset, setImportOffset] = useState(initialOffset);
  const [namePrefix, setNamePrefix] = useState(initialPrefix);
  const [numberStart, setNumberStart] = useState(initialNumberStart);
  const [numberPadding, setNumberPadding] = useState(batchRecord?.numberPadding ?? 3);
  const [importOrder, setImportOrder] = useState<FillImportOrder>(batchRecord?.order ?? 'source');
  const clampImportCount = (value: number) => Math.max(0, Math.min(preview.importableRows, Number.isFinite(value) ? Math.floor(value) : 0));
  const clampImportOffset = (value: number) => Math.max(0, Math.min(preview.importableRows, Number.isFinite(value) ? Math.floor(value) : 0));
  const effectiveCount = Math.min(importCount, Math.max(0, preview.importableRows - importOffset));
  const previewOptions: FillImportOptions = {
    offset: importOffset,
    count: effectiveCount,
    prefix: namePrefix,
    numberStart,
    numberPadding,
    order: importOrder
  };
  const shownHeaders = preview.headers.slice(0, 14);
  const hiddenHeaderCount = Math.max(0, preview.headers.length - shownHeaders.length);
  const shownSamples = applyFillImportOptions(preview, { ...previewOptions, count: Math.min(4, effectiveCount) });
  const importAll = importOffset === 0 && effectiveCount >= preview.importableRows;
  const rangeLabel = effectiveCount
    ? `将导入第 ${importOffset + 1} - ${importOffset + effectiveCount} 条资料`
    : '当前没有可导入的资料';

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="fill-import-dialog" role="dialog" aria-modal="true" aria-label="导入填表资料预览">
        <header>
          <span className="modal-glyph">
            <Upload size={23} />
          </span>
          <div>
            <h2>导入填表资料</h2>
            <p>{preview.sourceName}</p>
          </div>
          <button type="button" aria-label="关闭" onClick={onClose}>
            <X size={20} />
          </button>
        </header>

        <div className="fill-import-stats">
          <span>
            <strong>{preview.totalRows}</strong>
            总行数
          </span>
          <span>
            <strong>{preview.importableRows}</strong>
            可导入
          </span>
          <span>
            <strong>{preview.fieldCount}</strong>
            字段
          </span>
          <span>
            <strong>{preview.countryCode}</strong>
            国家
          </span>
        </div>

        <div className="fill-import-summary-card">
          <div>
            <strong>{fillProfileCategoryLabel(preview.category)}</strong>
            <p>
              已自动识别 Excel 表头并映射为网页填表字段。敏感字段只会写入本地加密 Vault，不会上传到第三方。
              {preview.importableRows > 1000 ? ' 文件较大，建议先分批导入，避免列表和弹窗变慢。' : ''}
            </p>
          </div>
          {preview.sensitiveFieldCount ? (
            <em>
              <Shield size={16} />
              {preview.sensitiveFieldCount} 个敏感字段
            </em>
          ) : (
            <em className="safe">
              <Check size={16} />
              未检测到敏感字段
            </em>
          )}
        </div>

        <section className="fill-import-limit" aria-label="导入数量">
          <div>
            <h3>分批导入</h3>
            <p>
              先导入一部分测试字段匹配，确认没问题后再继续导入剩余资料。
              {batchRecord ? ` 上次已导入到第 ${batchRecord.nextOffset} 条。` : ''}
            </p>
          </div>
          <div className="fill-import-limit-control">
            <label>
              <span>起始位置</span>
              <input
                type="number"
                min={1}
                max={Math.max(1, preview.importableRows)}
                value={Math.min(preview.importableRows, importOffset + 1)}
                onChange={(event) => {
                  const nextOffset = clampImportOffset(Number(event.currentTarget.value) - 1);
                  setImportOffset(nextOffset);
                  setImportCount((count) => Math.min(count, Math.max(0, preview.importableRows - nextOffset)));
                }}
              />
              <small>1 表示第一条</small>
            </label>
            <label>
              <span>本次导入</span>
              <input
                type="number"
                min={0}
                max={Math.max(0, preview.importableRows - importOffset)}
                value={importCount}
                onChange={(event) => setImportCount(clampImportCount(Number(event.currentTarget.value)))}
              />
              <small>/ 剩余 {Math.max(0, preview.importableRows - importOffset)} 条</small>
            </label>
            <div>
              {[100, 500, 1000]
                .filter((count) => count < Math.max(0, preview.importableRows - importOffset))
                .map((count) => (
                  <button key={count} type="button" onClick={() => setImportCount(clampImportCount(count))}>
                    {count} 条
                  </button>
                ))}
              <button type="button" onClick={() => setImportCount(Math.max(0, preview.importableRows - importOffset))}>
                剩余全部
              </button>
            </div>
          </div>
          <strong>{importAll ? '将导入全部资料' : rangeLabel}</strong>
        </section>

        <section className="fill-import-naming" aria-label="命名和排序">
          <div>
            <h3>名称和排序</h3>
            <p>导入前统一重命名，方便你把不同批次、不同来源的资料区分开。</p>
          </div>
          <div className="fill-import-name-grid">
            <label>
              <span>名称前缀</span>
              <input value={namePrefix} onChange={(event) => setNamePrefix(event.currentTarget.value)} placeholder="例如 车险_" />
            </label>
            <label>
              <span>编号从</span>
              <input type="number" min={0} value={numberStart} onChange={(event) => setNumberStart(Math.max(0, Number(event.currentTarget.value) || 0))} />
            </label>
            <label>
              <span>编号位数</span>
              <input
                type="number"
                min={1}
                max={8}
                value={numberPadding}
                onChange={(event) => setNumberPadding(Math.max(1, Math.min(8, Number(event.currentTarget.value) || 1)))}
              />
            </label>
            <label>
              <span>排序方式</span>
              <select value={importOrder} onChange={(event) => setImportOrder(event.currentTarget.value as FillImportOrder)}>
                <option value="source">按表格原顺序</option>
                <option value="reverse">按表格反向</option>
                <option value="titleAsc">按资料名称 A-Z</option>
                <option value="titleDesc">按资料名称 Z-A</option>
              </select>
            </label>
          </div>
          <strong>示例：{namePrefix ? `${namePrefix}${String(numberStart).padStart(numberPadding, '0')}` : shownSamples[0]?.title || '保留原名称'}</strong>
        </section>

        <section className="fill-import-fields" aria-label="字段映射">
          <h3>字段映射</h3>
          <div>
            {shownHeaders.map((header) => (
              <span key={`${header.column}-${header.key}`}>
                <small>{header.column}</small>
                <strong>{header.label}</strong>
              </span>
            ))}
            {hiddenHeaderCount ? <span className="more">+{hiddenHeaderCount} 个字段</span> : null}
          </div>
        </section>

        <section className="fill-import-samples" aria-label="资料预览">
          <h3>资料预览</h3>
          <div>
            {shownSamples.map((profile, index) => (
              <article key={`${profile.title}-${index}`}>
                <span className={`item-kind fill ${fillProfileTone(profile)}`}>{fillProfileBadgeText(profile)}</span>
                <div>
                  <strong>{profile.title}</strong>
                  <small>{fillProfileSummary(profile)} · {profile.fields.length} 字段</small>
                </div>
              </article>
            ))}
          </div>
        </section>

        <footer>
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button className="primary" type="button" onClick={() => onConfirm(previewOptions)} disabled={!effectiveCount}>
            <Check size={17} />
            导入 {effectiveCount} 条
          </button>
        </footer>
      </section>
    </div>
  );
}

function fillProfileExportSearchText(profile: FillProfile): string {
  return [
    profile.title,
    normalizeFolderLabel(profile.folder ?? ROOT_FOLDER_NAME),
    profile.countryCode,
    fillProfileCategoryLabel(profile.category),
    fillProfileSummary(profile),
    ...(profile.tags ?? []),
    ...profile.fields.flatMap((field) => [field.key, field.label, field.value])
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function credentialExportSearchText(credential: Credential): string {
  return [
    credential.title,
    credential.username,
    credential.domain,
    credential.matchDomain,
    credential.url,
    credential.matchUrl,
    normalizeFolderLabel(credential.folder ?? ROOT_FOLDER_NAME),
    credential.notes,
    ...(credential.tags ?? [])
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function CredentialExportDialog({
  credentials,
  onClose,
  onConfirm
}: {
  credentials: Credential[];
  onClose: () => void;
  onConfirm: (credentials: Credential[]) => void;
}) {
  const [query, setQuery] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>(() => credentials.map((credential) => credential.id));
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const normalizedQuery = query.trim().toLowerCase();
  const filteredCredentials = useMemo(
    () => credentials.filter((credential) => !normalizedQuery || credentialExportSearchText(credential).includes(normalizedQuery)),
    [credentials, normalizedQuery]
  );
  const visibleCredentials = filteredCredentials.slice(0, 260);
  const hiddenFilteredCount = Math.max(0, filteredCredentials.length - visibleCredentials.length);
  const selectedCredentials = credentials.filter((credential) => selectedSet.has(credential.id));
  const selectedDomainCount = new Set(selectedCredentials.map((credential) => credential.domain || extractDomain(credential.url)).filter(Boolean)).size;
  const selectedPasswordCount = selectedCredentials.filter((credential) => credential.password).length;
  const selectedWeakCount = selectedCredentials.filter((credential) => measurePasswordStrength(credential.password).score <= 1).length;
  const filteredSelectedCount = filteredCredentials.filter((credential) => selectedSet.has(credential.id)).length;
  const allFilteredSelected = filteredCredentials.length > 0 && filteredSelectedCount === filteredCredentials.length;

  useEffect(() => {
    setSelectedIds((currentIds) => currentIds.filter((id) => credentials.some((credential) => credential.id === id)));
  }, [credentials]);

  function toggleCredential(credentialId: string) {
    setSelectedIds((currentIds) => (
      currentIds.includes(credentialId) ? currentIds.filter((id) => id !== credentialId) : [...currentIds, credentialId]
    ));
  }

  function toggleFilteredCredentials() {
    const filteredIds = new Set(filteredCredentials.map((credential) => credential.id));
    setSelectedIds((currentIds) => {
      if (allFilteredSelected) {
        return currentIds.filter((id) => !filteredIds.has(id));
      }

      const nextIds = new Set(currentIds);
      filteredCredentials.forEach((credential) => nextIds.add(credential.id));
      return [...nextIds];
    });
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="fill-export-dialog" role="dialog" aria-modal="true" aria-label="选择要导出的账号">
        <header>
          <span className="modal-glyph">
            <KeyRound size={23} />
          </span>
          <div>
            <h2>选择导出账号</h2>
            <p>导出为 RoboForm CSV，只包含你勾选的账号和密码。</p>
          </div>
          <button type="button" aria-label="关闭" onClick={onClose}>
            <X size={20} />
          </button>
        </header>

        <div className="fill-export-toolbar">
          <label>
            <Search size={18} />
            <input value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="搜索账号、网站、用户名、文件夹" />
          </label>
          <div>
            <button type="button" onClick={toggleFilteredCredentials} disabled={!filteredCredentials.length}>
              {allFilteredSelected ? '取消筛选结果' : '全选筛选结果'}
            </button>
            <button type="button" onClick={() => setSelectedIds([])} disabled={!selectedIds.length}>
              清空
            </button>
          </div>
        </div>

        <div className="fill-export-summary" aria-live="polite">
          <span>
            <strong>{selectedCredentials.length}</strong>
            已选择
          </span>
          <span>
            <strong>{selectedDomainCount}</strong>
            网站
          </span>
          <span>
            <strong>{selectedPasswordCount}</strong>
            含密码
          </span>
          <span>
            <strong>{filteredCredentials.length}</strong>
            当前匹配
          </span>
        </div>

        <div className="fill-export-list" role="group" aria-label="账号列表">
          {visibleCredentials.map((credential) => {
            const checked = selectedSet.has(credential.id);
            const folder = normalizeFolderLabel(credential.folder ?? ROOT_FOLDER_NAME);
            const domain = credential.domain || extractDomain(credential.url);
            const strength = measurePasswordStrength(credential.password);

            return (
              <label key={credential.id} className={checked ? 'selected' : ''}>
                <input type="checkbox" checked={checked} onChange={() => toggleCredential(credential.id)} />
                <SiteIcon domain={domain || credential.title} url={credential.url} iconUrl={credential.iconUrl} />
                <span>
                  <strong>{credential.title}</strong>
                  <small>{credential.username || '无用户名'}</small>
                </span>
                <em>{folder}</em>
                <small>{domain || '本地账号'} · {credential.password ? strength.label : '无密码'}</small>
              </label>
            );
          })}

          {!visibleCredentials.length ? (
            <div className="fill-export-empty">
              <KeyRound size={30} />
              <strong>没有匹配的账号</strong>
              <p>换一个关键词，或者清空搜索后重新选择。</p>
            </div>
          ) : null}

          {hiddenFilteredCount ? (
            <div className="fill-export-more">
              还有 {hiddenFilteredCount} 条匹配账号未显示，继续输入关键词可以缩小范围。
            </div>
          ) : null}
        </div>

        <footer>
          <p>
            CSV 会包含明文账号和密码。{selectedWeakCount ? `当前选择里有 ${selectedWeakCount} 条弱密码，` : ''}
            请只保存在可信位置，用完后及时删除。
          </p>
          <div>
            <button type="button" onClick={onClose}>
              取消
            </button>
            <button className="primary" type="button" onClick={() => onConfirm(selectedCredentials)} disabled={!selectedCredentials.length}>
              <Download size={17} />
              导出 {selectedCredentials.length} 条
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}

function FillProfileExportDialog({
  profiles,
  onClose,
  onConfirm
}: {
  profiles: FillProfile[];
  onClose: () => void;
  onConfirm: (profiles: FillProfile[]) => void;
}) {
  const [query, setQuery] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>(() => profiles.map((profile) => profile.id));
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const normalizedQuery = query.trim().toLowerCase();
  const filteredProfiles = useMemo(
    () => profiles.filter((profile) => !normalizedQuery || fillProfileExportSearchText(profile).includes(normalizedQuery)),
    [profiles, normalizedQuery]
  );
  const visibleProfiles = filteredProfiles.slice(0, 260);
  const hiddenFilteredCount = Math.max(0, filteredProfiles.length - visibleProfiles.length);
  const selectedProfiles = profiles.filter((profile) => selectedSet.has(profile.id));
  const selectedSensitiveCount = selectedProfiles.reduce((sum, profile) => sum + profile.fields.filter((field) => field.sensitivity !== 'normal').length, 0);
  const selectedFieldCount = selectedProfiles.reduce((sum, profile) => sum + profile.fields.length, 0);
  const filteredSelectedCount = filteredProfiles.filter((profile) => selectedSet.has(profile.id)).length;
  const allFilteredSelected = filteredProfiles.length > 0 && filteredSelectedCount === filteredProfiles.length;

  useEffect(() => {
    setSelectedIds((currentIds) => currentIds.filter((id) => profiles.some((profile) => profile.id === id)));
  }, [profiles]);

  function toggleProfile(profileId: string) {
    setSelectedIds((currentIds) => (
      currentIds.includes(profileId) ? currentIds.filter((id) => id !== profileId) : [...currentIds, profileId]
    ));
  }

  function toggleFilteredProfiles() {
    const filteredIds = new Set(filteredProfiles.map((profile) => profile.id));
    setSelectedIds((currentIds) => {
      if (allFilteredSelected) {
        return currentIds.filter((id) => !filteredIds.has(id));
      }

      const nextIds = new Set(currentIds);
      filteredProfiles.forEach((profile) => nextIds.add(profile.id));
      return [...nextIds];
    });
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="fill-export-dialog" role="dialog" aria-modal="true" aria-label="选择要导出的填表资料">
        <header>
          <span className="modal-glyph">
            <Download size={23} />
          </span>
          <div>
            <h2>选择导出资料</h2>
            <p>只会导出你勾选的身份ID/填表资料，文件格式为 KeyPilot .kpfill。</p>
          </div>
          <button type="button" aria-label="关闭" onClick={onClose}>
            <X size={20} />
          </button>
        </header>

        <div className="fill-export-toolbar">
          <label>
            <Search size={18} />
            <input value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="搜索名称、文件夹、国家、字段内容" />
          </label>
          <div>
            <button type="button" onClick={toggleFilteredProfiles} disabled={!filteredProfiles.length}>
              {allFilteredSelected ? '取消筛选结果' : '全选筛选结果'}
            </button>
            <button type="button" onClick={() => setSelectedIds([])} disabled={!selectedIds.length}>
              清空
            </button>
          </div>
        </div>

        <div className="fill-export-summary" aria-live="polite">
          <span>
            <strong>{selectedProfiles.length}</strong>
            已选择
          </span>
          <span>
            <strong>{selectedFieldCount}</strong>
            字段
          </span>
          <span>
            <strong>{selectedSensitiveCount}</strong>
            敏感字段
          </span>
          <span>
            <strong>{filteredProfiles.length}</strong>
            当前匹配
          </span>
        </div>

        <div className="fill-export-list" role="group" aria-label="填表资料列表">
          {visibleProfiles.map((profile) => {
            const checked = selectedSet.has(profile.id);
            const folder = normalizeFolderLabel(profile.folder ?? ROOT_FOLDER_NAME);
            return (
              <label key={profile.id} className={checked ? 'selected' : ''}>
                <input type="checkbox" checked={checked} onChange={() => toggleProfile(profile.id)} />
                <span className={`item-kind fill ${fillProfileTone(profile)}`}>{fillProfileBadgeText(profile)}</span>
                <span>
                  <strong>{profile.title}</strong>
                  <small>{fillProfileSummary(profile)}</small>
                </span>
                <em>{folder}</em>
                <small>{profile.countryCode || '未设置'} · {fillProfileCategoryLabel(profile.category)} · {profile.fields.length} 字段</small>
              </label>
            );
          })}

          {!visibleProfiles.length ? (
            <div className="fill-export-empty">
              <FileText size={30} />
              <strong>没有匹配的资料</strong>
              <p>换一个关键词，或者清空搜索后重新选择。</p>
            </div>
          ) : null}

          {hiddenFilteredCount ? (
            <div className="fill-export-more">
              还有 {hiddenFilteredCount} 条匹配资料未显示，继续输入关键词可以缩小范围。
            </div>
          ) : null}
        </div>

        <footer>
          <p>导出的 .kpfill 可发给可信的人导入 KeyPilot；里面包含明文字段值，请谨慎保存和传输。</p>
          <div>
            <button type="button" onClick={onClose}>
              取消
            </button>
            <button className="primary" type="button" onClick={() => onConfirm(selectedProfiles)} disabled={!selectedProfiles.length}>
              <Download size={17} />
              导出 {selectedProfiles.length} 条
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}

function TrashPanel({
  items,
  onRestore,
  onPurge
}: {
  items: DeletedVaultItem[];
  onRestore: (item: DeletedVaultItem) => void;
  onPurge: (item: DeletedVaultItem) => void;
}) {
  return (
    <section className="trash-panel">
      <header>
        <div>
          <h2>回收站</h2>
          <p>删除的项目会先保留在这里。恢复后会重新回到对应列表。</p>
        </div>
        <span>{items.length} 个项目</span>
      </header>

      {items.length ? (
        <div className="trash-list" role="list">
          {items.map((item, index) => (
            <article className="trash-row" key={item.id} role="listitem" style={{ '--row-delay': `${(index % 12) * 14}ms` } as CSSProperties}>
              <span className="item-name">
                <DeletedItemIcon item={item} />
                <span>
                  <strong>{deletedItemName(item)}</strong>
                  <small>{deletedItemSubtitle(item)}</small>
                </span>
              </span>
              <span>{deletedItemKindLabel(item)}</span>
              <span>{deletedItemWebsite(item) || '本地资料'}</span>
              <span>{new Date(item.deletedAt).toLocaleString('zh-CN')}</span>
              <span className="trash-actions">
                <button type="button" onClick={() => onRestore(item)}>
                  <Undo2 size={16} />
                  恢复
                </button>
                <button className="danger" type="button" onClick={() => onPurge(item)}>
                  <Trash2 size={16} />
                  永久删除
                </button>
              </span>
            </article>
          ))}
        </div>
      ) : (
        <div className="vault-empty">
          <Trash2 size={34} />
          <strong>回收站是空的</strong>
          <p>删除账号、保密笔记或个人信息后，会先显示在这里。</p>
        </div>
      )}
    </section>
  );
}

function CredentialDetailPane({
  credential,
  moreOpen,
  onClose,
  onEdit,
  onToggleMore,
  onAction,
  onSaveNotes,
  onCopy,
  onClone,
  onTogglePinned,
  onDelete,
  onBindFromWeb,
  onTestBinding,
  onMoveToFolder,
  onOpenTrash
}: {
  credential: Credential;
  moreOpen: boolean;
  onClose: () => void;
  onEdit: (credential: Credential) => void;
  onToggleMore: () => void;
  onAction: (action: CredentialAction, credential: Credential) => void;
  onSaveNotes: (credential: Credential, notesText: string) => void;
  onCopy: (label: string, value: string) => void;
  onClone: (credential: Credential) => void;
  onTogglePinned: (credential: Credential) => void;
  onDelete: (credential: Credential) => void;
  onBindFromWeb: (credential: Credential) => void;
  onTestBinding: (credential: Credential) => void;
  onMoveToFolder: (credential: Credential) => void;
  onOpenTrash: () => void;
}) {
  const strength = measurePasswordStrength(credential.password);
  const maskedPassword = credential.password ? '•'.repeat(Math.min(12, Math.max(8, credential.password.length))) : '未保存密码';
  const updatedAt = new Date(credential.updatedAt).toLocaleString('zh-CN');
  const createdAt = new Date(credential.createdAt).toLocaleString('zh-CN');
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [editingNotes, setEditingNotes] = useState(false);
  const [noteDraft, setNoteDraft] = useState(credential.notes ?? '');
  const boundFieldCount = credential.formFields?.length ?? 0;
  const boundUsername = Boolean(credential.formFields?.some((field) => field.kind === 'username'));
  const boundPassword = Boolean(credential.formFields?.some((field) => field.kind === 'password'));
  const hasSubmitBinding = Boolean(credential.formProfile?.submit);
  const bindingTone = boundUsername && boundPassword && hasSubmitBinding ? 'ready' : boundFieldCount || hasSubmitBinding ? 'partial' : 'empty';
  const bindingLabel =
    bindingTone === 'ready'
      ? '可用于一键登录'
      : bindingTone === 'partial'
        ? '绑定不完整'
        : '尚未绑定';
  const bindingHint =
    bindingTone === 'ready'
      ? '已记录用户名框、密码框和登录按钮。遇到网站改版时，可先测试再重新绑定。'
      : bindingTone === 'partial'
        ? '建议重新绑定一次，把用户名框、密码框和登录按钮都记录下来。'
        : '还没有保存网页字段结构。一键登录会使用通用识别，复杂网站建议手动绑定。';

  useEffect(() => {
    setPasswordVisible(false);
    setEditingNotes(false);
    setNoteDraft(credential.notes ?? '');
  }, [credential.id, credential.notes]);

  function saveNoteDraft() {
    onSaveNotes(credential, noteDraft);
    setEditingNotes(false);
  }

  return (
    <aside className="vault-detail-pane" aria-label={`查看 ${credential.title}`}>
      <header className="detail-toolbar">
        <button type="button" aria-label="编辑" title="编辑" onClick={() => onEdit(credential)}>
          <Settings2 size={20} />
        </button>
        <span className="detail-more-anchor">
          <button type="button" aria-label="更多操作" title="更多操作" onClick={onToggleMore}>
            <MoreVertical size={21} />
          </button>
          {moreOpen ? (
            <div className="detail-more-menu" role="menu" aria-label={`${credential.title} 更多操作`}>
              <button type="button" role="menuitem" onClick={() => onAction('goto', credential)}>
                <ArrowUpRight size={18} />
                在新标签页中查看
              </button>
              <button type="button" role="menuitem" disabled title="本地版暂未接入共享账户权限">
                <Share2 size={18} />
                共享
              </button>
              <button type="button" role="menuitem" disabled title="本地版暂未接入发送通道">
                <Send size={18} />
                发送
              </button>
              <button type="button" role="menuitem" onClick={() => window.print()}>
                <Printer size={18} />
                打印
              </button>
              <button type="button" role="menuitem" disabled title="当前账号保存在本地 Vault 主目录">
                <FolderOpen size={18} />
                打开文件所在位置
              </button>
              <button type="button" role="menuitem" onClick={() => onEdit(credential)}>
                <Settings2 size={18} />
                重命名
              </button>
              <button type="button" role="menuitem" onClick={() => onTestBinding(credential)}>
                <Eye size={18} />
                测试绑定
              </button>
              <button type="button" role="menuitem" onClick={() => onBindFromWeb(credential)}>
                <SlidersHorizontal size={18} />
                绑定字段和按钮
              </button>
              <button type="button" role="menuitem" onClick={() => onMoveToFolder(credential)}>
                <FolderOpen size={18} />
                移动到文件夹
              </button>
              <button type="button" role="menuitem" onClick={() => onClone(credential)}>
                <Copy size={18} />
                克隆
              </button>
              <button type="button" role="menuitem" onClick={() => onTogglePinned(credential)}>
                <Pin size={18} />
                {credential.pinned ? '取消固定' : '添加到固定栏'}
              </button>
              <button className="danger" type="button" role="menuitem" onClick={() => onDelete(credential)}>
                <Trash2 size={18} />
                删除
              </button>
              <button type="button" role="menuitem" onClick={onOpenTrash}>
                <Undo2 size={18} />
                恢复
              </button>
            </div>
          ) : null}
        </span>
        <button type="button" aria-label="关闭" title="关闭" onClick={onClose}>
          <X size={22} />
        </button>
      </header>

      <section className="detail-hero">
        <SiteIcon domain={credential.domain} url={credential.url} iconUrl={credential.iconUrl} />
        <h2>{credential.title}</h2>
        <p>{credential.domain}</p>
      </section>

      <div className="detail-actions">
        <button
          type="button"
          title="打开网站，填写账号和密码，并尝试点击登录按钮"
          data-tip="打开网站，填写账号和密码，并尝试点击登录按钮"
          onClick={() => onAction('login', credential)}
        >
          <CirclePlay size={18} />
          登录
        </button>
        <button
          type="button"
          title="打开网站并填写账号密码，但不自动点击登录"
          data-tip="打开网站并填写账号密码，但不自动点击登录"
          onClick={() => onAction('fill', credential)}
        >
          <FileText size={18} />
          浏览并填写
        </button>
        <button type="button" title="只打开保存的网址，不填写内容" data-tip="只打开保存的网址，不填写内容" onClick={() => onAction('goto', credential)}>
          <ArrowUpRight size={18} />
          转到
        </button>
      </div>

      <section className={`detail-binding is-${bindingTone}`} aria-label="自动登录绑定状态">
        <div className="binding-summary">
          <span>自动登录绑定</span>
          <strong>{bindingLabel}</strong>
          <p>{bindingHint}</p>
        </div>
        <div className="binding-metrics" aria-label="绑定记录">
          <span className={boundUsername ? 'ok' : ''}>
            <Check size={14} />
            用户名
          </span>
          <span className={boundPassword ? 'ok' : ''}>
            <Check size={14} />
            密码
          </span>
          <span className={hasSubmitBinding ? 'ok' : ''}>
            <CirclePlay size={14} />
            登录按钮
          </span>
          <span className={boundFieldCount ? 'ok' : ''}>
            <SlidersHorizontal size={14} />
            {boundFieldCount || 0} 字段
          </span>
        </div>
        <div className="binding-actions">
          <button type="button" onClick={() => onTestBinding(credential)}>
            <Eye size={16} />
            测试绑定
          </button>
          <button type="button" onClick={() => onBindFromWeb(credential)}>
            <SlidersHorizontal size={16} />
            重新绑定
          </button>
        </div>
      </section>

      <dl className="detail-fields">
        <div>
          <dt>URL 地址</dt>
          <dd>
            <a href={credential.url} target="_blank" rel="noreferrer">{credential.domain || credential.url}</a>
          </dd>
        </div>
        <div>
          <dt>匹配 URL</dt>
          <dd>
            <span>{credential.matchUrl || '自动使用网站域名'}</span>
          </dd>
        </div>
        <div>
          <dt>登录名</dt>
          <dd>
            <span>{credential.username || '无用户名'}</span>
            <button type="button" aria-label="复制登录名" onClick={() => onCopy('登录名', credential.username)}>
              <Copy size={17} />
            </button>
          </dd>
        </div>
        <div>
          <dt>密码</dt>
          <dd>
            <span>{passwordVisible ? credential.password || '未保存密码' : maskedPassword}</span>
            <button
              type="button"
              aria-label={passwordVisible ? '隐藏密码' : '显示密码'}
              title={passwordVisible ? '隐藏密码' : '显示密码'}
              onClick={() => setPasswordVisible((visible) => !visible)}
            >
              {passwordVisible ? <EyeOff size={17} /> : <Eye size={17} />}
            </button>
            <button type="button" aria-label="复制密码" onClick={() => onCopy('密码', credential.password)}>
              <Copy size={17} />
            </button>
            <span className={`strength s${strength.score}`}>
              <Shield size={16} />
              {strength.label}
            </span>
          </dd>
        </div>
      </dl>

      <section className="detail-notes">
        <div className="detail-notes-label">
          <span>备注</span>
          {editingNotes ? (
            <span className="detail-note-actions">
              <button type="button" onClick={() => {
                setNoteDraft(credential.notes ?? '');
                setEditingNotes(false);
              }}>
                取消
              </button>
              <button className="primary" type="button" onClick={saveNoteDraft}>
                保存
              </button>
            </span>
          ) : (
            <button type="button" onClick={() => setEditingNotes(true)}>
              编辑
            </button>
          )}
        </div>
        {editingNotes ? (
          <textarea value={noteDraft} onChange={(event) => setNoteDraft(event.target.value)} rows={5} placeholder="添加这个账号的备注" />
        ) : (
          <p>{credential.notes?.trim() || '无备注'}</p>
        )}
      </section>

      <section className="detail-meta">
        <div>
          <span>文件夹</span>
          <strong>{credential.folder || '主目录'}</strong>
        </div>
        <div>
          <span>创建时间</span>
          <strong>{createdAt}</strong>
        </div>
        <div>
          <span>更新时间</span>
          <strong>{updatedAt}</strong>
        </div>
      </section>
    </aside>
  );
}

function FillProfileDetailPane({
  profile,
  onClose,
  onEdit,
  onCopy,
  onDelete
}: {
  profile: FillProfile;
  onClose: () => void;
  onEdit: (profile: FillProfile) => void;
  onCopy: (label: string, value: string) => void;
  onDelete: (profile: FillProfile) => void;
}) {
  const groups = fillProfileFieldsByGroup(profile);
  const [activeGroup, setActiveGroup] = useState<FillField['group']>(groups[0]?.[0] ?? 'personal');
  const activeFields = groups.find(([group]) => group === activeGroup)?.[1] ?? groups[0]?.[1] ?? [];
  const activeGroupLabel = fillFieldGroupLabel(activeGroup);

  useEffect(() => {
    setActiveGroup(groups[0]?.[0] ?? 'personal');
  }, [profile.id]);

  return (
    <aside className="vault-detail-pane fill-profile-detail-pane" aria-label={`查看 ${profile.title}`}>
      <header className="fill-profile-detail-top">
        <span className={`fill-profile-avatar ${fillProfileTone(profile)}`}>{fillProfileBadgeText(profile)}</span>
        <strong>{profile.title}</strong>
        <span className="fill-profile-toolbar">
          <button type="button" aria-label="复制全部资料" title="复制全部资料" onClick={() => onCopy(`${profile.title} 全部资料`, formatFillProfileForClipboard(profile))}>
            <Copy size={20} />
          </button>
          <button type="button" aria-label="编辑" title="编辑" onClick={() => onEdit(profile)}>
            <Pencil size={20} />
          </button>
          <button type="button" aria-label="删除" title="删除" onClick={() => onDelete(profile)}>
            <Trash2 size={20} />
          </button>
          <button type="button" aria-label="关闭" title="关闭" onClick={onClose}>
            <X size={22} />
          </button>
        </span>
      </header>

      <div className="fill-profile-detail-shell">
        <nav className="fill-profile-section-nav" aria-label="资料分组">
          {groups.map(([group, fields]) => (
            <button
              key={group}
              className={group === activeGroup ? 'active' : ''}
              type="button"
              onClick={() => setActiveGroup(group)}
            >
              {fillFieldGroupIcon(group)}
              <span>{fillFieldGroupLabel(group)}</span>
              <small>{fields.length}</small>
            </button>
          ))}
          <button type="button" disabled>
            <Plus size={19} />
            <span>添加信用卡</span>
          </button>
          <button type="button" disabled>
            <Plus size={19} />
            <span>添加银行账户</span>
          </button>
        </nav>

        <section className="fill-profile-detail-content">
          <div className="fill-profile-title-block">
            <h2>{profile.title}</h2>
            <p>{fillProfileCategoryLabel(profile.category)} · {profile.countryCode || '未设置国家'} · {profile.fields.length} 字段</p>
          </div>

          <section className="fill-profile-field-panel">
            <header>
              <span>{fillFieldGroupIcon(activeGroup)}</span>
              <strong>{activeGroupLabel}</strong>
              <button type="button" aria-label={`复制${activeGroupLabel}`} title={`复制${activeGroupLabel}`} onClick={() => onCopy(activeGroupLabel, activeFields.map((field) => `${field.label}: ${field.value}`).join('\n'))}>
                <Copy size={17} />
              </button>
            </header>
            {activeFields.length ? (
              <dl>
                {activeFields.map((field) => (
                  <div key={`${field.key}-${field.label}`}>
                    <dt>{field.label}</dt>
                    <dd>
                      <span>{field.value || '空'}</span>
                      {field.sensitivity !== 'normal' ? <em>{field.sensitivity === 'secret' ? '敏感' : '私密'}</em> : null}
                      <button type="button" aria-label={`复制 ${field.label}`} title={`复制 ${field.label}`} onClick={() => onCopy(field.label, field.value)}>
                        <Copy size={16} />
                      </button>
                    </dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="fill-profile-no-fields">这个分组还没有字段。</p>
            )}
          </section>

          <section className="fill-profile-meta">
            <div>
              <span>文件夹</span>
              <strong>{profile.folder || ROOT_FOLDER_NAME}</strong>
            </div>
            <div>
              <span>来源</span>
              <strong>{profile.source || 'manual'}</strong>
            </div>
            <div>
              <span>更新时间</span>
              <strong>{new Date(profile.updatedAt).toLocaleString('zh-CN')}</strong>
            </div>
          </section>
        </section>
      </div>
    </aside>
  );
}

const FILL_PROFILE_CATEGORIES: FillProfile['category'][] = ['identity', 'auto_insurance', 'business', 'loan', 'shipping', 'billing', 'payment', 'custom'];
const FILL_FIELD_GROUPS: FillField['group'][] = ['personal', 'contact', 'address', 'business', 'loan', 'employment', 'finance', 'driver', 'vehicle', 'insurance', 'payment', 'sensitive', 'custom'];
const FILL_FIELD_SENSITIVITIES: FillField['sensitivity'][] = ['normal', 'private', 'secret'];

function FillProfileEditPane({
  profile,
  folders,
  onClose,
  onCancel,
  onSave
}: {
  profile: FillProfile;
  folders: string[];
  onClose: () => void;
  onCancel: () => void;
  onSave: (profile: FillProfile) => void;
}) {
  const [title, setTitle] = useState(profile.title);
  const [folder, setFolder] = useState(normalizeFolderLabel(profile.folder));
  const [countryCode, setCountryCode] = useState(profile.countryCode || 'US');
  const [category, setCategory] = useState<FillProfile['category']>(profile.category);
  const [fields, setFields] = useState<FillField[]>(() => profile.fields.map((field) => ({ ...field })));

  useEffect(() => {
    setTitle(profile.title);
    setFolder(normalizeFolderLabel(profile.folder));
    setCountryCode(profile.countryCode || 'US');
    setCategory(profile.category);
    setFields(profile.fields.map((field) => ({ ...field })));
  }, [profile]);

  function updateField(index: number, patch: Partial<FillField>) {
    setFields((current) => current.map((field, fieldIndex) => (fieldIndex === index ? { ...field, ...patch } : field)));
  }

  function addField() {
    setFields((current) => [
      ...current,
      {
        key: `custom_${current.length + 1}`,
        label: '新字段',
        value: '',
        group: 'custom',
        sensitivity: 'normal'
      }
    ]);
  }

  function removeField(index: number) {
    setFields((current) => current.filter((_, fieldIndex) => fieldIndex !== index));
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedFields = fields
      .filter((field) => field.label.trim() || field.value.trim())
      .map((field, index) => {
        const label = field.label.trim() || `字段 ${index + 1}`;
        const key = field.key.trim() || label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || `field_${index + 1}`;
        return {
          ...field,
          key,
          label,
          value: field.value,
          group: field.group,
          sensitivity: field.sensitivity
        };
      });

    onSave({
      ...profile,
      title: title.trim() || profile.title,
      folder: normalizeFolderLabel(folder),
      countryCode: countryCode.trim().toUpperCase() || 'US',
      category,
      fields: normalizedFields,
      updatedAt: Date.now()
    });
  }

  return (
    <aside className="vault-detail-pane fill-profile-edit-pane" aria-label={`编辑 ${profile.title}`}>
      <form onSubmit={submit}>
        <header className="edit-header">
          <div className="edit-identity">
            <span className={`fill-profile-avatar ${fillProfileTone({ ...profile, category })}`}>{fillProfileBadgeText({ ...profile, title, category })}</span>
            <strong>{title || profile.title}</strong>
          </div>
          <button type="button" aria-label="关闭" title="关闭" onClick={onClose}>
            <X size={24} />
          </button>
        </header>

        <div className="edit-savebar">
          <button type="button" onClick={onCancel}>
            取消
          </button>
          <button className="primary" type="submit">
            <Check size={17} />
            保存
          </button>
        </div>

        <section className="fill-profile-edit-body">
          <section className="fill-profile-edit-card">
            <header>
              <strong>资料信息</strong>
              <span>这些信息会影响列表名称、分类和填表匹配。</span>
            </header>
            <EditField label="资料名称" value={title} onChange={setTitle} required />
            <FolderField value={folder} folders={folders} onChange={setFolder} />
            <div className="fill-profile-edit-grid">
              <label className="edit-field">
                <span>国家</span>
                <input value={countryCode} onChange={(event) => setCountryCode(event.currentTarget.value)} placeholder="US" />
              </label>
              <label className="edit-field">
                <span>分类</span>
                <select value={category} onChange={(event) => setCategory(event.currentTarget.value as FillProfile['category'])}>
                  {FILL_PROFILE_CATEGORIES.map((item) => (
                    <option key={item} value={item}>{fillProfileCategoryLabel(item)}</option>
                  ))}
                </select>
              </label>
            </div>
          </section>

          <section className="fill-profile-edit-card">
            <header>
              <strong>字段</strong>
              <button type="button" onClick={addField}>
                <Plus size={17} />
                添加字段
              </button>
            </header>
            <div className="fill-profile-field-editor-list">
              {fields.length ? (
                fields.map((field, index) => (
                  <FillProfileFieldEditor
                    key={`${field.key}-${index}`}
                    field={field}
                    index={index}
                    onChange={(patch) => updateField(index, patch)}
                    onRemove={() => removeField(index)}
                  />
                ))
              ) : (
                <p>还没有字段。添加字段后可以用于网页自动填表。</p>
              )}
            </div>
          </section>
        </section>
      </form>
    </aside>
  );
}

function FillProfileFieldEditor({
  field,
  index,
  onChange,
  onRemove
}: {
  field: FillField;
  index: number;
  onChange: (patch: Partial<FillField>) => void;
  onRemove: () => void;
}) {
  return (
    <article className="fill-profile-field-editor">
      <header>
        <span>字段 {index + 1}</span>
        <button type="button" aria-label={`删除字段 ${index + 1}`} title="删除字段" onClick={onRemove}>
          <Trash2 size={16} />
        </button>
      </header>
      <div className="fill-profile-field-editor-grid">
        <label className="edit-field">
          <span>字段名</span>
          <input value={field.label} onChange={(event) => onChange({ label: event.currentTarget.value })} />
        </label>
        <label className="edit-field">
          <span>字段 Key</span>
          <input value={field.key} onChange={(event) => onChange({ key: event.currentTarget.value })} />
        </label>
        <label className="edit-field">
          <span>分组</span>
          <select value={field.group} onChange={(event) => onChange({ group: event.currentTarget.value as FillField['group'] })}>
            {FILL_FIELD_GROUPS.map((group) => (
              <option key={group} value={group}>{fillFieldGroupLabel(group)}</option>
            ))}
          </select>
        </label>
        <label className="edit-field">
          <span>敏感度</span>
          <select value={field.sensitivity} onChange={(event) => onChange({ sensitivity: event.currentTarget.value as FillField['sensitivity'] })}>
            {FILL_FIELD_SENSITIVITIES.map((sensitivity) => (
              <option key={sensitivity} value={sensitivity}>{sensitivity === 'normal' ? '普通' : sensitivity === 'private' ? '私密' : '敏感'}</option>
            ))}
          </select>
        </label>
      </div>
      <label className="edit-field fill-profile-value-field">
        <span>字段值</span>
        <textarea value={field.value} onChange={(event) => onChange({ value: event.currentTarget.value })} rows={2} />
      </label>
    </article>
  );
}

function CredentialEditPane({
  credential,
  onClose,
  onCancel,
  onSave,
  onBindFromWeb
}: {
  credential: Credential;
  onClose: () => void;
  onCancel: () => void;
  onSave: (draft: CredentialDraft, existing: Credential) => void;
  onBindFromWeb: (credential: Credential) => void;
}) {
  const [draft, setDraft] = useState(() => credentialToDraft(credential));
  const [passwordVisible, setPasswordVisible] = useState(false);

  useEffect(() => {
    setDraft(credentialToDraft(credential));
    setPasswordVisible(false);
  }, [credential]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSave(draft, credential);
  }

  function addFormField() {
    setDraft((current) => ({
      ...current,
      formFields: [
        ...current.formFields,
        {
          label: '',
          name: '',
          type: 'text',
          value: '',
          kind: 'text',
          index: current.formFields.length
        }
      ]
    }));
  }

  function updateFormField(index: number, patch: Partial<CredentialFormField>) {
    setDraft((current) => ({
      ...current,
      formFields: current.formFields.map((field, fieldIndex) =>
        fieldIndex === index
          ? {
              ...field,
              ...patch,
              index: fieldIndex
            }
          : field
      )
    }));
  }

  function removeFormField(index: number) {
    setDraft((current) => ({
      ...current,
      formFields: current.formFields.filter((_, fieldIndex) => fieldIndex !== index).map((field, fieldIndex) => ({ ...field, index: fieldIndex }))
    }));
  }

  return (
    <aside className="vault-detail-pane edit-pane" aria-label={`编辑 ${credential.title}`}>
      <form onSubmit={submit}>
        <header className="edit-header">
          <div className="edit-identity">
            <SiteIcon domain={credential.domain} url={credential.url} iconUrl={credential.iconUrl} />
            <strong>{credential.title}</strong>
          </div>
          <button type="button" aria-label="关闭" title="关闭" onClick={onClose}>
            <X size={24} />
          </button>
        </header>

        <div className="edit-savebar">
          <button type="button" onClick={onCancel}>
            取消
          </button>
          <button className="primary" type="submit">
            <Check size={17} />
            保存
          </button>
        </div>

        <section className="edit-fields">
          <EditField label="名称" value={draft.title} onChange={(value) => setDraft((current) => ({ ...current, title: value }))} required />
          <EditField label="转到 URL" value={draft.url} onChange={(value) => setDraft((current) => ({ ...current, url: value }))} required />
          <EditField label="匹配 URL" value={draft.matchUrl} onChange={(value) => setDraft((current) => ({ ...current, matchUrl: value }))} placeholder="留空使用网站域名，或填写 *.example.com/*" />
          <EditField label="登录名" value={draft.username} onChange={(value) => setDraft((current) => ({ ...current, username: value }))} />
          <EditPasswordField
            label="密码"
            value={draft.password}
            visible={passwordVisible}
            onToggleVisible={() => setPasswordVisible((visible) => !visible)}
            onChange={(value) => setDraft((current) => ({ ...current, password: value }))}
            required
          />
          <section className="edit-custom-fields" aria-label="自定义字段">
            <header>
              <div>
                <strong>字段</strong>
                <span>手动维护额外字段，或打开网页点选用户名框、密码框和登录按钮。</span>
              </div>
              <span className="custom-field-header-actions">
                <button type="button" onClick={() => onBindFromWeb(credential)}>
                  <SlidersHorizontal size={17} />
                  网页点选绑定
                </button>
                <button type="button" onClick={addFormField}>
                  <Plus size={17} />
                  添加字段
                </button>
              </span>
            </header>
            {draft.formFields.length ? (
              <div className="custom-field-list">
                {draft.formFields.map((field, index) => (
                  <CustomFieldEditor
                    key={`${field.index ?? index}-${index}`}
                    field={field}
                    index={index}
                    onChange={(patch) => updateFormField(index, patch)}
                    onRemove={() => removeFormField(index)}
                  />
                ))}
              </div>
            ) : (
              <p>这个登录项还没有额外字段。</p>
            )}
          </section>
          <EditField label="文件夹" value={draft.folder} onChange={(value) => setDraft((current) => ({ ...current, folder: value }))} />
          <EditArea label="备注" value={draft.notes} onChange={(value) => setDraft((current) => ({ ...current, notes: value }))} />
        </section>
      </form>
    </aside>
  );
}

function EditField({
  label,
  value,
  onChange,
  placeholder,
  required
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  required?: boolean;
}) {
  return (
    <label className="edit-field">
      <span>{label}</span>
      <input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} required={required} />
    </label>
  );
}

function CustomFieldEditor({
  field,
  index,
  onChange,
  onRemove
}: {
  field: CredentialFormField;
  index: number;
  onChange: (patch: Partial<CredentialFormField>) => void;
  onRemove: () => void;
}) {
  const [visible, setVisible] = useState(false);
  const fieldKind = field.kind || 'text';

  function changeKind(kind: CredentialFormFieldKind) {
    onChange({
      kind,
      type: kind === 'password' ? 'password' : 'text'
    });
  }

  return (
    <article className="custom-field-row">
      <div className="custom-field-kind">
        <span>类型</span>
        <select value={fieldKind} onChange={(event) => changeKind(event.target.value as CredentialFormFieldKind)}>
          <option value="text">文本</option>
          <option value="username">登录名</option>
          <option value="password">密码</option>
        </select>
      </div>
      <EditField label="字段名称" value={field.label} onChange={(value) => onChange({ label: value, name: field.name || value })} />
      <label className="edit-field edit-password-field custom-field-value">
        <span>字段值</span>
        <input
          type={fieldKind === 'password' && !visible ? 'password' : 'text'}
          value={field.value}
          onChange={(event) => onChange({ value: event.target.value })}
          placeholder={fieldKind === 'username' ? '默认使用登录名' : fieldKind === 'password' ? '默认使用密码' : ''}
        />
        {fieldKind === 'password' ? (
          <button type="button" aria-label={visible ? '隐藏字段值' : '显示字段值'} title={visible ? '隐藏字段值' : '显示字段值'} onClick={() => setVisible((current) => !current)}>
            {visible ? <EyeOff size={17} /> : <Eye size={17} />}
          </button>
        ) : null}
      </label>
      <button className="custom-field-remove" type="button" aria-label={`删除字段 ${index + 1}`} title="删除字段" onClick={onRemove}>
        <X size={17} />
      </button>
    </article>
  );
}

function EditPasswordField({
  label,
  value,
  visible,
  onToggleVisible,
  onChange,
  required
}: {
  label: string;
  value: string;
  visible: boolean;
  onToggleVisible: () => void;
  onChange: (value: string) => void;
  required?: boolean;
}) {
  return (
    <label className="edit-field edit-password-field">
      <span>{label}</span>
      <input type={visible ? 'text' : 'password'} value={value} onChange={(event) => onChange(event.target.value)} required={required} />
      <button type="button" aria-label={visible ? '隐藏密码' : '显示密码'} title={visible ? '隐藏密码' : '显示密码'} onClick={onToggleVisible}>
        {visible ? <EyeOff size={17} /> : <Eye size={17} />}
      </button>
    </label>
  );
}

function EditArea({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="edit-field edit-area">
      <span>{label}</span>
      <textarea value={value} onChange={(event) => onChange(event.target.value)} rows={5} />
    </label>
  );
}

function SiteIcon({ domain, url, iconUrl }: { domain: string; url?: string; iconUrl?: string }) {
  const cacheKey = `${iconUrl ?? ''}|${url ?? ''}|${domain}`;
  const candidates = useMemo(() => getIconCandidates(iconUrl, url || domain).filter((candidate) => !failedIconUrls.has(candidate)), [domain, iconUrl, url]);
  const cached = resolvedIconCache.get(cacheKey);
  const [probeIndex, setProbeIndex] = useState(cached === undefined && candidates.length ? 0 : -1);
  const [resolvedSrc, setResolvedSrc] = useState<string | null>(cached ?? null);
  const probeSrc = probeIndex >= 0 ? candidates[probeIndex] : undefined;

  useEffect(() => {
    const nextCached = resolvedIconCache.get(cacheKey);

    setResolvedSrc(nextCached ?? null);
    setProbeIndex(nextCached === undefined && candidates.length ? 0 : -1);
  }, [cacheKey, candidates]);

  function tryNextIcon(failedUrl?: string) {
    if (failedUrl) {
      failedIconUrls.add(failedUrl);
    }

    const nextIndex = probeIndex + 1;
    if (nextIndex < candidates.length) {
      setProbeIndex(nextIndex);
      return;
    }

    resolvedIconCache.set(cacheKey, null);
    setProbeIndex(-1);
  }

  return (
    <span className="site-icon">
      <span>{(domain || '?').slice(0, 1).toUpperCase()}</span>
      {probeSrc ? (
        <img
          className="site-icon-probe"
          src={probeSrc}
          alt=""
          referrerPolicy="no-referrer"
          onLoad={(event) => {
            const image = event.currentTarget;

            if (image.naturalWidth <= 1 && image.naturalHeight <= 1) {
              tryNextIcon(probeSrc);
              return;
            }

            resolvedIconCache.set(cacheKey, probeSrc);
            setResolvedSrc(probeSrc);
            setProbeIndex(-1);
          }}
          onError={() => tryNextIcon(probeSrc)}
        />
      ) : null}
      {resolvedSrc ? <img className="site-icon-image" src={resolvedSrc} alt="" referrerPolicy="no-referrer" /> : null}
    </span>
  );
}

function GeneratorPanel({ onCopy }: { onCopy: (password: string) => void }) {
  const [options, setOptions] = useState<PasswordGeneratorOptions>(defaultGeneratorOptions);
  const [password, setPassword] = useState(() => generatePassword(defaultGeneratorOptions));
  const [copied, setCopied] = useState(false);
  const strength = measurePasswordStrength(password);
  const activeTypes = [options.uppercase, options.lowercase, options.numbers, options.symbols].filter(Boolean).length;

  function refresh(nextOptions = options) {
    setPassword(generatePassword(nextOptions));
    setCopied(false);
  }

  function updateOptions(patch: Partial<PasswordGeneratorOptions>) {
    const nextOptions = { ...options, ...patch };
    setOptions(nextOptions);
    refresh(nextOptions);
  }

  function applyPreset(preset: 'readable' | 'balanced' | 'maximum') {
    const nextOptions =
      preset === 'readable'
        ? {
            ...defaultGeneratorOptions,
            length: 18,
            symbols: false,
            excludeSimilar: true,
            requireEveryType: true,
            excludeCharacters: '',
            requiredCharacters: ''
          }
        : preset === 'maximum'
          ? {
              ...defaultGeneratorOptions,
              length: 28,
              symbols: true,
              excludeSimilar: false,
              requireEveryType: true,
              excludeCharacters: '',
              requiredCharacters: ''
            }
          : defaultGeneratorOptions;

    setOptions(nextOptions);
    refresh(nextOptions);
  }

  function copyPassword() {
    if (!password) return;
    onCopy(password);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }

  return (
    <section className="generator-workbench">
      <header className="generator-hero">
        <span className="generator-glyph"><KeyRound size={22} /></span>
        <div>
          <h2>密码生成器</h2>
          <p>按网站规则生成强密码。复制后也可以在注册页通过 KeyPilot 图标直接填入。</p>
        </div>
      </header>

      <div className="generator-output">
        <div className="generator-password" aria-live="polite">
          <code>{password || '请选择至少一种字符类型，或填写必须包含字符。'}</code>
          <span className={`strength s${strength.score}`}>
            <Shield size={15} />
            {password ? strength.label : '待生成'}
          </span>
        </div>
        <div className="generator-actions">
          <button type="button" onClick={() => refresh()} aria-label="重新生成密码">
            <RefreshCw size={17} />
            重新生成
          </button>
          <button className="primary" type="button" onClick={copyPassword} disabled={!password}>
            {copied ? <Check size={17} /> : <Copy size={17} />}
            {copied ? '已复制' : '复制'}
          </button>
        </div>
      </div>

      <div className="generator-presets" aria-label="密码预设">
        <button type="button" onClick={() => applyPreset('balanced')}>标准强密码</button>
        <button type="button" onClick={() => applyPreset('readable')}>易读少符号</button>
        <button type="button" onClick={() => applyPreset('maximum')}>高强度</button>
      </div>

      <div className="generator-settings">
        <section className="generator-card length-card">
          <div className="generator-card-title">
            <strong>长度</strong>
            <span>当前 {options.length} 位</span>
          </div>
          <div className="length-control">
            <input
              type="range"
              min={4}
              max={132}
              value={options.length}
              onChange={(event) => updateOptions({ length: Number(event.currentTarget.value) })}
              aria-label="密码长度"
            />
            <input
              type="number"
              min={4}
              max={132}
              value={options.length}
              onChange={(event) => updateOptions({ length: Number(event.currentTarget.value) })}
              aria-label="密码长度数值"
            />
          </div>
        </section>

        <section className="generator-card">
          <div className="generator-card-title">
            <strong>字符类型</strong>
            <span>{activeTypes} 类已启用</span>
          </div>
          <div className="generator-switch-grid">
            <GeneratorSwitch label="大写字母" hint="A-Z" checked={options.uppercase} onChange={(checked) => updateOptions({ uppercase: checked })} />
            <GeneratorSwitch label="小写字母" hint="a-z" checked={options.lowercase} onChange={(checked) => updateOptions({ lowercase: checked })} />
            <GeneratorSwitch label="数字" hint="0-9" checked={options.numbers} onChange={(checked) => updateOptions({ numbers: checked })} />
            <GeneratorSwitch label="符号" hint="!@#$" checked={options.symbols} onChange={(checked) => updateOptions({ symbols: checked })} />
          </div>
        </section>

        <section className="generator-card">
          <div className="generator-card-title">
            <strong>高级规则</strong>
            <span>适配特殊网站</span>
          </div>
          <div className="generator-rules">
            <label>
              <span>必须包含字符</span>
              <input
                value={options.requiredCharacters ?? ''}
                onChange={(event) => updateOptions({ requiredCharacters: event.currentTarget.value })}
                placeholder="例如：@#A9"
              />
            </label>
            <label>
              <span>排除字符</span>
              <input
                value={options.excludeCharacters ?? ''}
                onChange={(event) => updateOptions({ excludeCharacters: event.currentTarget.value })}
                placeholder="例如：{}[]'&quot;"
              />
            </label>
          </div>
        </section>

        <section className="generator-card">
          <div className="generator-card-title">
            <strong>安全偏好</strong>
            <span>减少输错和漏项</span>
          </div>
          <div className="generator-switch-list">
            <GeneratorSwitch label="排除相似字符" hint="不使用 I、l、1、O、0" checked={options.excludeSimilar} onChange={(checked) => updateOptions({ excludeSimilar: checked })} />
            <GeneratorSwitch label="每类至少 1 个" hint="启用的类型都会出现" checked={options.requireEveryType !== false} onChange={(checked) => updateOptions({ requireEveryType: checked })} />
          </div>
        </section>
      </div>
    </section>
  );
}

function GeneratorSwitch({ label, hint, checked, onChange }: { label: string; hint: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="generator-switch">
      <span>
        <strong>{label}</strong>
        <small>{hint}</small>
      </span>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.currentTarget.checked)} />
      <i aria-hidden="true" />
    </label>
  );
}

function SecurityPanel({ security }: { security: ReturnType<typeof analyzeSecurity> }) {
  const [tab, setTab] = useState<'overview' | 'breach'>('overview');
  const [filter, setFilter] = useState<SecurityFilter>('risk');
  const rows =
    filter === 'risk'
      ? security.riskItems
      : filter === 'weak'
        ? security.items.filter((item) => item.isWeak)
        : filter === 'reused'
          ? security.items.filter((item) => item.isReused)
          : filter === 'unbound'
            ? security.items.filter((item) => item.isUnbound)
            : filter === 'stale'
              ? security.items.filter((item) => item.isStale)
              : filter === 'duplicates'
                ? security.items.filter((item) => item.isExactDuplicate)
                : filter === 'excluded'
                  ? []
                  : security.items;

  return (
    <section className="security-panel">
      <nav className="security-tabs" aria-label="安全中心">
        <button className={tab === 'overview' ? 'active' : ''} type="button" onClick={() => setTab('overview')}>
          Security Overview
        </button>
        <button className={tab === 'breach' ? 'active' : ''} type="button" onClick={() => setTab('breach')}>
          Data Breach Monitoring
        </button>
      </nav>

      {tab === 'overview' ? (
        <>
          <section className="security-overview-card">
            <div className="security-chart-wrap">
              <SecurityDonut segments={security.donutSegments} />
              <div className="security-legend">
                {security.legend.map((item) => (
                  <span key={item.label}>
                    <i style={{ backgroundColor: item.color }} aria-hidden="true" />
                    <strong>{item.label}</strong>
                    <em>{item.percent}%</em>
                  </span>
                ))}
              </div>
            </div>

            <div className="security-score-card">
              <span className="security-score-label">您的安全分数：</span>
              <strong>{security.score}</strong>
              <em className={`security-level ${security.levelTone}`}>{security.level}</em>
              <SecurityScoreBar score={security.score} />
              <div className="security-recommendation">
                <strong>推荐</strong>
                <p>{security.recommendation}</p>
              </div>
            </div>
          </section>

          <div className="security-filter-tabs" role="tablist" aria-label="安全筛选">
            <SecurityFilterButton label="风险" count={security.riskItems.length} active={filter === 'risk'} onClick={() => setFilter('risk')} />
            <SecurityFilterButton label="弱的" count={security.weak} active={filter === 'weak'} onClick={() => setFilter('weak')} />
            <SecurityFilterButton label="重用" count={security.reused} active={filter === 'reused'} onClick={() => setFilter('reused')} />
            <SecurityFilterButton label="未绑定" count={security.unbound} active={filter === 'unbound'} onClick={() => setFilter('unbound')} />
            <SecurityFilterButton label="久未更新" count={security.stale} active={filter === 'stale'} onClick={() => setFilter('stale')} />
            <SecurityFilterButton label="所有" count={security.total} active={filter === 'all'} onClick={() => setFilter('all')} />
            <SecurityFilterButton label="完全重复" count={security.exactDuplicates} active={filter === 'duplicates'} onClick={() => setFilter('duplicates')} />
            <SecurityFilterButton label="排除" count={0} active={filter === 'excluded'} onClick={() => setFilter('excluded')} />
          </div>

          <SecurityTable rows={rows} emptyLabel={filter === 'excluded' ? '还没有排除项' : '没有匹配的安全风险'} />
        </>
      ) : (
        <section className="breach-monitor-panel">
          <span className="breach-icon">
            <ShieldCheck size={30} />
          </span>
          <div>
            <h2>数据泄露监控</h2>
            <p>当前版本不把网站域名、用户名或密码发送到任何第三方服务。这里先保留监控入口，后续会支持用户明确开启后的本地优先检测流程。</p>
          </div>
          <div className="breach-privacy-grid">
            <span><Shield size={16} /> 本地强度检测</span>
            <span><Lock size={16} /> 不上传密码</span>
            <span><AlertTriangle size={16} /> 发现风险后再提醒</span>
          </div>
        </section>
      )}
    </section>
  );
}

type SecurityFilter = 'risk' | 'weak' | 'reused' | 'unbound' | 'stale' | 'all' | 'duplicates' | 'excluded';

interface SecurityItem {
  credential: Credential;
  strength: ReturnType<typeof measurePasswordStrength>;
  isWeak: boolean;
  isReused: boolean;
  isExactDuplicate: boolean;
  isUnbound: boolean;
  isStale: boolean;
  missingUsername: boolean;
  passwordUseCount: number;
}

interface SecurityLegendItem {
  label: string;
  count: number;
  percent: number;
  color: string;
}

function SecurityDonut({ segments }: { segments: SecurityLegendItem[] }) {
  const total = Math.max(segments.reduce((sum, segment) => sum + segment.count, 0), 1);
  const radius = 74;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;

  return (
    <svg className="security-donut" viewBox="0 0 190 190" role="img" aria-label="密码强度分布">
      <circle className="security-donut-track" cx="95" cy="95" r={radius} />
      {segments.map((segment) => {
        const length = (segment.count / total) * circumference;
        const dash = `${Math.max(length - 3, 0)} ${circumference}`;
        const currentOffset = -offset;
        offset += length;

        return (
          <circle
            key={segment.label}
            className="security-donut-segment"
            cx="95"
            cy="95"
            r={radius}
            stroke={segment.color}
            strokeDasharray={dash}
            strokeDashoffset={currentOffset}
          />
        );
      })}
      <circle className="security-donut-core" cx="95" cy="95" r="48" />
      <text x="95" y="101" textAnchor="middle">
        KP
      </text>
    </svg>
  );
}

function SecurityScoreBar({ score }: { score: number }) {
  return (
    <div className="security-score-track" aria-label={`安全分数 ${score}`}>
      <span className="danger" />
      <span className="warning" />
      <span className="ok" />
      <span className="good" />
      <i style={{ left: `${Math.max(0, Math.min(score, 100))}%` }} aria-hidden="true" />
    </div>
  );
}

function SecurityFilterButton({ label, count, active, onClick }: { label: string; count: number; active: boolean; onClick: () => void }) {
  return (
    <button className={active ? 'active' : ''} type="button" role="tab" aria-selected={active} onClick={onClick}>
      {label} ({count})
    </button>
  );
}

function SecurityTable({ rows, emptyLabel }: { rows: SecurityItem[]; emptyLabel: string }) {
  return (
    <section className="security-table" aria-label="安全风险账号">
      <header>
        <span>名字</span>
        <span>密码</span>
        <span>密码强度</span>
        <span>网页地址</span>
        <span>建议</span>
      </header>
      {rows.length ? (
        rows.map((item, index) => <SecurityTableRow key={item.credential.id} item={item} index={index} />)
      ) : (
        <div className="security-empty">
          <ShieldCheck size={24} />
          <strong>{emptyLabel}</strong>
          <span>这里的分析只在本地 Vault 中完成。</span>
        </div>
      )}
    </section>
  );
}

function SecurityTableRow({ item, index }: { item: SecurityItem; index: number }) {
  const { credential, strength } = item;
  const suggestion = item.isWeak
    ? '换成更强密码'
    : item.isReused
      ? '避免重复使用'
      : item.isUnbound
        ? '绑定登录规则'
        : item.missingUsername
          ? '补全登录名'
          : item.isStale
            ? '建议核对更新'
            : '状态良好';

  return (
    <article className="security-row" style={{ '--row-delay': `${(index % 14) * 12}ms` } as CSSProperties}>
      <span className="security-name">
        <SiteIcon domain={credential.domain} url={credential.url} iconUrl={credential.iconUrl} />
        <span>
          <strong>{credential.title}</strong>
          <small>{credential.username || '无用户名'}</small>
        </span>
      </span>
      <span className="security-password">
        <code>••••••••</code>
        <Eye size={15} aria-hidden="true" />
      </span>
      <span>
        <em className={`security-strength s${strength.score}`}>
          <Shield size={15} />
          {strength.label}
        </em>
      </span>
      <span className="security-url">{credential.domain || extractDomain(credential.url)}</span>
      <span className={item.isWeak || item.isReused || item.isUnbound || item.missingUsername || item.isStale ? 'security-suggestion warn' : 'security-suggestion'}>{suggestion}</span>
    </article>
  );
}

const SECURITY_STALE_AGE = 365 * 24 * 60 * 60 * 1000;

function credentialHasCompleteLoginRule(credential: Credential): boolean {
  const fields = credential.formFields ?? [];
  const hasUsernameField = fields.some((field) => field.kind === 'username' && Boolean(field.selector || field.id || field.name || field.index !== undefined));
  const hasPasswordField = fields.some((field) => field.kind === 'password' && Boolean(field.selector || field.id || field.name || field.index !== undefined));

  return Boolean(credential.formProfile?.submit && (hasUsernameField || credential.username.trim()) && hasPasswordField);
}

function analyzeSecurity(credentials: Credential[]) {
  const passwordCounts = new Map<string, number>();
  const exactCounts = new Map<string, number>();

  credentials.forEach((credential) => {
    passwordCounts.set(credential.password, (passwordCounts.get(credential.password) ?? 0) + 1);
    exactCounts.set(securityExactKey(credential), (exactCounts.get(securityExactKey(credential)) ?? 0) + 1);
  });

  const items: SecurityItem[] = credentials.map((credential) => {
    const strength = measurePasswordStrength(credential.password);
    const passwordUseCount = passwordCounts.get(credential.password) ?? 0;
    const updatedAt = credential.updatedAt || credential.createdAt || 0;

    return {
      credential,
      strength,
      passwordUseCount,
      isWeak: strength.label === '弱',
      isReused: passwordUseCount > 1,
      isExactDuplicate: (exactCounts.get(securityExactKey(credential)) ?? 0) > 1,
      isUnbound: !credentialHasCompleteLoginRule(credential),
      isStale: Boolean(updatedAt && Date.now() - updatedAt > SECURITY_STALE_AGE),
      missingUsername: !credential.username.trim()
    };
  });

  const weak = items.filter((item) => item.isWeak).length;
  const reused = items.filter((item) => item.isReused).length;
  const exactDuplicates = items.filter((item) => item.isExactDuplicate).length;
  const total = credentials.length;
  const unbound = items.filter((item) => item.isUnbound).length;
  const stale = items.filter((item) => item.isStale).length;
  const missingUsername = items.filter((item) => item.missingUsername).length;
  const bound = total - unbound;
  const excellent = items.filter((item) => item.strength.score >= 5).length;
  const strong = items.filter((item) => item.strength.score === 4).length;
  const medium = items.filter((item) => item.strength.score >= 2 && item.strength.score <= 3).length;
  const score = total
    ? Math.max(
        0,
        Math.min(
          100,
          Math.round(
            100 -
              (weak / total) * 52 -
              (reused / total) * 22 -
              (exactDuplicates / total) * 10 -
              (unbound / total) * 12 -
              (missingUsername / total) * 6 -
              (stale / total) * 5
          )
        )
      )
    : 100;
  const level = score >= 85 ? '高' : score >= 65 ? '中' : '低';
  const levelTone = score >= 85 ? 'good' : score >= 65 ? 'warn' : 'bad';
  const riskItems = items
    .filter((item) => item.isWeak || item.isReused || item.isExactDuplicate || item.isUnbound || item.missingUsername || item.isStale)
    .sort(
      (left, right) =>
        Number(right.isWeak) - Number(left.isWeak) ||
        Number(right.isReused) - Number(left.isReused) ||
        Number(right.isUnbound) - Number(left.isUnbound) ||
        right.passwordUseCount - left.passwordUseCount ||
        left.strength.score - right.strength.score
    );
  const legend = [
    securityLegendItem('极强', excellent, total, '#22c55e'),
    securityLegendItem('强', strong, total, '#84cc16'),
    securityLegendItem('中', medium, total, '#f59e0b'),
    securityLegendItem('弱', weak, total, '#ef4444')
  ];
  const recommendation = weak
    ? `发现 ${weak} 个弱密码。建议先用密码生成器替换这些密码。`
    : reused
      ? `发现 ${reused} 个账号重复使用密码。建议为重要网站设置不同密码。`
      : unbound
        ? `还有 ${unbound} 个账号没有完整登录规则。绑定字段和登录按钮后，一键登录会更稳定。`
        : missingUsername
          ? `还有 ${missingUsername} 个账号缺少登录名。补全后自动填写会更准确。`
          : stale
            ? `还有 ${stale} 个账号超过一年未更新。建议核对密码和网站地址是否仍然有效。`
            : '当前账号没有明显本地风险，继续保持独立强密码。';

  return {
    total,
    weak,
    reused,
    exactDuplicates,
    bound,
    unbound,
    stale,
    missingUsername,
    score,
    level,
    levelTone,
    items,
    riskItems,
    legend,
    donutSegments: legend.filter((item) => item.count > 0),
    recommendation
  };
}

function securityLegendItem(label: string, count: number, total: number, color: string): SecurityLegendItem {
  return {
    label,
    count,
    percent: total ? Math.round((count / total) * 100) : 0,
    color
  };
}

function securityExactKey(credential: Credential): string {
  return [credential.domain || extractDomain(credential.url), credential.username, credential.password].join('\u001F').toLowerCase();
}

function PlaceholderPanel({ section }: { section: DashboardSection }) {
  return (
    <section className="tool-panel">
      <h2>{SECTION_LABELS[section]}</h2>
      <p>
        {section === 'authenticator'
          ? '这里会管理 TOTP 动态验证码。当前版本先保留入口，避免和登录密码混在一起。'
          : section === 'sharing'
            ? '共享中心会用于团队共享账号，后续需要权限和同步能力。'
            : '紧急访问会用于受信联系人恢复访问，后续需要独立授权流程。'}
      </p>
      <button type="button" disabled>
        即将支持
      </button>
    </section>
  );
}

function ItemModal({
  modal,
  onClose,
  folders,
  onSaveCredential,
  onSaveNote,
  onSaveIdentity,
  onSaveFolder,
  onMoveItem,
  onMoveFolder
}: {
  modal: NonNullable<ModalState>;
  onClose: () => void;
  folders: string[];
  onSaveCredential: (draft: CredentialDraft, existing?: Credential) => void;
  onSaveNote: (draft: NoteDraft, existing?: SecureNote) => void;
  onSaveIdentity: (draft: IdentityDraft, existing?: IdentityProfile) => void;
  onSaveFolder: (name: string, currentName?: string) => void;
  onMoveItem: (item: VaultItem, folderName: string) => void;
  onMoveFolder: (folderName: string, targetFolderName: string) => void;
}) {
  const [credentialDraft, setCredentialDraft] = useState(() =>
    modal.type === 'login' ? (modal.credential ? credentialToDraft(modal.credential) : emptyCredentialDraft(modal.folder ?? ROOT_FOLDER_NAME)) : emptyCredentialDraft()
  );
  const [loginPasswordVisible, setLoginPasswordVisible] = useState(false);
  const [siteLookup, setSiteLookup] = useState<{ status: 'idle' | 'loading' | 'done' | 'error'; message: string }>({
    status: 'idle',
    message: '输入网址后自动识别站点标题和图标。'
  });
  const [noteDraft, setNoteDraft] = useState(() => noteToDraft(modal.type === 'note' ? modal.note : undefined));
  const [identityDraft, setIdentityDraft] = useState(() =>
    modal.type === 'identity'
      ? identityToDraft(modal.identity)
      : modal.type === 'contact'
        ? modal.identity
          ? identityToDraft(modal.identity)
          : emptyIdentityDraft('联系人')
        : emptyIdentityDraft()
  );
  const [folderDraft, setFolderDraft] = useState(() => (modal.type === 'folder' ? modal.folder?.name ?? '' : ''));
  const [moveFolder, setMoveFolder] = useState(() => (modal.type === 'move' ? itemFolder(modal.item) : ROOT_FOLDER_NAME));
  const moveFolderOptions = modal.type === 'moveFolder' ? folders.filter((folder) => folder.toLowerCase() !== normalizeFolderLabel(modal.folderName).toLowerCase()) : folders;
  const title =
    modal.type === 'login'
      ? modal.credential
        ? '编辑登录'
        : '新建登录'
      : modal.type === 'note'
        ? modal.note
          ? '编辑保密笔记'
          : '新建保密笔记'
        : modal.type === 'identity'
          ? modal.identity
            ? '编辑个人信息'
            : '新建个人信息'
          : modal.type === 'contact'
            ? modal.identity
              ? '编辑联系人'
              : '新建联系人'
            : modal.type === 'folder'
              ? modal.folder
                ? '重命名文件夹'
                : '新建文件夹'
              : modal.type === 'moveFolder'
                ? '移动文件夹内容'
                : '移动到文件夹';
  const modalClass = `item-modal ${modal.type}-modal`;
  const modalEyebrow =
    modal.type === 'folder'
      ? modal.folder
        ? '更新文件夹'
        : '整理空间'
      : modal.type === 'move'
        ? '选择位置'
        : modal.type === 'moveFolder'
          ? '选择位置'
        : modal.type === 'login'
          ? '保存登录'
          : modal.type === 'note'
            ? '加密笔记'
            : '身份资料';
  const loginPreviewDomain = extractDomain(credentialDraft.url);
  const loginPreviewTitle = credentialDraft.title.trim() || loginPreviewDomain || '新登录项';
  const loginStrength = measurePasswordStrength(credentialDraft.password);

  useEffect(() => {
    if (modal.type !== 'login' || modal.credential) return;

    const rawUrl = credentialDraft.url.trim();
    if (!rawUrl || rawUrl.length < 4 || !rawUrl.includes('.')) {
      setSiteLookup({ status: 'idle', message: '输入网址后自动识别站点标题和图标。' });
      return;
    }

    let cancelled = false;
    const requestedUrl = normalizeUrl(rawUrl);
    setSiteLookup({ status: 'loading', message: '正在识别站点标题和图标...' });

    const timer = window.setTimeout(() => {
      void fetchSiteMetadata(requestedUrl)
        .then((metadata) => {
          if (cancelled) return;

          setCredentialDraft((current) => {
            if (normalizeUrl(current.url) !== requestedUrl) return current;

            const currentDomain = extractDomain(current.url);
            const nextTitle = metadata.title?.trim();
            const shouldUseTitle = Boolean(nextTitle && (!current.title.trim() || current.title.trim() === currentDomain));

            return {
              ...current,
              title: shouldUseTitle ? nextTitle! : current.title,
              iconUrl: toHttpIconUrl(metadata.iconUrl) ?? current.iconUrl,
              iconType: metadata.iconUrl ? metadata.iconType ?? 'favicon' : current.iconType
            };
          });

          setSiteLookup({
            status: metadata.ok ? 'done' : 'error',
            message: metadata.ok
              ? metadata.title
                ? `已识别：${metadata.title}`
                : '已识别图标，标题可手动填写。'
              : '暂时无法读取标题，仍可手动保存。'
          });
        })
        .catch(() => {
          if (!cancelled) {
            setSiteLookup({ status: 'error', message: '暂时无法读取标题，仍可手动保存。' });
          }
        });
    }, 520);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [credentialDraft.url, modal]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (modal.type === 'login') onSaveCredential(credentialDraft, modal.credential);
    if (modal.type === 'note') onSaveNote(noteDraft, modal.note);
    if (modal.type === 'identity' || modal.type === 'contact') onSaveIdentity(identityDraft, modal.identity);
    if (modal.type === 'folder') onSaveFolder(folderDraft, modal.folder?.name);
    if (modal.type === 'move') onMoveItem(modal.item, moveFolder);
    if (modal.type === 'moveFolder') onMoveFolder(modal.folderName, moveFolder);
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <form className={modalClass} onSubmit={submit}>
        <header>
          <span className="modal-title-block">
            <small>{modalEyebrow}</small>
            <h2>{title}</h2>
          </span>
          <button type="button" aria-label="关闭" onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        {modal.type === 'folder' ? (
          <section className="folder-create-body">
            <span className="modal-glyph">
              <FolderOpen size={24} />
            </span>
            <div>
              <strong>把相同项目放在一起</strong>
              <p>文件夹会保存到加密 Vault，之后可以在左侧直接查看。</p>
            </div>
            <Field label="文件夹名称" value={folderDraft} onChange={setFolderDraft} placeholder="例如：服务器、客户账号、工作" required />
          </section>
        ) : modal.type === 'move' ? (
          <section className="move-folder-body">
            <div className="move-target">
              <ItemIcon item={modal.item} />
              <span>
                <small>正在移动</small>
                <strong>{itemName(modal.item)}</strong>
                <em>当前文件夹：{itemFolder(modal.item)}</em>
              </span>
            </div>
            <FolderField label="目标文件夹" value={moveFolder} folders={folders} onChange={setMoveFolder} />
          </section>
        ) : modal.type === 'moveFolder' ? (
          <section className="move-folder-body">
            <div className="move-target">
              <span className="modal-glyph compact">
                <FolderOpen size={22} />
              </span>
              <span>
                <small>正在移动文件夹内容</small>
                <strong>{modal.folderName}</strong>
                <em>原文件夹会删除，项目会进入目标文件夹。</em>
              </span>
            </div>
            <FolderField label="目标文件夹" value={moveFolder} folders={moveFolderOptions} onChange={setMoveFolder} />
          </section>
        ) : modal.type === 'login' ? (
          <section className="login-create-body">
            <div className="login-preview-strip">
              <SiteIcon domain={loginPreviewDomain} url={credentialDraft.url} iconUrl={credentialDraft.iconUrl} />
              <span>
                <strong>{loginPreviewTitle}</strong>
                <small>{loginPreviewDomain || '输入网址后会自动识别域名'}</small>
              </span>
              <em>
                <ShieldCheck size={15} />
                本地加密
              </em>
            </div>
            {!modal.credential ? (
              <p className={`site-lookup-status ${siteLookup.status}`}>
                {siteLookup.status === 'loading' ? <RefreshCw size={14} /> : siteLookup.status === 'done' ? <Check size={14} /> : <Shield size={14} />}
                {siteLookup.message}
              </p>
            ) : null}

            <section className="login-fieldset">
              <header>
                <span>网站</span>
                <small>用于匹配网页和显示账号名称</small>
              </header>
              <div className="login-two-col">
                <Field label="名称" value={credentialDraft.title} onChange={(value) => setCredentialDraft((draft) => ({ ...draft, title: value }))} placeholder="例如：GitHub 工作号" required />
                <Field label="网址" value={credentialDraft.url} onChange={(value) => setCredentialDraft((draft) => ({ ...draft, url: value }))} placeholder="https://example.com/login" required />
              </div>
            </section>

            <section className="login-fieldset">
              <header>
                <span>凭据</span>
                <small>保存登录名和密码，稍后用于一键填写</small>
              </header>
              <div className="login-two-col">
                <Field label="用户名" value={credentialDraft.username} onChange={(value) => setCredentialDraft((draft) => ({ ...draft, username: value }))} placeholder="邮箱、用户名或手机号" />
                <PasswordField
                  label="密码"
                  value={credentialDraft.password}
                  visible={loginPasswordVisible}
                  onToggleVisible={() => setLoginPasswordVisible((visible) => !visible)}
                  onChange={(value) => setCredentialDraft((draft) => ({ ...draft, password: value }))}
                  required
                />
              </div>
              <span className={`login-strength s${loginStrength.score}`}>
                <Shield size={15} />
                {credentialDraft.password ? `密码强度：${loginStrength.label}` : '输入密码后显示强度'}
              </span>
            </section>

            <section className="login-fieldset">
              <header>
                <span>归档</span>
                <small>把账号放进指定文件夹，便于后续筛选</small>
              </header>
              <FolderField value={credentialDraft.folder} folders={folders} onChange={(value) => setCredentialDraft((draft) => ({ ...draft, folder: value }))} />
            </section>

            <section className="login-fieldset">
              <header>
                <span>备注</span>
                <small>可记录恢复邮箱、用途或安全提示</small>
              </header>
              <TextArea label="备注" value={credentialDraft.notes} onChange={(value) => setCredentialDraft((draft) => ({ ...draft, notes: value }))} placeholder="可选" rows={3} />
            </section>
          </section>
        ) : modal.type === 'note' ? (
          <>
            <Field label="标题" value={noteDraft.title} onChange={(value) => setNoteDraft((draft) => ({ ...draft, title: value }))} required />
            <FolderField value={noteDraft.folder} folders={folders} onChange={(value) => setNoteDraft((draft) => ({ ...draft, folder: value }))} />
            <TextArea label="笔记" value={noteDraft.note} onChange={(value) => setNoteDraft((draft) => ({ ...draft, note: value }))} />
          </>
        ) : (
          <>
            <Field label="资料名称" value={identityDraft.title} onChange={(value) => setIdentityDraft((draft) => ({ ...draft, title: value }))} required />
            <FolderField value={identityDraft.folder} folders={folders} onChange={(value) => setIdentityDraft((draft) => ({ ...draft, folder: value }))} />
            <Field label="姓名" value={identityDraft.fullName} onChange={(value) => setIdentityDraft((draft) => ({ ...draft, fullName: value }))} />
            <Field label="邮箱" value={identityDraft.email} onChange={(value) => setIdentityDraft((draft) => ({ ...draft, email: value }))} />
            <Field label="电话" value={identityDraft.phone} onChange={(value) => setIdentityDraft((draft) => ({ ...draft, phone: value }))} />
            <Field label="公司" value={identityDraft.company} onChange={(value) => setIdentityDraft((draft) => ({ ...draft, company: value }))} />
            <Field label="地址" value={identityDraft.address} onChange={(value) => setIdentityDraft((draft) => ({ ...draft, address: value }))} />
            <div className="modal-grid">
              <Field label="城市" value={identityDraft.city} onChange={(value) => setIdentityDraft((draft) => ({ ...draft, city: value }))} />
              <Field label="地区" value={identityDraft.region} onChange={(value) => setIdentityDraft((draft) => ({ ...draft, region: value }))} />
              <Field label="邮编" value={identityDraft.postalCode} onChange={(value) => setIdentityDraft((draft) => ({ ...draft, postalCode: value }))} />
              <Field label="国家" value={identityDraft.country} onChange={(value) => setIdentityDraft((draft) => ({ ...draft, country: value }))} />
            </div>
            <TextArea label="备注" value={identityDraft.notes} onChange={(value) => setIdentityDraft((draft) => ({ ...draft, notes: value }))} />
          </>
        )}
        <footer>
          <button type="button" onClick={onClose}>取消</button>
          <button className="primary" type="submit">
            <Check size={17} />
            {modal.type === 'folder' ? (modal.folder ? '重命名' : '创建') : modal.type === 'move' || modal.type === 'moveFolder' ? '移动' : '保存'}
          </button>
        </footer>
      </form>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  className,
  required
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  required?: boolean;
}) {
  return (
    <label className={className ? `field ${className}` : 'field'}>
      <span>{label}</span>
      <input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} required={required} />
    </label>
  );
}

function PasswordField({
  label,
  value,
  visible,
  onToggleVisible,
  onChange,
  required
}: {
  label: string;
  value: string;
  visible: boolean;
  onToggleVisible: () => void;
  onChange: (value: string) => void;
  required?: boolean;
}) {
  return (
    <label className="field password-entry-field">
      <span>{label}</span>
      <span className="password-entry-control">
        <input type={visible ? 'text' : 'password'} value={value} onChange={(event) => onChange(event.target.value)} required={required} />
        <button type="button" aria-label={visible ? '隐藏密码' : '显示密码'} title={visible ? '隐藏密码' : '显示密码'} onClick={onToggleVisible}>
          {visible ? <EyeOff size={17} /> : <Eye size={17} />}
        </button>
      </span>
    </label>
  );
}

function FolderField({ label = '文件夹', value, folders, onChange }: { label?: string; value: string; folders: string[]; onChange: (value: string) => void }) {
  const normalizedValue = normalizeFolderLabel(value);

  return (
    <div className="field folder-field">
      <span>{label}</span>
      <div className="folder-choice-list" role="listbox" aria-label={label}>
        {folders.map((folder) => (
          <button
            key={folder}
            className={normalizedValue === folder ? 'selected' : ''}
            type="button"
            role="option"
            aria-selected={normalizedValue === folder}
            onClick={() => onChange(folder)}
          >
            <FolderOpen size={16} />
            <span>{folder}</span>
          </button>
        ))}
      </div>
      <input value={value} onChange={(event) => onChange(event.target.value)} placeholder="输入新文件夹名称" />
      <small>选择已有文件夹，或直接输入一个新名称。</small>
    </div>
  );
}

function TextArea({
  label,
  value,
  onChange,
  placeholder,
  rows = 4
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <textarea value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} rows={rows} />
    </label>
  );
}
