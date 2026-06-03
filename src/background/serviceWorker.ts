import { credentialMatchesUrl, domainsMatch, extractDomain, extractMatchDomain, normalizeMatchUrl, normalizeUrl } from '../shared/domain';
import { getRootFaviconUrl, toHttpIconUrl } from '../shared/icons';
import {
  addCredentialToVault,
  buildCredential,
  deleteCredentialFromVault,
  deleteFillProfileFromVault,
  persistVaultSession,
  restoreCachedVaultSession,
  touchCredentialInVault,
  updateCredentialInVault,
  updateFillProfileInVault,
  upsertVaultSettings
} from '../shared/vault';
import type {
  Credential,
  CredentialFormField,
  BindingTestResult,
  InlineCredentialCommand,
  FillCredentialPayload,
  FillCredentialResult,
  FillProfileBindingResult,
  FillProfileFillResult,
  FillProfilePayload,
  FillProfile,
  FillProfileSiteBinding,
  InlineFillProfileFillRequest,
  InlineFillProfileSummary,
  InlineCredentialFillRequest,
  InlineCredentialCommandResult,
  InlineDiagnosticsResult,
  InlineFrameDiagnostic,
  InlineCredentialSummary,
  ManualBindingResult,
  PendingLoginCandidate,
  RecognitionRuleApplyRequest,
  RecognitionRuleApplyResult,
  SiteMetadataResult,
  SiteRule,
  SiteRuleField,
  SiteRulePageMode,
  SiteRuleSummary,
  SubmitOutcome,
  SubmitRepairAction,
  UnlockedVaultSession
} from '../shared/types';

interface PendingFill {
  credential: FillCredentialPayload;
  createdAt: number;
  attempts: number;
}

interface PendingBinding {
  credentialId: string;
  createdAt: number;
  attempts: number;
}

interface PendingBindingTest {
  credentialId: string;
  createdAt: number;
  attempts: number;
}

interface StagedLoginCandidate {
  candidate: PendingLoginCandidate;
  createdAt: number;
}

type FrameCredential = Pick<Credential, 'domain' | 'url' | 'matchUrl' | 'matchDomain'>;

const pendingFills = new Map<number, PendingFill>();
const pendingBindings = new Map<number, PendingBinding>();
const pendingBindingTests = new Map<number, PendingBindingTest>();
const pendingSubmitOutcomes = new Map<number, SubmitOutcome>();
const stagedLoginCandidates = new Map<number, StagedLoginCandidate>();
const recordedSubmitOutcomeKeys = new Set<string>();
const SUBMIT_OUTCOME_TTL = 30000;
const STAGED_CANDIDATE_TTL = 90000;
const SITE_RULE_LIMIT = 120;
const DEFAULT_REPAIR_ACTIONS: SubmitRepairAction[] = ['commit-fields', 'wait-enabled-click', 'retry-click', 'click-nearby', 'enter-password', 'request-submit'];
const CONTENT_SCRIPT_FILE = 'content.js';
let pendingLoginCandidate: PendingLoginCandidate | null = null;
let pendingLoginCandidateExpiresAt = 0;
let savePolicy = {
  autoPromptSave: true,
  blacklist: [] as string[]
};

type SaveCandidateMode = 'save' | 'update' | 'new' | 'skip' | 'blacklist';

interface SaveCandidateContext {
  ok: boolean;
  ignored?: boolean;
  duplicate?: boolean;
  locked?: boolean;
  error?: string;
  existing?: {
    title: string;
    username: string;
  };
  candidateId?: string;
}

chrome.runtime.onInstalled.addListener(() => {
  void chrome.action.setBadgeText({ text: '' });
  scheduleOpenTabContentInjection();
});

chrome.runtime.onStartup.addListener(() => {
  scheduleOpenTabContentInjection();
});

function isSupportedOpenUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function pingContentScript(tabId: number): Promise<boolean> {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: 'KEYPILOT_CONTENT_PING' }, (response) => {
      resolve(!chrome.runtime.lastError && Boolean(response));
    });
  });
}

function executeContentScript(tabId: number, allFrames: boolean): Promise<boolean> {
  return new Promise((resolve) => {
    if (!chrome.scripting?.executeScript) {
      resolve(false);
      return;
    }

    chrome.scripting.executeScript(
      {
        target: { tabId, allFrames },
        files: [CONTENT_SCRIPT_FILE]
      },
      () => {
        resolve(!chrome.runtime.lastError);
      }
    );
  });
}

async function ensureContentScriptInTab(tabId: number, url: string | undefined) {
  if (!url || !isSupportedOpenUrl(url)) return;
  if (await pingContentScript(tabId)) return;

  const injectedAllFrames = await executeContentScript(tabId, true);
  if (!injectedAllFrames) {
    await executeContentScript(tabId, false);
  }
}

function scheduleOpenTabContentInjection(delay = 900) {
  setTimeout(() => {
    chrome.tabs.query({}, (tabs) => {
      if (chrome.runtime.lastError) return;

      for (const tab of tabs) {
        if (typeof tab.id !== 'number') continue;
        void ensureContentScriptInTab(tab.id, tab.url);
      }
    });
  }, delay);
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || 'UNKNOWN_ERROR');
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code: string) => String.fromCharCode(parseInt(code, 16)));
}

function stripTitleSuffix(title: string, domain?: string): string {
  const normalized = title.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';

  const parts = normalized.split(/\s*(?:[-–—|·•»]\s*)/).map((part) => part.trim()).filter(Boolean);
  if (parts.length <= 1) return normalized.slice(0, 80);

  const domainRoot = domain?.split('.')[0]?.toLowerCase() ?? '';
  const matchingPart = parts.find((part) => domainRoot && part.toLowerCase().includes(domainRoot));
  return (matchingPart ?? parts[0]).slice(0, 80);
}

function readAttribute(tag: string, name: string): string | undefined {
  const pattern = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'=<>` + '`' + `]+))`, 'i');
  const match = tag.match(pattern);
  return match?.[2] ?? match?.[3] ?? match?.[4];
}

function resolveSiteAssetUrl(baseUrl: string, value?: string): string | undefined {
  if (!value || /^data:/i.test(value) || /^javascript:/i.test(value)) return undefined;

  try {
    const parsed = new URL(value, baseUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    return parsed.href;
  } catch {
    return undefined;
  }
}

function scoreIconRel(rel: string, href: string): number {
  const haystack = `${rel} ${href}`.toLowerCase();
  let score = 0;
  if (haystack.includes('apple-touch-icon')) score += 70;
  if (haystack.includes('shortcut icon')) score += 85;
  if (/\bicon\b/.test(haystack)) score += 80;
  if (haystack.includes('favicon')) score += 16;
  if (haystack.includes('svg')) score += 8;
  if (/32x32|64x64|128x128|180x180|192x192/.test(haystack)) score += 10;
  return score;
}

function extractSiteMetadataFromHtml(url: string, html: string): SiteMetadataResult {
  const domain = extractDomain(url);
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? stripTitleSuffix(decodeHtmlEntities(titleMatch[1]), domain) : '';
  const icons = Array.from(html.matchAll(/<link\b[^>]*>/gi))
    .map((match) => match[0])
    .map((tag) => {
      const rel = readAttribute(tag, 'rel') ?? '';
      const href = readAttribute(tag, 'href') ?? '';
      const iconUrl = resolveSiteAssetUrl(url, href);
      return {
        iconUrl,
        score: iconUrl && /(icon|apple-touch-icon|shortcut)/i.test(rel) ? scoreIconRel(rel, iconUrl) : 0
      };
    })
    .filter((item): item is { iconUrl: string; score: number } => Boolean(item.iconUrl && item.score))
    .sort((left, right) => right.score - left.score);
  const iconUrl = toHttpIconUrl(icons[0]?.iconUrl) ?? getRootFaviconUrl(url);

  return {
    ok: true,
    url,
    domain,
    title: title || undefined,
    iconUrl,
    iconType: iconUrl ? 'favicon' : 'default'
  };
}

async function fetchSiteMetadata(inputUrl: string | undefined): Promise<SiteMetadataResult> {
  const normalizedUrl = normalizeUrl(inputUrl ?? '');

  if (!normalizedUrl || !isSupportedOpenUrl(normalizedUrl)) {
    return { ok: false, error: 'INVALID_SITE_URL' };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);

  try {
    const response = await fetch(normalizedUrl, {
      credentials: 'omit',
      redirect: 'follow',
      signal: controller.signal
    });
    const finalUrl = response.url || normalizedUrl;
    const contentType = response.headers.get('content-type') ?? '';

    if (!response.ok) {
      return {
        ok: false,
        url: finalUrl,
        domain: extractDomain(finalUrl),
        iconUrl: getRootFaviconUrl(finalUrl),
        iconType: getRootFaviconUrl(finalUrl) ? 'favicon' : 'default',
        error: `HTTP_${response.status}`
      };
    }

    if (contentType && !/html|xml|text/i.test(contentType)) {
      return {
        ok: true,
        url: finalUrl,
        domain: extractDomain(finalUrl),
        iconUrl: getRootFaviconUrl(finalUrl),
        iconType: getRootFaviconUrl(finalUrl) ? 'favicon' : 'default'
      };
    }

    const html = (await response.text()).slice(0, 524288);
    return extractSiteMetadataFromHtml(finalUrl, html);
  } catch (error) {
    return {
      ok: false,
      url: normalizedUrl,
      domain: extractDomain(normalizedUrl),
      iconUrl: getRootFaviconUrl(normalizedUrl),
      iconType: getRootFaviconUrl(normalizedUrl) ? 'favicon' : 'default',
      error: error instanceof Error ? error.message : 'SITE_META_FETCH_FAILED'
    };
  } finally {
    clearTimeout(timeout);
  }
}

function getTabDomain(url?: string): string {
  if (!url) return '';
  return extractDomain(url);
}

function credentialMatchesTab(credential: Pick<Credential, 'domain' | 'matchUrl' | 'matchDomain'>, tabUrl?: string): boolean {
  return credentialMatchesUrl(credential, tabUrl);
}

function domainMatchesList(domain: string, domains: string[] = []): boolean {
  return Boolean(domain && domains.some((item) => domainsMatch(item, domain)));
}

function isInlineHiddenForTab(session: UnlockedVaultSession, tabUrl?: string): boolean {
  const tabDomain = getTabDomain(tabUrl);
  return domainMatchesList(tabDomain, session.vault.settings.inlineBlacklist ?? []);
}

function toInlineSummary(credential: Credential): InlineCredentialSummary {
  return {
    id: credential.id,
    title: credential.title,
    url: credential.url,
    domain: credential.domain,
    matchUrl: credential.matchUrl,
    matchDomain: credential.matchDomain,
    username: credential.username,
    iconUrl: credential.iconUrl,
    iconType: credential.iconType,
    lastUsedAt: credential.lastUsedAt
  };
}

function fillFieldValue(profile: FillProfile, key: string): string {
  return profile.fields.find((field) => field.key === key)?.value ?? '';
}

function fillProfileInlineSummary(profile: FillProfile): string {
  const fullName =
    fillFieldValue(profile, 'fullName') ||
    [fillFieldValue(profile, 'firstName'), fillFieldValue(profile, 'lastName')].filter(Boolean).join(' ');
  const businessName = fillFieldValue(profile, 'businessName') || fillFieldValue(profile, 'dbaName');
  const email = fillFieldValue(profile, 'email') || fillFieldValue(profile, 'businessEmail');
  const phone = fillFieldValue(profile, 'phone') || fillFieldValue(profile, 'businessPhone');
  const loanAmount = fillFieldValue(profile, 'loanAmount');
  const vehicle = [fillFieldValue(profile, 'vehicleYear'), fillFieldValue(profile, 'vehicleMake'), fillFieldValue(profile, 'vehicleModel')]
    .filter(Boolean)
    .join(' ');

  return businessName || loanAmount || fullName || email || phone || vehicle || `${profile.fields.length} 个字段`;
}

function toInlineFillProfileSummary(profile: FillProfile, targetUrl?: string): InlineFillProfileSummary {
  return {
    id: profile.id,
    title: profile.title,
    countryCode: profile.countryCode,
    category: profile.category,
    summary: fillProfileInlineSummary(profile),
    fieldCount: profile.fields.length,
    fields: profile.fields,
    siteBinding: selectFillProfileSiteBinding(profile, targetUrl),
    lastUsedAt: profile.lastUsedAt
  };
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

function withCredentialFieldValue(field: CredentialFormField, credential: Credential): CredentialFormField {
  if (field.kind === 'username') {
    return { ...field, value: credential.username };
  }

  if (field.kind === 'password') {
    return { ...field, value: credential.password };
  }

  return field;
}

function siteRuleFieldToCredentialField(field: SiteRuleField, credential: Credential): CredentialFormField | null {
  if (field.kind !== 'username' && field.kind !== 'password') return null;

  return {
    ...field,
    value: field.kind === 'username' ? credential.username : credential.password
  };
}

function normalizeRulePathPattern(value?: string): string | undefined {
  const text = (value ?? '').trim();
  if (!text || text === '*') return undefined;

  return text.startsWith('/') ? text : `/${text}`;
}

function siteRulePathFromUrl(value?: string): string | undefined {
  if (!value || !/^https?:\/\//i.test(value)) return undefined;

  try {
    const pathname = new URL(value).pathname || '/';
    return pathname === '/' ? undefined : pathname;
  } catch {
    return undefined;
  }
}

function siteRulePathMatches(rule: SiteRule, urlOrDomain?: string): boolean {
  const pattern = normalizeRulePathPattern(rule.pathPattern);
  if (!pattern) return true;
  if (!urlOrDomain || !/^https?:\/\//i.test(urlOrDomain)) return false;

  try {
    const path = new URL(urlOrDomain).pathname || '/';
    if (pattern.endsWith('*')) return path.startsWith(pattern.slice(0, -1));
    return path === pattern || path.startsWith(`${pattern.replace(/\/$/, '')}/`);
  } catch {
    return false;
  }
}

function toSiteRuleSummary(rule: SiteRule | undefined): SiteRuleSummary | undefined {
  return rule
    ? {
        id: rule.id,
        domain: rule.domain,
        pathPattern: rule.pathPattern,
        pageMode: rule.pageMode,
        disablePasswordGenerator: rule.disablePasswordGenerator,
        source: rule.source,
        updatedAt: rule.updatedAt
      }
    : undefined;
}

function selectSiteRule(vault: Pick<UnlockedVaultSession['vault'], 'settings'> | undefined, urlOrDomain?: string): SiteRule | undefined {
  const domain = getTabDomain(urlOrDomain) || extractDomain(urlOrDomain || '');
  if (!domain) return undefined;

  return (vault?.settings.siteRules ?? [])
    .filter((rule) => domainsMatch(rule.domain, domain))
    .filter((rule) => siteRulePathMatches(rule, urlOrDomain))
    .sort((left, right) => {
      const leftPathSpecificity = normalizeRulePathPattern(left.pathPattern)?.length ?? 0;
      const rightPathSpecificity = normalizeRulePathPattern(right.pathPattern)?.length ?? 0;
      if (leftPathSpecificity !== rightPathSpecificity) return rightPathSpecificity - leftPathSpecificity;
      const leftScore = (left.successCount ?? 0) - (left.failureCount ?? 0);
      const rightScore = (right.successCount ?? 0) - (right.failureCount ?? 0);
      if (leftScore !== rightScore) return rightScore - leftScore;
      return right.updatedAt - left.updatedAt;
    })[0];
}

function mergeCredentialFields(credential: Credential, siteRule?: SiteRule): Credential['formFields'] {
  const ruleFields = (siteRule?.formFields ?? [])
    .map((field) => siteRuleFieldToCredentialField(field, credential))
    .filter((field): field is CredentialFormField => Boolean(field));
  const credentialFields = (credential.formFields ?? []).map((field) => withCredentialFieldValue(field, credential));

  if (!ruleFields.length) {
    return credentialFields.length ? credentialFields : undefined;
  }

  const seen = new Set<string>();
  const merged = [...ruleFields, ...credentialFields].filter((field) => {
    const key = `${field.kind}:${field.selector ?? field.id ?? field.name ?? field.index ?? field.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return merged.length ? merged.slice(0, 40) : undefined;
}

