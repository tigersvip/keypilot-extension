import { backupInventory } from './backupInventory';
import type { VaultPlain } from './types';

export function BackupContents({ vault }: { vault: VaultPlain }) {
  const settings = vault.settings;
  return <div className="kp-backup-contents" aria-label="完整备份内容">
    <div className="kp-backup-counts">{backupInventory(vault).map(item => <span key={item.key}>{item.label} <strong>{item.count}</strong></span>)}</div>
    <p>包含插件设置、黑名单、站点规则 {settings.siteRules?.length ?? 0} 条、字段映射模板 {settings.fillImportMappingTemplates?.length ?? 0} 份及导入进度。</p>
    <p>提醒事项、确认状态、提醒开关和声音设置一起加密备份；恢复后会重新安排提醒。</p>
    <p>2FA 的密钥和生成参数一起加密保存，恢复后无需重新扫码。包含已移除记录；不包含浏览器权限、临时会话和诊断日志。</p>
  </div>;
}
