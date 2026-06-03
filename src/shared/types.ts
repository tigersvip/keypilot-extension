export type CredentialSource = 'manual' | 'roboform' | 'chrome' | 'edge' | 'generic';
export type CredentialIconType = 'favicon' | 'default' | 'custom';
export type CredentialFormFieldKind = 'username' | 'password' | 'text';

export interface CredentialFormField {
  label: string;
  name?: string;
  id?: string;
  selector?: string;
  type?: string;
  autocomplete?: string;
  placeholder?: string;
  ariaLabel?: string;
  value: string;
  kind: CredentialFormFieldKind;
  index?: number;
}

export interface CredentialSubmitTarget {
  selector?: string;
  text?: string;
  tagName?: string;
  type?: string;
  name?: string;
  id?: string;
  role?: string;
  index?: number;
}

export interface CredentialFormProfile {
  selector?: string;
  id?: string;
  name?: string;
  action?: string;
  method?: string;
  fieldCount?: number;
  passwordFieldCount?: number;
  submit?: CredentialSubmitTarget;
}

export type SubmitRepairAction = 'commit-fields' | 'wait-enabled-click' | 'retry-click' | 'click-nearby' | 'enter-password' | 'request-submit';
export type SiteRulePageMode = 'auto' | 'login' | 'register' | 'fill-profile';

export interface SiteRuleField {
  label: string;
  name?: string;
  id?: string;
  selector?: string;
  type?: string;
  autocomplete?: string;
  placeholder?: string;
  ariaLabel?: string;
  kind: CredentialFormFieldKind;
  index?: number;
}

export interface SiteRule {
  id: string;
  domain: string;
  pathPattern?: string;
  formFields?: SiteRuleField[];
  formProfile?: CredentialFormProfile;
  repairActions?: SubmitRepairAction[];
  pageMode?: SiteRulePageMode;
  disablePasswordGenerator?: boolean;
  source: 'manual-binding' | 'save-prompt' | 'auto-repair';
  successCount?: number;
  failureCount?: number;
  lastOutcome?: SubmitOutcomeStatus;
  createdAt: number;
  updatedAt: number;
}

export interface SiteRuleSummary {
  id: string;
  domain: string;
  pathPattern?: string;
  pageMode?: SiteRulePageMode;
  disablePasswordGenerator?: boolean;
  source: SiteRule['source'];
  updatedAt: number;
}

export interface Credential {
  id: string;
  title: string;
  url: string;
  domain: string;
  matchUrl?: string;
  matchDomain?: string;
  iconUrl?: string;
  iconType?: CredentialIconType;
  username: string;
  password: string;
  notes?: string;
  tags?: string[];
  folder?: string;
  formFields?: CredentialFormField[];
  formProfile?: CredentialFormProfile;
  pinned?: boolean;
  source?: CredentialSource;
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
}

export interface SecureNote {
  id: string;
  title: string;
  note: string;
  folder?: string;
  tags?: string[];
  pinned?: boolean;
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
}

export interface IdentityProfile {
  id: string;
  title: string;
  fullName?: string;
  email?: string;
  phone?: string;
  company?: string;
  address?: string;
  city?: string;
  region?: string;
  postalCode?: string;
  country?: string;
  notes?: string;
  folder?: string;
  tags?: string[];
  pinned?: boolean;
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
}

export type FillProfileCategory = 'identity' | 'auto_insurance' | 'shipping' | 'billing' | 'payment' | 'business' | 'loan' | 'custom';
export type FillFieldGroup =
  | 'personal'
  | 'contact'
  | 'address'
  | 'driver'
  | 'vehicle'
  | 'insurance'
  | 'payment'
  | 'business'
  | 'loan'
  | 'employment'
  | 'finance'
  | 'sensitive'
  | 'custom';
export type FillFieldSensitivity = 'normal' | 'private' | 'secret';

export interface FillField {
  key: string;
  label: string;
  value: string;
  group: FillFieldGroup;
  sensitivity: FillFieldSensitivity;
  aliases?: string[];
  sourceColumn?: string;
}

export interface FillFieldBinding {
  key: string;
  label?: string;
  selector?: string;
  name?: string;
  id?: string;
  tagName?: string;
  type?: string;
  autocomplete?: string;
  placeholder?: string;
  controlLabel?: string;
  index?: number;
}

export interface FillProfileSiteBinding {
  id: string;
  domain: string;
  pathPattern?: string;
  fields: FillFieldBinding[];
  createdAt: number;
  updatedAt: number;
  successCount?: number;
  failureCount?: number;
}