function credentialToFillPayload(credential: Credential, autoSubmit = false, vault?: UnlockedVaultSession['vault'], targetUrl = credential.url): FillCredentialPayload {
  const siteRule = selectSiteRule(vault, targetUrl || credential.url || credential.domain);

  return {
    id: credential.id,
    url: credential.url,
    domain: credential.domain,
    username: credential.username,
    password: credential.password,
    autoSubmit,
    formFields: mergeCredentialFields(credential, siteRule),
    formProfile: siteRule?.formProfile ?? credential.formProfile,
    siteRuleId: siteRule?.id,
    repairActions: siteRule?.repairActions ?? DEFAULT_REPAIR_ACTIONS
  };
}

function selectFillProfileSiteBinding(profile: FillProfile, targetUrl?: string): FillProfileSiteBinding | undefined {
  const domain = getTabDomain(targetUrl);
  if (!domain) return undefined;

  return (profile.siteBindings ?? [])
    .filter((binding) => domainsMatch(binding.domain, domain))
    .sort((left, right) => {
      const leftScore = (left.successCount ?? 0) - (left.failureCount ?? 0);
      const rightScore = (right.successCount ?? 0) - (right.failureCount ?? 0);
      if (leftScore !== rightScore) return rightScore - leftScore;
      return right.updatedAt - left.updatedAt;
    })[0];
}

function fillProfileToPayload(profile: FillProfile, targetUrl?: string, onlyEmpty = true): FillProfilePayload {
  return {
    id: profile.id,
    title: profile.title,
    countryCode: profile.countryCode,
    category: profile.category,
    fields: profile.fields,
    siteBinding: selectFillProfileSiteBinding(profile, targetUrl),
    onlyEmpty
  };
}

async function resolveFillProfilePayload(payload: FillProfilePayload, targetUrl?: string): Promise<FillProfilePayload> {
  const session = await restoreCachedVaultSession();
  const profile = session?.vault.fillProfiles?.find((item) => item.id === payload.id);
  return profile ? fillProfileToPayload(profile, targetUrl, payload.onlyEmpty ?? true) : payload;
}

function upsertSiteRuleFromForm(
  vault: UnlockedVaultSession['vault'],
  input: {
    domain?: string;
    url?: string;
    formFields?: Credential['formFields'];
    formProfile?: Credential['formProfile'];
    pathPattern?: string;
    pageMode?: SiteRulePageMode;
    disablePasswordGenerator?: boolean;
    repairActions?: SubmitRepairAction[];
    source: SiteRule['source'];
  }
): UnlockedVaultSession['vault'] {
  const domain = extractDomain(input.url || input.domain || '');
  const pathPattern = normalizeRulePathPattern(input.pathPattern);
  const hasFieldSelectors = Boolean(input.formFields?.some((field) => field.selector || field.id || field.name));
  const hasProfile = Boolean(input.formProfile?.submit || input.formProfile?.selector);
  const hasOverride = Boolean(input.pageMode && input.pageMode !== 'auto') || input.disablePasswordGenerator !== undefined;

  if (!domain || (!hasFieldSelectors && !hasProfile && !hasOverride)) {
    return vault;
  }

  const existingRules = vault.settings.siteRules ?? [];
  const existing = existingRules.find((rule) => domainsMatch(rule.domain, domain) && (normalizeRulePathPattern(rule.pathPattern) ?? '') === (pathPattern ?? ''));
  const now = Date.now();
  const nextRule: SiteRule = {
    id: existing?.id ?? crypto.randomUUID(),
    domain,
    pathPattern,
    formFields: input.formFields?.map(stripSiteRuleFieldValue).slice(0, 40),
    formProfile: input.formProfile ?? existing?.formProfile,
    repairActions: input.repairActions?.length ? input.repairActions : existing?.repairActions ?? DEFAULT_REPAIR_ACTIONS,
    pageMode: input.pageMode ?? existing?.pageMode,
    disablePasswordGenerator: input.disablePasswordGenerator ?? existing?.disablePasswordGenerator,
    source: input.source,
    successCount: existing?.successCount ?? 0,
    failureCount: existing?.failureCount ?? 0,
    lastOutcome: existing?.lastOutcome,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  };
  const siteRules = [nextRule, ...existingRules.filter((rule) => rule.id !== nextRule.id)].slice(0, SITE_RULE_LIMIT);

  return upsertVaultSettings(vault, { siteRules });
}

function recordSiteRuleOutcome(session: UnlockedVaultSession, outcome: SubmitOutcome | undefined): UnlockedVaultSession['vault'] {
  if (!outcome?.credentialId || outcome.status === 'checking') return session.vault;

  const key = `${outcome.credentialId}:${outcome.status}:${outcome.checkedAt}`;
  if (recordedSubmitOutcomeKeys.has(key)) return session.vault;
  recordedSubmitOutcomeKeys.add(key);

  const credential = session.vault.credentials.find((item) => item.id === outcome.credentialId);
  if (!credential) return session.vault;

  const withRule = upsertSiteRuleFromForm(session.vault, {
    domain: credential.domain,
    url: outcome.url || credential.url,
    formFields: credential.formFields,
    formProfile: credential.formProfile,
    source: 'auto-repair'
  });
  const rules = withRule.settings.siteRules ?? [];
  const success = outcome.status === 'navigated' || outcome.status === 'successLikely';
  const failed = outcome.status === 'stillOnLogin' || outcome.status === 'errorVisible' || outcome.status === 'blocked' || outcome.status === 'unknown';
  const siteRules = rules.map((rule) =>
    domainsMatch(rule.domain, credential.domain)
      ? {
          ...rule,
          successCount: (rule.successCount ?? 0) + (success ? 1 : 0),
          failureCount: (rule.failureCount ?? 0) + (failed ? 1 : 0),
          lastOutcome: outcome.status,
          updatedAt: Date.now()
        }
      : rule
  );

  return upsertVaultSettings(withRule, { siteRules });
}

async function resolveFillPayload(payload: FillCredentialPayload, targetUrl?: string): Promise<FillCredentialPayload> {
  const session = await restoreCachedVaultSession();
  const credential = session?.vault.credentials.find((item) => item.id === payload.id);

  if (!session || !credential) {
    return payload;
  }

  return credentialToFillPayload(credential, payload.autoSubmit, session.vault, targetUrl ?? payload.url);
}

