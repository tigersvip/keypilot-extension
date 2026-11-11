import { defaultSettings } from './defaults';
import type { VaultSettings } from './types';

export const backupSettingsGroups = [
  { key: 'preferences', label: '插件偏好与安全设置' },
  { key: 'blacklists', label: '黑名单与静默规则' },
  { key: 'siteRules', label: '站点识别规则' },
  { key: 'fillMappings', label: '字段映射模板与导入进度' }
] as const;
export type BackupSettingsGroup = typeof backupSettingsGroups[number]['key'];
export type BackupSettingsSelection = Partial<Record<BackupSettingsGroup, boolean>>;

function groupFor(key: string): BackupSettingsGroup {
  if (['blacklist', 'inlineBlacklist', 'inlineSilentRules'].includes(key)) return 'blacklists';
  if (key === 'siteRules'||key==='captchaSiteRules'||key==='autoTotpOrigins'||key==='siteLoginSettings') return 'siteRules';
  if (['fillImportMappingTemplates', 'fillImportBatches'].includes(key)) return 'fillMappings';
  return 'preferences';
}

export function stableBackupJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
}

export function backupSettingsSnapshot(settings: VaultSettings): string {
  const { backupExport: _export, ...values } = { ...defaultSettings, ...settings };
  return stableBackupJson(values);
}

export function backupSettingsChanges(current: VaultSettings, incoming: VaultSettings) {
  const before = JSON.parse(backupSettingsSnapshot(current)) as Record<string, unknown>;
  const after = JSON.parse(backupSettingsSnapshot(incoming)) as Record<string, unknown>;
  return backupSettingsGroups.map(group => ({ ...group, changed: [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter(key => groupFor(key) === group.key && stableBackupJson(before[key]) !== stableBackupJson(after[key])).length }));
}

export function mergeBackupSettings(current: VaultSettings, incoming: VaultSettings, selected: BackupSettingsSelection): VaultSettings {
  const result = { ...current } as unknown as Record<string, unknown>;
  const source = { ...defaultSettings, ...incoming } as unknown as Record<string, unknown>;
  for (const key of new Set([...Object.keys(result), ...Object.keys(source)])) {
    if (key === 'backupExport' || !selected[groupFor(key)]) continue;
    if (key in source) result[key] = source[key]; else delete result[key];
  }
  return result as unknown as VaultSettings;
}
