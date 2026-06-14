import type { VaultPlain, VaultSettings } from './types';

export const KDF_ITERATIONS = 310000;

export const defaultSettings: VaultSettings = {
  language: 'zh-CN',
  defaultHomeSort: 'favorite',
  openStartPageOnLogin: true,
  openStartPageOnToolbarClick: false,
  showLoginBookmarksTogether: false,
  showContextMenuCommands: true,
  useCompactPopupToolbar: true,
  showWebBottomToolbar: false,
  autoLockMinutes: 0,
  lockOnStartup: false,
  lockOnStartupUserSet: false,
  highSecurityMode: false,
  autoPromptSave: true,
  autoFill: true,
  autoSubmit: false,
  clearClipboardSeconds: 30,
  requireMasterPasswordForReveal: false,
  blacklist: [],
  inlineBlacklist: [],
  siteRules: [],
  fillImportBatches: [],
  fillImportMappingTemplates: [],
  diagnosticLogging: false,
  diagnosticLogLimit: 50,
  diagnosticLogRetentionDays: 7
};

export function createEmptyVault(): VaultPlain {
  return {
    version: 1,
    credentials: [],
    secureNotes: [],
    identities: [],
    fillProfiles: [],
    folders: [],
    deletedItems: [],
    settings: { ...defaultSettings, blacklist: [], inlineBlacklist: [], siteRules: [], fillImportBatches: [], fillImportMappingTemplates: [] }
  };
}