function rememberSubmitOutcome(tabId: number, response: FillCredentialResult | undefined) {
  const outcome = response?.submitOutcome;
  if (outcome?.status !== 'checking') return;

  pendingSubmitOutcomes.set(tabId, outcome);
}

function getPendingSubmitOutcome(tabId: number): SubmitOutcome | undefined {
  const outcome = pendingSubmitOutcomes.get(tabId);
  if (!outcome) return undefined;

  if (Date.now() - outcome.checkedAt > SUBMIT_OUTCOME_TTL) {
    pendingSubmitOutcomes.delete(tabId);
    return undefined;
  }

  return outcome;
}

function markPendingSubmitNavigated(tabId: number, url?: string) {
  const outcome = getPendingSubmitOutcome(tabId);
  if (!outcome || outcome.status !== 'checking') return;

  pendingSubmitOutcomes.set(tabId, {
    ...outcome,
    status: 'navigated',
    message: '页面已跳转，登录可能已成功。',
    url: url ?? outcome.url,
    checkedAt: Date.now()
  });
}

function getInlineMatchesFromSession(session: UnlockedVaultSession, tabUrl?: string): InlineCredentialSummary[] {
  return session.vault.credentials
    .filter((credential) => credentialMatchesTab(credential, tabUrl))
    .sort((left, right) => {
      if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
      return (right.lastUsedAt ?? right.updatedAt) - (left.lastUsedAt ?? left.updatedAt);
    })
    .map(toInlineSummary);
}

function getInlineMatchesForUrls(session: UnlockedVaultSession, urls: Array<string | undefined>): InlineCredentialSummary[] {
  const matchUrls = Array.from(new Set(urls.filter((url): url is string => Boolean(url))));

  return session.vault.credentials
    .filter((credential) => matchUrls.some((url) => credentialMatchesTab(credential, url)))
    .sort((left, right) => {
      if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
      return (right.lastUsedAt ?? right.updatedAt) - (left.lastUsedAt ?? left.updatedAt);
    })
    .map(toInlineSummary);
}

function getInlineFillProfiles(session: UnlockedVaultSession, tabUrl?: string): InlineFillProfileSummary[] {
  return (session.vault.fillProfiles ?? [])
    .filter((profile) => profile.fields.some((field) => field.value.trim()))
    .sort((left, right) => {
      if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
      const leftBinding = selectFillProfileSiteBinding(left, tabUrl);
      const rightBinding = selectFillProfileSiteBinding(right, tabUrl);
      if (Boolean(leftBinding) !== Boolean(rightBinding)) return leftBinding ? -1 : 1;
      return (right.lastUsedAt ?? right.updatedAt) - (left.lastUsedAt ?? left.updatedAt);
    })
    .slice(0, 80)
    .map((profile) => toInlineFillProfileSummary(profile, tabUrl));
}

async function getInlineState(urls: Array<string | undefined>): Promise<{ hidden: boolean; matches: InlineCredentialSummary[]; fillProfiles: InlineFillProfileSummary[]; siteRule?: SiteRuleSummary }> {
  const session = await restoreCachedVaultSession();

  if (!session) {
    throw new Error('VAULT_LOCKED');
  }

  const hidden = urls.some((url) => isInlineHiddenForTab(session, url));
  const targetUrl = urls.find((url): url is string => Boolean(url));
  const siteRule = selectSiteRule(session.vault, targetUrl);

  return {
    hidden,
    matches: hidden ? [] : getInlineMatchesForUrls(session, urls),
    fillProfiles: hidden ? [] : getInlineFillProfiles(session, targetUrl),
    siteRule: toSiteRuleSummary(siteRule)
  };
}

async function getInlineCredentialForEdit(
  tabUrl: string | undefined,
  credentialId: string | undefined
): Promise<{ ok: boolean; credential?: Credential; error?: string }> {
  const session = await restoreCachedVaultSession();

  if (!session) {
    throw new Error('VAULT_LOCKED');
  }

  if (!credentialId) {
    return { ok: false, error: 'MISSING_CREDENTIAL_ID' };
  }

  const credential = session.vault.credentials.find((item) => item.id === credentialId);

  if (!credential || !credentialMatchesTab(credential, tabUrl)) {
    return { ok: false, error: 'NO_MATCHING_CREDENTIAL' };
  }

  return { ok: true, credential };
}

async function saveInlineCredentialEdit(
  tabUrl: string | undefined,
  draft: Credential | undefined
): Promise<{ ok: boolean; credential?: Credential; error?: string; message?: string }> {
  const session = await restoreCachedVaultSession();

  if (!session) {
    throw new Error('VAULT_LOCKED');
  }

  if (!draft?.id) {
    return { ok: false, error: 'MISSING_CREDENTIAL_ID' };
  }

  const existing = session.vault.credentials.find((item) => item.id === draft.id);

  if (!existing || !credentialMatchesTab(existing, tabUrl)) {
    return { ok: false, error: 'NO_MATCHING_CREDENTIAL' };
  }

  const normalizedUrl = normalizeUrl(draft.url || existing.url);
  const normalizedDomain = extractDomain(normalizedUrl);

  if (!normalizedUrl || !normalizedDomain) {
    return { ok: false, error: 'INVALID_CREDENTIAL_URL' };
  }

  const matchUrl = normalizeMatchUrl(draft.matchUrl);
  const matchDomain = matchUrl ? extractMatchDomain(matchUrl) : undefined;
  const submittedIconUrl = toHttpIconUrl(draft.iconUrl);
  const existingIconUrl = toHttpIconUrl(existing.iconUrl);
  const keepsExistingIcon = Boolean(existingIconUrl && (existing.domain === normalizedDomain || existing.iconType === 'custom'));
  const usesCustomIcon = Boolean(submittedIconUrl && draft.iconType === 'custom');
  const iconUrl = usesCustomIcon
    ? submittedIconUrl
    : keepsExistingIcon
      ? existingIconUrl
      : getRootFaviconUrl(normalizedUrl);

  const updated: Credential = {
    ...existing,
    title: draft.title.trim() || normalizedDomain || existing.title,
    url: normalizedUrl,
    domain: normalizedDomain,
    matchUrl,
    matchDomain,
    iconUrl,
    iconType: iconUrl ? (usesCustomIcon ? 'custom' : 'favicon') : 'default',
    username: draft.username.trim(),
    password: draft.password,
    notes: draft.notes?.trim() || undefined,
    tags: draft.tags?.map((tag) => tag.trim()).filter(Boolean),
    folder: draft.folder?.trim() || undefined,
    updatedAt: Date.now()
  };

  await persistVaultSession(session, updateCredentialInVault(session.vault, updated));

  return { ok: true, credential: updated, message: '账号已保存。' };
}

async function handleInlineCredentialCommand(
  tabUrl: string | undefined,
  credentialId: string | undefined,
  command: InlineCredentialCommand | undefined
): Promise<InlineCredentialCommandResult> {
  const session = await restoreCachedVaultSession();

  if (!session) {
    throw new Error('VAULT_LOCKED');
  }

  if (!command || !['goto', 'edit', 'rename', 'delete', 'hide-domain'].includes(command)) {
    return { ok: false, error: 'INVALID_INLINE_COMMAND' };
  }

  if (command === 'hide-domain') {
    const tabDomain = getTabDomain(tabUrl);

    if (!tabDomain) {
      return { ok: false, error: 'NO_ACTIVE_DOMAIN' };
    }

    const inlineBlacklist = Array.from(new Set([...(session.vault.settings.inlineBlacklist ?? []), tabDomain]));
    await persistVaultSession(session, upsertVaultSettings(session.vault, { inlineBlacklist }));
    return { ok: true, hidden: true, message: '已在此域隐藏 KeyPilot 网页内图标。' };
  }

  const credential = session.vault.credentials.find((item) => item.id === credentialId);

  if (!credential || !credentialMatchesTab(credential, tabUrl)) {
    return { ok: false, error: 'NO_MATCHING_CREDENTIAL' };
  }

  if (command === 'goto') {
    if (!isSupportedOpenUrl(credential.url)) {
      return { ok: false, error: 'INVALID_CREDENTIAL_URL' };
    }

    chrome.tabs.create({ url: credential.url, active: true });
    await persistVaultSession(session, touchCredentialInVault(session.vault, credential.id));
    return { ok: true, message: '已打开起始页。' };
  }

  if (command === 'edit' || command === 'rename') {
    return { ok: true, message: '请在网页内编辑账号。' };
  }

  if (command === 'delete') {
    await persistVaultSession(session, deleteCredentialFromVault(session.vault, credential.id));
    return { ok: true, message: '账号已移到回收站。' };
  }

  return { ok: false, error: 'INVALID_INLINE_COMMAND' };
}

function sendFillMessage(tabId: number, frameId: number | undefined, credential: FillCredentialPayload): Promise<FillCredentialResult> {
  return new Promise((resolve) => {
    const message = { type: 'KEYPILOT_FILL_CREDENTIAL', credential };
    const callback = (response?: FillCredentialResult) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }

      resolve(response ?? { ok: false, error: 'NO_RESPONSE' });
    };

    if (typeof frameId === 'number' && frameId >= 0) {
      chrome.tabs.sendMessage(tabId, message, { frameId }, callback);
      return;
    }

    chrome.tabs.sendMessage(tabId, message, callback);
  });
}

function sendFillProfileMessage(tabId: number, frameId: number | undefined, profile: FillProfilePayload): Promise<FillProfileFillResult> {
  return new Promise((resolve) => {
    const message = { type: 'KEYPILOT_FILL_PROFILE', profile };
    const callback = (response?: FillProfileFillResult) => {
      if (chrome.runtime.lastError) {
        resolve({
          ok: false,
          error: chrome.runtime.lastError.message,
          filledCount: 0,
          matchedCount: 0,
          skippedCount: 0,
          totalFields: profile.fields.length
        });
        return;
      }

      resolve(
        response ?? {
          ok: false,
          error: 'NO_RESPONSE',
          filledCount: 0,
          matchedCount: 0,
          skippedCount: 0,
          totalFields: profile.fields.length
        }
      );
    };

    if (typeof frameId === 'number' && frameId >= 0) {
      chrome.tabs.sendMessage(tabId, message, { frameId }, callback);
      return;
    }

    chrome.tabs.sendMessage(tabId, message, callback);
  });
}

function sendFillProfileDiagnosticMessage(tabId: number, frameId: number | undefined, profile: FillProfilePayload): Promise<FillProfileFillResult> {
  return new Promise((resolve) => {
    const message = { type: 'KEYPILOT_DIAGNOSE_FILL_PROFILE', profile };
    const callback = (response?: FillProfileFillResult) => {
      if (chrome.runtime.lastError) {
        resolve({
          ok: false,
          error: chrome.runtime.lastError.message,
          filledCount: 0,
          matchedCount: 0,
          skippedCount: 0,
          totalFields: profile.fields.length
        });
        return;
      }

      resolve(
        response ?? {
          ok: false,
          error: 'NO_RESPONSE',
          filledCount: 0,
          matchedCount: 0,
          skippedCount: 0,
          totalFields: profile.fields.length
        }
      );
    };

    if (typeof frameId === 'number' && frameId >= 0) {
      chrome.tabs.sendMessage(tabId, message, { frameId }, callback);
      return;
    }

    chrome.tabs.sendMessage(tabId, message, callback);
  });
}

