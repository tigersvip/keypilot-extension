import type { VaultPlain } from './types';

export const backupCollections = [
  { key: 'credentials', label: '登录账号' },
  { key: 'totpAccounts', label: '身份验证器（2FA）' },
  { key: 'reminders', label: '提醒与确认状态' },
  { key: 'secureNotes', label: '保密笔记' },
  { key: 'identities', label: '个人信息' },
  { key: 'fillProfiles', label: '填表资料' },
  { key: 'folders', label: '文件夹' },
  { key: 'deletedItems', label: '回收站' }
] as const;

export function backupInventory(vault: VaultPlain) {
  return backupCollections.map(({ key, label }) => ({ key, label, count: vault[key]?.length ?? 0 }));
}