export interface FillProfile {
  id: string;
  title: string;
  countryCode: string;
  locale?: string;
  category: FillProfileCategory;
  folder?: string;
  fields: FillField[];
  siteBindings?: FillProfileSiteBinding[];
  tags?: string[];
  pinned?: boolean;
  source?: 'manual' | 'excel' | 'csv' | 'kpfill';
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
}

export interface FillProfilePayload {
  id: string;
  title: string;
  countryCode: string;
  category: FillProfileCategory;
  fields: FillField[];
  siteBinding?: FillProfileSiteBinding;
  onlyEmpty?: boolean;
}

export interface FillProfileDiagnostic {
  key: string;
  label: string;
  status: 'filled' | 'matched' | 'skipped' | 'missing';
  controlLabel?: string;
  score?: number;
  binding?: boolean;
}

export interface FillProfileFillResult {
  ok: boolean;
  error?: string;
  filledCount: number;
  matchedCount: number;
  skippedCount: number;
  totalFields: number;
  diagnostics?: FillProfileDiagnostic[];
}

export interface FillProfileBindingResult {
  profileId: string;
  url: string;
  domain: string;
  fields: FillFieldBinding[];
}

export interface VaultFolder {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}

export type DeletedVaultItem =
  | {
      id: string;
      kind: 'credential';
      deletedAt: number;
      item: Credential;
    }
  | {
      id: string;
      kind: 'secureNote';
      deletedAt: number;
      item: SecureNote;
    }
  | {
      id: string;
      kind: 'identity';
      deletedAt: number;
      item: IdentityProfile;
    }
  | {
      id: string;
      kind: 'fillProfile';
      deletedAt: number;
      item: FillProfile;
    };

export interface VaultSettings {
  language: 'zh-CN' | 'en-US';
  defaultHomeSort: 'favorite' | 'recent' | 'az';
  openStartPageOnLogin: boolean;
  openStartPageOnToolbarClick: boolean;
  showLoginBookmarksTogether: boolean;
  showContextMenuCommands: boolean;
  useCompactPopupToolbar: boolean;
  showWebBottomToolbar: boolean;
  autoLockMinutes: number;
  lockOnStartup: boolean;
  lockOnStartupUserSet?: boolean;
  highSecurityMode: boolean;
  autoPromptSave: boolean;
  autoFill: boolean;
  autoSubmit: boolean;
  clearClipboardSeconds: number;
  requireMasterPasswordForReveal: boolean;
  blacklist: string[];
  inlineBlacklist?: string[];
  siteRules?: SiteRule[];
  fillImportBatches?: FillImportBatchRecord[];
}

export interface FillImportBatchRecord {
  sourceKey: string;
  sourceName: string;
  sourceType: 'xlsx' | 'csv' | 'kpfill';
  category: FillProfileCategory;
  countryCode: string;
  totalRows: number;
  importedCount: number;
  nextOffset: number;
  prefix: string;
  numberStart: number;
  numberPadding: number;
  order: 'source' | 'reverse' | 'titleAsc' | 'titleDesc';
  createdAt: number;
  updatedAt: number;
}

export interface VaultPlain {
  version: 1;
  credentials: Credential[];
  secureNotes?: SecureNote[];
  identities?: IdentityProfile[];
  fillProfiles?: FillProfile[];
  folders?: VaultFolder[];
  deletedItems?: DeletedVaultItem[];
  settings: VaultSettings;
}

export interface VaultEncrypted {
  version: 1;
  kdf: {
    name: 'PBKDF2';
    hash: 'SHA-256';
    iterations: 310000;
    salt: string;
  };
  cipher: {
    name: 'AES-GCM';
    iv: string;
  };
  encryptedData: string;
  verifier: string;
  recovery?: {
    version: 1;
    kdf: {
      name: 'PBKDF2';
      hash: 'SHA-256';
      iterations: 310000;
      salt: string;
    };
    cipher: {
      name: 'AES-GCM';
      iv: string;
    };
    encryptedKey: string;
    createdAt: number;
  };
}

export interface LicenseInfo {
  userId?: string;
  plan: 'free' | 'pro' | 'team';
  features: string[];
  expiresAt?: number;
  deviceLimit?: number;
  issuedAt?: number;
  signature?: string;
}

export interface UnlockedVaultSession {
  key: CryptoKey;
  vault: VaultPlain;
  encryptedVault: VaultEncrypted;
}

export type VaultStatus = 'checking' | 'setup' | 'locked' | 'unlocked';

export type CredentialAction = 'login' | 'fill' | 'goto';