function sendFillProfileBindingStart(
  tabId: number,
  frameId: number | undefined,
  profile: FillProfilePayload
): Promise<{ ok?: boolean; error?: string }> {
  return new Promise((resolve) => {
    const message = { type: 'KEYPILOT_START_FILL_PROFILE_BINDING', profile };
    const callback = (response?: { ok?: boolean; error?: string }) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }

      resolve(response ?? { ok: false, error: 'NO_RESPONSE' });
    };

    if (typeof frameId === 'number' && frameId >= 0) {
      chrome.tabs.sendMessage(tabId, message, { frameId }, callback);
      return;
    }

    chrome.tabs.sendMessage(tabId, message, callback);
  });
}

async function fillTabBestFrame(tabId: number, credential: FillCredentialPayload) {
  const tab = await getTabById(tabId);
  const frameId = tab ? await chooseCredentialFrame(tab, credential) : undefined;
  const response = await sendFillMessage(tabId, frameId, credential);

  if (!response.ok && typeof frameId === 'number' && frameId !== 0) {
    const fallback = await sendFillMessage(tabId, 0, credential);
    const finalResponse = fallback.ok ? fallback : response;
    rememberSubmitOutcome(tabId, finalResponse);
    return finalResponse;
  }

  rememberSubmitOutcome(tabId, response);
  return response;
}

async function fillProfileActiveTab(tabId: number, profile: FillProfilePayload): Promise<FillProfileFillResult> {
  const tab = await getTabById(tabId);
  const resolvedProfile = await resolveFillProfilePayload(profile, tab?.url);
  await ensureContentScriptInTab(tabId, tab?.url);
  const frames = tab ? await getTabFrames(tab) : [{ frameId: 0, url: '' }];
  const orderedFrames = [...frames].sort((left, right) => {
    if (left.frameId === 0) return -1;
    if (right.frameId === 0) return 1;
    return left.frameId - right.frameId;
  });

  let lastError = 'NO_FILL_PROFILE_FIELDS';
  let matchedCount = 0;
  let skippedCount = 0;

  for (const frame of orderedFrames) {
    const response = await sendFillProfileMessage(tabId, frame.frameId, resolvedProfile);
    matchedCount += response.matchedCount ?? 0;
    skippedCount += response.skippedCount ?? 0;

    if (response.ok) {
      return response;
    }

    lastError = response.error ?? lastError;
  }

  return {
    ok: false,
    error: lastError,
    filledCount: 0,
    matchedCount,
    skippedCount,
    totalFields: resolvedProfile.fields.length
  };
}

async function chooseFillProfileFrame(tab: chrome.tabs.Tab, profile: FillProfilePayload): Promise<number | undefined> {
  if (!tab.id) return undefined;
  const frames = await getTabFrames(tab);
  const orderedFrames = [...frames].sort((left, right) => {
    if (left.frameId === 0) return -1;
    if (right.frameId === 0) return 1;
    return left.frameId - right.frameId;
  });

  let bestFrameId: number | undefined = orderedFrames[0]?.frameId ?? 0;
  let bestScore = -1;

  for (const frame of orderedFrames) {
    const result = await sendFillProfileDiagnosticMessage(tab.id, frame.frameId, profile);
    const score = (result.matchedCount ?? 0) * 2 + (result.totalFields - (result.skippedCount ?? 0));
    if (score > bestScore) {
      bestScore = score;
      bestFrameId = frame.frameId;
    }
  }

  return bestFrameId;
}

async function startFillProfileBinding(tabId: number, profileId: string | undefined): Promise<{ ok?: boolean; error?: string }> {
  if (!profileId) return { ok: false, error: 'INVALID_FILL_PROFILE' };

  const session = await restoreCachedVaultSession();
  if (!session) throw new Error('VAULT_LOCKED');

  const profile = session.vault.fillProfiles?.find((item) => item.id === profileId);
  if (!profile) return { ok: false, error: 'INVALID_FILL_PROFILE' };

  const tab = await getTabById(tabId);
  if (!tab?.id) return { ok: false, error: 'NO_ACTIVE_TAB' };

  await ensureContentScriptInTab(tab.id, tab.url);
  const payload = fillProfileToPayload(profile, tab.url, true);
  const frameId = await chooseFillProfileFrame(tab, payload);
  return sendFillProfileBindingStart(tab.id, frameId, payload);
}

async function saveFillProfileBinding(
  senderUrl: string | undefined,
  binding: FillProfileBindingResult | undefined
): Promise<{ ok?: boolean; error?: string }> {
  if (!binding?.profileId || !binding.fields?.length) return { ok: false, error: 'INVALID_BINDING' };

  const session = await restoreCachedVaultSession();
  if (!session) throw new Error('VAULT_LOCKED');

  const profile = session.vault.fillProfiles?.find((item) => item.id === binding.profileId);
  if (!profile) return { ok: false, error: 'INVALID_FILL_PROFILE' };

  const domain = binding.domain || getTabDomain(binding.url || senderUrl);
  if (!domain) return { ok: false, error: 'INVALID_BINDING_DOMAIN' };

  const now = Date.now();
  const existing = (profile.siteBindings ?? []).find((item) => domainsMatch(item.domain, domain));
  const siteBinding: FillProfileSiteBinding = {
    id: existing?.id ?? crypto.randomUUID(),
    domain,
    pathPattern: existing?.pathPattern,
    fields: binding.fields.slice(0, 120),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    successCount: existing?.successCount,
    failureCount: existing?.failureCount
  };
  const siteBindings = [siteBinding, ...(profile.siteBindings ?? []).filter((item) => !domainsMatch(item.domain, domain))].slice(0, 80);

  await persistVaultSession(
    session,
    updateFillProfileInVault(session.vault, {
      ...profile,
      siteBindings,
      updatedAt: now
    })
  );

  return { ok: true };
}

async function sendFillToTab(tabId: number, pendingFill: PendingFill) {
  pendingFill.attempts += 1;
  const response = await fillTabBestFrame(tabId, pendingFill.credential);
  const retryable = !response.ok && ['NO_RESPONSE', 'NO_LOGIN_FORM', 'NO_PASSWORD_FIELD', 'Receiving end does not exist.'].some((error) =>
    response.error?.includes(error)
  );

  if (retryable && Date.now() - pendingFill.createdAt < 60000 && pendingFill.attempts < 12) {
    setTimeout(() => {
      if (pendingFills.get(tabId) === pendingFill) {
        void sendFillToTab(tabId, pendingFill);
      }
    }, 350);
    return;
  }

  pendingFills.delete(tabId);
}

async function fillInlineCredential(tabId: number, frameUrl: string | undefined, frameId: number | undefined, request: InlineCredentialFillRequest) {
  const session = await restoreCachedVaultSession();

  if (!session) {
    throw new Error('VAULT_LOCKED');
  }

  const credential = session.vault.credentials.find((item) => item.id === request.credentialId);

  if (!credential || !credentialMatchesTab(credential, frameUrl)) {
    throw new Error('NO_MATCHING_CREDENTIAL');
  }

  const payload = credentialToFillPayload(credential, request.action === 'login', session.vault, frameUrl);

  return new Promise((resolve) => {
    const message = { type: 'KEYPILOT_FILL_CREDENTIAL', credential: payload };
    const callback = async (response?: unknown) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }

      const result = response as FillCredentialResult | undefined;

      if (result?.ok) {
        rememberSubmitOutcome(tabId, result);
        await persistVaultSession(session, touchCredentialInVault(session.vault, credential.id));
      }

      resolve(response ?? { ok: false, error: 'NO_RESPONSE' });
    };

    if (typeof frameId === 'number' && frameId >= 0) {
      chrome.tabs.sendMessage(tabId, message, { frameId }, callback);
      return;
    }

    chrome.tabs.sendMessage(tabId, message, callback);
  });
}

async function fillInlineProfile(tabId: number, frameUrl: string | undefined, frameId: number | undefined, request: InlineFillProfileFillRequest) {
  const session = await restoreCachedVaultSession();

  if (!session) {
    throw new Error('VAULT_LOCKED');
  }

  const profile = session.vault.fillProfiles?.find((item) => item.id === request.profileId);

  if (!profile) {
    throw new Error('INVALID_FILL_PROFILE');
  }

  const payload = fillProfileToPayload(profile, frameUrl, request.onlyEmpty ?? true);
  const response = await sendFillProfileMessage(tabId, frameId, payload);

  if (response.ok && request.recordUse !== false) {
    const now = Date.now();
    await persistVaultSession(
      session,
      updateFillProfileInVault(session.vault, {
        ...profile,
        lastUsedAt: now,
        updatedAt: now
      })
    );
  }

  return response;
}

async function renameInlineFillProfile(profileId: string | undefined, title: string | undefined): Promise<{ ok: boolean; error?: string; title?: string; message?: string }> {
  const nextTitle = title?.trim();

  if (!profileId || !nextTitle) {
    return { ok: false, error: 'INVALID_FILL_PROFILE' };
  }

  const session = await restoreCachedVaultSession();

  if (!session) {
    throw new Error('VAULT_LOCKED');
  }

  const profile = session.vault.fillProfiles?.find((item) => item.id === profileId);

  if (!profile) {
    return { ok: false, error: 'INVALID_FILL_PROFILE' };
  }

  await persistVaultSession(session, updateFillProfileInVault(session.vault, { ...profile, title: nextTitle }));
  return { ok: true, title: nextTitle, message: '身份资料已重命名。' };
}

async function deleteInlineFillProfile(profileId: string | undefined): Promise<{ ok: boolean; error?: string; message?: string }> {
  if (!profileId) {
    return { ok: false, error: 'INVALID_FILL_PROFILE' };
  }

  const session = await restoreCachedVaultSession();

  if (!session) {
    throw new Error('VAULT_LOCKED');
  }

  const profile = session.vault.fillProfiles?.find((item) => item.id === profileId);

  if (!profile) {
    return { ok: false, error: 'INVALID_FILL_PROFILE' };
  }

  await persistVaultSession(session, deleteFillProfileFromVault(session.vault, profileId));
  return { ok: true, message: '身份资料已移到回收站。' };
}

function queryActiveTab(): Promise<chrome.tabs.Tab | null> {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      resolve(tabs[0] ?? null);
    });
  });
}

function getTabById(tabId: number): Promise<chrome.tabs.Tab | null> {
  return new Promise((resolve) => {
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }

      resolve(tab ?? null);
    });
  });
}

