import { siteLoginSettings, siteAllowsSubmit } from '../shared/loginSettings';
import { setSavePromptBadge } from './reminders';
import { setupLoginJobs, type ManagedLoginGuard } from './loginJobs';
import { setupCaptcha } from './captcha';
import { authorizeLoginSubmit, continueLoginTotp } from './loginContinuation';
import { sameLoginTarget } from '../shared/loginJob';
import type { FillChoice, QuickFillProbe, QuickFillTarget } from '../shared/quickFill';
import { ensureOffscreenDocument } from './offscreen';
import { getSessionState, handleSecureCacheMessage, isVaultSessionActive } from '../shared/storage';
import { generateTotp, totpSecondsRemaining } from '../shared/totp';
import { credentialMatchesUrl, domainsMatch, extractDomain, extractMatchDomain, normalizeMatchUrl, normalizeUrl } from '../shared/domain';
import { appendDiagnosticLogEntry, clearDiagnosticLogEntries, getDiagnosticLogEntries } from '../shared/diagnosticsLog';
import { getRootFaviconUrl, toHttpIconUrl } from '../shared/icons';
import { appendPendingSaveCandidate } from '../shared/saveInbox';
import {
  addCredentialToVault,
  buildCredential,
  clearVaultSessionCache,
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
  DiagnosticLogEntry,
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
  InlineSilentRule,
  InlineSilentRuleReason,
  InlineSilentRuleSummary,
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

const openManagedLogin = setupLoginJobs(credentialToFillPayload, fillTabBestFrame);
setupCaptcha();
const pendingBindings = new Map<number, PendingBinding>();
const pendingBindingTests = new Map<number, PendingBindingTest>();
const pendingSubmitOutcomes = new Map<number, SubmitOutcome>();
const stagedLoginCandidates = new Map<number, StagedLoginCandidate>();
const recordedSubmitOutcomeKeys = new Set<string>();
const SUBMIT_OUTCOME_TTL = 30000;
const STAGED_CANDIDATE_TTL = 90000;
const SITE_RULE_LIMIT = 120;
const INLINE_SILENT_RULE_LIMIT = 120;
const INLINE_SILENT_RULE_TTL = 1000 * 60 * 60 * 24 * 90;
const DEFAULT_REPAIR_ACTIONS: SubmitRepairAction[] = ['commit-fields', 'wait-enabled-click', 'retry-click', 'click-nearby', 'enter-password', 'request-submit'];
const FAILED_LOGIN_REDIRECT_PATTERN = /(?:^|[?&#/])(error|err|failed|failure|invalid|denied|captcha|verify|verification|locked|disabled)(?:[=&#/]|$)/i;
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
  setSavePromptBadge(false);
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

function currentPathPatternFromUrl(value?: string): string | undefined {
  if (!value || !/^https?:\/\//i.test(value)) return undefined;

  try {
    const url = new URL(value);
    const pathname = url.pathname || '/';
    if (pathname === '/') return undefined;
    if (pathname.split('/').filter(Boolean).length <= 1) return pathname;
    return pathname.replace(/\/[^/]*$/, '/*');
  } catch {
    return undefined;
  }
}

function inlineSilentRulePathMatches(rule: InlineSilentRule, urlOrDomain?: string): boolean {
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

function activeInlineSilentRules(rules: InlineSilentRule[] = [], now = Date.now()): InlineSilentRule[] {
  return rules.filter((rule) => !rule.expiresAt || rule.expiresAt > now);
}

function selectInlineSilentRule(session: UnlockedVaultSession, tabUrl?: string): InlineSilentRule | undefined {
  if (session.vault.settings.autoSilentInline === false) return undefined;

  const tabDomain = getTabDomain(tabUrl);
  if (!tabDomain) return undefined;

  return activeInlineSilentRules(session.vault.settings.inlineSilentRules ?? [])
    .filter((rule) => domainsMatch(rule.domain, tabDomain))
    .filter((rule) => inlineSilentRulePathMatches(rule, tabUrl))
    .sort((left, right) => {
      const leftPathSpecificity = normalizeRulePathPattern(left.pathPattern)?.length ?? 0;
      const rightPathSpecificity = normalizeRulePathPattern(right.pathPattern)?.length ?? 0;
      if (leftPathSpecificity !== rightPathSpecificity) return rightPathSpecificity - leftPathSpecificity;
      if (left.matchCount !== right.matchCount) return right.matchCount - left.matchCount;
      return right.updatedAt - left.updatedAt;
    })[0];
}

function toInlineSilentRuleSummary(rule?: InlineSilentRule): InlineSilentRuleSummary | undefined {
  if (!rule) return undefined;

  return {
    id: rule.id,
    domain: rule.domain,
    pathPattern: rule.pathPattern,
    reason: rule.reason,
    source: rule.source ?? 'auto',
    title: rule.title,
    lastUrl: rule.lastUrl,
    confidence: rule.confidence,
    matchCount: rule.matchCount,
    updatedAt: rule.updatedAt,
    lastMatchedAt: rule.lastMatchedAt,
    expiresAt: rule.expiresAt
  };
}

function sanitizeInlineSilentReason(value: unknown): InlineSilentRuleReason {
  return value === 'empty-page' || value === 'no-form-context' || value === 'no-inline-anchor' || value === 'passive-form' || value === 'manual-hide'
    ? value
    : 'no-inline-anchor';
}

function sanitizeInlineSilentSource(value: unknown): InlineSilentRule['source'] {
  return value === 'manual' ? 'manual' : 'auto';
}

function sanitizeInlineSilentTitle(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const title = value.replace(/\s+/g, ' ').trim();
  return title ? title.slice(0, 120) : undefined;
}

function removeInlineSilentRule(
  vault: UnlockedVaultSession['vault'],
  input: {
    url?: string;
    ruleId?: unknown;
  }
): { vault: UnlockedVaultSession['vault']; removedCount: number } {
  const activeRules = activeInlineSilentRules(vault.settings.inlineSilentRules ?? []);
  const ruleId = typeof input.ruleId === 'string' ? input.ruleId : undefined;
  const domain = getTabDomain(input.url);

  if (!ruleId && !domain) {
    return { vault, removedCount: 0 };
  }

  const inlineSilentRules = activeRules.filter((rule) => {
    if (ruleId) return rule.id !== ruleId;
    return !(domain && domainsMatch(rule.domain, domain) && inlineSilentRulePathMatches(rule, input.url));
  });
  const removedCount = activeRules.length - inlineSilentRules.length;

  return {
    vault: removedCount ? upsertVaultSettings(vault, { inlineSilentRules }) : vault,
    removedCount
  };
}

function upsertInlineSilentRule(
  vault: UnlockedVaultSession['vault'],
  input: {
    url?: string;
    reason?: unknown;
    confidence?: unknown;
    source?: unknown;
    title?: unknown;
  }
): UnlockedVaultSession['vault'] {
  const domain = getTabDomain(input.url);
  if (!domain) return vault;

  const now = Date.now();
  const source = sanitizeInlineSilentSource(input.source);
  const pathPattern = currentPathPatternFromUrl(input.url);
  if (!pathPattern && source !== 'manual') return vault;
  const reason = sanitizeInlineSilentReason(input.reason);
  const confidence = Math.max(0, Math.min(1, Number(input.confidence) || 0.75));
  const activeRules = activeInlineSilentRules(vault.settings.inlineSilentRules ?? [], now);
  const existing = activeRules.find((rule) => domainsMatch(rule.domain, domain) && (normalizeRulePathPattern(rule.pathPattern) ?? '') === (pathPattern ?? ''));
  const nextRule: InlineSilentRule = {
    id: existing?.id ?? crypto.randomUUID(),
    domain,
    pathPattern,
    reason,
    source,
    title: sanitizeInlineSilentTitle(input.title) ?? existing?.title,
    lastUrl: input.url && /^https?:\/\//i.test(input.url) ? input.url : existing?.lastUrl,
    confidence: Math.max(existing?.confidence ?? 0, confidence),
    matchCount: (existing?.matchCount ?? 0) + 1,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    lastMatchedAt: now,
    expiresAt: source === 'manual' ? undefined : now + INLINE_SILENT_RULE_TTL
  };
  const inlineSilentRules = [nextRule, ...activeRules.filter((rule) => rule.id !== nextRule.id)]
    .sort((left, right) => {
      if (left.matchCount !== right.matchCount) return right.matchCount - left.matchCount;
      return right.updatedAt - left.updatedAt;
    })
    .slice(0, INLINE_SILENT_RULE_LIMIT);

  return upsertVaultSettings(vault, { inlineSilentRules });
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
  profile = { ...profile, fields: profile.fields.filter(field => field.sensitivity === 'normal') };
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
  if(vault && siteLoginSettings(vault.settings,targetUrl).fillEnabled===false)throw new Error('此网站已关闭账号填写，请在账号详情的“此网站设置”中开启。');
  const siteRule = selectSiteRule(vault, targetUrl || credential.url || credential.domain);

  return {
    id: credential.id,
    url: credential.url,
    domain: credential.domain,
    username: credential.username,
    password: credential.password,
    loginRequested: autoSubmit,
    autoSubmit: autoSubmit && Boolean(vault && siteAllowsSubmit(vault.settings,targetUrl)),
    formFields: mergeCredentialFields(credential, siteRule),
    formProfile: siteRule?.formProfile ?? credential.formProfile,
    siteRuleId: siteRule?.id,
    repairActions: siteRule?.repairActions ?? DEFAULT_REPAIR_ACTIONS
  };
}

function normalizedPathPatternFromUrl(value?: string): string | undefined {
  if (!value) return undefined;

  try {
    const path = new URL(value).pathname || '/';
    return path === '/' ? undefined : path;
  } catch {
    return undefined;
  }
}

function bindingPathMatches(binding: FillProfileSiteBinding, targetUrl?: string): boolean {
  if (!binding.pathPattern) return true;
  const path = normalizedPathPatternFromUrl(targetUrl);
  if (!path) return false;
  return path === binding.pathPattern || path.startsWith(`${binding.pathPattern.replace(/\/$/, '')}/`);
}

function sameBindingTarget(left: FillProfileSiteBinding, domain: string, pathPattern?: string): boolean {
  return domainsMatch(left.domain, domain) && (left.pathPattern ?? '') === (pathPattern ?? '');
}

function selectFillProfileSiteBinding(profile: FillProfile, targetUrl?: string): FillProfileSiteBinding | undefined {
  const domain = getTabDomain(targetUrl);
  if (!domain) return undefined;

  return (profile.siteBindings ?? [])
    .filter((binding) => domainsMatch(binding.domain, domain))
    .filter((binding) => bindingPathMatches(binding, targetUrl))
    .sort((left, right) => {
      const leftPathScore = left.pathPattern ? left.pathPattern.length : 0;
      const rightPathScore = right.pathPattern ? right.pathPattern.length : 0;
      if (leftPathScore !== rightPathScore) return rightPathScore - leftPathScore;
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
    url: credential.url,
    formFields: credential.formFields,
    formProfile: credential.formProfile,
    source: 'auto-repair'
  });
  const rules = withRule.settings.siteRules ?? [];
  // Navigation and disappearing forms cannot establish an authenticated session.
  const failed = outcome.status === 'errorVisible';
  const siteRules = rules.map((rule) =>
    domainsMatch(rule.domain, credential.domain)
      ? {
          ...rule,
          successCount: rule.successCount ?? 0,
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

  if (!session || !credential) throw new Error(session?'NO_MATCHING_CREDENTIAL':'VAULT_LOCKED');
  if(targetUrl && !credentialMatchesUrl(credential,targetUrl))throw new Error('NO_MATCHING_CREDENTIAL');

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
    message: '页面已跳转，登录结果尚未确认。',
    url: url ?? outcome.url,
    checkedAt: Date.now()
  });
}

function getInlineMatchesFromSession(session: UnlockedVaultSession, tabUrl?: string): InlineCredentialSummary[] {
  return session.vault.credentials
    .filter((credential) => credentialMatchesTab(credential, tabUrl))
    .sort((left, right) => {
      const preferred=siteLoginSettings(session.vault.settings,tabUrl ?? '').defaultCredentialId;
      if((left.id===preferred)!==(right.id===preferred))return left.id===preferred?-1:1;
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
      const preferred=matchUrls.map(url=>siteLoginSettings(session.vault.settings,url).defaultCredentialId).find(Boolean);
      if((left.id===preferred)!==(right.id===preferred))return left.id===preferred?-1:1;
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

async function getInlineState(urls: Array<string | undefined>): Promise<{ hidden: boolean; matches: InlineCredentialSummary[]; fillProfiles: InlineFillProfileSummary[]; silentRule?: InlineSilentRuleSummary; siteRule?: SiteRuleSummary }> {
  const session = await restoreCachedVaultSession();

  if (!session) {
    throw new Error('VAULT_LOCKED');
  }

  const targetUrl = urls.find((url): url is string => Boolean(url));
  const activeSilentRules = activeInlineSilentRules(session.vault.settings.inlineSilentRules ?? []);
  if (activeSilentRules.length !== (session.vault.settings.inlineSilentRules ?? []).length) {
    await persistVaultSession(session, upsertVaultSettings(session.vault, { inlineSilentRules: activeSilentRules }));
  }

  const silentRule = selectInlineSilentRule(session, targetUrl);
  const hidden =
    urls.some((url) => isInlineHiddenForTab(session, url)) ||
    Boolean(silentRule);
  const siteRule = selectSiteRule(session.vault, targetUrl);

  return {
    hidden,
    matches: hidden ? [] : getInlineMatchesForUrls(session, urls),
    fillProfiles: hidden ? [] : getInlineFillProfiles(session, targetUrl),
    silentRule: toInlineSilentRuleSummary(silentRule),
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

  if (session.vault.settings.requireMasterPasswordForReveal) return {ok:false,error:'REAUTH_REQUIRED'};

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
  command: InlineCredentialCommand | undefined,
  pageTitle?: unknown
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

    const nextVault = upsertInlineSilentRule(session.vault, {
      url: tabUrl,
      reason: 'manual-hide',
      confidence: 1,
      source: 'manual',
      title: pageTitle
    });
    await persistVaultSession(session, nextVault);
    return { ok: true, hidden: true, message: '已在此页面隐藏 KeyPilot 网页内图标，可在设置中恢复。' };
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

async function fillTotpInTab(accountId: string, tabId: number, sessionId: string) {
  const session = await restoreCachedVaultSession();
  if (!session || session.sessionId!==sessionId) throw new Error('VAULT_LOCKED');
  const account = session.vault.totpAccounts?.find(item=>item.id===accountId && !item.deletedAt);
  const credential = session.vault.credentials.find(item=>item.id===account?.credentialId);
  const tab = await getTabById(tabId);
  if (!account || !credential) throw new Error('OTP_NOT_LINKED');
  if (!tab?.url || !credentialMatchesUrl(credential,tab.url)) throw new Error('OTP_SITE_MISMATCH');
  if (new URL(credential.url).protocol==='https:' && new URL(tab.url).protocol!=='https:') throw new Error('OTP_SITE_MISMATCH');
  await ensureContentScriptInTab(tabId,tab.url);
  const origin = new URL(tab.url).origin;
  const frames = (await getTabFrames(tab)).filter(frame=>new URL(frame.url).origin===origin);
  const matches = [];
  for (const frame of frames) {
    const response = await chrome.tabs.sendMessage(tabId,{type:'KEYPILOT_PROBE_TOTP',digits:account.digits,expectedUrl:frame.url},{frameId:frame.frameId}).catch(()=>null);
    if (response?.count>1) throw new Error('OTP_AMBIGUOUS');
    if (response?.count===1) matches.push(frame);
  }
  if (matches.length!==1) throw new Error(matches.length?'OTP_AMBIGUOUS':'OTP_NOT_FOUND');
  if (!await isVaultSessionActive(sessionId)) throw new Error('VAULT_LOCKED');
  const latest = await restoreCachedVaultSession();
  const latestAccount = latest?.vault.totpAccounts?.find(item=>item.id===accountId && !item.deletedAt);
  if (latest?.sessionId!==sessionId || JSON.stringify(latestAccount)!==JSON.stringify(account) || JSON.stringify(latest.vault.credentials.find(item=>item.id===credential.id))!==JSON.stringify(credential)) throw new Error('VAULT_LOCKED');
  const now = Date.now();
  if (totpSecondsRemaining(account.period,now)<=Math.min(5,account.period/2)) throw new Error('OTP_EXPIRING');
  const code = await generateTotp(account,now);
  if (!await isVaultSessionActive(sessionId)) throw new Error('VAULT_LOCKED');
  return chrome.tabs.sendMessage(tabId,{type:'KEYPILOT_FILL_TOTP_CODE',code,expectedUrl:matches[0].url,expiresAt:(Math.floor(now/1000/account.period)+1)*account.period*1000},{frameId:matches[0].frameId});
}

function sendFillMessage(tabId: number, frameId: number | undefined, credential: FillCredentialPayload, documentId?: string): Promise<FillCredentialResult> {
  return new Promise((resolve) => {
    const message = { type: 'KEYPILOT_FILL_CREDENTIAL', credential };
    const callback = (response?: FillCredentialResult) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }

      resolve(response ?? { ok: false, error: 'NO_RESPONSE' });
    };

    if (documentId) {
      chrome.tabs.sendMessage(tabId, message, { documentId }, callback);
      return;
    }
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

async function fillTabBestFrame(tabId: number, credential: FillCredentialPayload, guard?: ManagedLoginGuard) {
  const tab = await getTabById(tabId);
  const frameId = tab ? await chooseCredentialFrame(tab, credential) : undefined;
  if (guard) {
    const main = await chrome.webNavigation.getFrame({ tabId, frameId: 0 }).catch(() => null);
    if (!main || main.errorOccurred || main.documentId !== guard.documentId || main.url !== guard.url) return { ok: false, error: 'LOGIN_CONTEXT_CHANGED' };
    let frame = typeof frameId === 'number' && frameId !== 0
      ? await chrome.webNavigation.getFrame({ tabId, frameId }).catch(() => null) : main;
    // A continuation may only fill a document on the verified origin.
    if (!frame || frame.errorOccurred || !sameLoginTarget(new URL(guard.url).origin, frame.url)) frame = main;
    if (!frame.documentId) return { ok: false, error: 'LOGIN_CONTEXT_CHANGED' };
    if (!await guard.authorize()) return { ok: false, error: 'LOGIN_CANCELLED' };
    if (!await isVaultSessionActive(guard.sessionId)) return { ok: false, error: 'VAULT_LOCKED' };
    const response = await sendFillMessage(tabId, frameId, credential, frame.documentId);
    rememberSubmitOutcome(tabId, response);
    return response;
  }
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
  const pathPattern = binding.pathPattern || undefined;

  const now = Date.now();
  const existing = (profile.siteBindings ?? []).find((item) => sameBindingTarget(item, domain, pathPattern));
  const siteBinding: FillProfileSiteBinding = {
    id: existing?.id ?? crypto.randomUUID(),
    domain,
    pathPattern,
    fields: binding.fields.slice(0, 120),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    successCount: existing?.successCount,
    failureCount: existing?.failureCount
  };
  const siteBindings = [siteBinding, ...(profile.siteBindings ?? []).filter((item) => !sameBindingTarget(item, domain, pathPattern))].slice(0, 80);

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

      try {
        if (result?.ok) {
          if (!session.sessionId || !await isVaultSessionActive(session.sessionId)) {
            resolve({ok:false,error:'VAULT_LOCKED'});
            return;
          }
          rememberSubmitOutcome(tabId, result);
          await persistVaultSession(session, touchCredentialInVault(session.vault, credential.id));
        }
        resolve(response ?? { ok: false, error: 'NO_RESPONSE' });
      } catch (error) {
        // OCR can outlive a lock. Always settle the channel, including failed metadata writes.
        resolve({ok:false,error:toErrorMessage(error)});
      }
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
  const withRule = upsertSiteRuleFromForm(session.vault, {
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
  const { vault: nextVault } = removeInlineSilentRule(withRule, { url });

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
  setSavePromptBadge(false);
}

function validateLoginCandidate(candidate: PendingLoginCandidate | undefined): candidate is PendingLoginCandidate {
  return Boolean(candidate?.domain && candidate.username && candidate.password);
}

function publishLoginCandidate(candidate: PendingLoginCandidate) {
  pendingLoginCandidate = candidate;
  pendingLoginCandidateExpiresAt = Date.now() + STAGED_CANDIDATE_TTL;
  setSavePromptBadge(true);
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

  if (url && FAILED_LOGIN_REDIRECT_PATTERN.test(url)) {
    stagedLoginCandidates.delete(tabId);
    return null;
  }

  const urlDomain = getTabDomain(url);
  if (urlDomain && !domainsMatch(staged.candidate.domain, urlDomain)) {
    return null;
  }

  if (!stagedCandidateUrlChanged(staged.candidate, url)) {
    return null;
  }

  publishLoginCandidate({
    ...staged.candidate,
    // The destination may be an OTP page or dashboard. Preserve the form's login URL.
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

async function recordDiagnosticLog(entry: Omit<DiagnosticLogEntry, 'id' | 'createdAt'> & Partial<Pick<DiagnosticLogEntry, 'id' | 'createdAt'>>) {
  const session = await restoreCachedVaultSession();
  const settings = session?.vault.settings;

  if (!settings?.diagnosticLogging) {
    return { ok: true, stored: false };
  }

  const logs = await appendDiagnosticLogEntry(entry, {
    limit: settings.diagnosticLogLimit,
    retentionDays: settings.diagnosticLogRetentionDays
  });

  return { ok: true, stored: true, count: logs.length };
}

async function readDiagnosticLog() {
  const session = await restoreCachedVaultSession();
  const settings = session?.vault.settings;
  const logs = await getDiagnosticLogEntries({
    limit: settings?.diagnosticLogLimit,
    retentionDays: settings?.diagnosticLogRetentionDays
  });

  return { ok: true, logs, enabled: Boolean(settings?.diagnosticLogging) };
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
    void recordDiagnosticLog({
      area: 'save-prompt',
      event: 'resolve-save-candidate',
      outcome: 'ignored',
      domain: candidate.domain,
      reason: '用户暂不保存登录信息。',
      source: candidate.source
    }).catch(() => undefined);
    clearPendingLoginCandidate();
    return { ok: true, skipped: true };
  }

  const session = await restoreCachedVaultSession();

  if (!session) {
    if (mode === 'blacklist') {
      savePolicy.blacklist = Array.from(new Set([...savePolicy.blacklist, candidate.domain]));
      void recordDiagnosticLog({
        area: 'save-prompt',
        event: 'resolve-save-candidate',
        outcome: 'ignored',
        domain: candidate.domain,
        reason: 'Vault 锁定时将当前网站加入临时不保存列表。',
        source: candidate.source
      }).catch(() => undefined);
      clearPendingLoginCandidate();
      return { ok: true, blacklisted: true, volatile: true };
    }

    await appendPendingSaveCandidate(candidate);
    void recordDiagnosticLog({
      area: 'save-prompt',
      event: 'resolve-save-candidate',
      outcome: 'success',
      domain: candidate.domain,
      reason: 'Vault 锁定，登录信息已加密暂存等待下次解锁导入。',
      source: candidate.source,
      counts: {
        locked: true,
        fields: candidate.formFields?.length ?? 0
      }
    }).catch(() => undefined);
    clearPendingLoginCandidate();
    return { ok: true, queued: true };
  }

  if (mode === 'blacklist') {
    const blacklist = Array.from(new Set([...session.vault.settings.blacklist, candidate.domain]));
    await persistVaultSession(session, upsertVaultSettings(session.vault, { blacklist }));
    void recordDiagnosticLog({
      area: 'save-prompt',
      event: 'resolve-save-candidate',
      outcome: 'ignored',
      domain: candidate.domain,
      reason: '用户选择不再保存此网站登录信息。',
      source: candidate.source
    }).catch(() => undefined);
    clearPendingLoginCandidate();
    return { ok: true, blacklisted: true };
  }

  const exactDuplicate = session.vault.credentials.find((credential) => sameCandidatePassword(credential, candidate));

  if (exactDuplicate) {
    const refreshed = await refreshCredentialFormProfile(session, exactDuplicate, candidate);
    void recordDiagnosticLog({
      area: 'save-prompt',
      event: 'resolve-save-candidate',
      outcome: 'success',
      domain: candidate.domain,
      reason: refreshed ? '账号已存在，已刷新表单结构或图标信息。' : '账号密码已存在，无需重复保存。',
      source: candidate.source,
      counts: {
        duplicate: true,
        refreshed
      }
    }).catch(() => undefined);
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
  void recordDiagnosticLog({
    area: 'save-prompt',
    event: 'resolve-save-candidate',
    outcome: 'success',
    domain: candidate.domain,
    reason: shouldUpdate ? '同站点同用户名，已更新保存的密码。' : '已保存为新的登录账号。',
    source: candidate.source,
    counts: {
      updated: shouldUpdate,
      fields: candidate.formFields?.length ?? 0
    }
  }).catch(() => undefined);
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

});

chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return;
  markPendingSubmitNavigated(details.tabId, details.url);
  promoteStagedLoginCandidate(details.tabId, details.url);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  pendingBindings.delete(tabId);
  pendingBindingTests.delete(tabId);
  pendingSubmitOutcomes.delete(tabId);
  stagedLoginCandidates.delete(tabId);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if(message?.type==='KEYPILOT_VALIDATE_QUICK_FILL'){
    const job=sender.tab?.id ? quickFillJobs.get(sender.tab.id) : undefined;
    void (async()=>({ok:Boolean(job && sender.id===chrome.runtime.id && sender.frameId===job.frameId && sender.documentId && sender.documentId===job.documentId && message.token===job.token && message.targetId===job.targetId && await quickFillIsCurrent(sender.tab!.id!,job))}))()
      .then(sendResponse).catch(()=>sendResponse({ok:false}));return true;
  }
  if (message?.type === 'KEYPILOT_SECURE_CACHE') {
    if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(''))) { sendResponse({ok:false}); return; }
    sendResponse(handleSecureCacheMessage(message)); return;
  }

  if (message?.type === 'KEYPILOT_PING') {
    sendResponse({ ok: true, source: 'background' });
    return true;
  }

  if (message?.type === 'KEYPILOT_COPY_GENERATED_PASSWORD') {
    void restoreCachedVaultSession().then(session => copyViaOffscreen(String(message.value ?? '').slice(0,256),session?.vault.settings.clearClipboardSeconds ?? 30)).then(sendResponse).catch(() => sendResponse({ok:false}));return true;
  }
  if (message?.type === 'KEYPILOT_COPY_TEXT') {
    if (!sender.url?.startsWith(chrome.runtime.getURL(''))) { sendResponse({ok:false, error:'REAUTH_REQUIRED'}); return; }
    void copyViaOffscreen(String(message.value ?? ''), Number(message.seconds) || 0)
      .then(sendResponse).catch(() => sendResponse({ok:false, error:'CLIPBOARD_UNAVAILABLE'}));
    return true;
  }

  if (message?.type === 'KEYPILOT_LOCK_VAULT') {
    void clearVaultSessionCache()
      .then(() => {
        pendingBindings.clear();
        pendingBindingTests.clear();
        pendingSubmitOutcomes.clear();
        stagedLoginCandidates.clear();
        clearPendingLoginCandidate();
        sendResponse({ ok: true });
      })
      .catch((error) => sendResponse({ ok: false, error: toErrorMessage(error) }));

    return true;
  }

  if (message?.type === 'KEYPILOT_FETCH_SITE_METADATA') {
    void fetchSiteMetadata(message.url as string | undefined)
      .then((response) => sendResponse(response))
      .catch((error) => sendResponse({ ok: false, error: toErrorMessage(error) }));

    return true;
  }

  if (message?.type === 'KEYPILOT_RECORD_DIAGNOSTIC_LOG') {
    const entry = message.entry as Omit<DiagnosticLogEntry, 'id' | 'createdAt'> & Partial<Pick<DiagnosticLogEntry, 'id' | 'createdAt'>> | undefined;

    if (!entry?.area || !entry.event || !entry.outcome || !entry.domain) {
      sendResponse({ ok: false, error: 'INVALID_DIAGNOSTIC_LOG' });
      return true;
    }

    void recordDiagnosticLog(entry)
      .then((response) => sendResponse(response))
      .catch((error) => sendResponse({ ok: false, error: toErrorMessage(error) }));

    return true;
  }

  if (message?.type === 'KEYPILOT_GET_DIAGNOSTIC_LOG') {
    void readDiagnosticLog()
      .then((response) => sendResponse(response))
      .catch((error) => sendResponse({ ok: false, error: toErrorMessage(error), logs: [] }));

    return true;
  }

  if (message?.type === 'KEYPILOT_CLEAR_DIAGNOSTIC_LOG') {
    void clearDiagnosticLogEntries()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: toErrorMessage(error) }));

    return true;
  }

  if (message?.type === 'KEYPILOT_OPEN_TAB') {
    const credential = message.credential as FillCredentialPayload;
    const action = message.action as 'login' | 'fill' | 'goto';

    if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(''))) {
      sendResponse({ ok: false, error: 'INVALID_SENDER' });
      return false;
    }

    if (!['login', 'fill', 'goto'].includes(action)) {
      sendResponse({ ok: false, error: 'INVALID_CREDENTIAL_ACTION' });
      return false;
    }

    void (async () => {
      if (action !== 'goto') return openManagedLogin(credential?.id, action === 'login' && Boolean(credential?.autoSubmit));
      const session = await restoreCachedVaultSession();
      const saved = session?.vault.credentials.find(item => item.id === credential?.id);
      if (!saved) throw new Error('VAULT_LOCKED');
      if (!isSupportedOpenUrl(saved.url)) throw new Error('INVALID_CREDENTIAL_URL');
      await chrome.tabs.create({ url: saved.url, active: true });
      return { ok: true, queued: true };
    })().then(sendResponse).catch(error => sendResponse({ ok: false, error: toErrorMessage(error) }));
    return true;
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

  if (message?.type === 'KEYPILOT_FILL_TOTP') {
    if (!sender.url?.startsWith(chrome.runtime.getURL('')) || sender.tab?.url?.startsWith('http')) { sendResponse({ok:false,error:'REAUTH_REQUIRED'}); return; }
    void fillTotpInTab(message.accountId, message.tabId, message.sessionId).then(sendResponse).catch(error=>sendResponse({ok:false,error:toErrorMessage(error)}));
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
          silentRule: state.silentRule,
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

  if (message?.type === 'KEYPILOT_GET_INLINE_PAGE_STATE') {
    void (async () => {
      const tab = message.url ? undefined : await queryActiveTab();
      return getInlineState([message.url as string | undefined, tab?.url]);
    })()
      .then((state) => {
        sendResponse({
          ok: true,
          locked: false,
          hidden: state.hidden,
          silentRule: state.silentRule,
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

  if (message?.type === 'KEYPILOT_RECORD_INLINE_SILENCE') {
    void restoreCachedVaultSession()
      .then(async (session) => {
        if (!session || session.vault.settings.autoSilentInline === false) {
          sendResponse({ ok: true, skipped: true });
          return;
        }

        const url = (message.url as string | undefined) || sender.url || sender.tab?.url;
        const nextVault = upsertInlineSilentRule(session.vault, {
          url,
          reason: message.reason,
          confidence: message.confidence,
          source: message.source,
          title: message.title
        });
        await persistVaultSession(session, nextVault);
        sendResponse({ ok: true });
      })
      .catch((error) => {
        sendResponse({ ok: false, error: toErrorMessage(error) });
      });

    return true;
  }

  if (message?.type === 'KEYPILOT_RESTORE_INLINE_FOR_PAGE') {
    void restoreCachedVaultSession()
      .then(async (session) => {
        if (!session) {
          sendResponse({ ok: false, locked: true, error: 'VAULT_LOCKED' });
          return;
        }

        const tab = message.url ? undefined : await queryActiveTab();
        const url = (message.url as string | undefined) || tab?.url || sender.url || sender.tab?.url;
        const { vault, removedCount } = removeInlineSilentRule(session.vault, {
          url,
          ruleId: message.ruleId
        });

        if (vault !== session.vault) {
          await persistVaultSession(session, vault);
        }

        sendResponse({ ok: true, removedCount });
      })
      .catch((error) => {
        const errorMessage = toErrorMessage(error);
        sendResponse({ ok: false, locked: errorMessage === 'VAULT_LOCKED', error: errorMessage });
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
      message.command as InlineCredentialCommand | undefined,
      message.title
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

  if(message?.type==='KEYPILOT_GET_LOGIN_PROGRESS'){
    const outcome=sender.id===chrome.runtime.id && sender.tab?.id && sender.frameId===0?getPendingSubmitOutcome(sender.tab.id):undefined;
    // Transfer to the destination document once; unrelated later navigation is not a login attempt.
    if(outcome && sender.tab?.id)pendingSubmitOutcomes.delete(sender.tab.id);
    sendResponse(outcome);return false;
  }
  if(message?.type==='KEYPILOT_OPEN_LOGIN_SETTINGS'){
    void (async()=>{
      if(sender.id!==chrome.runtime.id || !sender.tab?.id)return {ok:false};
      if(typeof message.credentialId!=='string' || message.credentialId.length>200 || !sender.url || !/^https?:/.test(sender.url))return {ok:false};
      // Opening the locked extension UI discloses no secrets and lets the user unlock there.
      await chrome.tabs.create({url:chrome.runtime.getURL('vault.html?loginFor='+encodeURIComponent(message.credentialId))});return {ok:true};
    })().then(sendResponse).catch(()=>sendResponse({ok:false}));return true;
  }
  if (message?.type === 'KEYPILOT_AUTHORIZE_LOGIN_SUBMIT') {
    void authorizeLoginSubmit(message,sender).then(sendResponse).catch(()=>sendResponse({ok:false}));
    return true;
  }
  if (message?.type === 'KEYPILOT_CONTINUE_LOGIN_TOTP') {
    void continueLoginTotp(sender).then(sendResponse).catch(()=>sendResponse({active:false}));
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

chrome.alarms.onAlarm.addListener(alarm => {
 if (alarm.name === 'keypilot-auto-lock') void getSessionState().then(state => {
  if (state?.expiresAt && Date.now() >= state.expiresAt) return clearVaultSessionCache();
 });
});
chrome.storage.onChanged.addListener((changes, area) => {
 if (area === 'session' && changes['keypilot.sessionState'] && !changes['keypilot.sessionState'].newValue) {
  pendingBindings.clear(); pendingBindingTests.clear(); pendingSubmitOutcomes.clear(); stagedLoginCandidates.clear(); clearPendingLoginCandidate();
  void chrome.tabs.query({}).then(tabs => Promise.allSettled(tabs.filter(tab => tab.id).map(tab => chrome.tabs.sendMessage(tab.id!, {type:'KEYPILOT_SESSION_LOCKED'}))));
 }
});

async function copyViaOffscreen(value: string, seconds: number) {
 await ensureOffscreenDocument();
 return chrome.runtime.sendMessage({target:'keypilot-clipboard',value,seconds});
}

interface QuickFillJob {
  sessionId:string;
  tabUrl:string;
  expiresAt:number;
  frameId?:number;
  frameUrl?:string;
  documentId?:string;
  token?:string;
  targetId?:string;
  kind?:QuickFillTarget['kind'];
  itemId?:string;
  revision?:string;
}
const quickFillJobs=new Map<number,QuickFillJob>();
async function quickFillIsCurrent(tabId:number,job:QuickFillJob):Promise<boolean>{
  if(quickFillJobs.get(tabId)!==job || Date.now()>job.expiresAt || !await isVaultSessionActive(job.sessionId))return false;
  const tab=await chrome.tabs.get(tabId);
  if(tab.url!==job.tabUrl)return false;
  if(job.documentId && job.frameId!==undefined){
    const frame=await chrome.webNavigation.getFrame({tabId,frameId:job.frameId});
    if(frame?.documentId!==job.documentId || frame.url!==job.frameUrl)return false;
  }
  const session=await restoreCachedVaultSession();
  if(session?.sessionId!==job.sessionId)return false;
  if(!job.itemId)return true;
  const item=job.kind==='profile'?session.vault.fillProfiles?.find(item=>item.id===job.itemId):session.vault.credentials.find(item=>item.id===job.itemId);
  if(job.kind==='login' && siteLoginSettings(session.vault.settings,job.frameUrl??job.tabUrl).fillEnabled===false)return false;
  return Boolean(item && JSON.stringify(item)===job.revision);
}

async function quickFillTab(tab:chrome.tabs.Tab,session:UnlockedVaultSession):Promise<boolean>{
  if(!tab.id || !tab.url || !/^https?:\/\//.test(tab.url) || !session.sessionId)return false;
  const tabId=tab.id, existing=quickFillJobs.get(tabId);
  if(existing && Date.now()<existing.expiresAt){
    if(existing.frameId!==undefined)await chrome.tabs.sendMessage(tabId,{type:'KEYPILOT_FOCUS_QUICK_FILL'},{frameId:existing.frameId}).catch(()=>undefined);
    return true;
  }
  const job:QuickFillJob={sessionId:session.sessionId,tabUrl:tab.url,expiresAt:Date.now()+120000};quickFillJobs.set(tabId,job);
  try{
    await ensureContentScriptInTab(tabId,tab.url);
    const frames=await getTabFrames(tab);
    const results=await Promise.all(frames.map(async frame=>{
      try{
        const probe:QuickFillProbe=await chrome.tabs.sendMessage(tabId,{type:'KEYPILOT_PROBE_QUICK_FILL'},{frameId:frame.frameId});
        return probe?.url===frame.url && probe.token && Array.isArray(probe.targets)?{...frame,probe}:undefined;
      }catch{return undefined;}
    }));
    const probes=results.filter((item):item is NonNullable<typeof item>=>Boolean(item));
    if(!probes.length)return false;
    const origin=new URL(tab.url).origin;
    const focused=probes.filter(item=>item.probe.frameFocused);
    const eligible=focused.length?focused:probes.filter(item=>new URL(item.url).origin===origin);
    const candidates=eligible.flatMap(frame=>frame.probe.targets.map(target=>({frame,target})));
    const focusedTargets=candidates.filter(item=>item.target.focused);
    const targets=focusedTargets.length?focusedTargets:candidates;
    const host=targets[0]?.frame ?? probes.find(frame=>frame.frameId===0) ?? probes[0];
    Object.assign(job,{frameId:host.frameId,frameUrl:host.url,token:host.probe.token});
    const choose=async(title:string,description:string,choices:FillChoice[])=>{
      if(!await quickFillIsCurrent(tabId,job))return null;
      return await chrome.tabs.sendMessage(tabId,{type:'KEYPILOT_CHOOSE_QUICK_FILL',token:job.token,title,description,choices},{frameId:job.frameId}) as string|null;
    };
    if(!targets.length){
      const selected=await choose('快捷填写','没有找到可填写的表单。请先点击网页中的输入框，再按快捷键。',[{id:'manage',label:'打开个人信息',detail:'添加或管理常用填写资料'}]);
      if(selected==='manage')await chrome.tabs.create({url:chrome.runtime.getURL('vault.html#identities')});return true;
    }
    let selected=targets[0];
    if(targets.length>1 || selected.target.uncertain || new URL(selected.frame.url).origin!==origin){
      const id=await choose('选择要填写的表单','选择本次填写的位置。也可以取消，点击目标输入框后再按快捷键。',targets.map((item,index)=>({id:String(index),label:item.target.label,detail:new URL(item.frame.url).host+' · 表单 '+(index+1)})));
      if(id===null)return true;
      selected=targets[Number(id)];if(!selected)return true;
    }
    Object.assign(job,{frameId:selected.frame.frameId,frameUrl:selected.frame.url,token:selected.frame.probe.token,targetId:selected.target.id,kind:selected.target.kind});
    job.documentId=(await chrome.webNavigation.getFrame({tabId,frameId:selected.frame.frameId}))?.documentId;
    const items=selected.target.kind==='profile'
      ? (session.vault.fillProfiles??[]).filter(item=>item.fields.some(field=>field.value.trim())).sort((a,b)=>Number(Boolean(b.pinned))-Number(Boolean(a.pinned)) || (b.lastUsedAt??0)-(a.lastUsedAt??0))
      : session.vault.credentials.filter(item=>credentialMatchesUrl(item,selected.frame.url));
    if(!items.length){
      const profile=selected.target.kind==='profile';
      const id=await choose(profile?'还没有填写资料':'没有匹配的账号',profile?'先在个人信息中添加姓名、联系方式、地址等资料，就可以用快捷键填写。':'此网站没有保存的登录账号。',[{id:'manage',label:profile?'添加填写资料':'打开密码库'}]);
      if(id==='manage')await chrome.tabs.create({url:chrome.runtime.getURL(profile?'vault.html#identities':'vault.html')});return true;
    }
    let item=items[0];
    if(items.length>1){
      const id=await choose(job.kind==='profile'?'选择填写资料':'选择登录账号',job.kind==='profile'?'选好后预览填写内容；已有值会保留。':'仅填写账号信息，不会自动点击登录。',items.map(item=>({id:item.id,label:item.title,detail:'fields' in item?`${item.fields.filter(field=>field.value.trim()).length} 个资料字段`:item.username})));
      if(id===null)return true;
      const found=items.find(item=>item.id===id);if(!found)return true;item=found;
    }
    job.itemId=item.id;job.revision=JSON.stringify(item);
    if(!await quickFillIsCurrent(tabId,job))return true;
    const payload='fields' in item?{profile:fillProfileToPayload(item,job.frameUrl,true)}:{credential:credentialToFillPayload(item,false,session.vault,job.frameUrl)};
    const result=await chrome.tabs.sendMessage(tabId,{type:'KEYPILOT_APPLY_QUICK_FILL',token:job.token,targetId:job.targetId,...payload},{frameId:job.frameId});
    if(result?.ok && job.kind==='profile' && await quickFillIsCurrent(tabId,job)){
      const latest=await restoreCachedVaultSession(), profile=latest?.vault.fillProfiles?.find(profile=>profile.id===job.itemId);
      if(latest && profile && latest.sessionId===job.sessionId && JSON.stringify(profile)===job.revision){
        await persistVaultSession(latest,updateFillProfileInVault(latest.vault,{...profile,lastUsedAt:Date.now()})).catch(()=>undefined);
      }
    }
    if(!result?.ok && result?.error!=='FILL_CANCELLED'){
      await choose('暂未填写','表单或密码库状态可能已变化。请关闭提示，点击要填写的输入框后重试。',[]);
    }
    return true;
  }finally{if(quickFillJobs.get(tabId)===job)quickFillJobs.delete(tabId);}
}

async function executeUserCommand(command: string, targetTab?: chrome.tabs.Tab) {
  if (command === 'lock-vault') { await clearVaultSessionCache(); return; }
  if (command === 'search-vault') { await chrome.tabs.create({url: chrome.runtime.getURL('vault.html?focus=search')}); return; }
  if (command !== 'fill-current') return;
  const tab = targetTab ?? await queryActiveTab();
  const session = await restoreCachedVaultSession();
  if (tab?.id && session) {
    if(await quickFillTab(tab,session).catch(()=>false))return;
  }
  try { await chrome.action.openPopup(); }
  catch { await chrome.tabs.create({url: chrome.runtime.getURL('popup.html')}); }
}
chrome.commands.onCommand.addListener(command => { void executeUserCommand(command).catch(() => undefined); });

let menuEnabled: boolean | undefined;
let menuQueue = Promise.resolve();
function refreshContextMenus() {
  menuQueue = menuQueue.then(async () => {
    const session = await restoreCachedVaultSession();
    const enabled = Boolean(session?.vault.settings.showContextMenuCommands);
    if (enabled === menuEnabled) return;
    await chrome.contextMenus.removeAll();
    if (enabled) {
      for (const [id, title] of [['fill-current', 'KeyPilot：填写当前网站'], ['search-vault', 'KeyPilot：搜索密码库'], ['lock-vault', 'KeyPilot：锁定密码库']]) {
        await new Promise<void>((resolve, reject) => chrome.contextMenus.create({id, title, contexts: ['page', 'editable']}, () => {
          const error = chrome.runtime.lastError;
          if (error) reject(new Error(error.message)); else resolve();
        }));
      }
    }
    menuEnabled = enabled;
  }).catch(() => { menuEnabled = undefined; });
}
chrome.contextMenus.onClicked.addListener((info, tab) => {
  void restoreCachedVaultSession().then(session => {
    if (session?.vault.settings.showContextMenuCommands) return executeUserCommand(String(info.menuItemId), tab);
  }).catch(() => undefined);
});
chrome.storage.onChanged.addListener((changes, area) => {
  if ((area === 'session' && ('keypilot.sessionState' in changes || 'keypilot.unlockedSession' in changes)) ||
      (area === 'local' && 'keypilot.encryptedVault' in changes)) refreshContextMenus();
});
chrome.runtime.onInstalled.addListener(refreshContextMenus);
chrome.runtime.onStartup.addListener(refreshContextMenus);
refreshContextMenus();