export interface FillCredentialPayload {
  id: string;
  url: string;
  domain: string;
  username: string;
  password: string;
  autoSubmit: boolean;
  formFields?: CredentialFormField[];
  formProfile?: CredentialFormProfile;
  siteRuleId?: string;
  repairActions?: SubmitRepairAction[];
}

export type FillStage = 'complete' | 'usernameOnly' | 'passwordOnly';
export type SubmitOutcomeStatus = 'checking' | 'navigated' | 'successLikely' | 'stillOnLogin' | 'errorVisible' | 'blocked' | 'unknown';

export interface SubmitOutcome {
  status: SubmitOutcomeStatus;
  message: string;
  credentialId?: string;
  url?: string;
  checkedAt: number;
  errorText?: string;
  repairAction?: SubmitRepairAction;
}

export interface FillCredentialResult {
  ok: boolean;
  error?: string;
  stage?: FillStage;
  filledUsername?: boolean;
  filledPassword?: boolean;
  submitted?: boolean;
  skippedSubmit?: boolean;
  submitButtonMissing?: boolean;
  unsafeReason?: string;
  submitOutcome?: SubmitOutcome;
}

export interface InlineCredentialSummary {
  id: string;
  title: string;
  url?: string;
  domain: string;
  matchUrl?: string;
  matchDomain?: string;
  username: string;
  iconUrl?: string;
  iconType?: CredentialIconType;
  lastUsedAt?: number;
}

export interface InlineFillProfileSummary {
  id: string;
  title: string;
  countryCode: string;
  category: FillProfileCategory;
  summary: string;
  fieldCount: number;
  fields: FillField[];
  siteBinding?: FillProfileSiteBinding;
  lastUsedAt?: number;
}

export interface SiteMetadataResult {
  ok: boolean;
  url?: string;
  domain?: string;
  title?: string;
  iconUrl?: string;
  iconType?: CredentialIconType;
  error?: string;
}

export interface InlineCredentialMatchesResult {
  ok: boolean;
  error?: string;
  locked?: boolean;
  hidden?: boolean;
  autoSubmit?: boolean;
  matches?: InlineCredentialSummary[];
  fillProfiles?: InlineFillProfileSummary[];
  siteRule?: SiteRuleSummary;
}

export interface InlineCredentialFillRequest {
  credentialId: string;
  action: 'login' | 'fill';
}

export interface InlineFillProfileFillRequest {
  profileId: string;
  onlyEmpty?: boolean;
  recordUse?: boolean;
}

export interface BindingTestResult {
  ok: boolean;
  error?: string;
  matchedFields: number;
  totalFields: number;
  hasSubmit: boolean;
  submitMatched: boolean;
  message: string;
}

export interface ManualBindingResult {
  credentialId: string;
  url: string;
  domain: string;
  formFields: CredentialFormField[];
  formProfile: CredentialFormProfile;
}

export interface RecognitionRuleApplyRequest {
  url?: string;
  domain?: string;
  pathPattern?: string;
  pageMode?: SiteRulePageMode;
  disablePasswordGenerator?: boolean;
  formFields?: CredentialFormField[];
  formProfile?: CredentialFormProfile;
  repairActions?: SubmitRepairAction[];
}

export interface RecognitionRuleApplyResult {
  ok: boolean;
  error?: string;
  locked?: boolean;
  siteRule?: SiteRuleSummary;
}

export type InlineCredentialCommand = 'goto' | 'edit' | 'rename' | 'delete' | 'hide-domain';

export interface InlineCredentialCommandResult {
  ok: boolean;
  error?: string;
  locked?: boolean;
  hidden?: boolean;
  message?: string;
}

export interface InlineFrameDiagnostic {
  frameId?: number;
  url: string;
  domain: string;
  hasLoginForm: boolean;
  hasUsernameField: boolean;
  hasPasswordField: boolean;
  matchedCount: number;
  unsafeReason?: string;
  error?: string;
  submitOutcome?: SubmitOutcome;
}

export interface InlineDiagnosticsResult {
  ok: boolean;
  error?: string;
  locked?: boolean;
  tabUrl?: string;
  tabDomain?: string;
  hasLoginForm?: boolean;
  matchedCount?: number;
  submitOutcome?: SubmitOutcome;
  frames?: InlineFrameDiagnostic[];
}

export interface PendingLoginCandidate {
  id: string;
  title: string;
  url: string;
  domain: string;
  iconUrl?: string;
  iconType?: CredentialIconType;
  username: string;
  password: string;
  formFields?: CredentialFormField[];
  formProfile?: CredentialFormProfile;
  capturedAt: number;
  source?: 'submit' | 'click' | 'enter' | 'input';
}