function getTabFrames(tab: chrome.tabs.Tab): Promise<Array<{ frameId: number; url: string }>> {
  return new Promise((resolve) => {
    if (!tab.id || !chrome.webNavigation?.getAllFrames) {
      resolve(tab.url ? [{ frameId: 0, url: tab.url }] : []);
      return;
    }

    chrome.webNavigation.getAllFrames({ tabId: tab.id }, (frames) => {
      if (chrome.runtime.lastError || !frames?.length) {
        resolve(tab.url ? [{ frameId: 0, url: tab.url }] : []);
        return;
      }

      resolve(
        frames
          .filter((frame) => frame.url && /^https?:\/\//i.test(frame.url))
          .map((frame) => ({ frameId: frame.frameId, url: frame.url }))
      );
    });
  });
}

function requestFrameDiagnostic(tabId: number, frameId: number, frameUrl: string): Promise<Omit<InlineFrameDiagnostic, 'matchedCount'>> {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: 'KEYPILOT_INLINE_DIAGNOSTICS' }, { frameId }, (response) => {
      if (chrome.runtime.lastError || !response) {
        resolve({
          frameId,
          url: frameUrl,
          domain: getTabDomain(frameUrl),
          hasLoginForm: false,
          hasUsernameField: false,
          hasPasswordField: false,
          error: chrome.runtime.lastError?.message ?? 'NO_CONTENT_RESPONSE'
        });
        return;
      }

      resolve({ ...(response as Omit<InlineFrameDiagnostic, 'matchedCount'>), frameId });
    });
  });
}

async function chooseCredentialFrame(tab: chrome.tabs.Tab, credential: FrameCredential): Promise<number | undefined> {
  if (!tab.id) return undefined;

  const frames = await getTabFrames(tab);
  const candidateFrames = frames.filter((frame) => credentialMatchesTab(credential, frame.url));
  const tabMatches = credentialMatchesTab(credential, tab.url);

  if (!tabMatches && !candidateFrames.length) {
    return undefined;
  }

  const scopedFrames = candidateFrames.length ? candidateFrames : frames;

  for (const frame of scopedFrames) {
    const diagnostic = await requestFrameDiagnostic(tab.id, frame.frameId, frame.url);
    if (diagnostic.hasLoginForm) {
      return frame.frameId;
    }
  }

  return scopedFrames[0]?.frameId;
}

function sendManualBindingStart(tabId: number, frameId: number | undefined, credential: FillCredentialPayload): Promise<{ ok?: boolean; error?: string }> {
  return new Promise((resolve) => {
    const callback = (response?: { ok?: boolean; error?: string }) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }

      resolve(response ?? { ok: false, error: 'NO_RESPONSE' });
    };

    if (typeof frameId === 'number' && frameId >= 0) {
      chrome.tabs.sendMessage(tabId, { type: 'KEYPILOT_START_MANUAL_BINDING', credential }, { frameId }, callback);
      return;
    }

    chrome.tabs.sendMessage(tabId, { type: 'KEYPILOT_START_MANUAL_BINDING', credential }, callback);
  });
}

function sendBindingTestMessage(tabId: number, frameId: number | undefined, credential: FillCredentialPayload): Promise<BindingTestResult> {
  return new Promise((resolve) => {
    const callback = (response?: BindingTestResult) => {
      if (chrome.runtime.lastError) {
        const errorMessage = chrome.runtime.lastError.message ?? 'NO_RESPONSE';
        resolve({
          ok: false,
          error: errorMessage,
          matchedFields: 0,
          totalFields: credential.formFields?.length ?? 0,
          hasSubmit: Boolean(credential.formProfile?.submit),
          submitMatched: false,
          message: errorMessage
        });
        return;
      }

      resolve(response ?? {
        ok: false,
        error: 'NO_RESPONSE',
        matchedFields: 0,
        totalFields: credential.formFields?.length ?? 0,
        hasSubmit: Boolean(credential.formProfile?.submit),
        submitMatched: false,
        message: '目标网页暂时没有响应。'
      });
    };

    if (typeof frameId === 'number' && frameId >= 0) {
      chrome.tabs.sendMessage(tabId, { type: 'KEYPILOT_TEST_BINDING', credential }, { frameId }, callback);
      return;
    }

    chrome.tabs.sendMessage(tabId, { type: 'KEYPILOT_TEST_BINDING', credential }, callback);
  });
}

async function startManualBinding(tabId: number, credentialId: string | undefined) {
  if (!credentialId) {
    return { ok: false, error: 'INVALID_CREDENTIAL_ID' };
  }

  const session = await restoreCachedVaultSession();
  if (!session) throw new Error('VAULT_LOCKED');

  const tab = await getTabById(tabId);
  if (!tab?.id) {
    return { ok: false, error: 'NO_ACTIVE_TAB' };
  }

  const credential = session.vault.credentials.find((item) => item.id === credentialId);
  if (!credential) {
    return { ok: false, error: 'NO_MATCHING_CREDENTIAL' };
  }

  const frameId = await chooseCredentialFrame(tab, credential);
  if (!credentialMatchesTab(credential, tab.url) && typeof frameId !== 'number') {
    return { ok: false, error: 'NO_MATCHING_CREDENTIAL' };
  }

  const response = await sendManualBindingStart(tab.id, frameId, credentialToFillPayload(credential, false, session.vault, tab.url));
  return response.ok ? { ok: true } : response;
}

async function startBindingTest(tabId: number, credentialId: string | undefined): Promise<BindingTestResult> {
  if (!credentialId) {
    return { ok: false, error: 'INVALID_CREDENTIAL_ID', matchedFields: 0, totalFields: 0, hasSubmit: false, submitMatched: false, message: '账号 ID 无效。' };
  }

  const session = await restoreCachedVaultSession();
  if (!session) throw new Error('VAULT_LOCKED');

  const tab = await getTabById(tabId);
  if (!tab?.id) {
    return { ok: false, error: 'NO_ACTIVE_TAB', matchedFields: 0, totalFields: 0, hasSubmit: false, submitMatched: false, message: '没有可测试的标签页。' };
  }

  const credential = session.vault.credentials.find((item) => item.id === credentialId);
  if (!credential) {
    return { ok: false, error: 'NO_MATCHING_CREDENTIAL', matchedFields: 0, totalFields: 0, hasSubmit: false, submitMatched: false, message: '没有找到匹配账号。' };
  }

  const frameId = await chooseCredentialFrame(tab, credential);
  if (!credentialMatchesTab(credential, tab.url) && typeof frameId !== 'number') {
    return {
      ok: false,
      error: 'NO_MATCHING_CREDENTIAL',
      matchedFields: 0,
      totalFields: credential.formFields?.length ?? 0,
      hasSubmit: Boolean(credential.formProfile?.submit),
      submitMatched: false,
      message: '当前网页和账号域名不匹配，不能测试绑定。'
    };
  }

  return sendBindingTestMessage(tab.id, frameId, credentialToFillPayload(credential, false, session.vault, tab.url));
}

async function openTabAndStartManualBinding(credentialId: string | undefined) {
  if (!credentialId) {
    return { ok: false, error: 'INVALID_CREDENTIAL_ID' };
  }

  const session = await restoreCachedVaultSession();
  if (!session) throw new Error('VAULT_LOCKED');

  const credential = session.vault.credentials.find((item) => item.id === credentialId);
  if (!credential) {
    return { ok: false, error: 'NO_MATCHING_CREDENTIAL' };
  }

  if (!isSupportedOpenUrl(credential.url)) {
    return { ok: false, error: 'INVALID_CREDENTIAL_URL' };
  }

  return new Promise<{ ok: boolean; error?: string; queued?: boolean }>((resolve) => {
    chrome.tabs.create({ url: credential.url, active: true }, (tab) => {
      if (chrome.runtime.lastError || !tab.id) {
        resolve({ ok: false, error: chrome.runtime.lastError?.message ?? 'TAB_CREATE_FAILED' });
        return;
      }

      pendingBindings.set(tab.id, {
        credentialId: credential.id,
        createdAt: Date.now(),
        attempts: 0
      });

      setTimeout(() => {
        const pendingBinding = pendingBindings.get(tab.id!);
        if (pendingBinding) {
          void sendBindingToTab(tab.id!, pendingBinding);
        }
      }, 450);

      resolve({ ok: true, queued: true });
    });
  });
}

async function sendBindingToTab(tabId: number, pendingBinding: PendingBinding) {
  pendingBinding.attempts += 1;

  try {
    const response = await startManualBinding(tabId, pendingBinding.credentialId);

    if (response.ok) {
      pendingBindings.delete(tabId);
      return;
    }

    const retryable = ['NO_RESPONSE', 'Receiving end does not exist.', 'NO_ACTIVE_TAB', 'NO_MATCHING_CREDENTIAL'].some((error) =>
      response.error?.includes(error)
    );

    if (retryable && Date.now() - pendingBinding.createdAt < 60000 && pendingBinding.attempts < 14) {
      setTimeout(() => {
        if (pendingBindings.get(tabId) === pendingBinding) {
          void sendBindingToTab(tabId, pendingBinding);
        }
      }, 500);
      return;
    }
  } catch {
    if (Date.now() - pendingBinding.createdAt < 60000 && pendingBinding.attempts < 14) {
      setTimeout(() => {
        if (pendingBindings.get(tabId) === pendingBinding) {
          void sendBindingToTab(tabId, pendingBinding);
        }
      }, 500);
      return;
    }
  }

  pendingBindings.delete(tabId);
}

async function openTabAndTestBinding(credentialId: string | undefined) {
  if (!credentialId) {
    return { ok: false, error: 'INVALID_CREDENTIAL_ID' };
  }

  const session = await restoreCachedVaultSession();
  if (!session) throw new Error('VAULT_LOCKED');

  const credential = session.vault.credentials.find((item) => item.id === credentialId);
  if (!credential) {
    return { ok: false, error: 'NO_MATCHING_CREDENTIAL' };
  }

  if (!isSupportedOpenUrl(credential.url)) {
    return { ok: false, error: 'INVALID_CREDENTIAL_URL' };
  }

  return new Promise<{ ok: boolean; error?: string; queued?: boolean }>((resolve) => {
    chrome.tabs.create({ url: credential.url, active: true }, (tab) => {
      if (chrome.runtime.lastError || !tab.id) {
        resolve({ ok: false, error: chrome.runtime.lastError?.message ?? 'TAB_CREATE_FAILED' });
        return;
      }

      pendingBindingTests.set(tab.id, {
        credentialId: credential.id,
        createdAt: Date.now(),
        attempts: 0
      });

      setTimeout(() => {
        const pendingTest = pendingBindingTests.get(tab.id!);
        if (pendingTest) {
          void sendBindingTestToTab(tab.id!, pendingTest);
        }
      }, 450);

      resolve({ ok: true, queued: true });
    });
  });
}

async function sendBindingTestToTab(tabId: number, pendingTest: PendingBindingTest) {
  pendingTest.attempts += 1;

  try {
    const response = await startBindingTest(tabId, pendingTest.credentialId);

    if (response.ok || !response.error) {
      pendingBindingTests.delete(tabId);
      return;
    }

    const retryable = ['NO_RESPONSE', 'Receiving end does not exist.', 'NO_ACTIVE_TAB', 'NO_MATCHING_CREDENTIAL'].some((error) =>
      response.error?.includes(error)
    );

    if (retryable && Date.now() - pendingTest.createdAt < 60000 && pendingTest.attempts < 14) {
      setTimeout(() => {
        if (pendingBindingTests.get(tabId) === pendingTest) {
          void sendBindingTestToTab(tabId, pendingTest);
        }
      }, 500);
      return;
    }
  } catch {
    if (Date.now() - pendingTest.createdAt < 60000 && pendingTest.attempts < 14) {
      setTimeout(() => {
        if (pendingBindingTests.get(tabId) === pendingTest) {
          void sendBindingTestToTab(tabId, pendingTest);
        }
      }, 500);
      return;
    }
  }

  pendingBindingTests.delete(tabId);
}

async function getBindingCredential(tabUrl: string | undefined, credentialId: string | undefined) {
  if (!credentialId) {
    return { ok: false, error: 'INVALID_CREDENTIAL_ID' };
  }

  const session = await restoreCachedVaultSession();
  if (!session) throw new Error('VAULT_LOCKED');

  const credential = session.vault.credentials.find((item) => item.id === credentialId);
  if (!credential || !credentialMatchesTab(credential, tabUrl)) {
    return { ok: false, error: 'NO_MATCHING_CREDENTIAL' };
  }

  return { ok: true, credential: credentialToFillPayload(credential, false, session.vault, tabUrl) };
}

async function saveManualBinding(senderUrl: string | undefined, binding: ManualBindingResult | undefined) {
  if (!binding?.credentialId || !binding.formFields?.length || !binding.formProfile) {
    return { ok: false, error: 'INVALID_BINDING' };
  }

  const session = await restoreCachedVaultSession();
  if (!session) throw new Error('VAULT_LOCKED');

  const credential = session.vault.credentials.find((item) => item.id === binding.credentialId);
  if (!credential) {
    return { ok: false, error: 'NO_MATCHING_CREDENTIAL' };
  }

  const senderMatches = credentialMatchesTab(credential, senderUrl);
  const bindingMatches = domainsMatch(credential.domain, binding.domain);

  if (!senderMatches && !bindingMatches) {
    return { ok: false, error: 'BINDING_DOMAIN_MISMATCH' };
  }

  const updatedVault = updateCredentialInVault(session.vault, {
      ...credential,
      url: binding.url || credential.url,
      formFields: binding.formFields,
      formProfile: binding.formProfile,
      updatedAt: Date.now()
    });
  const withRule = upsertSiteRuleFromForm(updatedVault, {
    domain: binding.domain,
    url: binding.url || credential.url,
    formFields: binding.formFields,
    formProfile: binding.formProfile,
    source: 'manual-binding'
  });

  await persistVaultSession(session, withRule);

  return { ok: true };
}

function isValidSiteRulePageMode(value: unknown): value is SiteRulePageMode {
  return value === 'auto' || value === 'login' || value === 'register' || value === 'fill-profile';
}

async function applyRecognitionRule(senderUrl: string | undefined, input: RecognitionRuleApplyRequest | undefined): Promise<RecognitionRuleApplyResult> {
  const session = await restoreCachedVaultSession();
  if (!session) throw new Error('VAULT_LOCKED');

  const url = normalizeUrl(input?.url || senderUrl || '');
  const domain = extractDomain(url || input?.domain || senderUrl || '');
  if (!domain) {
    return { ok: false, error: 'INVALID_RULE_DOMAIN' };
  }

  const pageMode = isValidSiteRulePageMode(input?.pageMode) ? input.pageMode : undefined;
  const pathPattern = normalizeRulePathPattern(input?.pathPattern) ?? siteRulePathFromUrl(url);
  const nextVault = upsertSiteRuleFromForm(session.vault, {
    domain,
    url: url || input?.url,
    pathPattern,
    pageMode,
    disablePasswordGenerator: input?.disablePasswordGenerator,
    formFields: input?.formFields,
    formProfile: input?.formProfile,
    repairActions: input?.repairActions,
    source: 'manual-binding'
  });

  if (nextVault === session.vault) {
    return { ok: false, error: 'EMPTY_RULE' };
  }

  await persistVaultSession(session, nextVault);
  return {
    ok: true,
    siteRule: toSiteRuleSummary(selectSiteRule(nextVault, url || input?.domain || senderUrl))
  };
}

async function getActiveTabDiagnostics(): Promise<InlineDiagnosticsResult> {
  const tab = await queryActiveTab();

  if (!tab?.id) {
    return { ok: false, error: 'NO_ACTIVE_TAB', frames: [] };
  }

  const frames = await getTabFrames(tab);
  const session = await restoreCachedVaultSession();
  const locked = !session;
  const diagnostics = await Promise.all(
    frames.map(async (frame) => {
      const frameDiagnostic = await requestFrameDiagnostic(tab.id!, frame.frameId, frame.url);
      const matches = session ? getInlineMatchesFromSession(session, frameDiagnostic.url || frame.url) : [];

      return {
        ...frameDiagnostic,
        matchedCount: matches.length
      };
    })
  );
  const submitOutcome = [...diagnostics.map((frame) => frame.submitOutcome), getPendingSubmitOutcome(tab.id)]
    .filter((outcome): outcome is SubmitOutcome => Boolean(outcome))
    .sort((left, right) => right.checkedAt - left.checkedAt)[0];

  if (session && submitOutcome?.status !== 'checking') {
    const nextVault = recordSiteRuleOutcome(session, submitOutcome);
    if (nextVault !== session.vault) {
      await persistVaultSession(session, nextVault);
    }
  }

  return {
    ok: true,
    locked,
    tabUrl: tab.url,
    tabDomain: getTabDomain(tab.url),
    hasLoginForm: diagnostics.some((frame) => frame.hasLoginForm),
    matchedCount: Math.max(0, ...diagnostics.map((frame) => frame.matchedCount)),
    submitOutcome,
    frames: diagnostics
  };
}

function clearPendingLoginCandidate() {
  pendingLoginCandidate = null;
  pendingLoginCandidateExpiresAt = 0;
  void chrome.action.setBadgeText({ text: '' });
}

function validateLoginCandidate(candidate: PendingLoginCandidate | undefined): candidate is PendingLoginCandidate {
  return Boolean(candidate?.domain && candidate.username && candidate.password);
}

function publishLoginCandidate(candidate: PendingLoginCandidate) {
  pendingLoginCandidate = candidate;
  pendingLoginCandidateExpiresAt = Date.now() + STAGED_CANDIDATE_TTL;
  void chrome.action.setBadgeText({ text: '!' });
  void chrome.action.setBadgeBackgroundColor({ color: '#2563EB' });
}

function stageLoginCandidate(tabId: number, candidate: PendingLoginCandidate) {
  stagedLoginCandidates.set(tabId, {
    candidate,
    createdAt: Date.now()
  });
}

function getStagedLoginCandidate(tabId: number): StagedLoginCandidate | undefined {
  const staged = stagedLoginCandidates.get(tabId);
  if (!staged) return undefined;

  if (Date.now() - staged.createdAt > STAGED_CANDIDATE_TTL) {
    stagedLoginCandidates.delete(tabId);
    return undefined;
  }

  return staged;
}

function stagedCandidateUrlChanged(candidate: PendingLoginCandidate, url?: string): boolean {
  if (!url) return false;

  const nextUrl = normalizeUrl(url);
  const originalUrl = normalizeUrl(candidate.url);
  return Boolean(nextUrl && originalUrl && nextUrl !== originalUrl);
}

function promoteStagedLoginCandidate(tabId: number, url?: string): PendingLoginCandidate | null {
  const staged = getStagedLoginCandidate(tabId);
  if (!staged) return null;

  const urlDomain = getTabDomain(url);
  if (urlDomain && !domainsMatch(staged.candidate.domain, urlDomain)) {
    return null;
  }

  if (!stagedCandidateUrlChanged(staged.candidate, url)) {
    return null;
  }

  publishLoginCandidate({
    ...staged.candidate,
    url: url || staged.candidate.url,
    capturedAt: Date.now()
  });
  stagedLoginCandidates.delete(tabId);
  return pendingLoginCandidate;
}

function getPendingLoginCandidate() {
  if (pendingLoginCandidate && Date.now() > pendingLoginCandidateExpiresAt) {
    clearPendingLoginCandidate();
  }

  return pendingLoginCandidate;
}

function sameCandidateAccount(credential: Credential, candidate: PendingLoginCandidate): boolean {
  const sameSite =
    credentialMatchesTab(credential, candidate.url) ||
    domainsMatch(credential.domain, candidate.domain) ||
    Boolean(credential.matchDomain && domainsMatch(credential.matchDomain, candidate.domain));
  return sameSite && credential.username.trim().toLowerCase() === candidate.username.trim().toLowerCase();
}

function sameCandidatePassword(credential: Credential, candidate: PendingLoginCandidate): boolean {
  return sameCandidateAccount(credential, candidate) && credential.password === candidate.password;
}

function candidateHasBetterFormProfile(existing: Credential, candidate: PendingLoginCandidate): boolean {
  const candidateHasFieldSelectors = Boolean(candidate.formFields?.some((field) => field.selector));
  const existingHasFieldSelectors = Boolean(existing.formFields?.some((field) => field.selector));
  const candidateSubmitSelector = candidate.formProfile?.submit?.selector;
  const existingSubmitSelector = existing.formProfile?.submit?.selector;
  const candidateFieldCount = candidate.formFields?.length ?? 0;
  const existingFieldCount = existing.formFields?.length ?? 0;

  return Boolean(
    (candidate.formProfile?.submit &&
      (!existing.formProfile?.submit ||
        candidateSubmitSelector !== existingSubmitSelector ||
        candidate.formProfile.submit.text !== existing.formProfile.submit.text)) ||
    (candidateHasFieldSelectors && !existingHasFieldSelectors) ||
    candidateFieldCount > existingFieldCount ||
    ((candidate.formProfile?.fieldCount ?? 0) > (existing.formProfile?.fieldCount ?? 0) &&
      (candidate.formProfile?.passwordFieldCount ?? 0) >= (existing.formProfile?.passwordFieldCount ?? 0))
  );
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
  if (/^(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?(?:\s*[-–—|:：]\s*(?:password|passwd|pwd|login|sign in|登录|密码))?$/i.test(title.trim())) {
    return true;
  }
  if (/^(?:login|log in|sign in|signin|sign-in|password|passwd|pwd|登录|登陆|登入|密码|用户登录|后台登录)$/i.test(title.trim())) {
    return true;
  }
  return false;
}

function candidateTitleIsBetter(existing: Credential, candidate: PendingLoginCandidate): boolean {
  const title = candidate.title.trim();

  return Boolean(title && title !== existing.title && !isWeakCredentialTitle(title, candidate.domain) && isWeakCredentialTitle(existing.title, existing.domain));
}

function candidateIconIsBetter(existing: Credential, candidate: PendingLoginCandidate): boolean {
  if (existing.iconType === 'custom') return false;
  if (!candidate.iconUrl || candidate.iconUrl === existing.iconUrl) return false;

  return !existing.iconUrl || existing.iconType === 'default' || /\/favicon\.ico(?:[?#].*)?$/i.test(existing.iconUrl);
}

async function refreshCredentialFormProfile(session: UnlockedVaultSession, existing: Credential, candidate: PendingLoginCandidate): Promise<boolean> {
  const hasBetterFormProfile = candidateHasBetterFormProfile(existing, candidate);
  const hasBetterTitle = candidateTitleIsBetter(existing, candidate);
  const hasBetterIcon = candidateIconIsBetter(existing, candidate);

  if (!hasBetterFormProfile && !hasBetterTitle && !hasBetterIcon) {
    return false;
  }

  const updatedVault = updateCredentialInVault(session.vault, {
      ...existing,
      title: hasBetterTitle ? candidate.title.trim() : existing.title,
      url: candidate.url || existing.url,
      formFields: hasBetterFormProfile && candidate.formFields?.length ? candidate.formFields : existing.formFields,
      formProfile: hasBetterFormProfile ? candidate.formProfile ?? existing.formProfile : existing.formProfile,
      iconUrl: hasBetterIcon ? candidate.iconUrl : existing.iconUrl,
      iconType: hasBetterIcon ? candidate.iconType ?? 'favicon' : existing.iconType,
      updatedAt: Date.now()
    });
  const withRule = upsertSiteRuleFromForm(updatedVault, {
    domain: candidate.domain,
    url: candidate.url || existing.url,
    formFields: candidate.formFields?.length ? candidate.formFields : existing.formFields,
    formProfile: candidate.formProfile ?? existing.formProfile,
    source: 'save-prompt'
  });

  await persistVaultSession(session, withRule);

  return true;
}

async function getSaveCandidateContext(candidate: PendingLoginCandidate, frameUrl?: string): Promise<SaveCandidateContext> {
  const frameDomain = getTabDomain(frameUrl);

  if (frameDomain && !domainsMatch(candidate.domain, frameDomain)) {
    return { ok: true, ignored: true };
  }

  if (!savePolicy.autoPromptSave || domainMatchesList(candidate.domain, savePolicy.blacklist)) {
    clearPendingLoginCandidate();
    return { ok: true, ignored: true };
  }

  const session = await restoreCachedVaultSession();

  if (!session) {
    return { ok: true, locked: true, candidateId: candidate.id };
  }

  const exactDuplicate = session.vault.credentials.find((credential) => sameCandidatePassword(credential, candidate));

  if (exactDuplicate) {
    await refreshCredentialFormProfile(session, exactDuplicate, candidate);
    clearPendingLoginCandidate();
    return { ok: true, duplicate: true };
  }

  const existing = session.vault.credentials.find((credential) => sameCandidateAccount(credential, candidate));

  return {
    ok: true,
    candidateId: candidate.id,
    existing: existing ? { title: existing.title, username: existing.username } : undefined
  };
}

async function resolveSaveCandidate(mode: SaveCandidateMode, candidateId?: string, fallbackCandidate?: PendingLoginCandidate) {
  const pendingCandidate = getPendingLoginCandidate();
  const candidate = pendingCandidate && fallbackCandidate && pendingCandidate.id === fallbackCandidate.id
    ? { ...pendingCandidate, ...fallbackCandidate }
    : pendingCandidate ?? fallbackCandidate;

  if (!candidate || (candidateId && candidate.id !== candidateId)) {
    return { ok: false, error: 'SAVE_CANDIDATE_EXPIRED' };
  }

  if (mode === 'skip') {
    clearPendingLoginCandidate();
    return { ok: true, skipped: true };
  }

  const session = await restoreCachedVaultSession();

  if (!session) {
    return { ok: false, locked: true, error: 'VAULT_LOCKED' };
  }

  if (mode === 'blacklist') {
    const blacklist = Array.from(new Set([...session.vault.settings.blacklist, candidate.domain]));
    await persistVaultSession(session, upsertVaultSettings(session.vault, { blacklist }));
    clearPendingLoginCandidate();
    return { ok: true, blacklisted: true };
  }

  const exactDuplicate = session.vault.credentials.find((credential) => sameCandidatePassword(credential, candidate));

  if (exactDuplicate) {
    const refreshed = await refreshCredentialFormProfile(session, exactDuplicate, candidate);
    clearPendingLoginCandidate();
    return { ok: true, duplicate: !refreshed, updated: refreshed };
  }

  const existing = session.vault.credentials.find((credential) => sameCandidateAccount(credential, candidate));
  const shouldUpdate = Boolean(existing && (mode === 'save' || mode === 'update'));
  const credential = shouldUpdate && existing
    ? {
        ...existing,
        password: candidate.password,
        url: candidate.url,
        formFields: candidate.formFields?.length ? candidate.formFields : existing.formFields,
        formProfile: candidate.formProfile ?? existing.formProfile,
        iconUrl: candidate.iconUrl ?? existing.iconUrl,
        iconType: candidate.iconType ?? existing.iconType,
        title: candidate.title.trim() || existing.title || candidate.domain,
        updatedAt: Date.now()
      }
    : buildCredential({
        title: candidate.title,
        url: candidate.url,
        iconUrl: candidate.iconUrl,
        iconType: candidate.iconType,
        username: candidate.username,
        password: candidate.password,
        formFields: candidate.formFields,
        formProfile: candidate.formProfile,
        source: 'manual'
      });
  const vault = shouldUpdate ? updateCredentialInVault(session.vault, credential) : addCredentialToVault(session.vault, credential);
  const withRule = upsertSiteRuleFromForm(vault, {
    domain: candidate.domain,
    url: candidate.url,
    formFields: candidate.formFields,
    formProfile: candidate.formProfile,
    source: 'save-prompt'
  });

  await persistVaultSession(session, withRule);
  clearPendingLoginCandidate();

  return { ok: true, saved: true, updated: shouldUpdate, credentialId: credential.id };
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url) {
    markPendingSubmitNavigated(tabId, changeInfo.url);
    promoteStagedLoginCandidate(tabId, changeInfo.url);
  }

  if (changeInfo.status !== 'complete') {
    return;
  }

  void getTabById(tabId).then((tab) => {
    promoteStagedLoginCandidate(tabId, tab?.url);
    setTimeout(() => {
      void ensureContentScriptInTab(tabId, tab?.url);
    }, 700);
  });

  const pendingBinding = pendingBindings.get(tabId);
  if (pendingBinding) {
    if (Date.now() - pendingBinding.createdAt > 60000) {
      pendingBindings.delete(tabId);
    } else {
      void sendBindingToTab(tabId, pendingBinding);
    }
  }

  const pendingBindingTest = pendingBindingTests.get(tabId);
  if (pendingBindingTest) {
    if (Date.now() - pendingBindingTest.createdAt > 60000) {
      pendingBindingTests.delete(tabId);
    } else {
      void sendBindingTestToTab(tabId, pendingBindingTest);
    }
  }

  const pendingFill = pendingFills.get(tabId);

  if (!pendingFill) {
    return;
  }

  if (Date.now() - pendingFill.createdAt > 60000) {
    pendingFills.delete(tabId);
    return;
  }

  void sendFillToTab(tabId, pendingFill);
});

chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return;
  markPendingSubmitNavigated(details.tabId, details.url);
  promoteStagedLoginCandidate(details.tabId, details.url);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  pendingFills.delete(tabId);
  pendingBindings.delete(tabId);
  pendingBindingTests.delete(tabId);
  pendingSubmitOutcomes.delete(tabId);
  stagedLoginCandidates.delete(tabId);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'KEYPILOT_PING') {
    sendResponse({ ok: true, source: 'background' });
    return true;
  }

  if (message?.type === 'KEYPILOT_FETCH_SITE_METADATA') {
    void fetchSiteMetadata(message.url as string | undefined)
      .then((response) => sendResponse(response))
      .catch((error) => sendResponse({ ok: false, error: toErrorMessage(error) }));

    return true;
  }

  if (message?.type === 'KEYPILOT_OPEN_TAB') {
    const credential = message.credential as FillCredentialPayload;
    const action = message.action as 'login' | 'fill' | 'goto';

    if (!credential?.url || !isSupportedOpenUrl(credential.url)) {
      sendResponse({ ok: false, error: 'INVALID_CREDENTIAL_URL' });
      return false;
    }

    if (!['login', 'fill', 'goto'].includes(action)) {
      sendResponse({ ok: false, error: 'INVALID_CREDENTIAL_ACTION' });
      return false;
    }

    try {
      sendResponse({ ok: true, queued: true });

      setTimeout(() => {
        chrome.tabs.create({ url: credential.url, active: false }, (tab) => {
          if (chrome.runtime.lastError || !tab.id) {
            return;
          }

          if (action !== 'goto') {
            const pendingFill = {
              credential: {
                ...credential,
                autoSubmit: action === 'login' ? credential.autoSubmit : false
              },
              createdAt: Date.now(),
              attempts: 0
            };
            pendingFills.set(tab.id, pendingFill);
            void resolveFillPayload(
              pendingFill.credential,
              tab.url ?? credential.url
            ).then((resolvedCredential) => {
              if (pendingFills.get(tab.id!) === pendingFill) {
                pendingFill.credential = resolvedCredential;
              }
            });
          }

          setTimeout(() => {
            chrome.tabs.update(tab.id!, { active: true });
          }, 250);
        });
      }, 0);
    } catch (error) {
      sendResponse({ ok: false, error: toErrorMessage(error) });
    }

    return false;
  }

  if (message?.type === 'KEYPILOT_OPEN_AND_BIND') {
    void openTabAndStartManualBinding(message.credentialId as string | undefined)
      .then((response) => sendResponse(response))
      .catch((error) => {
        const errorMessage = toErrorMessage(error);
        sendResponse({ ok: false, locked: errorMessage === 'VAULT_LOCKED', error: errorMessage });
      });

    return true;
  }

  if (message?.type === 'KEYPILOT_OPEN_AND_TEST_BINDING') {
    void openTabAndTestBinding(message.credentialId as string | undefined)
      .then((response) => sendResponse(response))
      .catch((error) => {
        const errorMessage = toErrorMessage(error);
        sendResponse({ ok: false, locked: errorMessage === 'VAULT_LOCKED', error: errorMessage });
      });

    return true;
  }

  if (message?.type === 'KEYPILOT_FILL_ACTIVE_TAB') {
    const tabId = sender.tab?.id ?? message.tabId;

    if (!tabId) {
      sendResponse({ ok: false, error: 'NO_ACTIVE_TAB' });
      return true;
    }

    void getTabById(tabId)
      .then((tab) => resolveFillPayload(message.credential as FillCredentialPayload, tab?.url))
      .then((credential) => fillTabBestFrame(tabId, credential))
      .then((response) => sendResponse(response))
      .catch((error) => sendResponse({ ok: false, error: toErrorMessage(error) }));

    return true;
  }

  if (message?.type === 'KEYPILOT_FILL_PROFILE_ACTIVE_TAB') {
    const tabId = sender.tab?.id ?? message.tabId;
    const profile = message.profile as FillProfilePayload | undefined;

    if (!tabId) {
      sendResponse({ ok: false, error: 'NO_ACTIVE_TAB', filledCount: 0, matchedCount: 0, skippedCount: 0, totalFields: profile?.fields.length ?? 0 });
      return true;
    }

    if (!profile?.fields?.length) {
      sendResponse({ ok: false, error: 'INVALID_FILL_PROFILE', filledCount: 0, matchedCount: 0, skippedCount: 0, totalFields: 0 });
      return true;
    }

    void fillProfileActiveTab(tabId, profile)
      .then((response) => sendResponse(response))
      .catch((error) =>
        sendResponse({
          ok: false,
          error: toErrorMessage(error),
          filledCount: 0,
          matchedCount: 0,
          skippedCount: 0,
          totalFields: profile.fields.length
        })
      );

    return true;
  }

  if (message?.type === 'KEYPILOT_START_FILL_PROFILE_BINDING') {
    const tabId = sender.tab?.id ?? message.tabId;

    if (typeof tabId !== 'number') {
      sendResponse({ ok: false, error: 'NO_ACTIVE_TAB' });
      return true;
    }

    void startFillProfileBinding(tabId, message.profileId as string | undefined)
      .then((response) => sendResponse(response))
      .catch((error) => {
        const errorMessage = toErrorMessage(error);
        sendResponse({ ok: false, locked: errorMessage === 'VAULT_LOCKED', error: errorMessage });
      });

    return true;
  }

  if (message?.type === 'KEYPILOT_START_MANUAL_BINDING') {
    const tabId = message.tabId as number | undefined;

    if (typeof tabId !== 'number') {
      sendResponse({ ok: false, error: 'NO_ACTIVE_TAB' });
      return true;
    }

    void startManualBinding(tabId, message.credentialId as string | undefined)
      .then((response) => sendResponse(response))
      .catch((error) => {
        const errorMessage = toErrorMessage(error);
        sendResponse({ ok: false, locked: errorMessage === 'VAULT_LOCKED', error: errorMessage });
      });

    return true;
  }

  if (message?.type === 'KEYPILOT_GET_INLINE_MATCHES') {
    void getInlineState([sender.url, sender.tab?.url])
      .then((state) => {
        sendResponse({
          ok: true,
          locked: false,
          hidden: state.hidden,
          matches: state.matches,
          fillProfiles: state.fillProfiles,
          siteRule: state.siteRule
        });
      })
      .catch((error) => {
        const errorMessage = toErrorMessage(error);
        sendResponse({
          ok: false,
          locked: errorMessage === 'VAULT_LOCKED',
          error: errorMessage
        });
      });

    return true;
  }

  if (message?.type === 'KEYPILOT_GET_BINDING_CREDENTIAL') {
    void getBindingCredential(sender.url ?? sender.tab?.url, message.credentialId as string | undefined)
      .then((response) => sendResponse(response))
      .catch((error) => {
        const errorMessage = toErrorMessage(error);
        sendResponse({ ok: false, locked: errorMessage === 'VAULT_LOCKED', error: errorMessage });
      });

    return true;
  }

  if (message?.type === 'KEYPILOT_SAVE_MANUAL_BINDING') {
    void saveManualBinding(sender.url ?? sender.tab?.url, message.binding as ManualBindingResult | undefined)
      .then((response) => sendResponse(response))
      .catch((error) => {
        const errorMessage = toErrorMessage(error);
        sendResponse({ ok: false, locked: errorMessage === 'VAULT_LOCKED', error: errorMessage });
      });

    return true;
  }

  if (message?.type === 'KEYPILOT_APPLY_RECOGNITION_RULE') {
    void applyRecognitionRule(sender.url ?? sender.tab?.url, message.rule as RecognitionRuleApplyRequest | undefined)
      .then((response) => sendResponse(response))
      .catch((error) => {
        const errorMessage = toErrorMessage(error);
        sendResponse({ ok: false, locked: errorMessage === 'VAULT_LOCKED', error: errorMessage });
      });

    return true;
  }

  if (message?.type === 'KEYPILOT_SAVE_FILL_PROFILE_BINDING') {
    void saveFillProfileBinding(sender.url ?? sender.tab?.url, message.binding as FillProfileBindingResult | undefined)
      .then((response) => sendResponse(response))
      .catch((error) => {
        const errorMessage = toErrorMessage(error);
        sendResponse({ ok: false, locked: errorMessage === 'VAULT_LOCKED', error: errorMessage });
      });

    return true;
  }

  if (message?.type === 'KEYPILOT_GET_INLINE_CREDENTIAL') {
    void getInlineCredentialForEdit(sender.url ?? sender.tab?.url, message.credentialId as string | undefined)
      .then((response) => sendResponse(response))
      .catch((error) => {
        const errorMessage = toErrorMessage(error);
        sendResponse({
          ok: false,
          locked: errorMessage === 'VAULT_LOCKED',
          error: errorMessage
        });
      });

    return true;
  }

  if (message?.type === 'KEYPILOT_SAVE_INLINE_CREDENTIAL') {
    void saveInlineCredentialEdit(sender.url ?? sender.tab?.url, message.credential as Credential | undefined)
      .then((response) => sendResponse(response))
      .catch((error) => {
        const errorMessage = toErrorMessage(error);
        sendResponse({
          ok: false,
          locked: errorMessage === 'VAULT_LOCKED',
          error: errorMessage
        });
      });

    return true;
  }

  if (message?.type === 'KEYPILOT_INLINE_COMMAND') {
    void handleInlineCredentialCommand(
      sender.url ?? sender.tab?.url,
      message.credentialId as string | undefined,
      message.command as InlineCredentialCommand | undefined
    )
      .then((response) => sendResponse(response))
      .catch((error) => {
        const errorMessage = toErrorMessage(error);
        sendResponse({
          ok: false,
          locked: errorMessage === 'VAULT_LOCKED',
          error: errorMessage
        });
      });

    return true;
  }

  if (message?.type === 'KEYPILOT_GET_ACTIVE_TAB_DIAGNOSTICS') {
    void getActiveTabDiagnostics()
      .then((diagnostics) => sendResponse(diagnostics))
      .catch((error) => sendResponse({ ok: false, error: toErrorMessage(error), frames: [] }));

    return true;
  }

  if (message?.type === 'KEYPILOT_INLINE_FILL') {
    const tabId = sender.tab?.id;

    if (!tabId) {
      sendResponse({ ok: false, error: 'NO_ACTIVE_TAB' });
      return true;
    }

    void fillInlineCredential(tabId, sender.url ?? sender.tab?.url, sender.frameId, message.request as InlineCredentialFillRequest)
      .then((response) => sendResponse(response))
      .catch((error) => {
        const errorMessage = toErrorMessage(error);
        sendResponse({
          ok: false,
          locked: errorMessage === 'VAULT_LOCKED',
          error: errorMessage
        });
      });

    return true;
  }

  if (message?.type === 'KEYPILOT_INLINE_FILL_PROFILE') {
    const tabId = sender.tab?.id;

    if (!tabId) {
      sendResponse({ ok: false, error: 'NO_ACTIVE_TAB', filledCount: 0, matchedCount: 0, skippedCount: 0, totalFields: 0 });
      return true;
    }

    void fillInlineProfile(tabId, sender.url ?? sender.tab?.url, sender.frameId, message.request as InlineFillProfileFillRequest)
      .then((response) => sendResponse(response))
      .catch((error) => {
        const errorMessage = toErrorMessage(error);
        sendResponse({
          ok: false,
          locked: errorMessage === 'VAULT_LOCKED',
          error: errorMessage,
          filledCount: 0,
          matchedCount: 0,
          skippedCount: 0,
          totalFields: 0
        });
      });

    return true;
  }

  if (message?.type === 'KEYPILOT_RENAME_FILL_PROFILE') {
    void renameInlineFillProfile(message.profileId as string | undefined, message.title as string | undefined)
      .then((response) => sendResponse(response))
      .catch((error) => {
        const errorMessage = toErrorMessage(error);
        sendResponse({
          ok: false,
          locked: errorMessage === 'VAULT_LOCKED',
          error: errorMessage
        });
      });

    return true;
  }

  if (message?.type === 'KEYPILOT_DELETE_FILL_PROFILE') {
    void deleteInlineFillProfile(message.profileId as string | undefined)
      .then((response) => sendResponse(response))
      .catch((error) => {
        const errorMessage = toErrorMessage(error);
        sendResponse({
          ok: false,
          locked: errorMessage === 'VAULT_LOCKED',
          error: errorMessage
        });
      });

    return true;
  }

  if (message?.type === 'KEYPILOT_SAVE_CANDIDATE') {
    const candidate = message.candidate as PendingLoginCandidate;

    if (!validateLoginCandidate(candidate)) {
      sendResponse({ ok: false, error: 'INVALID_SAVE_CANDIDATE' });
      return true;
    }

    const tabId = sender.tab?.id;
    if (typeof tabId === 'number') {
      stagedLoginCandidates.delete(tabId);
    }

    publishLoginCandidate(candidate);

    void getSaveCandidateContext(candidate, sender.url ?? sender.tab?.url)
      .then((context) => sendResponse(context))
      .catch((error) => sendResponse({ ok: false, error: toErrorMessage(error) }));

    return true;
  }

  if (message?.type === 'KEYPILOT_STAGE_SAVE_CANDIDATE') {
    const candidate = message.candidate as PendingLoginCandidate;
    const tabId = sender.tab?.id;

    if (!validateLoginCandidate(candidate) || typeof tabId !== 'number') {
      sendResponse({ ok: false, error: 'INVALID_SAVE_CANDIDATE' });
      return true;
    }

    stageLoginCandidate(tabId, candidate);
    sendResponse({ ok: true });
    return true;
  }

  if (message?.type === 'KEYPILOT_GET_SAVE_PROMPT') {
    const candidate = getPendingLoginCandidate();

    if (!candidate) {
      sendResponse({ ok: true, candidate: null });
      return true;
    }

    void getSaveCandidateContext(candidate, sender.url ?? sender.tab?.url)
      .then((context) => {
        if (context.ignored || context.duplicate) {
          sendResponse({ ...context, candidate: null });
          return;
        }

        sendResponse({ ...context, candidate });
      })
      .catch((error) => sendResponse({ ok: false, error: toErrorMessage(error), candidate: null }));

    return true;
  }

  if (message?.type === 'KEYPILOT_RESOLVE_SAVE_CANDIDATE') {
    void resolveSaveCandidate(
      message.mode as SaveCandidateMode,
      message.candidateId as string | undefined,
      message.candidate as PendingLoginCandidate | undefined
    )
      .then((response) => sendResponse(response))
      .catch((error) => {
        const errorMessage = toErrorMessage(error);
        sendResponse({ ok: false, locked: errorMessage === 'VAULT_LOCKED', error: errorMessage });
      });

    return true;
  }

  if (message?.type === 'KEYPILOT_SET_SAVE_POLICY') {
    savePolicy = {
      autoPromptSave: Boolean(message.autoPromptSave),
      blacklist: Array.isArray(message.blacklist) ? message.blacklist : []
    };

    if (pendingLoginCandidate && (!savePolicy.autoPromptSave || savePolicy.blacklist.includes(pendingLoginCandidate.domain))) {
      clearPendingLoginCandidate();
    }

    sendResponse({ ok: true });
    return true;
  }

  if (message?.type === 'KEYPILOT_GET_SAVE_CANDIDATE') {
    sendResponse({ ok: true, candidate: getPendingLoginCandidate() });
    return true;
  }

  if (message?.type === 'KEYPILOT_CLEAR_SAVE_CANDIDATE') {
    clearPendingLoginCandidate();
    if (typeof sender.tab?.id === 'number') {
      stagedLoginCandidates.delete(sender.tab.id);
    }
    sendResponse({ ok: true });
    return true;
  }

  return false;
});
