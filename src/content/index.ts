import type {
  Credential,
  CredentialIconType,
  CredentialFormProfile,
  CredentialFormField,
  CredentialSubmitTarget,
  BindingTestResult,
  FillField,
  FillFieldBinding,
  FillProfileBindingResult,
  FillProfileDiagnostic,
  FillCredentialPayload,
  FillCredentialResult,
  FillProfileFillResult,
  FillProfilePayload,
  InlineCredentialCommand,
  InlineCredentialCommandResult,
  InlineCredentialFillRequest,
  InlineFillProfileFillRequest,
  InlineFillProfileSummary,
  InlineCredentialMatchesResult,
  InlineCredentialSummary,
  InlineFrameDiagnostic,
  ManualBindingResult,
  PendingLoginCandidate,
  RecognitionRuleApplyResult,
  SiteRulePageMode,
  SiteRuleSummary,
  SubmitOutcome,
  SubmitRepairAction
} from '../shared/types';

interface PasswordGeneratorOptions {
  length: number;
  uppercase: boolean;
  lowercase: boolean;
  numbers: boolean;
  symbols: boolean;
  excludeSimilar: boolean;
  requireEveryType?: boolean;
  excludeCharacters?: string;
  requiredCharacters?: string;
}

const PASSWORD_UPPERCASE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const PASSWORD_LOWERCASE = 'abcdefghijklmnopqrstuvwxyz';
const PASSWORD_NUMBERS = '0123456789';
const PASSWORD_SYMBOLS = '!@#$%^&*()-_=+[]{};:,.?';
const PASSWORD_SIMILAR = /[il1LoO0]/g;
type FillControl = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
const defaultGeneratorOptions: PasswordGeneratorOptions = {
  length: 16,
  uppercase: true,
  lowercase: true,
  numbers: true,
  symbols: true,
  excludeSimilar: true,
  requireEveryType: true,
  excludeCharacters: '',
  requiredCharacters: ''
};

function passwordRandomIndex(max: number): number {
  const buffer = new Uint32Array(1);
  crypto.getRandomValues(buffer);
  return buffer[0] % max;
}

function passwordUniqueCharacters(value: string): string {
  return Array.from(new Set(Array.from(value))).join('');
}

function passwordCleanCharset(value: string, excludeSimilar: boolean): string {
  return excludeSimilar ? value.replace(PASSWORD_SIMILAR, '') : value;
}

function passwordWithoutCharacters(value: string, excluded: string): string {
  if (!excluded) return value;

  const excludedSet = new Set(Array.from(excluded));
  return Array.from(value).filter((char) => !excludedSet.has(char)).join('');
}

function generatePassword(options: PasswordGeneratorOptions): string {
  const excluded = passwordUniqueCharacters(options.excludeCharacters ?? '');
  const requiredCharacters = passwordWithoutCharacters(
    passwordCleanCharset(passwordUniqueCharacters(options.requiredCharacters ?? ''), options.excludeSimilar),
    excluded
  );
  const groups = [
    options.uppercase ? passwordCleanCharset(PASSWORD_UPPERCASE, options.excludeSimilar) : '',
    options.lowercase ? passwordCleanCharset(PASSWORD_LOWERCASE, options.excludeSimilar) : '',
    options.numbers ? passwordCleanCharset(PASSWORD_NUMBERS, options.excludeSimilar) : '',
    options.symbols ? PASSWORD_SYMBOLS : ''
  ]
    .map((group) => passwordWithoutCharacters(group, excluded))
    .filter(Boolean);
  const charset = passwordUniqueCharacters(`${groups.join('')}${requiredCharacters}`);

  if (!charset) return '';

  const required = options.requireEveryType === false ? [] : groups.map((group) => group[passwordRandomIndex(group.length)]);

  for (const char of requiredCharacters) {
    if (!required.includes(char)) required.push(char);
  }

  const length = Math.max(Math.min(132, Math.max(4, Math.floor(options.length))), required.length);
  const password = [...required];

  while (password.length < length) {
    password.push(charset[passwordRandomIndex(charset.length)]);
  }

  for (let index = password.length - 1; index > 0; index -= 1) {
    const swapIndex = passwordRandomIndex(index + 1);
    [password[index], password[swapIndex]] = [password[swapIndex], password[index]];
  }

  return password.join('');
}

function measurePasswordStrength(value: string): { score: number; label: '弱' | '中' | '强' | '极强' } {
  let score = 0;

  if (value.length >= 10) score += 1;
  if (value.length >= 14) score += 1;
  if (/[A-Z]/.test(value) && /[a-z]/.test(value)) score += 1;
  if (/\d/.test(value)) score += 1;
  if (/[^A-Za-z0-9]/.test(value)) score += 1;

  if (score <= 1) return { score, label: '弱' };
  if (score <= 3) return { score, label: '中' };
  if (score === 4) return { score, label: '强' };
  return { score, label: '极强' };
}

const UNSAFE_KEYWORDS = [
  'captcha',
  'verify',
  'verification',
  'code',
  'sms',
  'otp',
  '2fa',
  'mfa',
  'totp',
  'authenticator',
  'security code',
  'pay',
  'payment',
  'trade',
  'fund',
  'withdraw',
  'slider',
  'slide',
  'puzzle',
  '验证码',
  '短信',
  '校验码',
  '动态码',
  '图形验证码',
  '二次验证',
  '安全码',
  '支付密码',
  '交易密码',
  '资金密码',
  '提现密码',
  '滑块',
  '拼图'
];

const USERNAME_KEYWORDS = [
  'email',
  'e-mail',
  'mail',
  'user',
  'username',
  'login',
  'account',
  'phone',
  'mobile',
  'tel',
  'name',
  '邮箱',
  '邮件',
  '用户',
  '用户名',
  '账号',
  '帐号',
  '账户',
  '手机',
  '手机号'
];

const NEXT_BUTTON_PATTERN = /下一步|继续|下一个|next|continue|proceed|sign[-\s]?in|log[-\s]?in|sign[-\s]?up|register|create\s+account|join|login|submit|enter|auth|authorize|登录|登\s*录|登入|登\s*入|登陆|注册|创建账号|提交|确认|确定|进入|立即登录|登录系统/i;
const PASSWORD_TEXT_PATTERN = /password|passwd|pwd|密码/i;
const USERNAME_TEXT_PATTERN = new RegExp(USERNAME_KEYWORDS.join('|'), 'i');
const SUBMIT_OUTCOME_TTL = 30000;
const SUBMIT_OUTCOME_DELAY = 1700;
const SUBMIT_REPAIR_DELAY = 1400;
const DEFAULT_REPAIR_ACTIONS: SubmitRepairAction[] = ['commit-fields', 'wait-enabled-click', 'retry-click', 'click-nearby', 'enter-password', 'request-submit'];
const ERROR_TEXT_PATTERN =
  /incorrect|invalid|wrong|failed|failure|error|denied|locked|disabled|try again|not match|does not match|required|empty|missing|expired|too many|captcha|verify|verification|blocked|用户名|账号|账户|帐号|密码|错误|失败|无效|不存在|不正确|不匹配|重试|不能为空|必填|验证码|校验码|验证|锁定|禁用|过期|频繁|异常/i;
const REGISTER_PASSWORD_PATTERN =
  /sign\s*up|signup|register|registration|create\s+(?:an?\s+)?account|new\s+account|join\s+now|application|apply|set\s+password|create\s+(?:a\s+)?password|choose\s+(?:a\s+)?password|confirm\s+password|repeat\s+password|retype\s+password|注册|创建账号|新建账号|申请|设置密码|创建密码|确认密码|重复密码|再次输入密码/i;
const REGISTER_URL_PATTERN =
  /\/(?:register|registration|signup|sign-up|join|apply|application|create-account|new-account)(?:[/?#]|$)|注册|创建账号|申请/i;
const LOGIN_URL_PATTERN =
  /\/(?:login|log-in|signin|sign-in|sign\/in|auth|session)(?:[/?#]|$)|(?:^|[/?#&])(?:login|signin)=1(?:[&#]|$)|鐧诲綍|鐧诲叆|鐧婚檰/i;
const LOGIN_URL_ASCII_PATTERN =
  /(?:^|[/?#&])(?:login|log[-_/]?in|signin|sign[-_/]?in|auth|authorize|authorization|session|sessions)(?:[/?#&=]|$)/i;
const LOGIN_SCOPE_PATTERN =
  /sign\s*in|signin|log\s*in|login|remember\s*me|forgot\s+(?:your\s+)?password|account\s+login|user\s+login|admin\s+login|登录|登入|登陆|记住我|忘记密码/i;
const REGISTER_SUBMIT_PATTERN =
  /^(?:sign\s*up|signup|register|create\s+(?:an?\s+)?account|join(?:\s+now)?|apply|submit\s+application|注册|创建账号|申请)$/i;
const ERROR_TEXT_SELECTORS = [
  '[role="alert"]',
  '[aria-live]',
  '[aria-invalid="true"]',
  '.error',
  '.errors',
  '.invalid',
  '.is-invalid',
  '.alert',
  '.alert-danger',
  '.message-error',
  '.toast',
  '.notice',
  '.el-message',
  '.ant-message',
  '.ivu-message',
  '.layui-layer-content',
  '.form-error',
  '.field-error',
  '.help-block'
].join(',');
const SAME_ORIGIN_ICON_PATHS = [
  '/favicon.ico',
  '/favicon.png',
  '/favicon.svg',
  '/favicon-32x32.png',
  '/favicon-16x16.png',
  '/apple-touch-icon.png',
  '/apple-touch-icon-precomposed.png',
  '/apple-icon.png',
  '/apple-icon-precomposed.png',
  '/icon.png',
  '/logo.png',
  '/static/favicon.ico',
  '/static/favicon.png',
  '/assets/favicon.ico',
  '/assets/favicon.png',
  '/images/favicon.ico',
  '/images/favicon.png',
  '/img/favicon.ico',
  '/img/favicon.png'
];
const AUTH_TITLE_PATTERN =
  /^(?:login|log in|sign in|signin|sign-in|password|passwd|pwd|account|user|username|admin|administrator|dashboard|panel|登录|登陆|登入|密码|账号|帐号|账户|用户名|用户登录|后台登录|管理登录|管理后台|控制面板)$/i;
const AUTH_TITLE_PART_PATTERN =
  /(?:login|log in|sign in|signin|sign-in|password|passwd|pwd|account login|user login|admin login|登录|登陆|登入|密码|账号登录|帐号登录|用户登录|后台登录|管理登录)/i;

interface LoginContext {
  form: HTMLFormElement | null;
  scope: ParentNode;
  usernameField?: HTMLInputElement;
  passwordField?: HTMLInputElement;
  unsafeReason?: string;
}

interface PasswordGeneratorContext {
  scope: ParentNode;
  passwordField: HTMLInputElement;
  confirmField?: HTMLInputElement;
  usernameField?: HTMLInputElement;
}

interface DebugRect {
  x: number;
  y: number;
  width: number;
  height: number;
  right: number;
  bottom: number;
  inViewport: boolean;
}

interface DebugElementSummary {
  selector?: string;
  tagName?: string;
  id?: string;
  name?: string;
  className?: string;
  text?: string;
  rect?: DebugRect;
}

interface RecognitionInputDebug {
  index: number;
  selector?: string;
  type: string;
  name?: string;
  id?: string;
  autocomplete?: string;
  placeholder?: string;
  ariaLabel?: string;
  label?: string;
  className?: string;
  visible: boolean;
  disabled: boolean;
  readOnly: boolean;
  hasValue: boolean;
  valueLength: number;
  usernameCandidate: boolean;
  usernameScore: number;
  passwordCandidate: boolean;
  unsafeReason?: string;
  currentPasswordSignal: boolean;
  registrationSignal: boolean;
  explicitRegistrationSignal: boolean;
  confirmSignal: boolean;
  rect: DebugRect;
  form?: DebugElementSummary;
}

interface StagedFill {
  credential: FillCredentialPayload;
  expiresAt: number;
  autoSubmit: boolean;
}

type BindingStep = 'username' | 'password' | 'submit';

interface ManualBindingSession {
  credential: FillCredentialPayload;
  step: BindingStep;
  usernameField?: HTMLInputElement;
  passwordField?: HTMLInputElement;
  submitButton?: HTMLElement;
  status?: string;
}

interface FillProfileBindingSession {
  profile: FillProfilePayload;
  selectedKey: string;
  bindings: FillFieldBinding[];
  status?: string;
}

type FloatingIconKind = 'inline-login' | 'password-generator';

interface FloatingIconPosition {
  x: number;
  y: number;
}

let stagedFill: StagedFill | null = null;
let stagedObserver: MutationObserver | null = null;
let manualBinding: ManualBindingSession | null = null;
let fillProfileBinding: FillProfileBindingSession | null = null;
let bindingHost: HTMLDivElement | null = null;
let bindingRoot: ShadowRoot | null = null;
let bindingHighlight: HTMLDivElement | null = null;
let bindingTestHost: HTMLDivElement | null = null;
let bindingTestTimer: number | null = null;
let lastCandidate: PendingLoginCandidate | null = null;
let clearCandidateTimer: number | null = null;
let inlineHost: HTMLDivElement | null = null;
let inlineRoot: ShadowRoot | null = null;
let inlineMatches: InlineCredentialSummary[] = [];
let inlineFillProfiles: InlineFillProfileSummary[] = [];
let inlineSiteRule: SiteRuleSummary | null = null;
let inlineStateLoaded = false;
let inlineFilterQuery = '';
let inlineSearchNeedsFocus = false;
let inlineMenuOpen = false;
let inlineStatus = '';
let inlineLocked = false;
let inlineSuppressed = false;
let inlineMoreCredentialId: string | null = null;
let inlineMoreProfileId: string | null = null;
let inlineHoverFillTimer: number | null = null;
let inlineHoverOpenTimer: number | null = null;
let inlineHoverCloseTimer: number | null = null;
let inlineLastHoverFilledId = '';
let inlineLastHoverFilledAt = 0;
let inlineRefreshTimer: number | null = null;
let inlinePositionTimer: number | null = null;
let inlineRefreshSuppressedUntil = 0;
let inlineManualPosition: FloatingIconPosition | null = null;
let inlineDragSuppressClickUntil = 0;
let inlineMorePointerHandledUntil = 0;
let inlineEditorHost: HTMLDivElement | null = null;
let inlineEditorRoot: ShadowRoot | null = null;
let inlineEditorCredential: Credential | null = null;
let inlineEditorDraft: Credential | null = null;
let inlineEditorStatus = '';
let inlineEditorSaving = false;
let inlineEditorPasswordVisible = false;
let inlineEditorKeydownAttached = false;
const INLINE_MENU_WIDTH = 276;
const INLINE_MENU_MAX_HEIGHT = 380;
const INLINE_TRIGGER_SIZE = 30;
const INLINE_TRIGGER_RIGHT_OFFSET = 20;
let passwordGeneratorHost: HTMLDivElement | null = null;
let passwordGeneratorRoot: ShadowRoot | null = null;
let passwordGeneratorInlineButton: HTMLButtonElement | null = null;
let passwordGeneratorManualPosition: FloatingIconPosition | null = null;
let passwordGeneratorDragSuppressClickUntil = 0;
let passwordGeneratorDragInProgress = false;
let passwordGeneratorOpen = false;
let passwordGeneratorStatus = '';
let passwordGeneratorOptions: PasswordGeneratorOptions = {
  ...defaultGeneratorOptions
};
let passwordGeneratorValue = generatePassword(passwordGeneratorOptions);
let passwordGeneratorPositionTimer: number | null = null;
let recognitionDebugHost: HTMLDivElement | null = null;
let recognitionDebugRoot: ShadowRoot | null = null;
let recognitionDebugOpen = false;
let recognitionDebugCopyStatus = '';
let lastSubmitOutcome: SubmitOutcome | null = null;
let submitOutcomeTimer: number | null = null;
let submitRepairTimer: number | null = null;
let savePromptHost: HTMLDivElement | null = null;
let savePromptRoot: ShadowRoot | null = null;
let savePromptCandidate: PendingLoginCandidate | null = null;
let savePromptContext: SavePromptContext | null = null;
let savePromptMode: SaveCandidateMode = 'save';
let savePromptDraftTitle = '';
let savePromptDropdownOpen = false;

try {
  document.documentElement.dataset.keypilotContentScript = '0.1.0';
} catch {
  // Best-effort boot marker for diagnostics.
}

document.getElementById('keypilot-inline-root')?.remove();
document.getElementById('keypilot-password-generator-root')?.remove();
document.getElementById('keypilot-recognition-debug-root')?.remove();
document.querySelectorAll('[data-keypilot-password-inline-trigger]').forEach((element) => element.remove());

type SaveCandidateMode = 'save' | 'update' | 'new' | 'skip' | 'blacklist';

interface SavePromptContext {
  ok: boolean;
  ignored?: boolean;
  duplicate?: boolean;
  locked?: boolean;
  error?: string;
  candidateId?: string;
  existing?: {
    title: string;
    username: string;
  };
}

interface SavePromptResponse extends SavePromptContext {
  candidate?: PendingLoginCandidate | null;
}

function toHttpUrl(value: string | null | undefined): string | undefined {
  if (!value) return undefined;

  try {
    const parsed = new URL(value, document.baseURI);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    return parsed.href;
  } catch {
    return undefined;
  }
}

function getHttpOrigin(urlOrDomain?: string): string | undefined {
  if (!urlOrDomain) return undefined;
  if (/^[a-z][a-z\d+\-.]*:\/\//i.test(urlOrDomain) && !/^https?:\/\//i.test(urlOrDomain)) return undefined;

  try {
    const parsed = new URL(/^https?:\/\//i.test(urlOrDomain) ? urlOrDomain : `https://${urlOrDomain}`);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    return parsed.origin;
  } catch {
    return undefined;
  }
}

function getRootFaviconUrlFor(urlOrDomain?: string): string | undefined {
  const origin = getHttpOrigin(urlOrDomain);
  return origin ? `${origin}/favicon.ico` : undefined;
}

function getSameOriginIconUrls(urlOrDomain?: string): string[] {
  const origin = getHttpOrigin(urlOrDomain);
  if (!origin) return [];

  return SAME_ORIGIN_ICON_PATHS.map((path) => `${origin}${path}`);
}

function getIconCandidates(iconUrl?: string, urlOrDomain?: string): string[] {
  return Array.from(
    new Set(
      [toHttpUrl(iconUrl), ...getSameOriginIconUrls(urlOrDomain)]
        .filter((candidate): candidate is string => Boolean(candidate))
    )
  );
}

function getRootFaviconUrl(): string | undefined {
  return getRootFaviconUrlFor(window.location.href);
}

function parseLargestIconSize(link: HTMLLinkElement): number {
  const sizes = link.getAttribute('sizes')?.toLowerCase();
  if (!sizes || sizes === 'any') return 512;

  return sizes
    .split(/\s+/)
    .map((size) => {
      const match = size.match(/^(\d+)x(\d+)$/);
      return match ? Math.max(Number(match[1]), Number(match[2])) : 0;
    })
    .reduce((largest, size) => Math.max(largest, size), 0);
}

function iconLinkRank(link: HTMLLinkElement): number {
  const rel = link.rel.toLowerCase();
  if (rel.includes('mask-icon')) return -1;
  if (!toHttpUrl(link.href)) return -1;

  const sizeScore = Math.min(parseLargestIconSize(link), 512) / 512;

  if (rel.includes('icon') && !rel.includes('apple-touch-icon')) return 300 + sizeScore;
  if (rel.includes('apple-touch-icon')) return 200 + sizeScore;
  if (rel.includes('fluid-icon')) return 120 + sizeScore;
  return -1;
}

function getMetaContent(selector: string): string | undefined {
  return document.querySelector<HTMLMetaElement>(selector)?.content?.trim() || undefined;
}

function isSameOriginPageUrl(value: string): boolean {
  try {
    return new URL(value).origin === window.location.origin;
  } catch {
    return false;
  }
}

function imageIconRank(image: HTMLImageElement): number {
  const src = toHttpUrl(image.currentSrc || image.src);
  if (!src || !isSameOriginPageUrl(src)) return -1;

  const descriptor = [
    image.id,
    image.className,
    image.alt,
    image.title,
    image.getAttribute('aria-label') ?? '',
    image.src
  ].join(' ').toLowerCase();

  if (!/favicon|icon|logo|brand|avatar|site|app|图标|标识|徽标/.test(descriptor)) {
    return -1;
  }

  const rect = image.getBoundingClientRect();
  const isCompact = rect.width >= 12 && rect.height >= 12 && rect.width <= 160 && rect.height <= 160;
  let rank = /favicon|icon|图标/.test(descriptor) ? 95 : 70;

  if (isCompact) rank += 20;
  if (rect.width > rect.height * 2.5 || rect.height > rect.width * 2.5) rank -= 25;
  return rank;
}

function getPageIconCandidates(): string[] {
  const linkCandidates = Array.from(document.querySelectorAll<HTMLLinkElement>('link[href]'))
    .map((link) => ({ link, rank: iconLinkRank(link) }))
    .filter((item) => item.rank >= 0)
    .sort((left, right) => right.rank - left.rank)
    .map(({ link }) => toHttpUrl(link.href))
    .filter((url): url is string => Boolean(url));

  const metaCandidates = [
    getMetaContent('meta[name="msapplication-TileImage"]')
  ]
    .map((value) => toHttpUrl(value))
    .filter((url): url is string => Boolean(url));

  const imageCandidates = Array.from(document.querySelectorAll<HTMLImageElement>('img[src]'))
    .map((image) => ({ image, rank: imageIconRank(image) }))
    .filter((item) => item.rank >= 0)
    .sort((left, right) => right.rank - left.rank)
    .map(({ image }) => toHttpUrl(image.currentSrc || image.src))
    .filter((url): url is string => Boolean(url));

  return Array.from(
    new Set(
      [...linkCandidates, ...metaCandidates, ...getIconCandidates(undefined, window.location.href), ...imageCandidates]
        .filter((url): url is string => Boolean(url))
    )
  );
}

function getPageIcon(): { iconUrl?: string; iconType: CredentialIconType } {
  const iconUrl = getPageIconCandidates()[0];

  return iconUrl ? { iconUrl, iconType: 'favicon' } : { iconType: 'default' };
}

function compactTitleText(value: string | null | undefined): string {
  return (value ?? '')
    .replace(/[\t\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sanitizeTitleCandidate(value: string | null | undefined): string {
  let text = compactTitleText(value);

  if (!text) return '';

  text = text
    .replace(/^[\s\-–—|｜:：·•]+|[\s\-–—|｜:：·•]+$/g, '')
    .replace(/^(?:login to|sign in to|log in to|登录到|登录|登陆|登入)\s*/i, '')
    .replace(/\s*(?:[\-–—|｜:：·•]\s*)?(?:login|log in|sign in|signin|sign-in|password|passwd|pwd|登录|登陆|登入|密码|用户登录|账号登录|帐号登录|后台登录|管理登录)$/i, '');

  return compactTitleText(text).slice(0, 80);
}

function normalizedHostTitle(): string {
  return window.location.hostname.replace(/^www\./i, '').toLowerCase();
}

function isIpAddressTitle(value: string): boolean {
  return /^(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?$/i.test(value.trim());
}

function isDomainTitle(value: string): boolean {
  const text = value.trim().toLowerCase().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').replace(/^www\./i, '');
  return text === normalizedHostTitle() || /^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?$/i.test(text);
}

function isUsefulPageTitle(value: string): boolean {
  const text = sanitizeTitleCandidate(value);

  if (text.length < 2) return false;
  if (AUTH_TITLE_PATTERN.test(text)) return false;
  if (isIpAddressTitle(text)) return false;
  if (isDomainTitle(text)) return false;
  return true;
}

function splitDocumentTitle(value: string): string[] {
  const raw = compactTitleText(value);
  if (!raw) return [];

  return Array.from(
    new Set(
      [
        raw,
        ...raw.split(/\s+(?:[-–—|｜:：·•])\s+|[|｜]/),
        raw.replace(/\s*(?:[-–—|｜:：·•]\s*)?(?:login|log in|sign in|signin|sign-in|password|passwd|pwd|登录|登陆|登入|密码)$/i, '')
      ]
        .map(sanitizeTitleCandidate)
        .filter(Boolean)
    )
  );
}

function titleElementVisible(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);

  return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
}

function titleScore(text: string, source: 'visible' | 'meta' | 'document', index: number): number {
  let score = source === 'visible' ? 100 : source === 'meta' ? 75 : 55;
  const length = text.length;

  if (length >= 3 && length <= 36) score += 14;
  if (length > 56) score -= 24;
  if (/[\u4e00-\u9fff]/.test(text)) score += 5;
  if (AUTH_TITLE_PART_PATTERN.test(text)) score -= 20;
  return score - index * 0.4;
}

function collectVisibleTitleCandidates(scope: ParentNode): string[] {
  const selector = [
    'h1',
    'h2',
    '[class*="brand"]',
    '[class*="logo"]',
    '[class*="site-title"]',
    '[class*="login-title"]',
    '[class*="panel-title"]',
    '[class*="app-title"]',
    '[id*="brand"]',
    '[id*="logo"]',
    '.navbar-brand',
    '.title'
  ].join(',');

  return Array.from(scope.querySelectorAll<Element>(selector))
    .filter(titleElementVisible)
    .map((element) => sanitizeTitleCandidate(element.textContent))
    .filter(isUsefulPageTitle)
    .slice(0, 16);
}

function collectMetaTitleCandidates(): string[] {
  return [
    getMetaContent('meta[name="application-name"]'),
    getMetaContent('meta[name="apple-mobile-web-app-title"]'),
    getMetaContent('meta[property="og:site_name"]'),
    getMetaContent('meta[property="og:title"]'),
    getMetaContent('meta[name="twitter:title"]'),
    getMetaContent('meta[name="title"]')
  ]
    .flatMap((value) => splitDocumentTitle(value ?? ''))
    .filter(isUsefulPageTitle);
}

function getBestPageTitle(scope: ParentNode = document): string {
  const candidates: Array<{ text: string; source: 'visible' | 'meta' | 'document'; index: number }> = [];
  const scopedTitles = collectVisibleTitleCandidates(scope);
  const pageTitles = scope === document ? [] : collectVisibleTitleCandidates(document);

  scopedTitles.forEach((text, index) => candidates.push({ text, source: 'visible', index }));
  pageTitles.forEach((text, index) => candidates.push({ text, source: 'visible', index: index + scopedTitles.length }));
  collectMetaTitleCandidates().forEach((text, index) => candidates.push({ text, source: 'meta', index }));
  splitDocumentTitle(document.title).forEach((text, index) => candidates.push({ text, source: 'document', index }));

  const best = candidates
    .map((candidate) => ({
      ...candidate,
      text: sanitizeTitleCandidate(candidate.text),
      score: titleScore(candidate.text, candidate.source, candidate.index)
    }))
    .filter((candidate) => isUsefulPageTitle(candidate.text))
    .sort((left, right) => right.score - left.score)[0];

  return best?.text || normalizedHostTitle() || window.location.hostname || '未命名账号';
}

function getPageMeta() {
  return {
    ok: true,
    title: getBestPageTitle(document),
    url: window.location.href,
    domain: window.location.hostname.replace(/^www\./i, '').toLowerCase(),
    ...getPageIcon()
  };
}

function getInlineFrameDiagnostic(): Omit<InlineFrameDiagnostic, 'matchedCount'> {
  const context = findLoginContext();

  return {
    url: window.location.href,
    domain: window.location.hostname.replace(/^www\./i, '').toLowerCase(),
    hasLoginForm: Boolean(context),
    hasUsernameField: Boolean(context?.usernameField),
    hasPasswordField: Boolean(context?.passwordField),
    unsafeReason: context?.unsafeReason,
    submitOutcome: recentSubmitOutcome()
  };
}

function elementText(element: Element | null | undefined): string {
  return (element?.textContent ?? '').trim();
}

function getLabelText(input: HTMLInputElement): string {
  const labels = Array.from(input.labels ?? []).map(elementText);
  const byFor = input.id ? elementText(document.querySelector(`label[for="${CSS.escape(input.id)}"]`)) : '';
  const aria = input.getAttribute('aria-labelledby')
    ?.split(/\s+/)
    .map((id) => elementText(document.getElementById(id)))
    .join(' ');
  return [...labels, byFor, aria ?? ''].filter(Boolean).join(' ');
}

function inputText(input: HTMLInputElement): string {
  return [
    input.type,
    input.name,
    input.id,
    input.className,
    input.autocomplete,
    input.placeholder,
    input.title,
    input.getAttribute('aria-label') ?? '',
    getLabelText(input)
  ]
    .join(' ')
    .toLowerCase();
}

function inputTextWithoutClass(input: HTMLInputElement): string {
  return [
    input.type,
    input.name,
    input.id,
    input.autocomplete,
    input.placeholder,
    input.title,
    input.getAttribute('aria-label') ?? '',
    getLabelText(input)
  ]
    .join(' ')
    .toLowerCase();
}

function inputTextWithoutAutocomplete(input: HTMLInputElement): string {
  return [
    input.type,
    input.name,
    input.id,
    input.placeholder,
    input.title,
    input.getAttribute('aria-label') ?? '',
    getLabelText(input)
  ]
    .join(' ')
    .toLowerCase();
}

function isVisibleInput(input: HTMLInputElement): boolean {
  const rect = input.getBoundingClientRect();
  const style = window.getComputedStyle(input);
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    !input.disabled &&
    !input.readOnly &&
    input.type !== 'hidden' &&
    style.visibility !== 'hidden' &&
    style.display !== 'none' &&
    style.opacity !== '0'
  );
}

function getUnsafeReason(input: HTMLInputElement): string | undefined {
  const text = inputText(input);
  return UNSAFE_KEYWORDS.find((keyword) => text.includes(keyword.toLowerCase()));
}

function isUnsafeField(input: HTMLInputElement): boolean {
  return Boolean(getUnsafeReason(input));
}

function isUsernameInput(input: HTMLInputElement): boolean {
  if (!isVisibleInput(input) || isUnsafeField(input)) {
    return false;
  }

  const type = input.type.toLowerCase();

  if (!['email', 'text', 'tel', 'number', ''].includes(type)) {
    return false;
  }

  const text = inputText(input);
  return type === 'email' || USERNAME_TEXT_PATTERN.test(text) || input.autocomplete === 'username';
}

function isPasswordInput(input: HTMLInputElement): boolean {
  if (!isVisibleInput(input) || isUnsafeField(input)) {
    return false;
  }

  return input.type.toLowerCase() === 'password' || PASSWORD_TEXT_PATTERN.test(inputText(input));
}

function fieldLabel(input: HTMLInputElement): string {
  return (
    getLabelText(input) ||
    input.placeholder ||
    input.getAttribute('aria-label') ||
    input.name ||
    input.id ||
    input.autocomplete ||
    input.type ||
    'Field'
  ).trim();
}

const CONTROL_HINT_ATTRIBUTES = [
  'data-testid',
  'data-test',
  'data-qa',
  'data-cy',
  'data-field',
  'data-name',
  'data-label',
  'data-key',
  'data-automation-id',
  'data-auto',
  'formcontrolname',
  'ng-reflect-name',
  'aria-describedby',
  'aria-labelledby',
  'x-autocompletetype'
];

function controlAttributeHints(control: FillControl): string {
  const datasetText = Object.entries(control.dataset ?? {})
    .map(([key, value]) => `${key} ${value ?? ''}`)
    .join(' ');
  const attributeText = CONTROL_HINT_ATTRIBUTES.map((name) => control.getAttribute(name) ?? '').join(' ');
  const describedBy = (control.getAttribute('aria-describedby') ?? '')
    .split(/\s+/)
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ');
  const labelledBy = (control.getAttribute('aria-labelledby') ?? '')
    .split(/\s+/)
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ');
  const groupText =
    control
      .closest('fieldset')
      ?.querySelector('legend')
      ?.textContent ?? '';
  const nearbyText =
    control.closest('[data-field], [data-name], [class*="field"], [class*="form-group"], [class*="input"], [class*="control"], [class*="select"]')
      ?.textContent
      ?.slice(0, 240) ?? '';

  return [datasetText, attributeText, describedBy, labelledBy, groupText, nearbyText].join(' ');
}

function controlText(control: FillControl): string {
  const optionText =
    control instanceof HTMLSelectElement
      ? Array.from(control.options)
          .slice(0, 80)
          .map((option) => `${option.textContent ?? ''} ${option.value}`)
          .join(' ')
      : '';

  return [
    control instanceof HTMLInputElement ? control.type : control.tagName.toLowerCase(),
    control.name,
    control.id,
    control.className,
    control.autocomplete,
    control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement ? control.placeholder : '',
    control.title,
    control.getAttribute('aria-label') ?? '',
    getLabelText(control as HTMLInputElement),
    controlAttributeHints(control),
    optionText
  ]
    .join(' ')
    .toLowerCase();
}

function controlLabel(control: FillControl): string {
  return (
    getLabelText(control as HTMLInputElement) ||
    (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement ? control.placeholder : '') ||
    control.getAttribute('aria-label') ||
    control.name ||
    control.id ||
    control.autocomplete ||
    (control instanceof HTMLInputElement ? control.type : control.tagName.toLowerCase()) ||
    'Field'
  ).trim();
}

function isVisibleControl(control: FillControl): boolean {
  const rect = control.getBoundingClientRect();
  const style = window.getComputedStyle(control);
  const inputType = control instanceof HTMLInputElement ? control.type.toLowerCase() : '';

  return (
    rect.width > 0 &&
    rect.height > 0 &&
    !control.disabled &&
    (control instanceof HTMLSelectElement || !control.readOnly) &&
    inputType !== 'hidden' &&
    style.visibility !== 'hidden' &&
    style.display !== 'none' &&
    style.opacity !== '0'
  );
}

function isFillableControl(control: FillControl): boolean {
  if (!isVisibleControl(control)) return false;
  if (control instanceof HTMLSelectElement || control instanceof HTMLTextAreaElement) return true;

  const type = control.type.toLowerCase();
  return !['hidden', 'submit', 'button', 'reset', 'file', 'image', 'range', 'color'].includes(type);
}

function isStorableInput(input: HTMLInputElement): boolean {
  if (!isVisibleInput(input) || isUnsafeField(input)) return false;

  const type = input.type.toLowerCase();
  return !['hidden', 'submit', 'button', 'reset', 'file', 'checkbox', 'radio', 'image'].includes(type);
}

function cssAttr(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function safeQuerySelector<T extends Element>(selector: string | undefined, root: ParentNode = document): T | null {
  if (!selector) return null;

  try {
    return root.querySelector<T>(selector);
  } catch {
    return null;
  }
}

function isUniqueSelector(selector: string, element: Element, root: ParentNode = document): boolean {
  return safeQuerySelector(selector, root) === element;
}

function selectorCandidates(element: Element): string[] {
  const tag = element.tagName.toLowerCase();
  const candidates: string[] = [];
  const id = element.id?.trim();
  const name = element.getAttribute('name')?.trim();
  const type = element.getAttribute('type')?.trim();
  const autocomplete = element.getAttribute('autocomplete')?.trim();
  const placeholder = element.getAttribute('placeholder')?.trim();
  const ariaLabel = element.getAttribute('aria-label')?.trim();
  const role = element.getAttribute('role')?.trim();

  if (id) candidates.push(`#${CSS.escape(id)}`, `${tag}#${CSS.escape(id)}`);
  if (name && type) candidates.push(`${tag}[type="${cssAttr(type)}"][name="${cssAttr(name)}"]`);
  if (name) candidates.push(`${tag}[name="${cssAttr(name)}"]`);
  if (autocomplete) candidates.push(`${tag}[autocomplete="${cssAttr(autocomplete)}"]`);
  if (placeholder) candidates.push(`${tag}[placeholder="${cssAttr(placeholder)}"]`);
  if (ariaLabel) candidates.push(`${tag}[aria-label="${cssAttr(ariaLabel)}"]`);
  if (role) candidates.push(`${tag}[role="${cssAttr(role)}"]`);

  return candidates;
}

function nthOfTypeSelector(element: Element): string {
  const tag = element.tagName.toLowerCase();
  const siblings = Array.from(element.parentElement?.children ?? []).filter((child) => child.tagName === element.tagName);
  const index = Math.max(1, siblings.indexOf(element) + 1);
  return `${tag}:nth-of-type(${index})`;
}

function pathSelector(element: Element): string | undefined {
  const parts: string[] = [];
  let current: Element | null = element;

  while (current && current !== document.documentElement && parts.length < 6) {
    const id = current.id?.trim();

    if (id) {
      parts.unshift(`${current.tagName.toLowerCase()}#${CSS.escape(id)}`);
      break;
    }

    parts.unshift(nthOfTypeSelector(current));
    current = current.parentElement;
  }

  const selector = parts.join(' > ');
  return selector && safeQuerySelector(selector) === element ? selector : undefined;
}

function elementSelector(element: Element, scope?: ParentNode): string | undefined {
  for (const candidate of selectorCandidates(element)) {
    if (isUniqueSelector(candidate, element)) return candidate;
  }

  const root = scope instanceof Element ? scope : undefined;

  if (root && root !== element) {
    const rootSelector = elementSelector(root);

    if (rootSelector) {
      for (const candidate of selectorCandidates(element)) {
        const scopedSelector = `${rootSelector} ${candidate}`;
        if (isUniqueSelector(scopedSelector, element)) return scopedSelector;
      }
    }
  }

  return pathSelector(element);
}

function fieldKind(input: HTMLInputElement, usernameField?: HTMLInputElement, passwordField?: HTMLInputElement): CredentialFormField['kind'] {
  if (input === passwordField || isPasswordInput(input)) return 'password';
  if (input === usernameField || isUsernameInput(input)) return 'username';
  return 'text';
}

function captureFormFields(scope: ParentNode, usernameField?: HTMLInputElement, passwordField?: HTMLInputElement): CredentialFormField[] {
  return getAllVisibleInputs(scope)
    .filter(isStorableInput)
    .map<CredentialFormField | null>((input, index) => {
      const kind = fieldKind(input, usernameField, passwordField);
      const value = input.value.trim();

      if (!value) return null;

      const field: CredentialFormField = {
        label: fieldLabel(input),
        name: input.name || undefined,
        id: input.id || undefined,
        selector: elementSelector(input, scope),
        type: input.type || undefined,
        autocomplete: input.autocomplete || undefined,
        placeholder: input.placeholder || undefined,
        ariaLabel: input.getAttribute('aria-label') || undefined,
        value,
        kind,
        index
      };

      return field;
    })
    .filter((field): field is CredentialFormField => field !== null)
    .slice(0, 40);
}

function fieldMatchScore(input: HTMLInputElement, field: CredentialFormField, index: number): number {
  if (!isStorableInput(input)) return -1;

  let score = 0;
  const inputType = input.type.toLowerCase();
  const savedType = field.type?.toLowerCase() ?? '';
  const label = fieldLabel(input).toLowerCase();
  const savedLabel = field.label.toLowerCase();
  const savedPlaceholder = field.placeholder?.toLowerCase() ?? '';
  const savedAria = field.ariaLabel?.toLowerCase() ?? '';

  if (field.id && input.id === field.id) score += 90;
  if (field.name && input.name === field.name) score += 80;
  if (field.selector && safeQuerySelector(field.selector) === input) score += 120;
  if (field.autocomplete && input.autocomplete === field.autocomplete) score += 50;
  if (field.placeholder && input.placeholder === field.placeholder) score += 30;
  if (field.ariaLabel && input.getAttribute('aria-label') === field.ariaLabel) score += 30;
  if (savedType && inputType === savedType) score += 25;
  if (savedLabel && label === savedLabel) score += 45;
  if (savedLabel && label.includes(savedLabel)) score += 20;
  if (savedPlaceholder && inputText(input).includes(savedPlaceholder)) score += 16;
  if (savedAria && inputText(input).includes(savedAria)) score += 16;
  if (typeof field.index === 'number') score += Math.max(0, 18 - Math.abs(field.index - index) * 6);
  if (field.kind === 'password' && inputType === 'password') score += 40;
  if (field.kind === 'username' && isUsernameInput(input)) score += 35;
  if (field.kind === 'password' && inputType !== 'password') score -= 80;

  return score;
}

function findStoredFieldInput(field: CredentialFormField, usedInputs: Set<HTMLInputElement>): HTMLInputElement | null {
  const storedSelectorInput = safeQuerySelector<HTMLInputElement>(field.selector);

  if (storedSelectorInput && isStorableInput(storedSelectorInput) && !usedInputs.has(storedSelectorInput)) {
    return storedSelectorInput;
  }

  const candidates = getAllVisibleInputs(document)
    .filter((input) => !usedInputs.has(input))
    .map((input, index) => ({
      input,
      score: fieldMatchScore(input, field, index)
    }))
    .filter((item) => item.score > 20)
    .sort((left, right) => right.score - left.score);

  return candidates[0]?.input ?? null;
}

function fillStoredFormFields(fields: CredentialFormField[] | undefined): number {
  if (!fields?.length) return 0;

  const usedInputs = new Set<HTMLInputElement>();
  let filled = 0;

  for (const field of fields) {
    if (!field.value) continue;

    const input = findStoredFieldInput(field, usedInputs);
    if (!input) continue;

    setNativeValue(input, field.value);
    usedInputs.add(input);
    filled += 1;
  }

  return filled;
}

function setNativeValue(input: HTMLInputElement, value: string) {
  input.focus({ preventScroll: true });
  const prototype = Object.getPrototypeOf(input);
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value') ?? Object.getOwnPropertyDescriptor(input, 'value');
  if (descriptor?.set) {
    descriptor.set.call(input, value);
  } else {
    input.value = value;
  }

  const key = value.slice(-1) || ' ';
  input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, composed: true }));
  if (typeof InputEvent === 'function') {
    input.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, composed: true, inputType: 'insertText', data: value }));
  }
  input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  input.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true, composed: true }));
  input.dispatchEvent(new FocusEvent('focusout', { bubbles: true, composed: true }));
  input.blur();
}

function commitInputValue(input?: HTMLInputElement) {
  if (!input) return;

  input.focus({ preventScroll: true });
  input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  input.dispatchEvent(new FocusEvent('focusout', { bubbles: true, composed: true }));
  input.blur();
}

function getLoginScope(field: HTMLInputElement): ParentNode {
  return (
    field.closest('form') ??
    field.closest('[role="form"]') ??
    field.closest('.login, .signin, .sign-in, .auth, .wp-login, .bt-login, .panel, .card, .box') ??
    document
  );
}

function getAllVisibleInputs(scope: ParentNode = document): HTMLInputElement[] {
  return Array.from(scope.querySelectorAll<HTMLInputElement>('input')).filter(isVisibleInput);
}

function currentUrlSignalText(): string {
  return `${window.location.pathname} ${window.location.search} ${window.location.hash}`;
}

function pageLooksLikeLoginUrl(): boolean {
  const urlText = currentUrlSignalText();
  return (LOGIN_URL_PATTERN.test(urlText) || LOGIN_URL_ASCII_PATTERN.test(urlText)) && !REGISTER_URL_PATTERN.test(urlText);
}

function currentSiteRulePageMode(): SiteRulePageMode | undefined {
  return inlineSiteRule?.pageMode;
}

function siteRuleForcesLoginPage(): boolean {
  return currentSiteRulePageMode() === 'login';
}

function siteRuleForcesRegistrationPage(): boolean {
  return currentSiteRulePageMode() === 'register';
}

function siteRuleDisablesPasswordGenerator(): boolean {
  return Boolean(inlineSiteRule?.disablePasswordGenerator || siteRuleForcesLoginPage());
}

function pageLooksLikeRegistration(): boolean {
  if (siteRuleForcesLoginPage()) return false;
  if (siteRuleForcesRegistrationPage()) return true;

  const urlText = currentUrlSignalText();
  if (LOGIN_URL_PATTERN.test(urlText) || LOGIN_URL_ASCII_PATTERN.test(urlText)) return false;
  if (REGISTER_URL_PATTERN.test(urlText)) return true;

  const titleText = [
    document.title,
    document.querySelector('h1')?.textContent ?? '',
    document.querySelector('h2')?.textContent ?? ''
  ].join(' ');

  return REGISTER_PASSWORD_PATTERN.test(titleText);
}

function scopeElement(scope: ParentNode): Element | null {
  if (scope instanceof Element) return scope;
  return null;
}

function scopeHeadingText(scope: ParentNode): string {
  const element = scopeElement(scope);
  if (!element) return '';

  return Array.from(element.querySelectorAll('h1, h2, h3, [role="heading"]'))
    .slice(0, 6)
    .map((item) => compactText(item.textContent ?? ''))
    .filter(Boolean)
    .join(' ');
}

function scopeSubmitTexts(scope: ParentNode): string[] {
  const element = scopeElement(scope);
  if (!element) return [];

  return Array.from(element.querySelectorAll<HTMLElement>('button, input[type="submit"], input[type="button"], [role="button"]'))
    .filter(visibleElement)
    .slice(0, 12)
    .map((item) => compactText(item instanceof HTMLInputElement ? item.value : item.textContent ?? ''))
    .filter(Boolean);
}

function scopeSubmitText(scope: ParentNode): string {
  return scopeSubmitTexts(scope).join(' ');
}

function scopeLooksLikeLogin(scope: ParentNode): boolean {
  const element = scopeElement(scope);
  const form = element?.closest('form') ?? (element instanceof HTMLFormElement ? element : null);
  const formAction = form?.getAttribute('action') ?? '';
  const scopedText = [
    formAction,
    element?.getAttribute('aria-label') ?? '',
    scopeHeadingText(scope),
    scopeSubmitText(scope),
    element?.querySelector('label')?.textContent ?? ''
  ].join(' ');

  return LOGIN_SCOPE_PATTERN.test(scopedText);
}

function scopeLooksLikeRegistration(scope: ParentNode): boolean {
  const element = scopeElement(scope);
  const form = element?.closest('form') ?? (element instanceof HTMLFormElement ? element : null);
  const formAction = form?.getAttribute('action') ?? '';
  const passwordFields = getAllVisibleInputs(scope).filter((input) => isPasswordInput(input) && !isCurrentPasswordField(input));
  const headingText = scopeHeadingText(scope);
  const submitTexts = scopeSubmitTexts(scope);

  return (
    REGISTER_URL_PATTERN.test(formAction) ||
    passwordFields.some(hasExplicitRegistrationPasswordSignal) ||
    (passwordFields.length >= 2 && passwordFields.some(isConfirmPasswordField)) ||
    REGISTER_PASSWORD_PATTERN.test(headingText) ||
    submitTexts.some((text) => REGISTER_SUBMIT_PATTERN.test(text.trim()))
  );
}

function scopeIsSinglePasswordLogin(scope: ParentNode, fields: HTMLInputElement[]): boolean {
  const scopedPasswordFields = samePasswordScopeFields(scope);
  const usernameField = findUsernameField(scope, fields[0]);

  return (
    scopedPasswordFields.length === 1 &&
    Boolean(usernameField) &&
    scopeLooksLikeLogin(scope) &&
    !scopeLooksLikeRegistration(scope) &&
    !scopedPasswordFields.some(hasExplicitRegistrationPasswordSignal) &&
    !scopedPasswordFields.some(isConfirmPasswordField)
  );
}

function passwordFieldsLookLikeRegistration(fields: HTMLInputElement[]): boolean {
  if (siteRuleForcesLoginPage()) return false;
  if (siteRuleForcesRegistrationPage()) return true;

  if (!fields.length) return false;
  const scope = getPasswordGeneratorScope(fields, fields[0]);
  const scopedPasswordFields = samePasswordScopeFields(scope);
  const hasExplicitRegistrationSignal =
    fields.some(hasExplicitRegistrationPasswordSignal) ||
    (scopedPasswordFields.length >= 2 && scopedPasswordFields.some(isConfirmPasswordField));

  if (pageLooksLikeLoginUrl() && !hasExplicitRegistrationSignal) return false;

  if (scopeIsSinglePasswordLogin(scope, fields)) return false;

  if (fields.some((input) => input.autocomplete === 'new-password' || hasRegistrationPasswordSignal(input))) return true;
  if (scopedPasswordFields.length >= 2 && scopedPasswordFields.some(isConfirmPasswordField)) return true;

  return pageLooksLikeRegistration() || scopeLooksLikeRegistration(scope);
}

function scoreUsernameInput(input: HTMLInputElement, passwordField?: HTMLInputElement): number {
  const text = inputText(input);
  let score = 0;

  if (input.type === 'email') score += 40;
  if (input.autocomplete === 'username' || input.autocomplete === 'email') score += 35;
  if (/username|user|login|account|email|mail|phone|mobile/.test(text)) score += 30;
  if (/用户名|用户|账号|帐号|账户|邮箱|手机/.test(text)) score += 30;
  if (input.value) score += 8;

  if (passwordField) {
    const passwordRect = passwordField.getBoundingClientRect();
    const inputRect = input.getBoundingClientRect();
    if (inputRect.top <= passwordRect.top) score += 10;
    score -= Math.min(30, Math.abs(passwordRect.top - inputRect.top) / 20);
  }

  return score;
}

function findUsernameField(scope: ParentNode, passwordField?: HTMLInputElement): HTMLInputElement | undefined {
  const candidates = getAllVisibleInputs(scope).filter((input) => input !== passwordField && isUsernameInput(input));

  if (!candidates.length && passwordField) {
    const fallback = getAllVisibleInputs(document).filter((input) => input !== passwordField && isUsernameInput(input));
    return fallback.sort((left, right) => scoreUsernameInput(right, passwordField) - scoreUsernameInput(left, passwordField))[0];
  }

  return candidates.sort((left, right) => scoreUsernameInput(right, passwordField) - scoreUsernameInput(left, passwordField))[0];
}

function getUnsafeReasonInScope(scope: ParentNode): string | undefined {
  return getAllVisibleInputs(scope).map(getUnsafeReason).find(Boolean);
}

function findLoginContext(): LoginContext | null {
  const passwordField = getAllVisibleInputs(document).find(isPasswordInput);

  if (passwordField) {
    const form = passwordField.closest('form');
    const scope = getLoginScope(passwordField);
    return {
      form,
      scope,
      usernameField: findUsernameField(scope, passwordField),
      passwordField,
      unsafeReason: getUnsafeReasonInScope(scope)
    };
  }

  const usernameField = getAllVisibleInputs(document)
    .filter(isUsernameInput)
    .sort((left, right) => scoreUsernameInput(right) - scoreUsernameInput(left))[0];

  if (!usernameField) {
    return null;
  }

  const form = usernameField.closest('form');
  const scope = getLoginScope(usernameField);

  return {
    form,
    scope,
    usernameField,
    unsafeReason: getUnsafeReasonInScope(scope)
  };
}

function visibleClickable(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
}

function visibleElement(element: Element): element is HTMLElement {
  if (!(element instanceof HTMLElement)) return false;
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
}

function compactText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function visibleErrorText(scope: ParentNode): string | undefined {
  const candidates = Array.from(scope.querySelectorAll<Element>(ERROR_TEXT_SELECTORS));

  for (const element of candidates) {
    if (!visibleElement(element)) continue;

    const text = compactText(elementText(element));
    if (!text || text.length > 220) continue;
    if (ERROR_TEXT_PATTERN.test(text)) return text.slice(0, 160);
  }

  return undefined;
}

function recentSubmitOutcome(): SubmitOutcome | undefined {
  if (!lastSubmitOutcome) return undefined;
  if (Date.now() - lastSubmitOutcome.checkedAt > SUBMIT_OUTCOME_TTL) return undefined;
  return lastSubmitOutcome;
}

function createSubmitOutcome(
  status: SubmitOutcome['status'],
  message: string,
  credentialId: string,
  url = window.location.href,
  errorText?: string,
  repairAction?: SubmitRepairAction
): SubmitOutcome {
  return {
    status,
    message,
    credentialId,
    url,
    checkedAt: Date.now(),
    errorText,
    repairAction
  };
}

function inspectSubmitOutcome(
  credentialId: string,
  startUrl: string,
  formProfile?: CredentialFormProfile,
  repairActions: SubmitRepairAction[] = DEFAULT_REPAIR_ACTIONS,
  allowRepair = true
): SubmitOutcome {
  if (window.location.href !== startUrl) {
    return createSubmitOutcome('navigated', '页面已跳转，登录可能已成功。', credentialId);
  }

  const context = findLoginContext();
  const errorText = (context ? visibleErrorText(context.scope) : undefined) ?? visibleErrorText(document);

  if (errorText) {
    return createSubmitOutcome('errorVisible', `页面显示错误：${errorText}`, credentialId, window.location.href, errorText);
  }

  if (context?.unsafeReason) {
    return createSubmitOutcome('blocked', `检测到验证码或安全字段：${context.unsafeReason}，已停止自动提交。`, credentialId);
  }

  if (!context?.passwordField) {
    return createSubmitOutcome('successLikely', '登录框已消失，可能登录成功。', credentialId);
  }

  if (context.passwordField) {
    if (allowRepair && !context.unsafeReason) {
      const repairAction = runSubmitRepairActions(context, context.passwordField, formProfile, repairActions);

      if (repairAction) {
        if (submitRepairTimer) {
          window.clearTimeout(submitRepairTimer);
        }

        submitRepairTimer = window.setTimeout(() => {
          lastSubmitOutcome = inspectSubmitOutcome(credentialId, startUrl, formProfile, repairActions, false);
          submitRepairTimer = null;
          setInlineSubmitOutcomeStatus(lastSubmitOutcome);
        }, SUBMIT_REPAIR_DELAY);

        return createSubmitOutcome('checking', '第一次提交后仍在登录表单，已尝试备用提交动作，正在再次判断...', credentialId, window.location.href, undefined, repairAction);
      }
    }

    return createSubmitOutcome('stillOnLogin', '仍停留在登录表单，可能按钮未触发、密码错误或需要验证码。', credentialId);
  }

  return createSubmitOutcome('unknown', '已提交，但页面结果暂时无法判断。', credentialId);
}

function setInlineSubmitOutcomeStatus(outcome: SubmitOutcome) {
  if (!inlineMenuOpen && !inlineStatus.includes('判断') && !inlineStatus.includes('提交')) return;
  inlineStatus = outcome.message;
  renderInlineWidget();
}

function scheduleSubmitOutcomeCheck(
  credentialId: string,
  startUrl: string,
  formProfile?: CredentialFormProfile,
  repairActions: SubmitRepairAction[] = DEFAULT_REPAIR_ACTIONS
): SubmitOutcome {
  if (submitOutcomeTimer) {
    window.clearTimeout(submitOutcomeTimer);
  }
  if (submitRepairTimer) {
    window.clearTimeout(submitRepairTimer);
    submitRepairTimer = null;
  }

  lastSubmitOutcome = createSubmitOutcome('checking', '已提交，正在判断登录结果...', credentialId, startUrl);
  submitOutcomeTimer = window.setTimeout(() => {
    lastSubmitOutcome = inspectSubmitOutcome(credentialId, startUrl, formProfile, repairActions);
    submitOutcomeTimer = null;
    setInlineSubmitOutcomeStatus(lastSubmitOutcome);
  }, SUBMIT_OUTCOME_DELAY);

  return lastSubmitOutcome;
}

const SUBMIT_CONTROL_SELECTOR = [
  'button[type="submit"]',
  'input[type="submit"]',
  'input[type="button"]',
  'button',
  'a',
  '[role="button"]',
  '[data-action]',
  '[data-testid]',
  '[data-cy]',
  '[class*="submit"]',
  '[class*="login"]',
  '[class*="signin"]',
  '[class*="sign-in"]'
].join(', ');

function isDisabledControl(element: HTMLElement): boolean {
  const className = String(element.className ?? '');

  return Boolean(
    ((element instanceof HTMLButtonElement || element instanceof HTMLInputElement) && element.disabled) ||
      element.hasAttribute('disabled') ||
      element.getAttribute('aria-disabled') === 'true' ||
      /\b(?:disabled|is-disabled|btn-disabled|ant-btn-disabled|button-disabled)\b/i.test(className)
  );
}

function buttonText(element: HTMLElement): string {
  return [
    element.textContent ?? '',
    (element as HTMLInputElement).value ?? '',
    element.getAttribute('aria-label') ?? '',
    element.getAttribute('title') ?? ''
  ]
    .join(' ')
    .trim();
}

function buttonSignalText(element: HTMLElement): string {
  return [
    buttonText(element),
    element.id,
    element.className,
    element.getAttribute('name') ?? '',
    element.getAttribute('type') ?? '',
    element.getAttribute('role') ?? '',
    element.getAttribute('data-action') ?? '',
    element.getAttribute('data-testid') ?? ''
  ]
    .join(' ')
    .toLowerCase();
}

function isLikelySubmitControl(element: HTMLElement): boolean {
  if (element.matches('button, input[type="submit"], input[type="button"], a, [role="button"]')) return true;
  if (element.tabIndex >= 0) return true;
  if (typeof element.onclick === 'function') return true;

  const style = window.getComputedStyle(element);
  if (style.cursor === 'pointer') return true;

  const identity = [element.id, String(element.className ?? ''), element.getAttribute('name') ?? '', element.getAttribute('data-action') ?? '']
    .join(' ')
    .toLowerCase();
  return /(?:^|[\s_-])(?:btn|button|submit|login-btn|login-button|signin-btn|signin-button|sign-in-button)(?:$|[\s_-])/.test(identity);
}

function findSubmitButton(anchorField: HTMLInputElement, requireNextText = false): HTMLElement | null {
  const scope = anchorField.closest('form') ?? getLoginScope(anchorField);
  const candidates = Array.from(scope.querySelectorAll<HTMLElement>(SUBMIT_CONTROL_SELECTOR)).filter((element) => {
    if (!visibleClickable(element)) return false;
    if (!isLikelySubmitControl(element)) return false;
    const text = buttonSignalText(element);
    const type = element.getAttribute('type');
    return NEXT_BUTTON_PATTERN.test(text) || (!requireNextText && (type === 'submit' || element instanceof HTMLButtonElement));
  });

  if (!candidates.length && scope !== document) {
    return Array.from(document.querySelectorAll<HTMLElement>(SUBMIT_CONTROL_SELECTOR))
      .filter((element) => visibleClickable(element) && isLikelySubmitControl(element) && NEXT_BUTTON_PATTERN.test(buttonSignalText(element)))[0] ?? null;
  }

  if (!candidates.length) {
    return null;
  }

  const anchorRect = anchorField.getBoundingClientRect();
  return candidates.sort((left, right) => {
    const leftRect = left.getBoundingClientRect();
    const rightRect = right.getBoundingClientRect();
    const leftDistance = Math.hypot(leftRect.left - anchorRect.left, leftRect.top - anchorRect.top);
    const rightDistance = Math.hypot(rightRect.left - anchorRect.left, rightRect.top - anchorRect.top);
    const leftDisabledPenalty = isDisabledControl(left) ? 60 : 0;
    const rightDisabledPenalty = isDisabledControl(right) ? 60 : 0;
    return leftDistance + leftDisabledPenalty - (rightDistance + rightDisabledPenalty);
  })[0];
}

function sanitizedFormAction(form: HTMLFormElement | null): string | undefined {
  if (!form?.action) return undefined;

  try {
    const url = new URL(form.action, window.location.href);
    url.search = '';
    url.hash = '';
    return url.href;
  } catch {
    return undefined;
  }
}

function captureSubmitTarget(element: HTMLElement, scope: ParentNode): CredentialSubmitTarget {
  const clickables = Array.from(scope.querySelectorAll<HTMLElement>(SUBMIT_CONTROL_SELECTOR));
  const visibleClickables = clickables.filter(visibleClickable);

  return {
    selector: elementSelector(element, scope),
    text: buttonText(element) || undefined,
    tagName: element.tagName.toLowerCase(),
    type: element.getAttribute('type') || undefined,
    name: element.getAttribute('name') || undefined,
    id: element.id || undefined,
    role: element.getAttribute('role') || undefined,
    index: visibleClickables.indexOf(element)
  };
}

function captureFormProfile(
  scope: ParentNode,
  usernameField: HTMLInputElement | undefined,
  passwordField: HTMLInputElement,
  submitter?: HTMLElement
): CredentialFormProfile {
  const form = passwordField.closest('form') ?? usernameField?.closest('form') ?? (scope instanceof HTMLFormElement ? scope : null);
  const profileScope = form ?? scope;
  const fields = getAllVisibleInputs(profileScope).filter(isStorableInput);
  const submitterBelongsToForm = Boolean(form?.id && submitter?.getAttribute('form') === form.id);
  const submitterBelongsToScope = Boolean(submitter && (nodeContains(profileScope, submitter) || nodeContains(scope, submitter) || submitterBelongsToForm));
  const submitButton = submitter && submitterBelongsToScope && visibleClickable(submitter)
    ? submitter
    : findSubmitButton(passwordField);
  const submitScope = submitButton && nodeContains(profileScope, submitButton) ? profileScope : document;

  return {
    selector: profileScope instanceof Element ? elementSelector(profileScope) : undefined,
    id: form?.id || undefined,
    name: form?.getAttribute('name') || undefined,
    action: sanitizedFormAction(form),
    method: form?.method || undefined,
    fieldCount: fields.length,
    passwordFieldCount: fields.filter(isPasswordInput).length,
    submit: submitButton ? captureSubmitTarget(submitButton, submitScope) : undefined
  };
}

function fieldIndexInScope(scope: ParentNode, input: HTMLInputElement): number | undefined {
  const index = getAllVisibleInputs(scope).filter(isStorableInput).indexOf(input);
  return index >= 0 ? index : undefined;
}

function createBoundField(
  input: HTMLInputElement,
  kind: CredentialFormField['kind'],
  value: string,
  scope: ParentNode
): CredentialFormField {
  return {
    label: fieldLabel(input),
    name: input.name || undefined,
    id: input.id || undefined,
    selector: elementSelector(input, scope),
    type: input.type || undefined,
    autocomplete: input.autocomplete || undefined,
    placeholder: input.placeholder || undefined,
    ariaLabel: input.getAttribute('aria-label') || undefined,
    value,
    kind,
    index: fieldIndexInScope(scope, input)
  };
}

function scoreSubmitTarget(element: HTMLElement, target: CredentialSubmitTarget, anchorField: HTMLInputElement, index: number): number {
  let score = 0;
  const text = buttonText(element).toLowerCase();
  const signalText = buttonSignalText(element);
  const savedText = target.text?.toLowerCase() ?? '';
  const type = element.getAttribute('type') ?? '';
  const tagName = element.tagName.toLowerCase();

  if (target.selector && safeQuerySelector(target.selector) === element) score += 140;
  if (target.id && element.id === target.id) score += 90;
  if (target.name && element.getAttribute('name') === target.name) score += 70;
  if (target.type && type === target.type) score += 35;
  if (target.tagName && tagName === target.tagName) score += 25;
  if (target.role && element.getAttribute('role') === target.role) score += 25;
  if (savedText && text === savedText) score += 65;
  if (savedText && (text.includes(savedText) || signalText.includes(savedText))) score += 28;
  if (typeof target.index === 'number') score += Math.max(0, 18 - Math.abs(target.index - index) * 5);
  if (type === 'submit') score += 12;
  if (NEXT_BUTTON_PATTERN.test(signalText)) score += 12;
  if (isDisabledControl(element)) score -= 70;

  const anchorRect = anchorField.getBoundingClientRect();
  const rect = element.getBoundingClientRect();
  score -= Math.min(24, Math.hypot(rect.left - anchorRect.left, rect.top - anchorRect.top) / 40);

  return score;
}

function findStoredSubmitButton(profile: CredentialFormProfile | undefined, anchorField: HTMLInputElement): HTMLElement | null {
  const target = profile?.submit;
  if (!target) return null;

  const direct = safeQuerySelector<HTMLElement>(target.selector);

  if (direct && visibleClickable(direct) && isLikelySubmitControl(direct)) {
    return direct;
  }

  const profileScope = safeQuerySelector<HTMLElement>(profile?.selector) ?? getLoginScope(anchorField);
  const candidates = Array.from(
    profileScope.querySelectorAll<HTMLElement>('button[type="submit"], input[type="submit"], button, a, [role="button"]')
  )
    .filter((element) => visibleClickable(element) && isLikelySubmitControl(element))
    .map((element, index) => ({
      element,
      score: scoreSubmitTarget(element, target, anchorField, index)
    }))
    .filter((item) => item.score > 28)
    .sort((left, right) => right.score - left.score);

  return candidates[0]?.element ?? null;
}

function dispatchHumanClick(element: HTMLElement): boolean {
  if (isDisabledControl(element)) return false;

  element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
  element.focus({ preventScroll: true });

  const eventInit: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    button: 0,
    buttons: 1
  };

  const pointerInit: PointerEventInit = {
    ...eventInit,
    pointerId: 1,
    pointerType: 'mouse',
    isPrimary: true
  };

  const pointerEvents = typeof PointerEvent === 'function';
  if (pointerEvents) {
    element.dispatchEvent(new PointerEvent('pointerover', pointerInit));
    element.dispatchEvent(new PointerEvent('pointerenter', pointerInit));
    element.dispatchEvent(new PointerEvent('pointerdown', pointerInit));
  }

  element.dispatchEvent(new MouseEvent('mouseover', eventInit));
  element.dispatchEvent(new MouseEvent('mouseenter', eventInit));
  element.dispatchEvent(new MouseEvent('mousedown', eventInit));
  element.dispatchEvent(new MouseEvent('mouseup', eventInit));

  if (pointerEvents) {
    element.dispatchEvent(new PointerEvent('pointerup', pointerInit));
  }

  const accepted = element.dispatchEvent(new MouseEvent('click', eventInit));
  element.click();
  return accepted;
}

function requestFormSubmit(context: LoginContext, button?: HTMLElement | null): boolean {
  if (!context.form) return false;

  const submitter = button instanceof HTMLButtonElement || button instanceof HTMLInputElement ? button : undefined;

  try {
    if (typeof context.form.requestSubmit === 'function') {
      context.form.requestSubmit(submitter);
      return true;
    }
  } catch {
    // Some pages reject a non-submit custom button. Continue with event fallback.
  }

  const event = new Event('submit', { bubbles: true, cancelable: true });
  if (context.form.dispatchEvent(event)) {
    context.form.submit();
    return true;
  }

  return false;
}

function dispatchEnterSubmit(anchorField: HTMLInputElement): boolean {
  anchorField.focus({ preventScroll: true });
  const init: KeyboardEventInit = {
    key: 'Enter',
    code: 'Enter',
    bubbles: true,
    cancelable: true,
    composed: true
  };

  const keydownAccepted = anchorField.dispatchEvent(new KeyboardEvent('keydown', init));
  anchorField.dispatchEvent(new KeyboardEvent('keypress', init));
  anchorField.dispatchEvent(new KeyboardEvent('keyup', init));
  return keydownAccepted;
}

function resolveSubmitButton(anchorField: HTMLInputElement, requireNextText: boolean, formProfile?: CredentialFormProfile): HTMLElement | null {
  const storedButton = requireNextText ? null : findStoredSubmitButton(formProfile, anchorField);
  return storedButton ?? findSubmitButton(anchorField, requireNextText);
}

function commitLoginFields(context: LoginContext) {
  commitInputValue(context.usernameField);
  commitInputValue(context.passwordField);
}

const pendingEnabledSubmitClicks = new WeakSet<HTMLElement>();

function scheduleEnabledSubmitClick(
  context: LoginContext,
  button: HTMLElement,
  anchorField: HTMLInputElement,
  requireNextText: boolean,
  formProfile?: CredentialFormProfile
): boolean {
  if (pendingEnabledSubmitClicks.has(button)) return true;

  pendingEnabledSubmitClicks.add(button);
  let clicked = false;
  const delays = [90, 180, 360, 720, 1200, 1800, 2600];
  const lastDelay = delays[delays.length - 1];

  delays.forEach((delay) => {
    window.setTimeout(() => {
      if (clicked) return;

      commitLoginFields(context);
      const currentButton = resolveSubmitButton(anchorField, requireNextText, formProfile) ?? button;

      if (currentButton && visibleClickable(currentButton) && !isDisabledControl(currentButton)) {
        clicked = true;
        pendingEnabledSubmitClicks.delete(button);
        dispatchHumanClick(currentButton);
        return;
      }

      if (delay === lastDelay) {
        pendingEnabledSubmitClicks.delete(button);
        if (!requireNextText) {
          dispatchEnterSubmit(anchorField);
          requestFormSubmit(context, currentButton);
        }
      }
    }, delay);
  });

  return true;
}

function scheduleSubmitRetries(
  context: LoginContext,
  anchorField: HTMLInputElement,
  requireNextText: boolean,
  formProfile?: CredentialFormProfile
) {
  [120, 360, 800, 1400].forEach((delay) => {
    window.setTimeout(() => {
      commitLoginFields(context);
      const button = resolveSubmitButton(anchorField, requireNextText, formProfile);
      if (button && !isDisabledControl(button)) {
        dispatchHumanClick(button);
        return;
      }

      if (button && isDisabledControl(button)) {
        scheduleEnabledSubmitClick(context, button, anchorField, requireNextText, formProfile);
        return;
      }

      if (!requireNextText) {
        dispatchEnterSubmit(anchorField);
        requestFormSubmit(context, button);
      }
    }, delay);
  });
}

function submitLoginContext(
  context: LoginContext,
  anchorField: HTMLInputElement,
  requireNextText = false,
  formProfile?: CredentialFormProfile
): { submitted: boolean; submitButtonMissing?: boolean } {
  commitLoginFields(context);
  const button = resolveSubmitButton(anchorField, requireNextText, formProfile);

  if (button) {
    if (isDisabledControl(button)) {
      scheduleEnabledSubmitClick(context, button, anchorField, requireNextText, formProfile);
      scheduleSubmitRetries(context, anchorField, requireNextText, formProfile);
      return { submitted: true };
    }

    const activated = dispatchHumanClick(button);
    scheduleSubmitRetries(context, anchorField, requireNextText, formProfile);

    if (!activated && !requireNextText) {
      requestFormSubmit(context, button);
    }

    return { submitted: true };
  }

  if (!requireNextText && context.form) {
    dispatchEnterSubmit(anchorField);
    scheduleSubmitRetries(context, anchorField, requireNextText, formProfile);

    if (requestFormSubmit(context)) {
      return { submitted: true };
    }
  }

  if (!requireNextText && dispatchEnterSubmit(anchorField)) {
    scheduleSubmitRetries(context, anchorField, requireNextText, formProfile);
    return { submitted: true };
  }

  return { submitted: false, submitButtonMissing: true };
}

function uniqueElements(elements: Array<HTMLElement | null | undefined>): HTMLElement[] {
  const seen = new Set<HTMLElement>();
  return elements.filter((element): element is HTMLElement => {
    if (!element || seen.has(element)) return false;
    seen.add(element);
    return true;
  });
}

function findRepairSubmitCandidates(anchorField: HTMLInputElement, formProfile?: CredentialFormProfile): HTMLElement[] {
  const scope = anchorField.closest('form') ?? getLoginScope(anchorField);
  const anchorRect = anchorField.getBoundingClientRect();
  const scopedCandidates = Array.from(scope.querySelectorAll<HTMLElement>(SUBMIT_CONTROL_SELECTOR));
  const documentCandidates = Array.from(document.querySelectorAll<HTMLElement>(SUBMIT_CONTROL_SELECTOR));

  return uniqueElements([
    findStoredSubmitButton(formProfile, anchorField),
    findSubmitButton(anchorField, false),
    ...scopedCandidates,
    ...documentCandidates
  ])
    .filter((element) => visibleClickable(element) && !isDisabledControl(element) && isLikelySubmitControl(element))
    .filter((element) => {
      const signal = buttonSignalText(element);
      const type = element.getAttribute('type');
      return NEXT_BUTTON_PATTERN.test(signal) || type === 'submit' || element instanceof HTMLButtonElement;
    })
    .sort((left, right) => {
      const leftRect = left.getBoundingClientRect();
      const rightRect = right.getBoundingClientRect();
      const leftDistance = Math.hypot(leftRect.left - anchorRect.left, leftRect.top - anchorRect.top);
      const rightDistance = Math.hypot(rightRect.left - anchorRect.left, rightRect.top - anchorRect.top);
      return leftDistance - rightDistance;
    })
    .slice(0, 4);
}

function runSubmitRepairActions(
  context: LoginContext,
  anchorField: HTMLInputElement,
  formProfile?: CredentialFormProfile,
  repairActions: SubmitRepairAction[] = DEFAULT_REPAIR_ACTIONS
): SubmitRepairAction | undefined {
  const actions = repairActions.length ? repairActions : DEFAULT_REPAIR_ACTIONS;

  if (actions.includes('commit-fields')) {
    commitLoginFields(context);
  }

  if (actions.includes('wait-enabled-click')) {
    const button = resolveSubmitButton(anchorField, false, formProfile);
    if (button && isDisabledControl(button) && scheduleEnabledSubmitClick(context, button, anchorField, false, formProfile)) {
      return 'wait-enabled-click';
    }
  }

  if (actions.includes('retry-click')) {
    const button = resolveSubmitButton(anchorField, false, formProfile);
    if (button && !isDisabledControl(button) && dispatchHumanClick(button)) {
      return 'retry-click';
    }
  }

  if (actions.includes('click-nearby')) {
    const candidates = findRepairSubmitCandidates(anchorField, formProfile);
    if (candidates.some((candidate) => dispatchHumanClick(candidate))) {
      return 'click-nearby';
    }
  }

  if (actions.includes('enter-password') && dispatchEnterSubmit(anchorField)) {
    return 'enter-password';
  }

  if (actions.includes('request-submit') && requestFormSubmit(context, resolveSubmitButton(anchorField, false, formProfile))) {
    return 'request-submit';
  }

  return undefined;
}

function startStagedPasswordFill(credential: FillCredentialPayload) {
  stagedFill = {
    credential,
    expiresAt: Date.now() + 60000,
    autoSubmit: credential.autoSubmit
  };

  stagedObserver?.disconnect();
  stagedObserver = new MutationObserver(() => {
    if (!stagedFill || Date.now() > stagedFill.expiresAt) {
      stagedObserver?.disconnect();
      stagedFill = null;
      return;
    }

    const context = findLoginContext();

    if (!context?.passwordField) {
      return;
    }

    const result = fillCredential({ ...stagedFill.credential, autoSubmit: stagedFill.autoSubmit }, false);

    if (result.ok && result.filledPassword) {
      stagedObserver?.disconnect();
      stagedFill = null;
    }
  });
  stagedObserver.observe(document.documentElement, { childList: true, subtree: true });
}

function fillCredential(credential: FillCredentialPayload, allowStage = true): FillCredentialResult {
  const startUrl = window.location.href;
  const context = findLoginContext();

  if (!context) {
    return { ok: false, error: 'NO_LOGIN_FORM' };
  }

  fillStoredFormFields(credential.formFields);

  if (context.usernameField) {
    setNativeValue(context.usernameField, credential.username);
  }

  if (!context.passwordField) {
    if (!context.usernameField) {
      return { ok: false, error: 'NO_USERNAME_FIELD' };
    }

    if (credential.autoSubmit) {
      const submitResult = submitLoginContext(context, context.usernameField, true, credential.formProfile);

      if (!submitResult.submitted) {
        return {
          ok: true,
          stage: 'usernameOnly',
          filledUsername: true,
          filledPassword: false,
          submitButtonMissing: true
        };
      }

      if (allowStage) {
        startStagedPasswordFill(credential);
      }

      return {
        ok: true,
        stage: 'usernameOnly',
        filledUsername: true,
        filledPassword: false,
        submitted: true
      };
    }

    return {
      ok: true,
      stage: 'usernameOnly',
      filledUsername: true,
      filledPassword: false
    };
  }

  setNativeValue(context.passwordField, credential.password);

  const stage = context.usernameField ? 'complete' : 'passwordOnly';
  let submitted = false;
  let skippedSubmit = false;
  let submitButtonMissing = false;

  if (credential.autoSubmit) {
    if (context.unsafeReason) {
      skippedSubmit = true;
    } else {
      const submitResult = submitLoginContext(context, context.passwordField, false, credential.formProfile);
      submitted = submitResult.submitted;
      submitButtonMissing = Boolean(submitResult.submitButtonMissing);
    }
  }

  const submitOutcome = submitted
    ? scheduleSubmitOutcomeCheck(credential.id, startUrl, credential.formProfile, credential.repairActions)
    : undefined;

  return {
    ok: true,
    stage,
    filledUsername: Boolean(context.usernameField),
    filledPassword: true,
    submitted,
    skippedSubmit,
    submitButtonMissing,
    unsafeReason: context.unsafeReason,
    submitOutcome
  };
}

function normalizeFillText(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function countryNameFromCode(countryCode: string): string {
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

function normalizedSelectValueCandidates(value: string): string[] {
  const normalized = normalizeFillText(value);
  const countryAliases: Record<string, string[]> = {
    us: ['us', 'usa', 'u s a', 'united states', 'united states of america', 'america', '美国'],
    usa: ['us', 'usa', 'u s a', 'united states', 'united states of america', 'america', '美国'],
    'u s a': ['us', 'usa', 'u s a', 'united states', 'united states of america', 'america', '美国'],
    'united states': ['us', 'usa', 'u s a', 'united states', 'united states of america', 'america', '美国'],
    'united states of america': ['us', 'usa', 'u s a', 'united states', 'united states of america', 'america', '美国'],
    '美国': ['us', 'usa', 'u s a', 'united states', 'united states of america', 'america', '美国'],
    cn: ['cn', 'china', '中国'],
    china: ['cn', 'china', '中国'],
    '中国': ['cn', 'china', '中国']
  };
  return Array.from(new Set([normalized, ...(countryAliases[normalized] ?? []).map(normalizeFillText)]));
}

function fillFieldAliases(field: FillField): string[] {
  const base = [field.key, field.label, field.sourceColumn ?? '', ...(field.aliases ?? [])].filter(Boolean);
  const extra: Record<string, string[]> = {
    firstName: ['first name', 'firstname', 'given name', 'fname', '名'],
    lastName: ['last name', 'lastname', 'family name', 'surname', 'lname', '姓'],
    fullName: ['full name', 'fullname', 'name', '姓名', '联系人'],
    email: ['email', 'e-mail', 'mail', '邮箱', '电子邮件'],
    phone: ['phone', 'mobile', 'telephone', 'tel', 'cell', '手机', '电话'],
    address1: ['address', 'address line 1', 'street', 'street address', 'addr1', '地址'],
    address2: ['address line 2', 'apt', 'apartment', 'suite', 'unit', 'addr2'],
    city: ['city', 'town', '城市', '市'],
    state: ['state', 'province', 'region', '州', '省'],
    postalCode: ['zip', 'zipcode', 'zip code', 'postal code', 'postcode', '邮编'],
    country: ['country', 'country code', 'country/region', 'country region', 'nation', 'nationality', '国家', '国家/地区', '所在国家'],
    dob: ['dob', 'date of birth', 'birth date', 'birthday', '出生日期'],
    gender: ['gender', 'sex', '性别'],
    ssn: ['ssn', 'social security', 'social security number'],
    website: ['website', 'web site', 'url', 'company website', 'business website'],
    businessName: ['company', 'company name', 'business', 'business name', 'legal business name', 'organization', 'organisation'],
    dbaName: ['dba', 'doing business as', 'trade name', 'assumed name'],
    entityType: ['entity type', 'business type', 'company type', 'legal structure'],
    ein: ['ein', 'fein', 'federal tax id', 'tax id', 'taxpayer id', 'employer identification number'],
    businessPhone: ['business phone', 'company phone', 'office phone', 'work phone'],
    businessEmail: ['business email', 'company email', 'work email'],
    businessAddress1: ['business address', 'company address', 'business street', 'company street', 'street address'],
    businessAddress2: ['business address line 2', 'company suite', 'suite', 'unit'],
    businessCity: ['business city', 'company city', 'city'],
    businessState: ['business state', 'company state', 'state of business', 'state'],
    businessPostalCode: ['business zip', 'business zipcode', 'company zip', 'company postal code', 'postal code', 'zip'],
    businessCountry: ['business country', 'company country', 'country of business', 'country', '国家', '公司国家'],
    industry: ['industry', 'business industry', 'sector'],
    industryCode: ['naics', 'naics code', 'sic', 'sic code'],
    businessStartDate: ['business start date', 'date established', 'established', 'founded', 'incorporation date'],
    stateOfIncorporation: ['state of incorporation', 'incorporation state', 'formed in'],
    employeeCount: ['employees', 'number of employees', 'employee count'],
    annualRevenue: ['annual revenue', 'gross annual revenue', 'yearly revenue', 'annual sales', 'sales'],
    monthlyRevenue: ['monthly revenue', 'average monthly revenue', 'monthly sales'],
    ownerFirstName: ['owner first name', 'principal first name', 'applicant first name'],
    ownerLastName: ['owner last name', 'principal last name', 'applicant last name'],
    ownerName: ['owner name', 'principal name', 'authorized signer', 'business owner', 'applicant name'],
    ownerTitle: ['owner title', 'title', 'position', 'job title'],
    ownershipPercentage: ['ownership', 'ownership percent', 'ownership percentage', 'owner percent'],
    loanAmount: ['loan amount', 'amount requested', 'requested amount', 'requested loan amount', 'financing amount'],
    loanPurpose: ['loan purpose', 'purpose', 'use of funds', 'funding purpose'],
    loanTerm: ['loan term', 'term', 'requested term', 'repayment term'],
    loanType: ['loan type', 'financing type', 'product'],
    creditScore: ['credit score', 'fico', 'fico score'],
    annualIncome: ['annual income', 'gross annual income', 'yearly income'],
    monthlyIncome: ['monthly income', 'gross monthly income'],
    housingStatus: ['housing status', 'residential status', 'own or rent'],
    monthlyHousingPayment: ['monthly rent', 'mortgage', 'mortgage payment', 'rent payment'],
    employmentStatus: ['employment status', 'employment', 'employed'],
    employerName: ['employer', 'employer name', 'company employer'],
    jobTitle: ['job title', 'occupation title', 'position'],
    yearsEmployed: ['years employed', 'time employed', 'employment length'],
    bankName: ['bank', 'bank name', 'financial institution'],
    routingNumber: ['routing number', 'aba', 'aba number'],
    bankAccountNumber: ['account number', 'bank account', 'checking account'],
    bankAccountType: ['account type', 'bank account type'],
    vehicleMake: ['make', 'vehicle make', 'car make', '车辆品牌', '品牌'],
    vehicleModel: ['model', 'vehicle model', 'car model', '车型'],
    vehicleYear: ['year', 'vehicle year', 'car year', '年份'],
    currentInsuranceCompany: ['insurance company', 'current insurance company', 'carrier'],
    currentCoverageType: ['coverage type', 'current coverage'],
    requestedCoverageType: ['requested coverage', 'coverage'],
    creditRating: ['credit rating', 'credit'],
    maritalStatus: ['marital status', 'marital'],
    occupation: ['occupation', 'job', 'profession'],
    education: ['education'],
    residenceType: ['residence', 'residence type', 'home type'],
    dui: ['dui'],
    requiresSr22: ['sr22', 'requires sr22'],
    bankruptcy: ['bankruptcy']
  };

  const extraSemanticAliases: Record<string, string[]> = {
    fullName: ['your name', 'contact name', 'applicant name', 'legal name', 'customer name', 'recipient name', 'lead name', 'primary applicant', 'insured name', 'borrower name'],
    email: ['email address', 'your email', 'contact email', 'login email', 'account email'],
    phone: ['cell phone', 'mobile phone', 'contact phone', 'home phone', 'work phone', 'phone number'],
    address1: ['address1', 'address line one', 'street line 1', 'mailing address', 'physical address', 'residential address', 'home address', 'current address', 'primary address'],
    address2: ['address2', 'apartment', 'building', 'floor', 'room', 'unit number', 'suite number'],
    city: ['municipality', 'locality'],
    state: ['state region', 'state province', 'administrative area'],
    postalCode: ['postal', 'post code'],
    country: ['country name', 'country of residence', 'residence country'],
    dob: ['birth day', 'birthday date', 'date born'],
    ssn: ['social security no', 'taxpayer id', 'identity number'],
    website: ['site url', 'homepage', 'web address'],
    businessName: ['legal company name', 'merchant name', 'shop name', 'store name', 'vendor name', 'business legal name', 'company legal name', 'merchant legal name', 'affiliate company', 'agency name'],
    dbaName: ['brand name', 'public name', 'storefront name'],
    entityType: ['entity structure', 'business structure', 'organization type'],
    ein: ['federal ein', 'federal employer id', 'employer id number', 'business tax id', 'company tax id', 'irs tax id'],
    businessPhone: ['business telephone', 'company telephone', 'office telephone'],
    businessEmail: ['merchant email', 'office email'],
    businessAddress1: ['registered address', 'office address', 'business street address'],
    annualRevenue: ['gross sales', 'annual gross sales', 'yearly sales', 'annual gross receipts', 'gross yearly sales'],
    monthlyRevenue: ['average monthly sales', 'monthly gross sales', 'average monthly deposits', 'monthly bank deposits'],
    ownerFirstName: ['authorized signer first name', 'contact first name'],
    ownerLastName: ['authorized signer last name', 'contact last name'],
    ownerName: ['contact person', 'primary contact', 'authorized representative'],
    loanAmount: ['funding amount', 'advance amount', 'capital requested', 'cash advance amount', 'requested funding amount', 'requested capital'],
    loanPurpose: ['reason for loan', 'capital purpose', 'use of proceeds', 'funds purpose', 'intended use'],
    loanTerm: ['term months', 'months requested'],
    currentInsuranceCompany: ['insurance carrier', 'current carrier'],
    requestedBodilyInjury: ['bodily injury', 'liability bodily injury', 'bi limit'],
    requestedPropertyDamage: ['property damage', 'pd limit', 'liability property damage'],
    requestedUninsuredMotorist: ['uninsured motorist', 'um limit', 'uim limit'],
    licensedState: ['drivers license state', 'driver license state'],
    relationshipToApplicant: ['relation to applicant'],
    cardNumber: ['credit card number', 'cc number'],
    cardExpiry: ['exp date', 'expiration date', 'card expiry'],
    bankAccountNumber: ['deposit account number', 'dda account', 'checking account number'],
    bankAccountType: ['checking or savings', 'deposit account type'],
    cvv: ['cvc', 'security code', 'card code']
  };

  return Array.from(new Set([...base, ...(extra[field.key] ?? []), ...(extraSemanticAliases[field.key] ?? [])].map(normalizeFillText).filter(Boolean)));
}

function autocompleteScore(field: FillField, control: FillControl): number {
  const autocomplete = normalizeFillText(control.autocomplete);
  if (!autocomplete) return 0;

  const tokens: Record<string, string[]> = {
    firstName: ['given name', 'name'],
    lastName: ['family name', 'name'],
    fullName: ['name'],
    email: ['email', 'username'],
    phone: ['tel'],
    address1: ['street address', 'address line1', 'address-line1'],
    address2: ['address line2', 'address-line2'],
    city: ['address level2', 'address-level2'],
    state: ['address level1', 'address-level1'],
    postalCode: ['postal code', 'postal-code'],
    country: ['country', 'country name', 'country-name'],
    website: ['url'],
    cardNumber: ['cc number', 'cc-number'],
    cardExpiry: ['cc exp', 'cc-exp'],
    cvv: ['cc csc', 'cc-csc'],
    businessName: ['organization'],
    businessEmail: ['email', 'username'],
    businessPhone: ['tel'],
    businessAddress1: ['street address', 'address line1', 'address-line1'],
    businessAddress2: ['address line2', 'address-line2'],
    businessCity: ['address level2', 'address-level2'],
    businessState: ['address level1', 'address-level1'],
    businessPostalCode: ['postal code', 'postal-code'],
    businessCountry: ['country', 'country name', 'country-name']
  };

  return (tokens[field.key] ?? []).some((token) => autocomplete.includes(normalizeFillText(token))) ? 62 : 0;
}

function typeScore(field: FillField, control: FillControl): number {
  if (!(control instanceof HTMLInputElement)) return 0;
  const type = control.type.toLowerCase();
  if (field.key === 'email' && type === 'email') return 46;
  if (field.key === 'businessEmail' && type === 'email') return 42;
  if (field.key === 'phone' && type === 'tel') return 42;
  if (field.key === 'businessPhone' && type === 'tel') return 38;
  if (field.key === 'dob' && type === 'date') return 35;
  if (field.key === 'businessStartDate' && type === 'date') return 32;
  if (['postalCode', 'businessPostalCode', 'vehicleYear', 'employeeCount', 'loanAmount', 'annualRevenue', 'monthlyRevenue', 'annualIncome', 'monthlyIncome', 'creditScore'].includes(field.key) && ['number', 'text'].includes(type)) return 12;
  if (field.sensitivity === 'secret' && type === 'password') return 20;
  if (type === 'password' && field.sensitivity !== 'secret') return -120;
  return 0;
}

function selectOptionScore(field: FillField, control: FillControl): number {
  if (!(control instanceof HTMLSelectElement)) return 0;
  const values = normalizedSelectValueCandidates(field.value);
  if (!values.length) return 0;
  return Array.from(control.options).some((option) => {
    const optionValue = normalizeFillText(option.value);
    const optionText = normalizeFillText(option.textContent ?? '');
    return values.some((value) => optionValue === value || optionText === value || optionText.includes(value) || value.includes(optionText));
  })
    ? 36
    : 0;
}

function fieldSemanticScore(field: FillField, text: string, label: string): number {
  const normalizedText = normalizeFillText(text);
  const fieldHints: Record<string, string[]> = {
    firstName: ['first name', 'given name', 'fname'],
    lastName: ['last name', 'family name', 'surname', 'lname'],
    fullName: ['full name', 'your name', 'contact name', 'applicant name', 'legal name', 'customer name', 'lead name', 'borrower name', 'insured name'],
    email: ['email', 'email address', 'e mail', 'contact email'],
    phone: ['phone', 'phone number', 'mobile', 'cell phone', 'telephone'],
    address1: ['address', 'street address', 'address line 1', 'mailing address', 'physical address', 'residential address', 'home address'],
    address2: ['address line 2', 'apt', 'apartment', 'suite', 'unit', 'floor'],
    city: ['city', 'town', 'locality'],
    state: ['state', 'province', 'region', 'state region'],
    postalCode: ['zip', 'zip code', 'postal code', 'postcode'],
    country: ['country', 'country region', 'country of residence'],
    dob: ['dob', 'date of birth', 'birth date', 'birthday'],
    gender: ['gender', 'sex'],
    ssn: ['ssn', 'social security', 'social security number'],
    website: ['website', 'url', 'web address', 'homepage'],
    businessName: ['company', 'company name', 'business name', 'legal business name', 'organization', 'merchant name', 'vendor name', 'agency name', 'affiliate company'],
    dbaName: ['dba', 'doing business as', 'trade name'],
    entityType: ['entity type', 'business type', 'company type', 'legal structure'],
    ein: ['ein', 'fein', 'federal tax id', 'tax id', 'employer identification number', 'business tax id', 'irs tax id'],
    businessPhone: ['business phone', 'company phone', 'office phone'],
    businessEmail: ['business email', 'company email', 'work email'],
    businessAddress1: ['business address', 'company address', 'office address', 'registered address'],
    businessAddress2: ['business suite', 'company suite', 'business address line 2'],
    businessCity: ['business city', 'company city'],
    businessState: ['business state', 'company state', 'state of business'],
    businessPostalCode: ['business zip', 'company zip', 'business postal code'],
    businessCountry: ['business country', 'company country', 'country of business'],
    industry: ['industry', 'business industry', 'sector'],
    industryCode: ['naics', 'sic', 'industry code'],
    businessStartDate: ['business start date', 'date established', 'founded', 'incorporation date'],
    stateOfIncorporation: ['state of incorporation', 'incorporation state', 'formed in'],
    employeeCount: ['employees', 'number of employees', 'employee count'],
    annualRevenue: ['annual revenue', 'gross annual revenue', 'annual sales', 'yearly revenue', 'annual gross receipts'],
    monthlyRevenue: ['monthly revenue', 'monthly sales', 'average monthly revenue', 'average monthly deposits', 'monthly bank deposits'],
    ownerFirstName: ['owner first name', 'principal first name', 'applicant first name'],
    ownerLastName: ['owner last name', 'principal last name', 'applicant last name'],
    ownerName: ['owner name', 'principal name', 'business owner', 'authorized signer', 'primary contact'],
    ownerTitle: ['owner title', 'job title', 'position', 'title'],
    ownershipPercentage: ['ownership', 'ownership percent', 'ownership percentage'],
    loanAmount: ['loan amount', 'amount requested', 'requested amount', 'financing amount', 'funding amount', 'cash advance amount', 'requested capital'],
    loanPurpose: ['loan purpose', 'use of funds', 'funding purpose', 'use of proceeds', 'intended use'],
    loanTerm: ['loan term', 'requested term', 'repayment term'],
    loanType: ['loan type', 'financing type', 'funding type'],
    creditScore: ['credit score', 'fico', 'fico score'],
    annualIncome: ['annual income', 'gross annual income', 'yearly income'],
    monthlyIncome: ['monthly income', 'gross monthly income'],
    housingStatus: ['housing status', 'residential status', 'own or rent'],
    monthlyHousingPayment: ['monthly rent', 'mortgage payment', 'rent payment'],
    employmentStatus: ['employment status', 'employed', 'employment'],
    employerName: ['employer', 'employer name'],
    jobTitle: ['job title', 'occupation title', 'position'],
    yearsEmployed: ['years employed', 'time employed', 'employment length'],
    bankName: ['bank', 'bank name', 'financial institution'],
    routingNumber: ['routing number', 'aba number'],
    bankAccountNumber: ['account number', 'bank account', 'checking account', 'deposit account number', 'dda account'],
    bankAccountType: ['account type', 'bank account type'],
    currentCoverageType: ['current coverage', 'coverage type'],
    currentInsuranceCompany: ['insurance company', 'insurance carrier', 'current carrier'],
    insuranceExpirationDate: ['insurance expiration', 'expiration date'],
    insuredSinceDate: ['insured since'],
    requestedCoverageType: ['requested coverage', 'coverage'],
    requestedBodilyInjury: ['bodily injury', 'bi limit'],
    requestedPropertyDamage: ['property damage', 'pd limit'],
    requestedUninsuredMotorist: ['uninsured motorist', 'um limit', 'uim limit'],
    relationshipToApplicant: ['relationship', 'relationship to applicant'],
    dui: ['dui', 'driving under influence'],
    licensedState: ['licensed state', 'license state', 'driver license state'],
    requiresSr22: ['sr22', 'requires sr22'],
    bankruptcy: ['bankruptcy'],
    creditRating: ['credit rating'],
    licenseEverSuspended: ['license suspended', 'license ever suspended'],
    residenceType: ['residence type', 'home type'],
    vehicleMake: ['vehicle make', 'car make', 'make'],
    vehicleModel: ['vehicle model', 'car model', 'model'],
    vehicleYear: ['vehicle year', 'car year', 'year'],
    cardNumber: ['card number', 'credit card number', 'cc number'],
    cardExpiry: ['expiration', 'expiry', 'exp date', 'card expiry'],
    cvv: ['cvv', 'cvc', 'security code']
  };

  let score = 0;

  for (const hint of fieldHints[field.key] ?? []) {
    const normalizedHint = normalizeFillText(hint);
    if (!normalizedHint) continue;
    if (label === normalizedHint) score += 92;
    if (label.includes(normalizedHint) || normalizedHint.includes(label)) score += 52;
    if (normalizedText.includes(normalizedHint)) score += 30;
  }

  if (field.key === 'email' && /(company|business|work|office)/.test(normalizedText)) score -= 22;
  if (field.key === 'businessEmail' && /(personal|home)/.test(normalizedText)) score -= 18;
  if (field.key === 'phone' && /(fax|business|company|office)/.test(normalizedText)) score -= 18;
  if (field.key === 'businessPhone' && /(home|personal|mobile)/.test(normalizedText)) score -= 12;
  if (field.key === 'address1' && /(billing|shipping|business|company)/.test(normalizedText)) score -= 14;
  if (field.key === 'businessAddress1' && /(home|residential|personal)/.test(normalizedText)) score -= 14;

  return score;
}

function scoreFillProfileControl(field: FillField, control: FillControl, usedControls: Set<FillControl>): number {
  if (usedControls.has(control) || !isFillableControl(control)) return -1;

  const text = controlText(control);
  const label = normalizeFillText(controlLabel(control));
  const aliases = fillFieldAliases(field);
  const normalizedText = normalizeFillText(text);
  let score = autocompleteScore(field, control) + typeScore(field, control) + selectOptionScore(field, control) + fieldSemanticScore(field, text, label);

  aliases.forEach((alias) => {
    if (!alias) return;
    if (label === alias) score += 86;
    if (label.includes(alias) || alias.includes(label)) score += 44;
    if (text.includes(alias) || normalizedText.includes(alias)) score += 28;
  });

  if (field.group === 'address' && /(province|region|residential|mailing|billing|shipping|suite|apartment|unit)/i.test(text)) score += 8;
  if (field.group === 'business' && /(merchant|vendor|agency|affiliate|seller|storefront|business legal|company legal|irs|tax id)/i.test(text)) score += 10;
  if (field.group === 'loan' && /(capital|advance|proceeds|requested capital|cash advance|loan request|funds purpose)/i.test(text)) score += 10;
  if (field.group === 'finance' && /(deposit|checking|savings|gross receipts|monthly deposits|bank statement)/i.test(text)) score += 8;

  if (field.group === 'address' && /(address|street|city|state|zip|postal|country|地址|城市|邮编)/i.test(text)) score += 10;
  if (field.group === 'vehicle' && /(vehicle|car|auto|make|model|year|车辆|车型|品牌)/i.test(text)) score += 10;
  if (field.group === 'insurance' && /(insurance|coverage|carrier|policy|保险|投保)/i.test(text)) score += 10;
  if (field.group === 'payment' && /(card|credit|cvv|cvc|expiry|payment|信用卡|卡号)/i.test(text)) score += 12;
  if (field.group === 'business' && /(business|company|organization|entity|ein|tax|dba|industry|naics|employee|owner|principal|incorporation|公司|企业|税号|法人)/i.test(text)) score += 12;
  if (field.group === 'loan' && /(loan|financing|funding|amount|purpose|term|borrow|lender|贷款|融资|金额|用途|期限)/i.test(text)) score += 12;
  if (field.group === 'employment' && /(employment|employer|job|occupation|position|title|income|工作|雇主|职位|就业)/i.test(text)) score += 10;
  if (field.group === 'finance' && /(income|revenue|sales|credit|fico|bank|routing|account|rent|mortgage|收入|营业额|信用|银行|账号)/i.test(text)) score += 10;
  if (field.sensitivity !== 'secret' && /password|current-password|密码/.test(text)) score -= 120;

  return score;
}

function getAllFillControls(scope: ParentNode = document): FillControl[] {
  return Array.from(scope.querySelectorAll<FillControl>('input, select, textarea')).filter(isFillableControl);
}

function setTextControlValue(control: HTMLInputElement | HTMLTextAreaElement, value: string) {
  control.focus({ preventScroll: true });
  const prototype = Object.getPrototypeOf(control);
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
  descriptor?.set?.call(control, value);
  control.dispatchEvent(new KeyboardEvent('keydown', { key: value.slice(-1) || ' ', bubbles: true, cancelable: true }));
  control.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: value }));
  control.dispatchEvent(new Event('input', { bubbles: true }));
  control.dispatchEvent(new Event('change', { bubbles: true }));
  control.dispatchEvent(new KeyboardEvent('keyup', { key: value.slice(-1) || ' ', bubbles: true, cancelable: true }));
  control.blur();
}

function setSelectControlValue(control: HTMLSelectElement, value: string): boolean {
  const values = normalizedSelectValueCandidates(value);
  const option = Array.from(control.options).find((candidate) => {
    const optionValue = normalizeFillText(candidate.value);
    const optionText = normalizeFillText(candidate.textContent ?? '');
    return values.some((normalized) => optionValue === normalized || optionText === normalized || optionText.includes(normalized) || normalized.includes(optionText));
  });

  if (!option) return false;

  control.focus({ preventScroll: true });
  control.value = option.value;
  option.selected = true;
  control.dispatchEvent(new Event('input', { bubbles: true }));
  control.dispatchEvent(new Event('change', { bubbles: true }));
  control.blur();
  return true;
}

function setCheckboxOrRadioValue(control: HTMLInputElement, value: string): boolean {
  const normalized = normalizeFillText(value);
  const shouldCheck = /^(yes|true|1|y|on|是|男|male|female|女)$/i.test(normalized);
  const shouldUncheck = /^(no|false|0|n|off|否)$/i.test(normalized);

  if (!shouldCheck && !shouldUncheck) return false;

  control.focus({ preventScroll: true });
  control.checked = shouldCheck;
  control.dispatchEvent(new Event('input', { bubbles: true }));
  control.dispatchEvent(new Event('change', { bubbles: true }));
  control.blur();
  return true;
}

function fillProfileControl(control: FillControl, value: string): boolean {
  if (control instanceof HTMLSelectElement) {
    return setSelectControlValue(control, value);
  }

  if (control instanceof HTMLInputElement && ['checkbox', 'radio'].includes(control.type.toLowerCase())) {
    return setCheckboxOrRadioValue(control, value);
  }

  setTextControlValue(control, value);
  return true;
}

function expandFillProfileFields(profile: FillProfilePayload): FillField[] {
  const fields = [...profile.fields];
  const byKey = new Map(fields.map((field) => [field.key, field.value]));
  const firstName = byKey.get('firstName') ?? '';
  const lastName = byKey.get('lastName') ?? '';
  const ownerFirstName = byKey.get('ownerFirstName') ?? '';
  const ownerLastName = byKey.get('ownerLastName') ?? '';
  const address1 = byKey.get('address1') ?? '';
  const address2 = byKey.get('address2') ?? '';
  const businessAddress1 = byKey.get('businessAddress1') ?? '';
  const businessAddress2 = byKey.get('businessAddress2') ?? '';
  const hasAddressSignal = fields.some((field) =>
    field.group === 'address' ||
    ['address1', 'address2', 'city', 'state', 'postalCode', 'licensedState', 'businessState', 'businessPostalCode'].includes(field.key)
  );

  if (!byKey.has('fullName') && (firstName || lastName)) {
    fields.push({
      key: 'fullName',
      label: '姓名',
      value: `${firstName} ${lastName}`.trim(),
      group: 'personal',
      sensitivity: 'normal',
      aliases: ['full name', 'name', '姓名']
    });
  }

  if (!byKey.has('address') && (address1 || address2)) {
    fields.push({
      key: 'address',
      label: '完整地址',
      value: `${address1} ${address2}`.trim(),
      group: 'address',
      sensitivity: 'normal',
      aliases: ['address', 'street address', '完整地址', '地址']
    });
  }

  if (!byKey.has('country') && !byKey.has('businessCountry') && profile.countryCode && hasAddressSignal) {
    fields.push({
      key: 'country',
      label: '国家',
      value: countryNameFromCode(profile.countryCode),
      group: 'address',
      sensitivity: 'normal',
      aliases: ['country', 'country code', 'country/region', 'country region', 'nation', '国家', '国家/地区']
    });
  }

  if (!byKey.has('ownerName') && (ownerFirstName || ownerLastName)) {
    fields.push({
      key: 'ownerName',
      label: '负责人姓名',
      value: `${ownerFirstName} ${ownerLastName}`.trim(),
      group: 'business',
      sensitivity: 'normal',
      aliases: ['owner name', 'principal name', 'authorized signer', 'business owner', 'applicant name']
    });
  }

  if (!byKey.has('businessAddress') && (businessAddress1 || businessAddress2)) {
    fields.push({
      key: 'businessAddress',
      label: '公司完整地址',
      value: `${businessAddress1} ${businessAddress2}`.trim(),
      group: 'business',
      sensitivity: 'normal',
      aliases: ['business address', 'company address', 'business street address', 'company street address']
    });
  }

  return fields.filter((field) => field.value.trim());
}

function findBestFillControl(field: FillField, usedControls: Set<FillControl>): { control: FillControl; score: number } | null {
  const candidates = getAllFillControls(document)
    .map((control) => ({ control, score: scoreFillProfileControl(field, control, usedControls) }))
    .filter((item) => item.score >= 34)
    .sort((left, right) => right.score - left.score);

  return candidates[0] ?? null;
}

function fillControlIndex(control: FillControl): number | undefined {
  const index = getAllFillControls(document).indexOf(control);
  return index >= 0 ? index : undefined;
}

function createFillFieldBinding(control: FillControl, field: FillField): FillFieldBinding {
  return {
    key: field.key,
    label: field.label,
    selector: elementSelector(control),
    name: control.name || undefined,
    id: control.id || undefined,
    tagName: control.tagName.toLowerCase(),
    type: control instanceof HTMLInputElement ? control.type || undefined : control.tagName.toLowerCase(),
    autocomplete: control.autocomplete || undefined,
    placeholder: control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement ? control.placeholder || undefined : undefined,
    controlLabel: controlLabel(control),
    index: fillControlIndex(control)
  };
}

function findBoundFillControl(binding: FillFieldBinding | undefined, usedControls: Set<FillControl>): FillControl | null {
  if (!binding) return null;

  const candidates: FillControl[] = [];
  const selectorControl = safeQuerySelector<FillControl>(binding.selector);
  if (selectorControl) candidates.push(selectorControl);

  if (binding.id) {
    const byId = document.getElementById(binding.id);
    if (byId instanceof HTMLInputElement || byId instanceof HTMLSelectElement || byId instanceof HTMLTextAreaElement) {
      candidates.push(byId);
    }
  }

  if (binding.name) {
    candidates.push(...Array.from(document.querySelectorAll<FillControl>(`input[name="${cssAttr(binding.name)}"], select[name="${cssAttr(binding.name)}"], textarea[name="${cssAttr(binding.name)}"]`)));
  }

  if (typeof binding.index === 'number') {
    const indexed = getAllFillControls(document)[binding.index];
    if (indexed) candidates.push(indexed);
  }

  return candidates.find((control) => isFillableControl(control) && !usedControls.has(control)) ?? null;
}

function bindingForField(profile: FillProfilePayload, field: FillField): FillFieldBinding | undefined {
  return profile.siteBinding?.fields.find((binding) => binding.key === field.key || binding.label === field.label);
}

function matchFillProfileField(profile: FillProfilePayload, field: FillField, usedControls: Set<FillControl>): { control: FillControl; score: number; binding: boolean } | null {
  const boundControl = findBoundFillControl(bindingForField(profile, field), usedControls);
  if (boundControl) {
    return { control: boundControl, score: 999, binding: true };
  }

  const automatic = findBestFillControl(field, usedControls);
  return automatic ? { ...automatic, binding: false } : null;
}

function fillProfile(profile: FillProfilePayload): FillProfileFillResult {
  const fields = expandFillProfileFields(profile);
  const usedControls = new Set<FillControl>();
  let filledCount = 0;
  let matchedCount = 0;
  let skippedCount = 0;
  const diagnostics: FillProfileDiagnostic[] = [];

  for (const field of fields) {
    const match = matchFillProfileField(profile, field, usedControls);
    if (!match) {
      diagnostics.push({
        key: field.key,
        label: field.label,
        status: 'missing'
      });
      continue;
    }

    matchedCount += 1;

    const currentValue = 'value' in match.control ? String(match.control.value ?? '').trim() : '';
    if (profile.onlyEmpty && currentValue) {
      skippedCount += 1;
      usedControls.add(match.control);
      diagnostics.push({
        key: field.key,
        label: field.label,
        status: 'skipped',
        controlLabel: controlLabel(match.control),
        score: match.score,
        binding: match.binding
      });
      continue;
    }

    if (fillProfileControl(match.control, field.value)) {
      filledCount += 1;
      usedControls.add(match.control);
      diagnostics.push({
        key: field.key,
        label: field.label,
        status: 'filled',
        controlLabel: controlLabel(match.control),
        score: match.score,
        binding: match.binding
      });
    } else {
      diagnostics.push({
        key: field.key,
        label: field.label,
        status: 'matched',
        controlLabel: controlLabel(match.control),
        score: match.score,
        binding: match.binding
      });
    }
  }

  return {
    ok: filledCount > 0,
    error: filledCount > 0 ? undefined : 'NO_FILL_PROFILE_FIELDS',
    filledCount,
    matchedCount,
    skippedCount,
    totalFields: fields.length,
    diagnostics
  };
}

function diagnoseFillProfile(profile: FillProfilePayload): FillProfileFillResult {
  const fields = expandFillProfileFields(profile);
  const usedControls = new Set<FillControl>();
  const diagnostics: FillProfileDiagnostic[] = [];
  let matchedCount = 0;

  for (const field of fields) {
    const match = matchFillProfileField(profile, field, usedControls);
    if (!match) {
      diagnostics.push({ key: field.key, label: field.label, status: 'missing' });
      continue;
    }

    matchedCount += 1;
    usedControls.add(match.control);
    diagnostics.push({
      key: field.key,
      label: field.label,
      status: 'matched',
      controlLabel: controlLabel(match.control),
      score: match.score,
      binding: match.binding
    });
  }

  return {
    ok: matchedCount > 0,
    error: matchedCount > 0 ? undefined : 'NO_FILL_PROFILE_FIELDS',
    filledCount: 0,
    matchedCount,
    skippedCount: 0,
    totalFields: fields.length,
    diagnostics
  };
}

function sendRuntimeMessage<T>(message: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      resolve(response as T);
    });
  });
}

function bindingStepText(step: BindingStep): string {
  if (step === 'username') return '1. 点击用户名输入框';
  if (step === 'password') return '2. 点击密码输入框';
  return '3. 点击登录按钮';
}

function bindingStepHint(step: BindingStep): string {
  if (step === 'username') return '选择平时输入账号、邮箱或用户名的位置。';
  if (step === 'password') return '选择保存密码对应的输入框。';
  return '选择点击后会提交登录的按钮。';
}

function ensureBindingUi() {
  if (!bindingHost || !bindingRoot) {
    bindingHost = document.createElement('div');
    bindingHost.id = 'keypilot-binding-root';
    bindingHost.style.position = 'fixed';
    bindingHost.style.top = '20px';
    bindingHost.style.right = '20px';
    bindingHost.style.zIndex = '2147483647';
    bindingHost.style.width = '340px';
    bindingHost.style.colorScheme = 'light';
    bindingRoot = bindingHost.attachShadow({ mode: 'open' });
    document.documentElement.appendChild(bindingHost);
  }

  if (!bindingHighlight) {
    bindingHighlight = document.createElement('div');
    bindingHighlight.id = 'keypilot-binding-highlight';
    bindingHighlight.style.position = 'fixed';
    bindingHighlight.style.zIndex = '2147483646';
    bindingHighlight.style.pointerEvents = 'none';
    bindingHighlight.style.border = '2px solid #2563eb';
    bindingHighlight.style.borderRadius = '8px';
    bindingHighlight.style.boxShadow = '0 0 0 4px rgba(37, 99, 235, 0.16)';
    bindingHighlight.style.display = 'none';
    document.documentElement.appendChild(bindingHighlight);
  }
}

function renderManualBinding() {
  if (!manualBinding) return;
  ensureBindingUi();
  if (!bindingRoot) return;

  const done = {
    username: Boolean(manualBinding.usernameField),
    password: Boolean(manualBinding.passwordField),
    submit: Boolean(manualBinding.submitButton)
  };

  bindingRoot.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; }
      .panel {
        border: 1px solid #d7e4f7;
        border-radius: 14px;
        background: #ffffff;
        box-shadow: 0 18px 48px rgba(16, 24, 40, 0.2);
        color: #101828;
        font-family: Satoshi, Geist, Outfit, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
        overflow: visible;
        animation: keypilot-bind-in 160ms ease-out both;
      }
      header {
        display: grid;
        grid-template-columns: minmax(0, 1fr) 28px;
        align-items: center;
        gap: 10px;
        border-bottom: 1px solid #edf2f8;
        background: #fbfdff;
        padding: 12px 12px 10px;
      }
      h3 {
        margin: 0;
        color: #111827;
        font-size: 15px;
        font-weight: 800;
      }
      button {
        font: inherit;
      }
      .close {
        display: grid;
        width: 28px;
        height: 28px;
        place-items: center;
        border: 0;
        border-radius: 7px;
        background: transparent;
        color: #667085;
        cursor: pointer;
        font-size: 18px;
      }
      .close:hover { background: #f2f4f7; color: #344054; }
      .body {
        display: grid;
        gap: 10px;
        padding: 11px 12px 12px;
      }
      .current {
        border: 1px solid #cfe0ff;
        border-radius: 10px;
        background: #f5f8ff;
        padding: 9px 10px;
      }
      .current strong {
        display: block;
        color: #175cd3;
        font-size: 13px;
        font-weight: 850;
      }
      .current span {
        display: block;
        margin-top: 4px;
        color: #475467;
        font-size: 12px;
        line-height: 1.4;
      }
      ol {
        display: grid;
        gap: 6px;
        margin: 0;
        padding: 0;
        list-style: none;
      }
      li {
        display: grid;
        grid-template-columns: 20px minmax(0, 1fr);
        align-items: center;
        gap: 8px;
        color: #667085;
        font-size: 12px;
        font-weight: 740;
      }
      li::before {
        content: "";
        width: 18px;
        height: 18px;
        border: 1px solid #d0d5dd;
        border-radius: 999px;
        background: #ffffff;
      }
      li.done { color: #166534; }
      li.done::before {
        border-color: #22c55e;
        background: #22c55e;
        box-shadow: inset 0 0 0 4px #ffffff;
      }
      li.active { color: #175cd3; }
      li.active::before {
        border-color: #2563eb;
        background: #eaf2ff;
        box-shadow: inset 0 0 0 4px #ffffff;
      }
      .status {
        margin: 0;
        color: #475467;
        font-size: 12px;
        line-height: 1.45;
      }
      @keyframes keypilot-bind-in {
        from { opacity: 0; transform: translateY(-8px); }
        to { opacity: 1; transform: translateY(0); }
      }
      @media (prefers-reduced-motion: reduce) {
        .panel { animation-duration: 1ms; }
      }
    </style>
    <section class="panel" role="dialog" aria-label="KeyPilot 手动绑定字段">
      <header>
        <h3>KeyPilot 点选绑定</h3>
        <button class="close" type="button" data-binding-action="cancel" aria-label="取消绑定">×</button>
      </header>
      <div class="body">
        <div class="current">
          <strong>${escapeHtml(bindingStepText(manualBinding.step))}</strong>
          <span>${escapeHtml(bindingStepHint(manualBinding.step))}</span>
        </div>
        <ol>
          <li class="${done.username ? 'done' : manualBinding.step === 'username' ? 'active' : ''}">用户名框</li>
          <li class="${done.password ? 'done' : manualBinding.step === 'password' ? 'active' : ''}">密码框</li>
          <li class="${done.submit ? 'done' : manualBinding.step === 'submit' ? 'active' : ''}">登录按钮</li>
        </ol>
        <p class="status">${escapeHtml(manualBinding.status || '点击页面里的对应元素。按 Esc 可取消。')}</p>
      </div>
    </section>
  `;

  bindingRoot.querySelector<HTMLElement>('[data-binding-action="cancel"]')?.addEventListener('click', (event) => {
    event.preventDefault();
    stopManualBinding('已取消绑定。');
  });
}

function setBindingHighlight(element: Element | null) {
  if (!bindingHighlight || !element) {
    if (bindingHighlight) bindingHighlight.style.display = 'none';
    return;
  }

  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    bindingHighlight.style.display = 'none';
    return;
  }

  bindingHighlight.style.display = 'block';
  bindingHighlight.style.left = `${Math.max(0, rect.left - 3)}px`;
  bindingHighlight.style.top = `${Math.max(0, rect.top - 3)}px`;
  bindingHighlight.style.width = `${rect.width + 6}px`;
  bindingHighlight.style.height = `${rect.height + 6}px`;
}

function bindingEventHitsPanel(event: Event): boolean {
  const path = event.composedPath();
  return Boolean(bindingHost && path.includes(bindingHost));
}

function getBindingTarget(event: Event): HTMLElement | null {
  if (!manualBinding || bindingEventHitsPanel(event)) return null;

  const target = event.target instanceof HTMLElement ? event.target : null;
  if (!target) return null;

  if (manualBinding.step === 'submit') {
    return target.closest<HTMLElement>('button, input[type="submit"], input[type="button"], a, [role="button"]');
  }

  return target.closest<HTMLInputElement>('input');
}

function stopManualBinding(status?: string) {
  document.removeEventListener('click', handleManualBindingClick, true);
  document.removeEventListener('mouseover', handleManualBindingHover, true);
  document.removeEventListener('keydown', handleManualBindingKeydown, true);
  bindingHost?.remove();
  bindingHighlight?.remove();
  bindingHost = null;
  bindingRoot = null;
  bindingHighlight = null;
  manualBinding = null;

  if (status) {
    inlineStatus = status;
    renderInlineWidget();
  }
}

function startManualBinding(credential: FillCredentialPayload) {
  stopManualBinding();
  manualBinding = {
    credential,
    step: 'username',
    status: '请先点击用户名、邮箱或账号输入框。'
  };

  document.addEventListener('click', handleManualBindingClick, true);
  document.addEventListener('mouseover', handleManualBindingHover, true);
  document.addEventListener('keydown', handleManualBindingKeydown, true);
  renderManualBinding();
  setBindingHighlight(getInlineAnchor());
}

function handleManualBindingHover(event: MouseEvent) {
  const target = getBindingTarget(event);
  setBindingHighlight(target);
}

function handleManualBindingKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  event.stopImmediatePropagation();
  stopManualBinding('已取消绑定。');
}

function handleManualBindingClick(event: MouseEvent) {
  if (!manualBinding || bindingEventHitsPanel(event)) return;

  const target = getBindingTarget(event);
  if (!target) return;

  event.preventDefault();
  event.stopImmediatePropagation();

  if (manualBinding.step === 'username') {
    if (!(target instanceof HTMLInputElement) || !isStorableInput(target)) {
      manualBinding.status = '请选择可输入账号的文本框。';
      renderManualBinding();
      return;
    }

    manualBinding.usernameField = target;
    manualBinding.step = 'password';
    manualBinding.status = '已绑定用户名框。现在点击密码输入框。';
    renderManualBinding();
    setBindingHighlight(target);
    return;
  }

  if (manualBinding.step === 'password') {
    if (!(target instanceof HTMLInputElement) || !isStorableInput(target)) {
      manualBinding.status = '请选择密码输入框。';
      renderManualBinding();
      return;
    }

    manualBinding.passwordField = target;
    manualBinding.step = 'submit';
    manualBinding.status = target.type.toLowerCase() === 'password'
      ? '已绑定密码框。现在点击登录按钮。'
      : '已绑定密码框。这个输入框不是 password 类型，如无法登录可重新绑定。';
    renderManualBinding();
    setBindingHighlight(target);
    return;
  }

  manualBinding.submitButton = target;
  manualBinding.status = '正在保存绑定规则...';
  renderManualBinding();
  setBindingHighlight(target);
  void saveManualBinding();
}

async function saveManualBinding() {
  if (!manualBinding?.usernameField || !manualBinding.passwordField || !manualBinding.submitButton) return;

  const { credential, usernameField, passwordField, submitButton } = manualBinding;
  const scope = passwordField.closest('form') ?? usernameField.closest('form') ?? getLoginScope(passwordField);
  const binding: ManualBindingResult = {
    credentialId: credential.id,
    url: window.location.href,
    domain: window.location.hostname.replace(/^www\./i, '').toLowerCase(),
    formFields: [
      createBoundField(usernameField, 'username', credential.username, scope),
      createBoundField(passwordField, 'password', credential.password, scope)
    ],
    formProfile: captureFormProfile(scope, usernameField, passwordField, submitButton)
  };

  try {
    const response = await sendRuntimeMessage<{ ok: boolean; error?: string; locked?: boolean }>({
      type: 'KEYPILOT_SAVE_MANUAL_BINDING',
      binding
    });

    if (!response.ok) {
      throw new Error(response.error ?? (response.locked ? 'VAULT_LOCKED' : 'BINDING_SAVE_FAILED'));
    }

    if (manualBinding) {
      manualBinding.status = '已保存绑定。下次一键登录会优先使用这组字段和按钮。';
      renderManualBinding();
    }

    window.setTimeout(() => stopManualBinding('已保存字段和登录按钮绑定。'), 1200);
  } catch (error) {
    if (manualBinding) {
      manualBinding.status = inlineErrorMessage(error);
      renderManualBinding();
    }
  }
}

function currentRulePathPattern(): string | undefined {
  const path = window.location.pathname || '/';
  return path === '/' ? undefined : path;
}

function captureLoginStructureFields(scope: ParentNode, usernameField: HTMLInputElement | undefined, passwordField: HTMLInputElement): CredentialFormField[] {
  return [
    usernameField ? createBoundField(usernameField, 'username', '', scope) : null,
    createBoundField(passwordField, 'password', '', scope)
  ].filter((field): field is CredentialFormField => Boolean(field));
}

async function applyLoginRecognitionRule() {
  const context = findLoginContext();
  const passwordField = context?.passwordField;

  if (!passwordField) {
    recognitionDebugCopyStatus = '没有检测到可保存的密码框，请先用“定位”确认页面里有登录表单。';
    renderRecognitionDebugPanel();
    return;
  }

  const usernameField = context.usernameField;
  const scope = passwordField.closest('form') ?? usernameField?.closest('form') ?? context.scope ?? getLoginScope(passwordField);
  const submitButton = findSubmitButton(passwordField);

  recognitionDebugCopyStatus = '正在保存当前页面为登录页规则...';
  renderRecognitionDebugPanel();

  try {
    const response = await sendRuntimeMessage<RecognitionRuleApplyResult>({
      type: 'KEYPILOT_APPLY_RECOGNITION_RULE',
      rule: {
        url: window.location.href,
        domain: window.location.hostname.replace(/^www\./i, '').toLowerCase(),
        pathPattern: currentRulePathPattern(),
        pageMode: 'login',
        disablePasswordGenerator: true,
        formFields: captureLoginStructureFields(scope, usernameField, passwordField),
        formProfile: captureFormProfile(scope, usernameField, passwordField, submitButton ?? undefined),
        repairActions: DEFAULT_REPAIR_ACTIONS
      }
    });

    if (!response.ok) {
      throw new Error(response.error ?? (response.locked ? 'VAULT_LOCKED' : 'RULE_SAVE_FAILED'));
    }

    inlineSiteRule = response.siteRule ?? inlineSiteRule;
    inlineStateLoaded = true;
    recognitionDebugCopyStatus = '已保存登录页规则。这个路径会优先显示登录入口，并关闭错误的密码生成器。';
    await refreshInlineMatches().catch(() => undefined);
    renderRecognitionDebugPanel();
    positionInlineWidget();
    positionPasswordGeneratorWidget();
  } catch (error) {
    recognitionDebugCopyStatus = inlineErrorMessage(error);
    renderRecognitionDebugPanel();
  }
}

function renderFillProfileBinding() {
  if (!fillProfileBinding) return;
  ensureBindingUi();
  if (!bindingRoot) return;

  const fields = expandFillProfileFields(fillProfileBinding.profile);
  const selectedField = fields.find((field) => field.key === fillProfileBinding?.selectedKey) ?? fields[0];
  const boundKeys = new Set(fillProfileBinding.bindings.map((binding) => binding.key));
  const options = fields
    .map((field) => `<option value="${escapeHtml(field.key)}" ${field.key === selectedField?.key ? 'selected' : ''}>${escapeHtml(field.label)}${boundKeys.has(field.key) ? ' · 已绑定' : ''}</option>`)
    .join('');

  bindingRoot.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; }
      .panel {
        border: 1px solid #d7e4f7;
        border-radius: 14px;
        background: #ffffff;
        box-shadow: 0 18px 48px rgba(16, 24, 40, 0.2);
        color: #101828;
        font-family: Satoshi, Geist, Outfit, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
        overflow: hidden;
        animation: keypilot-bind-in 160ms ease-out both;
      }
      header {
        display: grid;
        grid-template-columns: minmax(0, 1fr) 28px;
        align-items: center;
        gap: 10px;
        border-bottom: 1px solid #edf2f8;
        background: #fbfdff;
        padding: 12px 12px 10px;
      }
      h3 {
        margin: 0;
        color: #111827;
        font-size: 15px;
        font-weight: 800;
      }
      button, select { font: inherit; }
      .close {
        display: grid;
        width: 28px;
        height: 28px;
        place-items: center;
        border: 0;
        border-radius: 7px;
        background: transparent;
        color: #667085;
        cursor: pointer;
        font-size: 18px;
      }
      .close:hover { background: #f2f4f7; color: #344054; }
      .body {
        display: grid;
        gap: 10px;
        padding: 11px 12px 12px;
      }
      .current {
        border: 1px solid #cfe0ff;
        border-radius: 10px;
        background: #f5f8ff;
        padding: 9px 10px;
      }
      .current strong {
        display: block;
        color: #175cd3;
        font-size: 13px;
        font-weight: 850;
      }
      .current span {
        display: block;
        margin-top: 4px;
        color: #475467;
        font-size: 12px;
        line-height: 1.4;
      }
      select {
        width: 100%;
        height: 36px;
        border: 1px solid #d0d5dd;
        border-radius: 9px;
        background: #ffffff;
        color: #111827;
        padding: 0 10px;
        font-size: 13px;
        outline: none;
      }
      select:focus { border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.12); }
      .status {
        margin: 0;
        color: #475467;
        font-size: 12px;
        line-height: 1.45;
      }
      .actions {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
      }
      .actions button {
        min-height: 34px;
        border: 1px solid #d0d5dd;
        border-radius: 9px;
        background: #ffffff;
        color: #344054;
        cursor: pointer;
        font-size: 12px;
        font-weight: 760;
      }
      .actions .primary {
        border-color: #2563eb;
        background: #2563eb;
        color: #ffffff;
      }
      .actions button:hover { transform: translateY(-1px); }
      .count {
        display: inline-flex;
        width: fit-content;
        border: 1px solid #bbf7d0;
        border-radius: 999px;
        background: #f0fdf4;
        color: #166534;
        padding: 5px 9px;
        font-size: 11px;
        font-weight: 800;
      }
      @keyframes keypilot-bind-in {
        from { opacity: 0; transform: translateY(-8px); }
        to { opacity: 1; transform: translateY(0); }
      }
      @media (prefers-reduced-motion: reduce) {
        .panel { animation-duration: 1ms; }
        .actions button:hover { transform: none; }
      }
    </style>
    <section class="panel" role="dialog" aria-label="KeyPilot 填表字段绑定">
      <header>
        <h3>绑定填表字段</h3>
        <button class="close" type="button" data-fill-binding-action="cancel" aria-label="取消绑定">×</button>
      </header>
      <div class="body">
        <div class="current">
          <strong>${escapeHtml(selectedField ? `点击网页中的“${selectedField.label}”输入框` : '选择字段')}</strong>
          <span>先在下方选择资料字段，再点击网页上对应的输入框、下拉框或文本框。</span>
        </div>
        <select data-fill-binding-field aria-label="选择要绑定的资料字段">${options}</select>
        <span class="count">已绑定 ${fillProfileBinding.bindings.length} 个字段</span>
        <p class="status">${escapeHtml(fillProfileBinding.status || '点击页面里的对应表单字段。按 Esc 可取消。')}</p>
        <div class="actions">
          <button type="button" data-fill-binding-action="skip">跳过此字段</button>
          <button class="primary" type="button" data-fill-binding-action="save">保存绑定</button>
        </div>
      </div>
    </section>
  `;

  bindingRoot.querySelector<HTMLElement>('[data-fill-binding-action="cancel"]')?.addEventListener('click', (event) => {
    event.preventDefault();
    stopFillProfileBinding('已取消填表字段绑定。');
  });
  bindingRoot.querySelector<HTMLElement>('[data-fill-binding-action="skip"]')?.addEventListener('click', (event) => {
    event.preventDefault();
    selectNextFillBindingField();
  });
  bindingRoot.querySelector<HTMLElement>('[data-fill-binding-action="save"]')?.addEventListener('click', (event) => {
    event.preventDefault();
    void saveFillProfileBinding();
  });
  bindingRoot.querySelector<HTMLSelectElement>('[data-fill-binding-field]')?.addEventListener('change', (event) => {
    const select = event.currentTarget as HTMLSelectElement | null;
    if (!fillProfileBinding) return;
    fillProfileBinding.selectedKey = select?.value ?? fillProfileBinding.selectedKey;
    fillProfileBinding.status = '现在点击网页上对应的表单字段。';
    renderFillProfileBinding();
  });
}

function getFillProfileBindingTarget(event: Event): FillControl | null {
  if (!fillProfileBinding || bindingEventHitsPanel(event)) return null;
  const target = event.target instanceof HTMLElement ? targetAsFillControl(event.target) : null;
  return target && isFillableControl(target) ? target : null;
}

function targetAsFillControl(target: HTMLElement): FillControl | null {
  const control = target.closest('input, select, textarea');
  if (control instanceof HTMLInputElement || control instanceof HTMLSelectElement || control instanceof HTMLTextAreaElement) {
    return control;
  }
  return null;
}

function selectNextFillBindingField() {
  if (!fillProfileBinding) return;
  const fields = expandFillProfileFields(fillProfileBinding.profile);
  const boundKeys = new Set(fillProfileBinding.bindings.map((binding) => binding.key));
  const currentIndex = Math.max(0, fields.findIndex((field) => field.key === fillProfileBinding?.selectedKey));
  const next =
    fields.slice(currentIndex + 1).find((field) => !boundKeys.has(field.key)) ??
    fields.find((field) => !boundKeys.has(field.key)) ??
    fields[(currentIndex + 1) % Math.max(1, fields.length)];

  if (next) {
    fillProfileBinding.selectedKey = next.key;
    fillProfileBinding.status = `已切换到“${next.label}”。`;
  }
  renderFillProfileBinding();
}

function startFillProfileBinding(profile: FillProfilePayload) {
  stopManualBinding();
  stopFillProfileBinding();
  const fields = expandFillProfileFields(profile);
  fillProfileBinding = {
    profile,
    selectedKey: fields[0]?.key ?? '',
    bindings: [...(profile.siteBinding?.fields ?? [])],
    status: '选择字段后，点击网页上对应的表单字段。'
  };

  document.addEventListener('click', handleFillProfileBindingClick, true);
  document.addEventListener('mouseover', handleFillProfileBindingHover, true);
  document.addEventListener('keydown', handleFillProfileBindingKeydown, true);
  renderFillProfileBinding();
}

function stopFillProfileBinding(status?: string) {
  document.removeEventListener('click', handleFillProfileBindingClick, true);
  document.removeEventListener('mouseover', handleFillProfileBindingHover, true);
  document.removeEventListener('keydown', handleFillProfileBindingKeydown, true);
  bindingHost?.remove();
  bindingHighlight?.remove();
  bindingHost = null;
  bindingRoot = null;
  bindingHighlight = null;
  fillProfileBinding = null;

  if (status) {
    inlineStatus = status;
    renderInlineWidget();
  }
}

function handleFillProfileBindingHover(event: MouseEvent) {
  const target = getFillProfileBindingTarget(event);
  setBindingHighlight(target);
}

function handleFillProfileBindingKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  event.stopImmediatePropagation();
  stopFillProfileBinding('已取消填表字段绑定。');
}

function handleFillProfileBindingClick(event: MouseEvent) {
  if (!fillProfileBinding || bindingEventHitsPanel(event)) return;

  const target = getFillProfileBindingTarget(event);
  if (!target) return;

  event.preventDefault();
  event.stopImmediatePropagation();

  const field = expandFillProfileFields(fillProfileBinding.profile).find((item) => item.key === fillProfileBinding?.selectedKey);
  if (!field) {
    fillProfileBinding.status = '请先选择要绑定的资料字段。';
    renderFillProfileBinding();
    return;
  }

  const binding = createFillFieldBinding(target, field);
  fillProfileBinding.bindings = [binding, ...fillProfileBinding.bindings.filter((item) => item.key !== field.key)];
  fillProfileBinding.status = `已绑定“${field.label}”到“${binding.controlLabel || binding.name || binding.id || binding.selector || '字段'}”。`;
  setBindingHighlight(target);
  selectNextFillBindingField();
}

async function saveFillProfileBinding() {
  if (!fillProfileBinding) return;

  if (!fillProfileBinding.bindings.length) {
    fillProfileBinding.status = '至少绑定一个字段后再保存。';
    renderFillProfileBinding();
    return;
  }

  fillProfileBinding.status = '正在保存绑定规则...';
  renderFillProfileBinding();

  const binding: FillProfileBindingResult = {
    profileId: fillProfileBinding.profile.id,
    url: window.location.href,
    domain: window.location.hostname.replace(/^www\./i, '').toLowerCase(),
    fields: fillProfileBinding.bindings
  };

  try {
    const response = await sendRuntimeMessage<{ ok: boolean; error?: string; locked?: boolean }>({
      type: 'KEYPILOT_SAVE_FILL_PROFILE_BINDING',
      binding
    });

    if (!response.ok) {
      throw new Error(response.error ?? (response.locked ? 'VAULT_LOCKED' : 'FILL_BINDING_SAVE_FAILED'));
    }

    if (fillProfileBinding) {
      fillProfileBinding.status = '已保存绑定。下次填写身份资料会优先使用这组字段。';
      renderFillProfileBinding();
    }

    window.setTimeout(() => stopFillProfileBinding('已保存填表字段绑定。'), 1200);
  } catch (error) {
    if (fillProfileBinding) {
      fillProfileBinding.status = inlineErrorMessage(error);
      renderFillProfileBinding();
    }
  }
}

function clearBindingTestOverlay() {
  if (bindingTestTimer) {
    window.clearTimeout(bindingTestTimer);
    bindingTestTimer = null;
  }

  bindingTestHost?.remove();
  bindingTestHost = null;
}

function renderBindingTestOverlay(elements: Array<{ element: HTMLElement; label: string; tone: 'field' | 'submit' }>, result: BindingTestResult) {
  clearBindingTestOverlay();

  bindingTestHost = document.createElement('div');
  bindingTestHost.id = 'keypilot-binding-test-root';
  bindingTestHost.style.position = 'fixed';
  bindingTestHost.style.inset = '0';
  bindingTestHost.style.zIndex = '2147483647';
  bindingTestHost.style.pointerEvents = 'none';
  bindingTestHost.style.colorScheme = 'light';
  const root = bindingTestHost.attachShadow({ mode: 'open' });
  document.documentElement.appendChild(bindingTestHost);

  const boxes = elements
    .map(({ element, label, tone }) => {
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return '';

      return `
        <div class="box ${tone}" style="left:${Math.max(0, rect.left - 4)}px;top:${Math.max(0, rect.top - 4)}px;width:${rect.width + 8}px;height:${rect.height + 8}px;">
          <span>${escapeHtml(label)}</span>
        </div>
      `;
    })
    .join('');
  const statusTone = result.ok ? 'good' : 'warn';

  root.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; }
      .panel {
        position: fixed;
        top: 20px;
        right: 20px;
        width: 340px;
        pointer-events: auto;
        border: 1px solid #d7e4f7;
        border-radius: 14px;
        background: #ffffff;
        box-shadow: 0 18px 48px rgba(16, 24, 40, 0.2);
        color: #101828;
        font-family: Satoshi, Geist, Outfit, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
        overflow: hidden;
        animation: keypilot-test-in 160ms ease-out both;
      }
      header {
        display: grid;
        grid-template-columns: minmax(0, 1fr) 28px;
        align-items: center;
        gap: 10px;
        border-bottom: 1px solid #edf2f8;
        background: #fbfdff;
        padding: 12px;
      }
      h3 {
        margin: 0;
        color: #111827;
        font-size: 15px;
        font-weight: 800;
      }
      button {
        display: grid;
        width: 28px;
        height: 28px;
        place-items: center;
        border: 0;
        border-radius: 7px;
        background: transparent;
        color: #667085;
        cursor: pointer;
        font: inherit;
        font-size: 18px;
      }
      button:hover { background: #f2f4f7; color: #344054; }
      .body {
        display: grid;
        gap: 10px;
        padding: 12px;
      }
      .status {
        border: 1px solid ${result.ok ? '#bbf7d0' : '#fed7aa'};
        border-radius: 10px;
        background: ${result.ok ? '#f0fdf4' : '#fff7ed'};
        color: ${result.ok ? '#166534' : '#9a3412'};
        padding: 9px 10px;
        font-size: 13px;
        font-weight: 760;
        line-height: 1.45;
      }
      .metrics {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
      }
      .metric {
        border: 1px solid #e5eaf2;
        border-radius: 10px;
        background: #ffffff;
        padding: 9px 10px;
      }
      .metric span {
        display: block;
        color: #667085;
        font-size: 12px;
      }
      .metric strong {
        display: block;
        margin-top: 4px;
        color: #111827;
        font-size: 16px;
        font-variant-numeric: tabular-nums;
      }
      .hint {
        margin: 0;
        color: #667085;
        font-size: 12px;
        line-height: 1.45;
      }
      .box {
        position: fixed;
        pointer-events: none;
        border: 2px solid #2563eb;
        border-radius: 8px;
        box-shadow: 0 0 0 4px rgba(37, 99, 235, 0.16);
        animation: keypilot-test-in 160ms ease-out both;
      }
      .box.submit {
        border-color: #16a34a;
        box-shadow: 0 0 0 4px rgba(22, 163, 74, 0.16);
      }
      .box span {
        position: absolute;
        left: 0;
        top: -28px;
        border-radius: 999px;
        background: #111827;
        color: #ffffff;
        padding: 5px 8px;
        font-size: 12px;
        font-weight: 760;
        white-space: nowrap;
      }
      @keyframes keypilot-test-in {
        from { opacity: 0; transform: translateY(-8px); }
        to { opacity: 1; transform: translateY(0); }
      }
      @media (prefers-reduced-motion: reduce) {
        .panel, .box { animation-duration: 1ms; }
      }
    </style>
    ${boxes}
    <section class="panel" role="dialog" aria-label="KeyPilot 绑定测试结果">
      <header>
        <h3>KeyPilot 绑定测试</h3>
        <button type="button" data-action="close" aria-label="关闭测试结果">×</button>
      </header>
      <div class="body">
        <div class="status ${statusTone}">${escapeHtml(result.message)}</div>
        <div class="metrics">
          <div class="metric"><span>字段匹配</span><strong>${result.matchedFields}/${result.totalFields}</strong></div>
          <div class="metric"><span>登录按钮</span><strong>${result.submitMatched ? '已匹配' : result.hasSubmit ? '未匹配' : '未记录'}</strong></div>
        </div>
        <p class="hint">测试只高亮绑定目标，不会填写密码，也不会点击登录。</p>
      </div>
    </section>
  `;

  root.querySelector<HTMLElement>('[data-action="close"]')?.addEventListener('click', (event) => {
    event.preventDefault();
    clearBindingTestOverlay();
  });

  bindingTestTimer = window.setTimeout(clearBindingTestOverlay, 9000);
}

function testCredentialBinding(credential: FillCredentialPayload): BindingTestResult {
  const fields = credential.formFields ?? [];
  const usedInputs = new Set<HTMLInputElement>();
  const highlighted: Array<{ element: HTMLElement; label: string; tone: 'field' | 'submit' }> = [];
  let matchedFields = 0;
  let anchorField: HTMLInputElement | undefined;

  for (const field of fields) {
    const input = findStoredFieldInput(field, usedInputs);
    if (!input) continue;

    usedInputs.add(input);
    matchedFields += 1;
    anchorField = field.kind === 'password' ? input : anchorField ?? input;
    highlighted.push({
      element: input,
      label: field.kind === 'password' ? '密码框' : field.kind === 'username' ? '用户名框' : field.label || '字段',
      tone: 'field'
    });
  }

  if (!anchorField) {
    anchorField = findLoginContext()?.passwordField ?? findLoginContext()?.usernameField;
  }

  const hasSubmit = Boolean(credential.formProfile?.submit);
  const submitButton = anchorField ? findStoredSubmitButton(credential.formProfile, anchorField) : safeQuerySelector<HTMLElement>(credential.formProfile?.submit?.selector);

  if (submitButton) {
    highlighted.push({
      element: submitButton,
      label: '登录按钮',
      tone: 'submit'
    });
  }

  highlighted[0]?.element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });

  const ok = fields.length > 0 && matchedFields === fields.length && (!hasSubmit || Boolean(submitButton));
  const message = !fields.length && !hasSubmit
    ? '这个账号还没有保存字段绑定。'
    : ok
      ? '绑定目标匹配正常。'
      : `匹配不完整：字段 ${matchedFields}/${fields.length}，登录按钮${hasSubmit ? (submitButton ? '已匹配' : '未匹配') : '未记录'}。`;
  const result: BindingTestResult = {
    ok,
    matchedFields,
    totalFields: fields.length,
    hasSubmit,
    submitMatched: Boolean(submitButton),
    message
  };

  renderBindingTestOverlay(highlighted, result);
  return result;
}

function getInlineLoginAnchor(): HTMLInputElement | null {
  const forceLogin = siteRuleForcesLoginPage();

  if (!forceLogin && pageLooksLikeRegistration()) {
    return null;
  }

  const passwordFields = getAllVisibleInputs(document).filter((input) => isPasswordInput(input) && !isCurrentPasswordField(input));

  if (!forceLogin && passwordFieldsLookLikeRegistration(passwordFields)) {
    return null;
  }

  const context = findLoginContext();
  const generatorContext = forceLogin ? null : findPasswordGeneratorContext();

  if (generatorContext) {
    return null;
  }

  return context?.usernameField ?? context?.passwordField ?? null;
}

function scoreFillProfileInlineAnchor(control: FillControl): number {
  if (control instanceof HTMLInputElement && ['password', 'checkbox', 'radio'].includes(control.type.toLowerCase())) return -1;

  const text = controlText(control);
  const normalizedText = normalizeFillText(text);
  const type = control instanceof HTMLInputElement ? control.type.toLowerCase() : control.tagName.toLowerCase();
  const autocomplete = control.autocomplete.toLowerCase();
  const active = document.activeElement;
  let score = 0;

  if (active === control || control.matches(':focus')) score += 96;
  if (/(legal\s*name|customer\s*name|contact\s*name|applicant\s*name|merchant|social\s*security|license|coverage|insurance|carrier|vehicle|vin|make|model|revenue|income|bank|routing|account|cvv|cvc|card|shipping|billing|checkout|quote|lead)/i.test(text)) score += 58;

  if (/(full\s*name|first\s*name|last\s*name|given\s*name|family\s*name|company|business|organization|address|street|country|state|province|region|city|zip|postal|ein|tax|loan|amount|ssn|driver|birth|dob|姓名|名字|姓氏|公司|地址|城市|邮编|国家|省|州|税号|贷款)/i.test(text)) score += 64;
  if (/(phone|mobile|tel|email|e-mail|mail|电话|手机|邮箱|邮件)/i.test(text)) score += 30;
  if (/(name|contact|applicant|owner|principal|联系人|申请人|负责人)/i.test(text)) score += 20;

  if (/(name|given-name|family-name|organization|street-address|address-line1|address-line2|country|address-level1|address-level2|postal-code|tel)/i.test(autocomplete)) score += 44;
  if (autocomplete === 'email' || type === 'email') score += 12;
  if (/(username|current-password|new-password)/i.test(autocomplete)) score -= 30;
  if (/(password|current password|new password|confirm password)/i.test(normalizedText)) score -= 90;
  if (/(quote|lead|checkout|loan|insurance|shipping|billing|vehicle|company|business|profile)/i.test(document.body?.innerText.slice(0, 5000) ?? '')) score += 18;

  if (/(register|registration|sign\s*up|create\s+account|application|apply|contact|address|profile|affiliate|注册|申请|资料|联系)/i.test(document.body?.innerText.slice(0, 5000) ?? '')) score += 22;

  const rect = control.getBoundingClientRect();
  score -= Math.min(18, Math.max(0, rect.top) / 260);
  return score;
}

function getFillProfileInlineAnchor(): HTMLInputElement | null {
  const controls = getAllFillControls(document).filter((control) => !(control instanceof HTMLInputElement && isPasswordInput(control)));
  if (controls.length < 2) return null;

  const candidates = controls
    .map((control) => ({ control, score: scoreFillProfileInlineAnchor(control) }))
    .filter((item) => item.control instanceof HTMLInputElement && item.score >= 38)
    .sort((left, right) => right.score - left.score);

  return (candidates[0]?.control as HTMLInputElement | undefined) ?? null;
}

function getInlineAnchor(): HTMLInputElement | null {
  const fillAnchor = getFillProfileInlineAnchor();
  const loginAnchor = getInlineLoginAnchor();

  if (fillAnchor && (pageLooksLikeRegistration() || !loginAnchor)) {
    return fillAnchor;
  }

  return loginAnchor ?? fillAnchor;
}

function hasInlineVisibleItems(): boolean {
  return inlineMatches.length > 0 || inlineFillProfiles.length > 0;
}

function hasInlineContextualItems(): boolean {
  const loginAnchor = getInlineLoginAnchor();
  const fillAnchor = getFillProfileInlineAnchor();

  return Boolean((loginAnchor && inlineMatches.length > 0) || (fillAnchor && inlineFillProfiles.length > 0));
}

function hideInlineWidget() {
  inlineMenuOpen = false;
  inlineMoreCredentialId = null;
  inlineMoreProfileId = null;
  if (inlineHost) inlineHost.style.display = 'none';
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char] ?? char);
}

function getInlineInitial(match: InlineCredentialSummary): string {
  return (match.title || match.domain || match.username || 'K').slice(0, 1).toUpperCase();
}

function getRuntimeAssetUrl(path: string): string {
  try {
    return chrome.runtime.getURL(path);
  } catch {
    return '';
  }
}

function floatingPositionKey(kind: FloatingIconKind): string {
  const host = window.location.hostname.replace(/^www\./i, '').toLowerCase() || 'local';
  return `keypilot:floating:${kind}:${host}`;
}

function normalizeFloatingPosition(value: unknown): FloatingIconPosition | null {
  if (!value || typeof value !== 'object') return null;

  const maybePosition = value as Partial<FloatingIconPosition>;
  const x = Number(maybePosition.x);
  const y = Number(maybePosition.y);

  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;

  return {
    x,
    y
  };
}

function clampFloatingPosition(position: FloatingIconPosition, width = 34, height = 34): FloatingIconPosition {
  const margin = 8;
  const maxX = Math.max(margin, window.innerWidth - width - margin);
  const maxY = Math.max(margin, window.innerHeight - height - margin);

  return {
    x: Math.max(margin, Math.min(maxX, position.x)),
    y: Math.max(margin, Math.min(maxY, position.y))
  };
}

function loadFloatingIconPositions() {
  try {
    const storage = chrome.storage?.local;
    if (!storage?.get) return;

    const inlineKey = floatingPositionKey('inline-login');
    const generatorKey = floatingPositionKey('password-generator');

    storage.get([inlineKey, generatorKey], (result) => {
      if (chrome.runtime.lastError) return;

      inlineManualPosition = normalizeFloatingPosition(result?.[inlineKey]);
      passwordGeneratorManualPosition = normalizeFloatingPosition(result?.[generatorKey]);
      renderInlineWidget();
      positionInlineWidget();
      renderPasswordGeneratorWidget();
      positionPasswordGeneratorWidget();
    });
  } catch {
    // Optional persistence should never block page interaction.
  }
}

function saveFloatingIconPosition(kind: FloatingIconKind, position: FloatingIconPosition | null) {
  try {
    const storage = chrome.storage?.local;
    if (!storage?.set || !storage?.remove) return;

    const key = floatingPositionKey(kind);

    if (!position) {
      storage.remove(key);
      return;
    }

    storage.set({ [key]: clampFloatingPosition(position) });
  } catch {
    // Optional persistence should never block page interaction.
  }
}

function beginFloatingIconDrag(
  event: PointerEvent,
  target: HTMLElement,
  options: {
    width?: number;
    height?: number;
    onStart: () => void;
    onMove: (position: FloatingIconPosition) => void;
    onEnd: (position: FloatingIconPosition) => void;
    suppressClick: () => void;
  }
) {
  if (event.button !== 0) return;

  const rect = target.getBoundingClientRect();
  const offsetX = event.clientX - rect.left;
  const offsetY = event.clientY - rect.top;
  const startX = event.clientX;
  const startY = event.clientY;
  let dragging = false;
  let lastPosition = clampFloatingPosition({ x: rect.left, y: rect.top }, options.width, options.height);

  const move = (moveEvent: PointerEvent) => {
    const dx = moveEvent.clientX - startX;
    const dy = moveEvent.clientY - startY;

    if (!dragging && Math.hypot(dx, dy) < 6) {
      return;
    }

    if (!dragging) {
      dragging = true;
      options.suppressClick();
      options.onStart();
      document.documentElement.style.userSelect = 'none';
      target.style.cursor = 'grabbing';
    }

    moveEvent.preventDefault();
    moveEvent.stopPropagation();

    lastPosition = clampFloatingPosition(
      {
        x: moveEvent.clientX - offsetX,
        y: moveEvent.clientY - offsetY
      },
      options.width,
      options.height
    );
    options.onMove(lastPosition);
  };

  const finish = () => {
    window.removeEventListener('pointermove', move, true);
    window.removeEventListener('pointerup', finish, true);
    window.removeEventListener('pointercancel', finish, true);
    document.documentElement.style.userSelect = '';
    target.style.cursor = 'grab';

    if (dragging) {
      options.suppressClick();
      options.onEnd(lastPosition);
    }
  };

  window.addEventListener('pointermove', move, true);
  window.addEventListener('pointerup', finish, true);
  window.addEventListener('pointercancel', finish, true);
}

function isInteractiveDragTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest('button, input, select, textarea, a, [role="button"]'));
}

function beginFloatingSurfaceDrag(
  event: PointerEvent,
  handle: HTMLElement,
  surface: HTMLElement,
  options: {
    width?: number;
    height?: number;
    onStart: () => void;
    onMove: (position: FloatingIconPosition) => void;
    onEnd: (position: FloatingIconPosition) => void;
    suppressClick: () => void;
  }
) {
  if (event.button !== 0 || isInteractiveDragTarget(event.target)) return;

  const rect = surface.getBoundingClientRect();
  const width = options.width ?? rect.width;
  const height = options.height ?? rect.height;
  const offsetX = event.clientX - rect.left;
  const offsetY = event.clientY - rect.top;
  const startX = event.clientX;
  const startY = event.clientY;
  let dragging = false;
  let lastPosition = clampFloatingPosition({ x: rect.left, y: rect.top }, width, height);

  const move = (moveEvent: PointerEvent) => {
    const dx = moveEvent.clientX - startX;
    const dy = moveEvent.clientY - startY;

    if (!dragging && Math.hypot(dx, dy) < 5) {
      return;
    }

    if (!dragging) {
      dragging = true;
      options.suppressClick();
      options.onStart();
      document.documentElement.style.userSelect = 'none';
      handle.style.cursor = 'grabbing';
    }

    moveEvent.preventDefault();
    moveEvent.stopPropagation();

    lastPosition = clampFloatingPosition(
      {
        x: moveEvent.clientX - offsetX,
        y: moveEvent.clientY - offsetY
      },
      width,
      height
    );
    options.onMove(lastPosition);
  };

  const finish = () => {
    window.removeEventListener('pointermove', move, true);
    window.removeEventListener('pointerup', finish, true);
    window.removeEventListener('pointercancel', finish, true);
    document.documentElement.style.userSelect = '';
    handle.style.cursor = '';

    if (dragging) {
      options.suppressClick();
      options.onEnd(lastPosition);
    }
  };

  window.addEventListener('pointermove', move, true);
  window.addEventListener('pointerup', finish, true);
  window.addEventListener('pointercancel', finish, true);
}

function disableNativeDragGhost(root: ParentNode | null) {
  if (!root) return;

  root.querySelectorAll<Element>('img, svg').forEach((element) => {
    element.setAttribute('draggable', 'false');
    if (element instanceof HTMLImageElement) {
      element.draggable = false;
    }
    element.addEventListener('dragstart', (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
  });
}

function renderDefaultInlineIcon(): string {
  const iconUrl = getRuntimeAssetUrl('icons/default-site-32.png');
  if (iconUrl) {
    return `<img class="default-site-icon" src="${escapeHtml(iconUrl)}" alt="" draggable="false" />`;
  }

  return `
    <svg class="default-site-icon" viewBox="0 0 64 64" aria-hidden="true">
      <rect x="2" y="2" width="60" height="60" rx="14" fill="#EAF2FF"/>
      <rect x="2.5" y="2.5" width="59" height="59" rx="13.5" fill="none" stroke="#BBD2FF"/>
      <path d="M32 13.5 45 18v10.5c0 12.4-7.1 20.7-13 23.5-5.9-2.8-13-11.1-13-23.5V18l13-4.5Z" fill="#2563EB"/>
      <path d="M32 21 38.5 23.3v5.6c0 6-3 10.3-6.5 12.3-3.5-2-6.5-6.3-6.5-12.3v-5.6L32 21Z" fill="#FFFFFF" opacity=".96"/>
      <circle cx="32" cy="29" r="3.5" fill="#2563EB"/>
      <path d="M30.5 32h3l1 7h-5l1-7Z" fill="#2563EB"/>
    </svg>
  `;
}

function inlineErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || '');

  if (message === 'VAULT_LOCKED') return 'KeyPilot 已锁定，请先打开插件解锁。';
  if (message === 'NO_MATCHING_CREDENTIAL') return '当前网页没有匹配的账号。';
  if (message === 'NO_LOGIN_FORM') return '没有检测到登录表单。';
  if (message === 'NO_USERNAME_FIELD') return '没有检测到用户名输入框。';
  if (message === 'NO_PASSWORD_FIELD') return '没有检测到密码输入框。';
  if (message === 'NO_FILL_PROFILE_FIELDS') return '当前页面没有匹配到身份资料字段。';
  if (message === 'FILL_BINDING_START_FAILED') return '无法启动身份字段绑定，请刷新页面后重试。';
  if (message === 'BINDING_DOMAIN_MISMATCH') return '当前网页和账号域名不匹配，不能保存绑定。';
  if (message === 'INVALID_BINDING') return '绑定信息不完整，请重新选择字段。';
  if (message.includes('Receiving end does not exist')) return '页面脚本未就绪，请刷新网页后重试。';

  return message || '快捷填充失败，请稍后重试。';
}

function ensureInlineWidget() {
  if (inlineHost && inlineRoot) return;

  inlineHost = document.createElement('div');
  inlineHost.id = 'keypilot-inline-root';
  inlineHost.setAttribute('aria-hidden', 'false');
  inlineHost.style.position = 'fixed';
  inlineHost.style.zIndex = '2147483646';
  inlineHost.style.display = 'none';
  inlineHost.style.width = `${INLINE_MENU_WIDTH}px`;
  inlineHost.style.pointerEvents = 'none';
  inlineHost.style.colorScheme = 'light';
  inlineRoot = inlineHost.attachShadow({ mode: 'open' });
  document.documentElement.appendChild(inlineHost);
}

function isKeyPilotOwnedNode(node: Node): boolean {
  const element = node instanceof Element ? node : node.parentElement;
  return Boolean(
    element?.closest(
      '#keypilot-inline-root, #keypilot-inline-editor-root, #keypilot-password-generator-root, #keypilot-recognition-debug-root, [data-keypilot-password-inline-trigger]'
    )
  );
}

function shouldIgnoreKeyPilotMutations(mutations: MutationRecord[]): boolean {
  return mutations.length > 0 && mutations.every((mutation) => {
    if (isKeyPilotOwnedNode(mutation.target)) return true;

    const changedNodes = [...Array.from(mutation.addedNodes), ...Array.from(mutation.removedNodes)];
    return changedNodes.length > 0 && changedNodes.every(isKeyPilotOwnedNode);
  });
}

function cancelInlineHoverFill() {
  if (inlineHoverFillTimer) {
    window.clearTimeout(inlineHoverFillTimer);
    inlineHoverFillTimer = null;
  }
}

function cancelInlineHoverOpen() {
  if (inlineHoverOpenTimer) {
    window.clearTimeout(inlineHoverOpenTimer);
    inlineHoverOpenTimer = null;
  }
}

function cancelInlineHoverClose() {
  if (inlineHoverCloseTimer) {
    window.clearTimeout(inlineHoverCloseTimer);
    inlineHoverCloseTimer = null;
  }
}

function openInlineMenuFromHover() {
  if (Date.now() < inlineDragSuppressClickUntil || inlineSuppressed) return;
  if (inlineStateLoaded && !hasInlineContextualItems()) {
    hideInlineWidget();
    return;
  }

  cancelInlineHoverClose();
  cancelInlineHoverOpen();

  if (inlineMenuOpen) {
    suppressInlineRefreshFor(260);
    return;
  }

  inlineMenuOpen = true;
  inlineMoreCredentialId = null;
  inlineMoreProfileId = null;
  inlineSearchNeedsFocus = false;
  if (!inlineMatches.length && !inlineFillProfiles.length) {
    inlineStatus = '正在读取 KeyPilot 状态...';
  }
  suppressInlineRefreshFor(220);
  renderInlineWidget();
  positionInlineWidget();

  window.setTimeout(() => {
    if (!inlineMenuOpen || inlineSuppressed) return;
    scheduleInlineRefresh(0);
  }, 260);
}

function closeInlineMenuFromHover() {
  cancelInlineHoverOpen();
  cancelInlineHoverClose();

  inlineHoverCloseTimer = window.setTimeout(() => {
    inlineHoverCloseTimer = null;
    inlineMenuOpen = false;
    inlineStatus = '';
    inlineFilterQuery = '';
    inlineMoreCredentialId = null;
    inlineMoreProfileId = null;
    cancelInlineHoverFill();
    renderInlineWidget();
    positionInlineWidget();
  }, 360);
}

function suppressInlineRefreshFor(durationMs: number) {
  inlineRefreshSuppressedUntil = Math.max(inlineRefreshSuppressedUntil, Date.now() + durationMs);

  if (inlineRefreshTimer) {
    window.clearTimeout(inlineRefreshTimer);
    inlineRefreshTimer = null;
  }
}

function scheduleInlineHoverAction(key: string, action: () => void, delay = 300) {
  if (inlineLocked) return;

  const now = Date.now();
  if (inlineLastHoverFilledId === key && now - inlineLastHoverFilledAt < 2200) {
    return;
  }

  cancelInlineHoverFill();
  inlineHoverFillTimer = window.setTimeout(() => {
    inlineHoverFillTimer = null;
    inlineLastHoverFilledId = key;
    inlineLastHoverFilledAt = Date.now();
    action();
  }, delay);
}

function scheduleInlineHoverFill(credentialId: string) {
  scheduleInlineHoverAction(`credential:${credentialId}`, () => {
    suppressInlineRefreshFor(1600);
    void handleInlineFill(credentialId, 'fill', true);
  }, 480);
}

function scheduleInlineProfileHoverFill(profileId: string) {
  scheduleInlineHoverAction(`profile:${profileId}`, () => {
    suppressInlineRefreshFor(1600);
    void handleInlineFillProfile(profileId, true, false);
  }, 480);
}

function renderInlineMoreMenu(match: InlineCredentialSummary): string {
  return `
    <div class="more-popover" role="menu" aria-label="${escapeHtml(match.title || match.domain)} 更多选项">
      <button class="command primary" type="button" data-action="login" data-id="${escapeHtml(match.id)}">
        <span>${inlineCommandIcon('login')}</span><strong>填写并提交</strong>
      </button>
      <button class="command" type="button" data-action="fill" data-id="${escapeHtml(match.id)}">
        <span>${inlineCommandIcon('fill')}</span><strong>填表</strong>
      </button>
      <button class="command" type="button" data-action="edit" data-id="${escapeHtml(match.id)}">
        <span>${inlineCommandIcon('edit')}</span><strong>编辑</strong>
      </button>
      <button class="command" type="button" data-action="rename" data-id="${escapeHtml(match.id)}">
        <span>${inlineCommandIcon('rename')}</span><strong>重命名</strong>
      </button>
      <button class="command danger" type="button" data-action="delete" data-id="${escapeHtml(match.id)}">
        <span>${inlineCommandIcon('delete')}</span><strong>删除</strong>
      </button>
      <hr />
      <button class="command" type="button" data-action="goto" data-id="${escapeHtml(match.id)}">
        <span>${inlineCommandIcon('home')}</span><strong>打开起始页</strong>
      </button>
      <button class="command" type="button" data-action="hide-domain" data-id="${escapeHtml(match.id)}">
        <span>${inlineCommandIcon('hide')}</span><strong>不在此域中显示</strong>
      </button>
    </div>
  `;
}

function inlineCommandIcon(kind: 'login' | 'fill' | 'bind' | 'edit' | 'rename' | 'delete' | 'home' | 'hide'): string {
  const icons: Record<typeof kind, string> = {
    login: '<path d="M8 12h8m0 0-3-3m3 3-3 3M5 4h6a2 2 0 0 1 2 2v1M13 17v1a2 2 0 0 1-2 2H5" />',
    fill: '<rect x="5" y="4" width="14" height="16" rx="2" /><path d="M8 8h8M8 12h8M8 16h5" />',
    bind: '<path d="M7 7h4v4H7zM13 13h4v4h-4zM11 9h4M9 11v4" />',
    edit: '<path d="m5 16-.8 3.8L8 19l9.8-9.8a2 2 0 0 0-2.8-2.8L5 16Z" /><path d="m14 7 3 3" />',
    rename: '<path d="M5 7h8M5 12h12M5 17h8" /><path d="M16 6v12" />',
    delete: '<path d="M5 7h14M10 11v6M14 11v6M8 7l1-3h6l1 3M7 7l1 13h8l1-13" />',
    home: '<path d="M4 11.5 12 5l8 6.5" /><path d="M6.5 10.5V19h11v-8.5" />',
    hide: '<path d="M5 5 19 19" /><path d="M10.8 10.8A2 2 0 0 0 13.2 13.2" /><path d="M8.6 8.7C6.8 9.6 5.4 11 4.5 12c1.6 2 4.2 4 7.5 4 1.1 0 2.1-.2 3-.7M12 8c3.3 0 5.9 2 7.5 4-.4.5-.8 1-1.3 1.4" />'
  };

  return `<svg viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${icons[kind]}</g></svg>`;
}

function renderInlineAccountLockIcon(): string {
  return `
    <svg class="credential-lock-icon" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="5.5" y="10" width="13" height="9" rx="2" />
      <path d="M8 10V7.8A4 4 0 0 1 12 4a4 4 0 0 1 4 3.8V10" />
      <path d="M8.7 14.5h.01M12 14.5h.01M15.3 14.5h.01" />
    </svg>
  `;
}

function renderInlineAccount(match: InlineCredentialSummary): string {
  const isMoreOpen = inlineMoreCredentialId === match.id;
  const title = match.title || match.domain || match.username || '未命名账号';

  return `
    <article class="account${isMoreOpen ? ' more-open' : ''}" data-account-id="${escapeHtml(match.id)}">
      <button class="account-main" type="button" data-action="login" data-id="${escapeHtml(match.id)}" aria-label="使用 ${escapeHtml(title)} 登录">
        <span class="mark credential-mark">${renderInlineAccountLockIcon()}</span>
        <span class="text">
          <strong>${escapeHtml(title)}</strong>
          <small>${escapeHtml(match.username || '无用户名')}</small>
        </span>
      </button>
      <button class="more-button" type="button" data-action="more" data-id="${escapeHtml(match.id)}" aria-label="更多选项">⋮</button>
      ${isMoreOpen ? renderInlineMoreMenu(match) : ''}
    </article>
  `;
}

function inlineProfileCategoryLabel(category: InlineFillProfileSummary['category']): string {
  if (category === 'auto_insurance') return '车险';
  if (category === 'business') return '公司';
  if (category === 'loan') return '贷款';
  if (category === 'payment') return '付款';
  if (category === 'shipping' || category === 'billing') return '地址';
  if (category === 'identity') return '身份';
  return '资料';
}

function inlineStableHash(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function getInlineProfileInitial(profile: InlineFillProfileSummary): string {
  if (profile.category === 'auto_insurance') {
    return '车';
  }

  const label = inlineProfileCategoryLabel(profile.category);
  return label.slice(0, 1).toUpperCase();
}

function inlineSearchNeedle(value: string): string {
  return value.trim().toLowerCase();
}

function inlineAccountSearchText(match: InlineCredentialSummary): string {
  return [match.title, match.username, match.domain, match.url, match.matchUrl].filter(Boolean).join(' ').toLowerCase();
}

function inlineProfileSearchText(profile: InlineFillProfileSummary): string {
  return [
    profile.title,
    profile.countryCode,
    inlineProfileCategoryLabel(profile.category),
    profile.summary,
    ...profile.fields.flatMap((field) => [field.label, field.value, field.sourceColumn ?? ''])
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function filterInlineAccounts(matches: InlineCredentialSummary[], query: string): InlineCredentialSummary[] {
  const needle = inlineSearchNeedle(query);
  if (!needle) return matches;
  return matches.filter((match) => inlineAccountSearchText(match).includes(needle));
}

function filterInlineProfiles(profiles: InlineFillProfileSummary[], query: string): InlineFillProfileSummary[] {
  const needle = inlineSearchNeedle(query);
  if (!needle) return profiles;
  return profiles.filter((profile) => inlineProfileSearchText(profile).includes(needle));
}

function compareInlineProfileTitle(left: InlineFillProfileSummary, right: InlineFillProfileSummary): number {
  return left.title.localeCompare(right.title, undefined, { numeric: true, sensitivity: 'base' });
}

function inlineProfileTone(profile: InlineFillProfileSummary): string {
  if (profile.category === 'auto_insurance') {
    const tones = ['tone-green', 'tone-blue', 'tone-purple', 'tone-amber', 'tone-rose'] as const;
    return tones[inlineStableHash(`${profile.id}:${profile.title}:${profile.summary}`) % tones.length];
  }
  if (profile.category === 'business') return 'business';
  if (profile.category === 'loan') return 'loan';
  if (profile.category === 'payment') return 'payment';
  return 'identity';
}

function renderInlineProfileMoreMenu(profile: InlineFillProfileSummary): string {
  return `
    <div class="more-popover profile-popover" role="menu" aria-label="${escapeHtml(profile.title)} 更多选项">
      <button class="command primary" type="button" data-action="fill-profile" data-id="${escapeHtml(profile.id)}" title="使用这条身份资料填写当前表单">
        <span>${inlineCommandIcon('fill')}</span><strong>填表</strong>
      </button>
      <button class="command" type="button" data-action="bind-profile" data-id="${escapeHtml(profile.id)}" title="为这个网站校准身份资料字段">
        <span>${inlineCommandIcon('edit')}</span><strong>编辑</strong>
      </button>
      <button class="command" type="button" data-action="rename-profile" data-id="${escapeHtml(profile.id)}">
        <span>${inlineCommandIcon('rename')}</span><strong>重命名</strong>
      </button>
      <button class="command danger" type="button" data-action="delete-profile" data-id="${escapeHtml(profile.id)}">
        <span>${inlineCommandIcon('delete')}</span><strong>删除</strong>
      </button>
      <hr />
      <button class="command" type="button" data-action="profile-home" data-id="${escapeHtml(profile.id)}">
        <span>${inlineCommandIcon('home')}</span><strong>打开起始页</strong>
      </button>
      <button class="command" type="button" data-action="hide-domain" data-id="${escapeHtml(profile.id)}">
        <span>${inlineCommandIcon('hide')}</span><strong>不在此域中显示</strong>
      </button>
    </div>
  `;
}

function renderInlineFillProfile(profile: InlineFillProfileSummary): string {
  const category = inlineProfileCategoryLabel(profile.category);
  const summary = profile.summary || `${profile.fieldCount} 个字段`;
  const isMoreOpen = inlineMoreProfileId === profile.id;

  return `
    <article class="account profile ${escapeHtml(inlineProfileTone(profile))}${isMoreOpen ? ' more-open' : ''}" data-profile-id="${escapeHtml(profile.id)}">
      <button class="account-main" type="button" data-action="fill-profile" data-id="${escapeHtml(profile.id)}" aria-label="填写 ${escapeHtml(profile.title)}">
        <span class="mark profile-mark">${escapeHtml(getInlineProfileInitial(profile))}</span>
        <span class="text">
          <strong>${escapeHtml(profile.title || '未命名资料')}</strong>
          <small>${escapeHtml(`${category} · ${summary}`)}</small>
        </span>
      </button>
      <button class="more-button" type="button" data-action="profile-more" data-id="${escapeHtml(profile.id)}" aria-label="更多选项" title="更多选项">⋮</button>
      ${isMoreOpen ? renderInlineProfileMoreMenu(profile) : ''}
    </article>
  `;
}

function renderInlineWidget() {
  ensureInlineWidget();

  if (!inlineRoot) return;

  const query = inlineFilterQuery.trim();
  const filteredAccounts = filterInlineAccounts(inlineMatches, query);
  const filteredProfiles = filterInlineProfiles(inlineFillProfiles, query);
  const shouldShowProfiles = filteredAccounts.length === 0 || Boolean(query);
  const visibleProfiles = shouldShowProfiles ? filteredProfiles : [];
  const recentProfiles = query
    ? []
    : visibleProfiles
        .filter((profile) => Boolean(profile.lastUsedAt))
        .sort((left, right) => (right.lastUsedAt ?? 0) - (left.lastUsedAt ?? 0))
        .slice(0, 6);
  const recentProfileIds = new Set(recentProfiles.map((profile) => profile.id));
  const otherProfiles = visibleProfiles
    .filter((profile) => !recentProfileIds.has(profile.id))
    .sort(compareInlineProfileTitle);
  const accountContent = filteredAccounts.length ? filteredAccounts.map(renderInlineAccount).join('') : '';
  const recentProfileContent = recentProfiles.length ? recentProfiles.map(renderInlineFillProfile).join('') : '';
  const otherProfileContent = otherProfiles.length ? otherProfiles.map(renderInlineFillProfile).join('') : '';
  const rawHasContent = inlineMatches.length > 0 || inlineFillProfiles.length > 0;
  const hasAccountContent = filteredAccounts.length > 0;
  const hasProfileContent = visibleProfiles.length > 0;
  const hasAnyContent = hasAccountContent || hasProfileContent;
  const showSearchBox = rawHasContent && (Boolean(query) || !hasAccountContent);
  const menuContent = hasAnyContent
    ? `
      ${hasAccountContent ? `<div class="section-title">登录账号</div>${accountContent}` : ''}
      ${recentProfileContent ? `<div class="section-title">最近使用的身份信息</div>${recentProfileContent}` : ''}
      ${otherProfileContent ? `<div class="section-title">${recentProfileContent ? '其他身份信息（A-Z 排序）' : '身份资料'}</div>${otherProfileContent}` : ''}
    `
    : `
      <div class="empty">
        <strong>${rawHasContent ? '没有匹配结果' : inlineLocked ? 'KeyPilot 已锁定' : '没有可用资料'}</strong>
        <p>${rawHasContent ? '换个关键词试试，可以搜索名称、邮箱、电话、公司或资料编号。' : inlineLocked ? '请先点击浏览器工具栏里的 KeyPilot 解锁 Vault。' : '当前页面没有匹配账号或身份资料。'}</p>
        <button type="button" data-action="refresh">刷新状态</button>
      </div>
    `;
  const searchBox = showSearchBox
    ? `
      <label class="inline-search" aria-label="搜索账号或身份资料">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="m21 21-4.3-4.3M10.8 18a7.2 7.2 0 1 1 0-14.4 7.2 7.2 0 0 1 0 14.4Z" />
        </svg>
        <input data-inline-search type="search" value="${escapeHtml(inlineFilterQuery)}" placeholder="搜索账号、身份资料" autocomplete="off" />
      </label>
    `
    : '';
  const menu = inlineMenuOpen ? `
    <section class="menu" role="menu" aria-label="KeyPilot 快捷登录">
      ${searchBox}
      <div class="accounts">
        ${menuContent}
      </div>
      <footer>
        <button class="footer-home" type="button" data-action="vault-home" aria-label="打开 KeyPilot 首页">
          ${inlineCommandIcon('home')}
        </button>
        <button class="footer-report" type="button" data-action="report">报告自动填充问题</button>
      </footer>
      ${inlineStatus ? `<p class="status">${escapeHtml(inlineStatus)}</p>` : ''}
    </section>
  ` : '';
  const shellClass = `inline-shell${inlineManualPosition ? ' manual' : ''}${inlineMenuOpen ? ' open' : ''}`;

  inlineRoot.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; }
      button { font: inherit; }
      .inline-shell {
        position: relative;
        width: ${INLINE_MENU_WIDTH}px;
        min-height: ${INLINE_TRIGGER_SIZE}px;
      }
      .trigger {
        position: absolute;
        top: 0;
        right: ${INLINE_TRIGGER_RIGHT_OFFSET}px;
        display: grid;
        width: ${INLINE_TRIGGER_SIZE}px;
        height: ${INLINE_TRIGGER_SIZE}px;
        place-items: center;
        border: 1px solid #d7dee9;
        border-radius: 8px;
        background: #ffffff;
        color: #2563eb;
        box-shadow: 0 5px 14px rgba(16, 24, 40, 0.14);
        cursor: grab;
        pointer-events: auto;
        touch-action: none;
        user-select: none;
        -webkit-user-drag: none;
      }
      .trigger *,
      .mark * {
        pointer-events: none;
        user-select: none;
        -webkit-user-drag: none;
      }
      .trigger:active { cursor: grabbing; }
      .trigger:hover { background: #f8fbff; }
      .trigger svg { width: 17px; height: 17px; }
      .inline-shell.manual .trigger {
        left: 0;
        right: auto;
      }
      .menu {
        position: absolute;
        top: 35px;
        right: 0;
        width: ${INLINE_MENU_WIDTH}px;
        overflow: hidden;
        border: 1px solid #d7dde7;
        border-radius: 7px;
        background: #ffffff;
        box-shadow: 0 6px 18px rgba(15, 23, 42, 0.18);
        color: #0f172a;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
        pointer-events: auto;
        animation: inline-menu-in 110ms ease-out both;
      }
      .inline-shell.manual .menu {
        left: 0;
        right: auto;
      }
      header {
        display: grid;
        grid-template-columns: 24px minmax(0, 1fr) 28px;
        align-items: center;
        gap: 9px;
        min-height: 42px;
        border-bottom: 1px solid #edf2f8;
        padding: 7px 8px;
      }
      header strong {
        overflow: hidden;
        font-size: 13px;
        font-weight: 800;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .icon {
        display: grid;
        width: 28px;
        height: 28px;
        place-items: center;
        border: 0;
        border-radius: 8px;
        background: transparent;
        color: #475467;
        cursor: pointer;
      }
      .icon:hover { background: #f2f6fc; }
      .icon svg { width: 16px; height: 16px; }
      .icon.close-button { color: #667085; }
      .icon.close-button:hover { color: #344054; }
      .inline-search {
        display: grid;
        grid-template-columns: 18px minmax(0, 1fr);
        align-items: center;
        gap: 8px;
        margin: 7px;
        min-height: 34px;
        border: 1px solid #dbe5f1;
        border-radius: 8px;
        background: #f8fafc;
        color: #64748b;
        padding: 0 10px;
      }
      .inline-search:focus-within {
        border-color: #9bbcff;
        background: #ffffff;
        box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.12);
      }
      .inline-search svg {
        width: 16px;
        height: 16px;
        fill: none;
        stroke: currentColor;
        stroke-width: 2;
        stroke-linecap: round;
        stroke-linejoin: round;
      }
      .inline-search input {
        width: 100%;
        min-width: 0;
        border: 0;
        outline: 0;
        background: transparent;
        color: #0f172a;
        font: inherit;
        font-size: 12px;
        line-height: 1.3;
      }
      .inline-search input::placeholder { color: #73839b; }
      .accounts {
        display: grid;
        max-height: min(${INLINE_MENU_MAX_HEIGHT}px, calc(100vh - 142px));
        overflow-x: hidden;
        overflow-y: auto;
        overscroll-behavior: contain;
        scrollbar-color: #aab7c8 transparent;
        scrollbar-width: thin;
      }
      .accounts::-webkit-scrollbar { width: 9px; }
      .accounts::-webkit-scrollbar-track { background: transparent; }
      .accounts::-webkit-scrollbar-thumb {
        border: 3px solid #ffffff;
        border-radius: 999px;
        background: #aab7c8;
      }
      .section-title {
        border-bottom: 1px solid #edf2f8;
        background: #f4f6f9;
        color: #667085;
        padding: 5px 10px;
        font-size: 12px;
        font-weight: 650;
        letter-spacing: 0;
      }
      .empty {
        display: grid;
        gap: 7px;
        padding: 12px;
      }
      .empty strong {
        color: #101828;
        font-size: 13px;
        font-weight: 820;
      }
      .empty p {
        margin: 0;
        color: #667085;
        font-size: 12px;
        line-height: 1.45;
      }
      .empty button {
        justify-self: start;
        min-height: 30px;
        border: 1px solid #dfe7f3;
        border-radius: 8px;
        padding: 0 10px;
        background: #ffffff;
        color: #2563eb;
        cursor: pointer;
        font-size: 12px;
        font-weight: 760;
      }
      .account {
        position: relative;
        display: grid;
        grid-template-columns: minmax(0, 1fr) 30px;
        align-items: center;
        gap: 2px;
        min-height: 42px;
        border-bottom: 1px solid #edf2f8;
        padding: 0 6px 0 10px;
        transition: background 120ms ease-out;
      }
      .account:hover,
      .account.more-open { background: #edf4ff; }
      .account-main {
        display: grid;
        grid-template-columns: 22px minmax(0, 1fr);
        align-items: center;
        gap: 10px;
        width: 100%;
        border: 0;
        padding: 0;
        background: transparent;
        color: inherit;
        cursor: pointer;
        text-align: left;
      }
      .more-button {
        position: relative;
        z-index: 2;
        display: grid;
        width: 30px;
        height: 30px;
        place-items: center;
        border: 0;
        border-radius: 999px;
        background: transparent;
        color: #5f6f86;
        cursor: pointer;
        font-size: 20px;
        font-weight: 700;
        line-height: 1;
        transition: background 120ms ease-out, color 120ms ease-out, transform 120ms ease-out;
      }
      .more-button:hover,
      .account.more-open .more-button {
        background: #e1e7ef;
        color: #26364c;
      }
      .more-button:active { transform: translateY(1px); }
      .more-button svg {
        width: 17px;
        height: 17px;
      }
      .profile-bind-button {
        color: #64748b;
      }
      .text { min-width: 0; }
      .text strong,
      .text small {
        display: block;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .text strong {
        color: #0f172a;
        font-size: 13.5px;
        font-weight: 560;
        line-height: 1.25;
        letter-spacing: 0;
      }
      .text small {
        margin-top: 3px;
        color: #58677f;
        font-size: 11px;
        line-height: 1.25;
      }
      .account:not(.profile) .text small {
        display: none;
      }
      .account:not(.profile) .account-main {
        min-height: 42px;
      }
      .more-popover {
        position: fixed;
        z-index: 2147483647;
        top: var(--keypilot-more-top, 0);
        left: var(--keypilot-more-left, 0);
        display: grid;
        width: max-content;
        min-width: 176px;
        max-width: min(226px, calc(100vw - 16px));
        overflow: hidden;
        border: 1px solid #d5dbe4;
        border-radius: 4px;
        background: #ffffff;
        box-shadow: 0 7px 18px rgba(15, 23, 42, 0.18);
        padding: 4px 0;
        animation: more-popover-in 110ms ease-out both;
      }
      .more-popover::before {
        content: none;
      }
      .more-popover hr {
        width: 100%;
        height: 1px;
        margin: 4px 0;
        border: 0;
        background: #e7eaf0;
      }
      @keyframes more-popover-in {
        from { opacity: 0; transform: translateX(-3px) scale(.985); }
        to { opacity: 1; transform: translateX(0) scale(1); }
      }
      @media (prefers-reduced-motion: reduce) {
        .more-popover { animation: none; }
      }
      .command {
        display: grid;
        grid-template-columns: 22px minmax(0, 1fr);
        align-items: center;
        gap: 12px;
        min-height: 38px;
        border: 0;
        border-radius: 0;
        background: transparent;
        color: #1f2937;
        cursor: pointer;
        padding: 0 15px;
        text-align: left;
        transition: background 120ms ease-out, color 120ms ease-out, transform 120ms ease-out;
      }
      .command:hover { background: #f1f5f9; }
      .command:active { transform: translateY(1px); }
      .command span {
        display: grid;
        width: 22px;
        height: 22px;
        place-items: center;
        color: #3f4b5f;
      }
      .command span svg {
        width: 18px;
        height: 18px;
      }
      .command strong {
        overflow: hidden;
        color: inherit;
        font-size: 14px;
        font-weight: 520;
        line-height: 1.2;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .command.primary {
        color: #13923c;
        font-weight: 650;
      }
      .command.primary span { color: #16a34a; }
      .command.primary strong { font-weight: 680; }
      .command.primary:hover { background: #eefbf3; }
      .command.danger { color: #dc2626; }
      .command.danger span { color: #ef4444; }
      .command.danger:hover { background: #fff1f2; }
      .mark {
        position: relative;
        display: grid;
        width: 22px;
        height: 22px;
        place-items: center;
        overflow: hidden;
        border: 1px solid #cfe0ff;
        border-radius: 6px;
        background: #eaf2ff;
        color: #2563eb;
        font-size: 12px;
        font-weight: 850;
      }
      .credential-mark {
        border: 0;
        background: transparent;
        color: #31a24c;
      }
      .credential-lock-icon {
        width: 21px;
        height: 21px;
        fill: #8ddf7d;
        stroke: #2f7d32;
        stroke-width: 1.45;
        stroke-linecap: round;
        stroke-linejoin: round;
      }
      .credential-lock-icon path {
        fill: none;
      }
      .mark .default-site-icon {
        width: 100%;
        height: 100%;
        display: block;
      }
      .profile-mark {
        border-color: #bbf7d0;
        background: #ecfdf3;
        color: #15803d;
      }
      .profile.business .profile-mark { border-color: #c7d2fe; background: #eef2ff; color: #3154c7; }
      .profile.loan .profile-mark { border-color: #fde68a; background: #fffbeb; color: #a16207; }
      .profile.payment .profile-mark { border-color: #fed7aa; background: #fff7ed; color: #c2410c; }
      .profile.identity .profile-mark { border-color: #cfe0ff; background: #eff6ff; color: #2563eb; }
      .profile.tone-green .profile-mark { border-color: #86efac; background: #dcfce7; color: #15803d; }
      .profile.tone-blue .profile-mark { border-color: #bfdbfe; background: #dbeafe; color: #2563eb; }
      .profile.tone-purple .profile-mark { border-color: #c4b5fd; background: #ede9fe; color: #6d4aff; }
      .profile.tone-amber .profile-mark { border-color: #fcd34d; background: #fef3c7; color: #b45309; }
      .profile.tone-rose .profile-mark { border-color: #fda4af; background: #ffe4e6; color: #e11d48; }
      .mark img {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        object-fit: contain;
        padding: 3px;
        background: #ffffff;
      }
      footer {
        display: grid;
        grid-template-columns: 42px minmax(0, 1fr);
        align-items: center;
        min-height: 38px;
        border-top: 1px solid #edf2f8;
        background: #f7f7f8;
        padding: 0;
      }
      footer button {
        border: 0;
        background: transparent;
        color: #667085;
        cursor: pointer;
        font-size: 12px;
        text-align: center;
      }
      .footer-home {
        display: grid;
        height: 38px;
        place-items: center;
        border-right: 1px solid #dfe3ea;
        color: #475467;
      }
      .footer-home svg {
        width: 21px;
        height: 21px;
      }
      .footer-report {
        height: 38px;
        color: #8a94a3;
        text-decoration: underline;
        text-underline-offset: 2px;
      }
      .status {
        margin: 0;
        border-top: 1px solid #edf2f8;
        background: #f8fafc;
        padding: 7px 8px;
        color: #2563eb;
        font-size: 12px;
        line-height: 1.4;
      }
      @keyframes inline-menu-in {
        from { opacity: 0; }
        to { opacity: 1; }
      }
      @media (prefers-reduced-motion: reduce) {
        .menu { animation: none; }
        .account,
        .more-button,
        .command { transition: none; }
      }
    </style>
    <div class="${shellClass}">
      <button class="trigger" type="button" data-action="toggle" aria-label="打开 KeyPilot 快捷登录">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path fill="currentColor" d="M12 2.5 19 5v5.3c0 5.1-2.9 8.5-7 10.2-4.1-1.7-7-5.1-7-10.2V5l7-2.5Z"/>
          <path fill="#fff" d="m10.8 14.6-3-3 1.5-1.5 1.5 1.5 3.9-3.9 1.5 1.5-5.4 5.4Z"/>
        </svg>
      </button>
      ${menu}
    </div>
  `;

  disableNativeDragGhost(inlineRoot);

  inlineRoot.querySelectorAll<HTMLImageElement>('img[data-fallback]').forEach((image) => {
    const tryNextIcon = () => {
      const nextIcon = image.dataset.nextIcon;
      if (nextIcon && image.src !== nextIcon) {
        image.dataset.nextIcon = '';
        image.src = nextIcon;
        return;
      }

      image.remove();
    };

    image.addEventListener('load', () => {
      if (image.naturalWidth <= 1 && image.naturalHeight <= 1) {
        tryNextIcon();
      }
    });

    image.addEventListener('error', () => {
      tryNextIcon();
    });
  });

  const searchInput = inlineRoot.querySelector<HTMLInputElement>('[data-inline-search]');
  if (searchInput) {
    searchInput.addEventListener('click', (event) => event.stopPropagation());
    searchInput.addEventListener('keydown', (event) => event.stopPropagation());
    searchInput.addEventListener('input', () => {
      inlineFilterQuery = searchInput.value;
      inlineMoreCredentialId = null;
      inlineMoreProfileId = null;
      inlineSearchNeedsFocus = true;
      renderInlineWidget();
    });

    if (inlineSearchNeedsFocus) {
      searchInput.focus({ preventScroll: true });
      searchInput.setSelectionRange(searchInput.value.length, searchInput.value.length);
      inlineSearchNeedsFocus = false;
    }
  }

  inlineRoot.querySelectorAll<HTMLElement>('[data-action]').forEach((element) => {
    element.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (Date.now() < inlineDragSuppressClickUntil) return;

      const action = element.dataset.action;
      const id = element.dataset.id;

      if (action === 'toggle') {
        inlineMenuOpen = !inlineMenuOpen;
        inlineMoreCredentialId = null;
        inlineMoreProfileId = null;
        if (inlineMenuOpen) {
          inlineSearchNeedsFocus = false;
          scheduleInlineRefresh(0);
        } else {
          inlineFilterQuery = '';
        }
        renderInlineWidget();
        positionInlineWidget();
        return;
      }

      if (action === 'close') {
        inlineMenuOpen = false;
        inlineStatus = '';
        inlineFilterQuery = '';
        inlineMoreCredentialId = null;
        inlineMoreProfileId = null;
        renderInlineWidget();
        positionInlineWidget();
        return;
      }

      if (action === 'report') {
        inlineStatus = '请打开 KeyPilot 弹窗里的当前网站诊断，复现后把诊断结果发给开发者。';
        renderInlineWidget();
        return;
      }

      if (action === 'vault-home') {
        openInlineVaultHome();
        return;
      }

      if (action === 'refresh') {
        inlineStatus = '正在刷新状态...';
        renderInlineWidget();
        scheduleInlineRefresh(0);
        return;
      }

      if (action === 'more' && id) {
        if (Date.now() < inlineMorePointerHandledUntil) return;
        cancelInlineHoverFill();
        suppressInlineRefreshFor(900);
        inlineMoreCredentialId = inlineMoreCredentialId === id ? null : id;
        inlineMoreProfileId = null;
        renderInlineWidget();
        positionInlineWidget();
        return;
      }

      if (action === 'profile-more' && id) {
        if (Date.now() < inlineMorePointerHandledUntil) return;
        cancelInlineHoverFill();
        suppressInlineRefreshFor(900);
        inlineMoreProfileId = inlineMoreProfileId === id ? null : id;
        inlineMoreCredentialId = null;
        renderInlineWidget();
        positionInlineWidget();
        return;
      }

      if ((action === 'login' || action === 'fill') && id) {
        void handleInlineFill(id, action);
        return;
      }

      if (action === 'bind' && id) {
        void handleInlineBind(id);
        return;
      }

      if (action === 'fill-profile' && id) {
        void handleInlineFillProfile(id);
        return;
      }

      if (action === 'bind-profile' && id) {
        void handleInlineBindProfile(id);
        return;
      }

      if (action === 'rename-profile' && id) {
        void handleInlineRenameProfile(id);
        return;
      }

      if (action === 'delete-profile' && id) {
        void handleInlineDeleteProfile(id);
        return;
      }

      if (action === 'profile-home') {
        openInlineProfileHome();
        return;
      }

      if ((action === 'goto' || action === 'edit' || action === 'rename' || action === 'delete' || action === 'hide-domain') && id) {
        void handleInlineCommand(id, action);
      }
    });
  });

  attachInlineDragHandlers();

  inlineRoot.querySelectorAll<HTMLElement>('[data-account-id]').forEach((element) => {
    const id = element.dataset.accountId;
    if (!id) return;

    element.addEventListener('mouseenter', () => scheduleInlineHoverFill(id));
    element.addEventListener('mouseleave', cancelInlineHoverFill);
  });

  inlineRoot.querySelectorAll<HTMLElement>('[data-profile-id]').forEach((element) => {
    const id = element.dataset.profileId;
    if (!id) return;

    element.addEventListener('mouseenter', () => scheduleInlineProfileHoverFill(id));
    element.addEventListener('mouseleave', cancelInlineHoverFill);
  });

  positionInlineMorePopover();
}

function positionInlineMorePopover() {
  if (!inlineRoot) return;

  const popover = inlineRoot.querySelector<HTMLElement>('.more-popover');
  if (!popover) return;

  const id = inlineMoreCredentialId ?? inlineMoreProfileId;
  if (!id) return;

  const action = inlineMoreCredentialId ? 'more' : 'profile-more';
  const button = Array.from(inlineRoot.querySelectorAll<HTMLButtonElement>(`[data-action="${action}"]`))
    .find((item) => item.dataset.id === id);

  if (!button) return;

  const rect = button.getBoundingClientRect();
  const width = Math.max(176, Math.ceil(popover.offsetWidth || 176));
  const height = Math.max(120, Math.ceil(popover.offsetHeight || 268));
  let left = rect.right + 8;
  let top = rect.top - Math.max(0, Math.round((42 - rect.height) / 2));

  if (left + width + 8 > window.innerWidth) {
    left = rect.left - width - 8;
  }

  if (top + height + 8 > window.innerHeight) {
    top = Math.max(8, window.innerHeight - height - 8);
  }

  left = Math.max(8, Math.min(window.innerWidth - width - 8, left));
  top = Math.max(8, top);

  popover.style.setProperty('--keypilot-more-left', `${left}px`);
  popover.style.setProperty('--keypilot-more-top', `${top}px`);
}

function openInlineMoreMenuFromButton(button: HTMLButtonElement) {
  const action = button.dataset.action;
  const id = button.dataset.id;

  if (!id || (action !== 'more' && action !== 'profile-more')) return;

  cancelInlineHoverFill();
  cancelInlineHoverClose();
  suppressInlineRefreshFor(900);
  inlineMenuOpen = true;
  inlineMorePointerHandledUntil = Date.now() + 360;

  if (action === 'more') {
    inlineMoreCredentialId = inlineMoreCredentialId === id ? null : id;
    inlineMoreProfileId = null;
  } else {
    inlineMoreProfileId = inlineMoreProfileId === id ? null : id;
    inlineMoreCredentialId = null;
  }

  renderInlineWidget();
  positionInlineWidget();
  positionInlineMorePopover();
}

function attachInlineDragHandlers() {
  const trigger = inlineRoot?.querySelector<HTMLElement>('.trigger');
  if (!trigger) return;

  trigger.addEventListener('pointerdown', (event) => {
    cancelInlineHoverOpen();
    beginFloatingIconDrag(event, trigger, {
      width: inlineMenuOpen ? INLINE_MENU_WIDTH : INLINE_TRIGGER_SIZE,
      height: inlineMenuOpen ? INLINE_MENU_MAX_HEIGHT + 58 : INLINE_TRIGGER_SIZE,
      suppressClick: () => {
        inlineDragSuppressClickUntil = Date.now() + 420;
      },
      onStart: () => {
        inlineManualPosition = clampFloatingPosition(
          {
            x: trigger.getBoundingClientRect().left,
            y: trigger.getBoundingClientRect().top
          },
          inlineMenuOpen ? INLINE_MENU_WIDTH : INLINE_TRIGGER_SIZE,
          inlineMenuOpen ? INLINE_MENU_MAX_HEIGHT + 58 : INLINE_TRIGGER_SIZE
        );
        renderInlineWidget();
      },
      onMove: (position) => {
        inlineManualPosition = position;
        positionInlineWidget();
      },
      onEnd: (position) => {
        inlineManualPosition = position;
        saveFloatingIconPosition('inline-login', position);
        positionInlineWidget();
      }
    });
  });

  trigger.addEventListener('dblclick', (event) => {
    event.preventDefault();
    event.stopPropagation();
    inlineManualPosition = null;
    saveFloatingIconPosition('inline-login', null);
    renderInlineWidget();
    positionInlineWidget();
  });
}

function renderInlineWidgetLegacy() {
  ensureInlineWidget();

  if (!inlineRoot) return;

  const accountContent = inlineMatches.length
    ? inlineMatches.map((match) => `
        <article class="account">
          <button class="account-main" type="button" data-action="login" data-id="${escapeHtml(match.id)}" aria-label="使用 ${escapeHtml(match.title)} 登录">
            <span class="mark">${renderInlineIcon(match)}</span>
            <span class="text">
              <strong>${escapeHtml(match.title || match.domain || '未命名账号')}</strong>
              <small>${escapeHtml(match.username || '无用户名')}</small>
            </span>
          </button>
          <div class="account-actions">
            <button type="button" data-action="fill" data-id="${escapeHtml(match.id)}">填充</button>
            <button type="button" data-action="login" data-id="${escapeHtml(match.id)}">登录</button>
          </div>
        </article>
      `).join('')
    : `
      <div class="empty">
        <strong>${inlineLocked ? 'KeyPilot 已锁定' : '没有匹配账号'}</strong>
        <p>${inlineLocked ? '请先点击浏览器工具栏里的 KeyPilot 解锁 Vault。' : '打开 KeyPilot 新增当前网站账号，或检查保存的网址是否属于同一主域。'}</p>
        <button type="button" data-action="refresh">刷新状态</button>
      </div>
    `;
  const menu = inlineMenuOpen ? `
    <section class="menu" role="menu" aria-label="KeyPilot 快捷登录">
      <div class="accounts">
        ${accountContent}
      </div>
      <footer>
        <button type="button" data-action="report">报告自动填充问题</button>
      </footer>
      ${inlineStatus ? `<p class="status">${escapeHtml(inlineStatus)}</p>` : ''}
    </section>
  ` : '';

  inlineRoot.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; }
      button { font: inherit; }
      .trigger {
        position: absolute;
        top: 0;
        right: ${INLINE_TRIGGER_RIGHT_OFFSET}px;
        display: grid;
        width: 32px;
        height: 32px;
        place-items: center;
        border: 1px solid #b8d0ff;
        border-radius: 8px;
        background: #ffffff;
        color: #2563eb;
        box-shadow: 0 8px 20px rgba(16, 24, 40, 0.16);
        cursor: pointer;
        pointer-events: auto;
      }
      .trigger:hover { background: #f8fbff; }
      .trigger svg { width: 19px; height: 19px; }
      .menu {
        position: absolute;
        top: 38px;
        right: 0;
        width: 248px;
        overflow: hidden;
        border: 1px solid #dfe7f3;
        border-radius: 8px;
        background: #ffffff;
        box-shadow: 0 16px 38px rgba(16, 24, 40, 0.18);
        color: #101828;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
        pointer-events: auto;
      }
      header {
        display: grid;
        grid-template-columns: 24px minmax(0, 1fr) 28px;
        align-items: center;
        gap: 9px;
        min-height: 42px;
        border-bottom: 1px solid #edf2f8;
        padding: 7px 8px;
      }
      header strong {
        overflow: hidden;
        font-size: 13px;
        font-weight: 800;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .icon {
        display: grid;
        width: 28px;
        height: 28px;
        place-items: center;
        border: 0;
        border-radius: 8px;
        background: transparent;
        color: #475467;
        cursor: pointer;
      }
      .icon:hover { background: #f2f6fc; }
      .icon svg { width: 16px; height: 16px; }
      .icon.close-button { color: #667085; }
      .icon.close-button:hover { color: #344054; }
      .accounts { display: grid; max-height: 238px; overflow-y: auto; }
      .empty {
        display: grid;
        gap: 7px;
        padding: 12px;
      }
      .empty strong {
        color: #101828;
        font-size: 13px;
        font-weight: 820;
      }
      .empty p {
        margin: 0;
        color: #667085;
        font-size: 12px;
        line-height: 1.45;
      }
      .empty button {
        justify-self: start;
        min-height: 30px;
        border: 1px solid #dfe7f3;
        border-radius: 8px;
        padding: 0 10px;
        background: #ffffff;
        color: #2563eb;
        cursor: pointer;
        font-size: 12px;
        font-weight: 760;
      }
      .account {
        display: grid;
        gap: 8px;
        border-bottom: 1px solid #edf2f8;
        padding: 8px;
      }
      .account-main {
        display: grid;
        grid-template-columns: 28px minmax(0, 1fr);
        align-items: center;
        gap: 9px;
        width: 100%;
        border: 0;
        padding: 0;
        background: transparent;
        color: inherit;
        cursor: pointer;
        text-align: left;
      }
      .text { min-width: 0; }
      .text strong,
      .text small {
        display: block;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .text strong { font-size: 13px; font-weight: 800; }
      .text small { margin-top: 2px; color: #667085; font-size: 12px; }
      .account-actions {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 6px;
      }
      .account-actions button {
        min-height: 30px;
        border: 1px solid #dfe7f3;
        border-radius: 8px;
        background: #ffffff;
        color: #344054;
        cursor: pointer;
        font-size: 12px;
        font-weight: 760;
      }
      .account-actions button:last-child {
        border-color: #2563eb;
        background: #2563eb;
        color: #ffffff;
      }
      .mark {
        position: relative;
        display: grid;
        width: 24px;
        height: 24px;
        place-items: center;
        overflow: hidden;
        border: 1px solid #cfe0ff;
        border-radius: 7px;
        background: #eaf2ff;
        color: #2563eb;
        font-size: 12px;
        font-weight: 850;
      }
      .mark .default-site-icon {
        width: 100%;
        height: 100%;
        display: block;
      }
      .mark img {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        object-fit: contain;
        padding: 3px;
        background: #ffffff;
      }
      footer {
        display: grid;
        border-top: 1px solid #edf2f8;
        padding: 7px 8px;
      }
      footer button {
        border: 0;
        background: transparent;
        color: #667085;
        cursor: pointer;
        font-size: 12px;
        text-align: left;
      }
      .status {
        margin: 0;
        border-top: 1px solid #edf2f8;
        padding: 7px 8px;
        color: #2563eb;
        font-size: 12px;
        line-height: 1.4;
      }
    </style>
    <button class="trigger" type="button" data-action="toggle" aria-label="打开 KeyPilot 快捷登录">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path fill="currentColor" d="M12 2.5 19 5v5.3c0 5.1-2.9 8.5-7 10.2-4.1-1.7-7-5.1-7-10.2V5l7-2.5Z"/>
        <path fill="#fff" d="m10.8 14.6-3-3 1.5-1.5 1.5 1.5 3.9-3.9 1.5 1.5-5.4 5.4Z"/>
      </svg>
    </button>
    ${menu}
  `;

  inlineRoot.querySelectorAll<HTMLImageElement>('img[data-fallback]').forEach((image) => {
    const tryNextIcon = () => {
      const nextIcon = image.dataset.nextIcon;
      if (nextIcon && image.src !== nextIcon) {
        image.dataset.nextIcon = '';
        image.src = nextIcon;
        return;
      }

      image.remove();
    };

    image.addEventListener('load', () => {
      if (image.naturalWidth <= 1 && image.naturalHeight <= 1) {
        tryNextIcon();
      }
    });

    image.addEventListener('error', () => {
      tryNextIcon();
    });
  });

  const shell = inlineRoot.querySelector<HTMLElement>('.inline-shell');
  if (shell) {
    const openFromPointer = () => {
      cancelInlineHoverClose();
      openInlineMenuFromHover();
    };
    shell.addEventListener('mouseenter', openFromPointer);
    shell.addEventListener('pointerenter', openFromPointer);
    shell.addEventListener('mouseleave', closeInlineMenuFromHover);
    shell.addEventListener('pointerleave', closeInlineMenuFromHover);
  }

  const hoverTrigger = inlineRoot.querySelector<HTMLElement>('.trigger');
  if (hoverTrigger) {
    const openFromTrigger = () => {
      cancelInlineHoverClose();
      openInlineMenuFromHover();
    };
    hoverTrigger.addEventListener('mouseenter', openFromTrigger);
    hoverTrigger.addEventListener('mouseover', openFromTrigger);
    hoverTrigger.addEventListener('pointerenter', openFromTrigger);
    hoverTrigger.addEventListener('pointerover', openFromTrigger);
    hoverTrigger.addEventListener('pointermove', openFromTrigger);
  }

  const hoverMenu = inlineRoot.querySelector<HTMLElement>('.menu');
  if (hoverMenu) {
    hoverMenu.addEventListener('mouseenter', cancelInlineHoverClose);
    hoverMenu.addEventListener('pointerenter', cancelInlineHoverClose);
    hoverMenu.addEventListener('mouseleave', closeInlineMenuFromHover);
    hoverMenu.addEventListener('pointerleave', closeInlineMenuFromHover);
  }

  const accountsScroller = inlineRoot.querySelector<HTMLElement>('.accounts');
  if (accountsScroller) {
    accountsScroller.addEventListener('scroll', positionInlineMorePopover, { passive: true });
  }

  const morePopover = inlineRoot.querySelector<HTMLElement>('.more-popover');
  if (morePopover) {
    morePopover.addEventListener('mouseenter', cancelInlineHoverClose);
    morePopover.addEventListener('pointerenter', cancelInlineHoverClose);
    morePopover.addEventListener('mouseleave', closeInlineMenuFromHover);
    morePopover.addEventListener('pointerleave', closeInlineMenuFromHover);
  }

  inlineRoot.querySelectorAll<HTMLButtonElement>('[data-action="more"], [data-action="profile-more"]').forEach((button) => {
    button.addEventListener('mouseenter', cancelInlineHoverFill);
    button.addEventListener('pointerenter', cancelInlineHoverFill);
    button.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      openInlineMoreMenuFromButton(button);
    });
  });

  inlineRoot.querySelectorAll<HTMLElement>('[data-action]').forEach((element) => {
    element.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const action = element.dataset.action;
      const id = element.dataset.id;

      if (action === 'toggle') {
        inlineMenuOpen = !inlineMenuOpen;
        if (inlineMenuOpen) {
          scheduleInlineRefresh(0);
        }
        renderInlineWidget();
        positionInlineWidget();
        return;
      }

      if (action === 'close') {
        inlineMenuOpen = false;
        inlineStatus = '';
        renderInlineWidget();
        positionInlineWidget();
        return;
      }

      if (action === 'report') {
        inlineStatus = '请刷新网页后重试；如果仍然失败，可在 KeyPilot 里使用“绑定字段”校准此网站。';
        renderInlineWidget();
        return;
      }

      if (action === 'refresh') {
        inlineStatus = '正在刷新状态...';
        renderInlineWidget();
        scheduleInlineRefresh(0);
        return;
      }

      if ((action === 'login' || action === 'fill') && id) {
        void handleInlineFill(id, action);
      }
    });
  });
}

function renderInlineIcon(match: InlineCredentialSummary): string {
  const [iconUrl, nextIconUrl] = getIconCandidates(match.iconUrl, match.url || match.domain);
  const nextAttribute = nextIconUrl ? ` data-next-icon="${escapeHtml(nextIconUrl)}"` : '';
  return `${renderDefaultInlineIcon()}${iconUrl ? `<img data-fallback${nextAttribute} src="${escapeHtml(iconUrl)}" alt="" referrerpolicy="no-referrer" draggable="false" />` : ''}`;
}

function renderInlineEditorIcon(kind: 'close' | 'eye' | 'eye-off' | 'refresh' | 'save' | 'link'): string {
  const icons: Record<typeof kind, string> = {
    close: '<path d="M6 6l12 12M18 6 6 18" />',
    eye: '<path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" /><circle cx="12" cy="12" r="2.6" />',
    'eye-off': '<path d="M3 3l18 18" /><path d="M9.7 5.5A9.7 9.7 0 0 1 12 5c6 0 9.5 7 9.5 7a16 16 0 0 1-2.2 3.1M6.2 6.7C3.8 8.3 2.5 12 2.5 12s3.5 7 9.5 7c1.4 0 2.7-.3 3.8-.8" />',
    refresh: '<path d="M20 12a8 8 0 0 1-14.7 4.4M4 12A8 8 0 0 1 18.7 7.6" /><path d="M5 17H2.8v-2.2M19 5h2.2v2.2" />',
    save: '<path d="M5 4h12l2 2v15H5z" /><path d="M8 4v6h8V4M8 21v-7h8v7" />',
    link: '<path d="M10 13a5 5 0 0 0 7.1 0l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1" /><path d="M14 11a5 5 0 0 0-7.1 0l-2 2a5 5 0 0 0 7.1 7.1l1.1-1.1" />'
  };

  return `<svg viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${icons[kind]}</g></svg>`;
}

function cloneCredentialForEditor(credential: Credential): Credential {
  return {
    ...credential,
    tags: credential.tags ? [...credential.tags] : undefined,
    formFields: credential.formFields?.map((field) => ({ ...field })),
    formProfile: credential.formProfile
      ? {
          ...credential.formProfile,
          submit: credential.formProfile.submit ? { ...credential.formProfile.submit } : undefined
        }
      : undefined
  };
}

function inlineEditorOpen(): boolean {
  return Boolean(inlineEditorHost && inlineEditorHost.style.display !== 'none');
}

function handleInlineEditorKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape' || !inlineEditorOpen()) return;

  event.preventDefault();
  closeInlineCredentialEditor();
}

function ensureInlineCredentialEditor() {
  if (!inlineEditorHost || !inlineEditorRoot) {
    inlineEditorHost = document.createElement('div');
    inlineEditorHost.id = 'keypilot-inline-editor-root';
    inlineEditorHost.style.position = 'fixed';
    inlineEditorHost.style.inset = '0';
    inlineEditorHost.style.zIndex = '2147483647';
    inlineEditorHost.style.display = 'none';
    inlineEditorHost.style.pointerEvents = 'auto';
    inlineEditorHost.style.colorScheme = 'light';
    inlineEditorRoot = inlineEditorHost.attachShadow({ mode: 'open' });
    document.documentElement.appendChild(inlineEditorHost);
  }

  if (!inlineEditorKeydownAttached) {
    document.addEventListener('keydown', handleInlineEditorKeydown, true);
    inlineEditorKeydownAttached = true;
  }
}

function renderInlineCredentialEditor() {
  ensureInlineCredentialEditor();

  if (!inlineEditorRoot) return;

  const draft = inlineEditorDraft;
  const summary = draft
    ? {
        id: draft.id,
        title: draft.title,
        url: draft.url,
        domain: draft.domain,
        matchUrl: draft.matchUrl,
        matchDomain: draft.matchDomain,
        username: draft.username,
        iconUrl: draft.iconUrl,
        iconType: draft.iconType
      } satisfies InlineCredentialSummary
    : null;
  const canSave = Boolean(draft?.title.trim() && draft?.url.trim()) && !inlineEditorSaving;

  inlineEditorRoot.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; }
      button,
      input,
      textarea { font: inherit; }
      .backdrop {
        position: fixed;
        inset: 0;
        display: grid;
        justify-items: end;
        background: rgba(15, 23, 42, 0.08);
        color: #101828;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
      }
      .drawer {
        width: min(430px, calc(100vw - 24px));
        height: 100dvh;
        overflow: hidden;
        border-left: 1px solid #d9e2ee;
        background: #ffffff;
        box-shadow: -8px 0 22px rgba(15, 23, 42, 0.14);
        animation: drawer-in 150ms ease-out both;
      }
      .drawer-shell {
        display: grid;
        grid-template-rows: auto auto minmax(0, 1fr);
        height: 100%;
      }
      .titlebar {
        display: grid;
        grid-template-columns: 34px minmax(0, 1fr) 34px;
        align-items: center;
        gap: 10px;
        min-height: 64px;
        border-bottom: 1px solid #edf1f6;
        padding: 10px 14px;
      }
      .title-icon {
        position: relative;
        display: grid;
        width: 32px;
        height: 32px;
        place-items: center;
        overflow: hidden;
        border: 1px solid #bbf7d0;
        border-radius: 8px;
        background: #ecfdf3;
        color: #15803d;
      }
      .title-icon .default-site-icon {
        width: 100%;
        height: 100%;
        display: block;
      }
      .title-icon img {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        object-fit: contain;
        padding: 4px;
        background: #ffffff;
      }
      .title-copy { min-width: 0; }
      .title-copy strong,
      .title-copy span {
        display: block;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .title-copy strong {
        color: #0f172a;
        font-size: 15px;
        font-weight: 760;
        line-height: 1.2;
      }
      .title-copy span {
        margin-top: 3px;
        color: #667085;
        font-size: 12px;
        line-height: 1.2;
      }
      .icon-button {
        display: grid;
        width: 34px;
        height: 34px;
        place-items: center;
        border: 0;
        border-radius: 8px;
        background: transparent;
        color: #475467;
        cursor: pointer;
      }
      .icon-button:hover { background: #f2f6fc; color: #1f2937; }
      .icon-button:focus-visible {
        outline: 2px solid #8db4ff;
        outline-offset: 2px;
      }
      .icon-button svg { width: 18px; height: 18px; }
      .actionbar {
        display: flex;
        justify-content: flex-end;
        gap: 10px;
        border-bottom: 1px solid #edf1f6;
        background: #fbfcfe;
        padding: 10px 14px;
      }
      .button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 34px;
        border: 1px solid #d9e2ee;
        border-radius: 8px;
        background: #ffffff;
        color: #344054;
        cursor: pointer;
        padding: 0 16px;
        font-size: 13px;
        font-weight: 700;
      }
      .button:hover { background: #f8fafc; }
      .button.primary {
        border-color: #2563eb;
        background: #2563eb;
        color: #ffffff;
      }
      .button.primary:hover { background: #1d4ed8; }
      .button:disabled {
        border-color: #e5e9f0;
        background: #eef2f7;
        color: #98a2b3;
        cursor: not-allowed;
      }
      .body {
        min-height: 0;
        overflow: auto;
        padding: 18px 18px 22px;
        scrollbar-color: #aab7c8 transparent;
        scrollbar-width: thin;
      }
      .body::-webkit-scrollbar { width: 9px; }
      .body::-webkit-scrollbar-track { background: transparent; }
      .body::-webkit-scrollbar-thumb {
        border: 3px solid #ffffff;
        border-radius: 999px;
        background: #aab7c8;
      }
      .loading {
        display: grid;
        gap: 12px;
        padding-top: 10px;
      }
      .skeleton {
        height: 44px;
        border-radius: 8px;
        background: linear-gradient(90deg, #f1f5f9, #e8eef6, #f1f5f9);
        background-size: 200% 100%;
        animation: skeleton 1200ms ease-out infinite;
      }
      .form {
        display: grid;
        gap: 16px;
      }
      .field {
        display: grid;
        gap: 7px;
      }
      .field span {
        color: #7b8798;
        font-size: 12px;
        font-weight: 660;
      }
      .field input,
      .field textarea {
        width: 100%;
        min-width: 0;
        border: 1px solid #cfd8e6;
        border-radius: 7px;
        background: #ffffff;
        color: #111827;
        font-size: 13.5px;
        line-height: 1.35;
        outline: 0;
        padding: 9px 11px;
      }
      .field input:focus,
      .field textarea:focus,
      .password-control:focus-within {
        border-color: #2563eb;
        box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.12);
      }
      .password-control {
        display: grid;
        grid-template-columns: minmax(0, 1fr) 34px 34px;
        align-items: center;
        border: 1px solid #cfd8e6;
        border-radius: 7px;
        background: #ffffff;
      }
      .password-control input {
        border: 0;
        box-shadow: none;
      }
      .password-control input:focus { box-shadow: none; }
      .password-control .icon-button {
        width: 32px;
        height: 32px;
        color: #516174;
      }
      textarea {
        min-height: 110px;
        resize: vertical;
      }
      .hint {
        display: flex;
        align-items: center;
        gap: 7px;
        margin: 2px 0 0;
        color: #667085;
        font-size: 12px;
        line-height: 1.45;
      }
      .hint svg {
        width: 15px;
        height: 15px;
        color: #2563eb;
      }
      .status {
        border: 1px solid #bfdbfe;
        border-radius: 8px;
        background: #eff6ff;
        color: #1d4ed8;
        margin: 4px 0 0;
        padding: 9px 11px;
        font-size: 12.5px;
        line-height: 1.45;
      }
      .status.error {
        border-color: #fecaca;
        background: #fff1f2;
        color: #b91c1c;
      }
      @keyframes drawer-in {
        from { opacity: 0; transform: translateX(14px); }
        to { opacity: 1; transform: translateX(0); }
      }
      @keyframes skeleton {
        from { background-position: 100% 0; }
        to { background-position: -100% 0; }
      }
      @media (prefers-reduced-motion: reduce) {
        .drawer,
        .skeleton { animation: none; }
      }
    </style>
    <div class="backdrop" data-editor-backdrop="true">
      <aside class="drawer" role="dialog" aria-modal="true" aria-label="编辑账号">
        <div class="drawer-shell">
          <header class="titlebar">
            <span class="title-icon">${summary ? renderInlineIcon(summary) : renderInlineAccountLockIcon()}</span>
            <span class="title-copy">
              <strong>${escapeHtml(draft?.title || '编辑账号')}</strong>
              <span>${escapeHtml(draft?.domain || draft?.username || '本地加密账号')}</span>
            </span>
            <button class="icon-button" type="button" data-editor-action="close" aria-label="关闭编辑面板">
              ${renderInlineEditorIcon('close')}
            </button>
          </header>
          <div class="actionbar">
            <button class="button" type="button" data-editor-action="cancel">取消</button>
            <button class="button primary" type="button" data-editor-action="save" ${canSave ? '' : 'disabled'}>${inlineEditorSaving ? '保存中' : '保存'}</button>
          </div>
          <main class="body">
            ${draft ? `
              <div class="form">
                <label class="field">
                  <span>名称</span>
                  <input data-field="title" type="text" value="${escapeHtml(draft.title)}" autocomplete="off" />
                </label>
                <label class="field">
                  <span>转到 URL</span>
                  <input data-field="url" type="url" value="${escapeHtml(draft.url)}" autocomplete="off" />
                </label>
                <label class="field">
                  <span>匹配 URL</span>
                  <input data-field="matchUrl" type="text" value="${escapeHtml(draft.matchUrl ?? '')}" autocomplete="off" placeholder="留空使用网站域名，或填写 *.example.com/*" />
                </label>
                <label class="field">
                  <span>登录名</span>
                  <input data-field="username" type="text" value="${escapeHtml(draft.username)}" autocomplete="username" />
                </label>
                <label class="field">
                  <span>密码</span>
                  <span class="password-control">
                    <input data-field="password" type="${inlineEditorPasswordVisible ? 'text' : 'password'}" value="${escapeHtml(draft.password)}" autocomplete="current-password" />
                    <button class="icon-button" type="button" data-editor-action="toggle-password" aria-label="${inlineEditorPasswordVisible ? '隐藏密码' : '显示密码'}">
                      ${renderInlineEditorIcon(inlineEditorPasswordVisible ? 'eye-off' : 'eye')}
                    </button>
                    <button class="icon-button" type="button" data-editor-action="generate-password" aria-label="重新生成密码">
                      ${renderInlineEditorIcon('refresh')}
                    </button>
                  </span>
                </label>
                <label class="field">
                  <span>备注</span>
                  <textarea data-field="notes">${escapeHtml(draft.notes ?? '')}</textarea>
                </label>
                <p class="hint">
                  ${renderInlineEditorIcon('link')}
                  转到 URL 和匹配 URL 第一版会同步保存为同一个地址，后续可以扩展为独立匹配规则。
                </p>
                ${inlineEditorStatus ? `<p class="status${inlineEditorStatus.includes('失败') || inlineEditorStatus.includes('错误') || inlineEditorStatus.includes('不能为空') ? ' error' : ''}">${escapeHtml(inlineEditorStatus)}</p>` : ''}
              </div>
            ` : `
              <div class="loading" aria-live="polite">
                <div class="skeleton"></div>
                <div class="skeleton"></div>
                <div class="skeleton"></div>
                ${inlineEditorStatus ? `<p class="status">${escapeHtml(inlineEditorStatus)}</p>` : ''}
              </div>
            `}
          </main>
        </div>
      </aside>
    </div>
  `;

  disableNativeDragGhost(inlineEditorRoot);

  inlineEditorRoot.querySelectorAll<HTMLImageElement>('img[data-fallback]').forEach((image) => {
    const tryNextIcon = () => {
      const nextIcon = image.dataset.nextIcon;
      if (nextIcon && image.src !== nextIcon) {
        image.dataset.nextIcon = '';
        image.src = nextIcon;
        return;
      }

      image.remove();
    };

    image.addEventListener('load', () => {
      if (image.naturalWidth <= 1 && image.naturalHeight <= 1) {
        tryNextIcon();
      }
    });
    image.addEventListener('error', tryNextIcon);
  });

  inlineEditorRoot.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[data-field]').forEach((control) => {
    control.addEventListener('input', () => {
      if (!inlineEditorDraft) return;

      const field = control.dataset.field;
      if (field !== 'title' && field !== 'url' && field !== 'matchUrl' && field !== 'username' && field !== 'password' && field !== 'notes') return;

      inlineEditorDraft = {
        ...inlineEditorDraft,
        [field]: control.value
      };
    });
  });

  inlineEditorRoot.querySelectorAll<HTMLElement>('[data-editor-action]').forEach((element) => {
    element.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();

      const action = element.dataset.editorAction;
      if (action === 'close' || action === 'cancel') {
        closeInlineCredentialEditor();
        return;
      }

      if (action === 'toggle-password') {
        inlineEditorPasswordVisible = !inlineEditorPasswordVisible;
        renderInlineCredentialEditor();
        return;
      }

      if (action === 'generate-password' && inlineEditorDraft) {
        inlineEditorDraft = {
          ...inlineEditorDraft,
          password: generatePassword(defaultGeneratorOptions)
        };
        inlineEditorPasswordVisible = true;
        inlineEditorStatus = '已生成新密码，保存后才会写入 Vault。';
        renderInlineCredentialEditor();
        return;
      }

      if (action === 'save') {
        void saveInlineCredentialEditor();
      }
    });
  });

  inlineEditorRoot.querySelector<HTMLElement>('[data-editor-backdrop]')?.addEventListener('click', (event) => {
    if (event.target === event.currentTarget) {
      closeInlineCredentialEditor();
    }
  });
}

function closeInlineCredentialEditor() {
  inlineEditorCredential = null;
  inlineEditorDraft = null;
  inlineEditorStatus = '';
  inlineEditorSaving = false;
  inlineEditorPasswordVisible = false;

  if (inlineEditorHost) {
    inlineEditorHost.style.display = 'none';
  }
}

function updateInlineMatchFromCredential(credential: Credential) {
  inlineMatches = inlineMatches.map((match) =>
    match.id === credential.id
      ? {
          ...match,
          title: credential.title,
          url: credential.url,
          domain: credential.domain,
          matchUrl: credential.matchUrl,
          matchDomain: credential.matchDomain,
          username: credential.username,
          iconUrl: credential.iconUrl,
          iconType: credential.iconType,
          lastUsedAt: credential.lastUsedAt
        }
      : match
  );
}

async function openInlineCredentialEditor(credentialId: string) {
  ensureInlineCredentialEditor();

  inlineMenuOpen = false;
  inlineMoreCredentialId = null;
  inlineMoreProfileId = null;
  inlineStatus = '';
  inlineEditorCredential = null;
  inlineEditorDraft = null;
  inlineEditorSaving = false;
  inlineEditorPasswordVisible = false;
  inlineEditorStatus = '正在读取账号...';

  if (inlineEditorHost) inlineEditorHost.style.display = 'block';
  renderInlineWidget();
  positionInlineWidget();
  renderInlineCredentialEditor();

  try {
    const response = await sendRuntimeMessage<{ ok: boolean; credential?: Credential; locked?: boolean; error?: string }>({
      type: 'KEYPILOT_GET_INLINE_CREDENTIAL',
      credentialId
    });

    if (!response.ok || !response.credential) {
      throw new Error(response.error ?? (response.locked ? 'VAULT_LOCKED' : 'NO_MATCHING_CREDENTIAL'));
    }

    inlineEditorCredential = cloneCredentialForEditor(response.credential);
    inlineEditorDraft = cloneCredentialForEditor(response.credential);
    inlineEditorStatus = '';
    renderInlineCredentialEditor();
  } catch (error) {
    inlineEditorStatus = inlineErrorMessage(error);
    renderInlineCredentialEditor();
  }
}

async function saveInlineCredentialEditor() {
  const draft = inlineEditorDraft;
  if (!draft || inlineEditorSaving) return;

  if (!draft.title.trim() || !draft.url.trim()) {
    inlineEditorStatus = '名称和 URL 不能为空。';
    renderInlineCredentialEditor();
    return;
  }

  inlineEditorSaving = true;
  inlineEditorStatus = '正在保存...';
  renderInlineCredentialEditor();

  try {
    const response = await sendRuntimeMessage<{ ok: boolean; credential?: Credential; locked?: boolean; error?: string; message?: string }>({
      type: 'KEYPILOT_SAVE_INLINE_CREDENTIAL',
      credential: draft
    });

    if (!response.ok || !response.credential) {
      throw new Error(response.error ?? (response.locked ? 'VAULT_LOCKED' : 'SAVE_INLINE_CREDENTIAL_FAILED'));
    }

    inlineEditorCredential = cloneCredentialForEditor(response.credential);
    inlineEditorDraft = cloneCredentialForEditor(response.credential);
    inlineEditorSaving = false;
    inlineEditorStatus = response.message ?? '账号已保存。';
    updateInlineMatchFromCredential(response.credential);
    renderInlineCredentialEditor();
    renderInlineWidget();
    scheduleInlineRefresh(700);
  } catch (error) {
    inlineEditorSaving = false;
    inlineEditorStatus = inlineErrorMessage(error);
    renderInlineCredentialEditor();
  }
}

function isCurrentPasswordField(input: HTMLInputElement): boolean {
  const text = inputText(input);
  return (
    input.autocomplete === 'current-password' ||
    /\b(?:current|old|existing|previous)\b|原密码|旧密码|当前密码|原始密码/.test(text)
  );
}

function isConfirmPasswordField(input: HTMLInputElement): boolean {
  return /confirm|repeat|retype|verify|again|确认|重复|再次|二次|重复密码/.test(inputText(input));
}

function hasNewPasswordSignal(input: HTMLInputElement): boolean {
  return (
    input.autocomplete === 'new-password' ||
    /new|create|signup|sign-up|register|registration|set password|choose password|confirm|repeat|新密码|设置密码|创建密码|注册|确认密码|重复密码/.test(inputTextWithoutClass(input))
  );
}

function authSignalText(input: HTMLInputElement): string {
  const parent = input.parentElement;
  const parentText =
    parent &&
    !(parent instanceof HTMLFormElement) &&
    parent.querySelectorAll('input').length <= 1 &&
    !Array.from(parent.querySelectorAll('a, button, [role="button"]')).some((item) => compactText(item.textContent ?? ''))
      ? compactText(parent.textContent ?? '')
      : '';
  const wrapper = input.closest('[class*="field"], [class*="input"], [class*="password"], .form-group, .input-group');
  const wrapperText =
    wrapper &&
    wrapper !== parent &&
    wrapper.querySelectorAll('input').length <= 1 &&
    !Array.from(wrapper.querySelectorAll('a, button, [role="button"]')).some((item) => compactText(item.textContent ?? ''))
      ? compactText(wrapper.textContent ?? '')
      : '';

  return [
    inputTextWithoutClass(input),
    input.closest('label')?.textContent ?? '',
    parentText.length <= 160 ? parentText : '',
    wrapperText.length <= 180 ? wrapperText : ''
  ].join(' ');
}

function explicitAuthSignalText(input: HTMLInputElement): string {
  const parent = input.parentElement;
  const parentText =
    parent &&
    !(parent instanceof HTMLFormElement) &&
    parent.querySelectorAll('input').length <= 1 &&
    !Array.from(parent.querySelectorAll('a, button, [role="button"]')).some((item) => compactText(item.textContent ?? ''))
      ? compactText(parent.textContent ?? '')
      : '';
  const wrapper = input.closest('[class*="field"], [class*="input"], [class*="password"], .form-group, .input-group');
  const wrapperText =
    wrapper &&
    wrapper !== parent &&
    wrapper.querySelectorAll('input').length <= 1 &&
    !Array.from(wrapper.querySelectorAll('a, button, [role="button"]')).some((item) => compactText(item.textContent ?? ''))
      ? compactText(wrapper.textContent ?? '')
      : '';

  return [
    inputTextWithoutAutocomplete(input),
    input.closest('label')?.textContent ?? '',
    parentText.length <= 160 ? parentText : '',
    wrapperText.length <= 180 ? wrapperText : ''
  ].join(' ');
}

function hasExplicitRegistrationPasswordSignal(input: HTMLInputElement): boolean {
  return isConfirmPasswordField(input) || REGISTER_PASSWORD_PATTERN.test(explicitAuthSignalText(input));
}

function hasRegistrationPasswordSignal(input: HTMLInputElement): boolean {
  return hasNewPasswordSignal(input) || isConfirmPasswordField(input) || REGISTER_PASSWORD_PATTERN.test(authSignalText(input));
}

function elementContains(scope: ParentNode, element: Element): boolean {
  return scope === document || (scope instanceof Element && scope.contains(element));
}

function commonAncestorElement(elements: Element[]): Element | null {
  if (!elements.length) return null;

  let current: Element | null = elements[0];

  while (current) {
    if (elements.every((element) => current?.contains(element))) {
      return current;
    }

    current = current.parentElement;
  }

  return null;
}

function getPasswordGeneratorScope(fields: HTMLInputElement[], fallback: HTMLInputElement): ParentNode {
  const form = fallback.closest('form');
  if (form) return form;

  const common = commonAncestorElement(fields);
  if (common) {
    const inputs = getAllVisibleInputs(common);
    if (inputs.length >= fields.length && inputs.length <= 12) {
      return common;
    }
  }

  return getLoginScope(fallback);
}

function samePasswordScopeFields(scope: ParentNode): HTMLInputElement[] {
  return getAllVisibleInputs(scope).filter((input) => isPasswordInput(input) && !isCurrentPasswordField(input));
}

function scorePasswordGeneratorField(input: HTMLInputElement, active: HTMLInputElement | null): number {
  const scope = getLoginScope(input);
  const scopedPasswordFields = samePasswordScopeFields(scope);
  let score = 0;

  if (input === active) score += 80;
  if (hasRegistrationPasswordSignal(input)) score += 70;
  if (isConfirmPasswordField(input)) score += 30;
  if (scopedPasswordFields.length >= 2) score += 35;
  if (!input.value) score += 8;
  if (input.autocomplete === 'current-password') score -= 120;

  return score;
}

function findConfirmPasswordField(fields: HTMLInputElement[], passwordField: HTMLInputElement, preferred?: HTMLInputElement): HTMLInputElement | undefined {
  if (preferred && preferred !== passwordField && isConfirmPasswordField(preferred)) return preferred;

  const passwordRect = passwordField.getBoundingClientRect();
  const candidates = fields
    .filter((input) => input !== passwordField)
    .map((input) => {
      const rect = input.getBoundingClientRect();
      let score = 0;
      if (isConfirmPasswordField(input)) score += 80;
      if (rect.top >= passwordRect.top - 4) score += 20;
      score -= Math.min(40, Math.abs(rect.top - passwordRect.top) / 12);
      return { input, score };
    })
    .sort((left, right) => right.score - left.score);

  return candidates[0]?.score > 10 ? candidates[0].input : undefined;
}

function findPasswordGeneratorContext(): PasswordGeneratorContext | null {
  if (siteRuleDisablesPasswordGenerator()) return null;

  const active = document.activeElement instanceof HTMLInputElement && isPasswordInput(document.activeElement)
    ? document.activeElement
    : null;
  const passwordFields = getAllVisibleInputs(document).filter((input) => isPasswordInput(input) && !isCurrentPasswordField(input));
  const pageExplicitRegistrationSignal =
    passwordFields.some(hasExplicitRegistrationPasswordSignal) ||
    (passwordFields.length >= 2 && passwordFields.some(isConfirmPasswordField));

  if (pageLooksLikeLoginUrl() && !pageExplicitRegistrationSignal) {
    return null;
  }

  if (passwordFields.length) {
    const scope = getPasswordGeneratorScope(passwordFields, passwordFields[0]);
    if (scopeIsSinglePasswordLogin(scope, passwordFields)) return null;
  }

  const registrationFields = passwordFields.filter(hasRegistrationPasswordSignal);
  const registrationContext = passwordFieldsLookLikeRegistration(passwordFields);
  const multiPasswordRegistration =
    passwordFields.length >= 2 &&
    (registrationContext || passwordFields.some((input) => hasRegistrationPasswordSignal(input) || isConfirmPasswordField(input)));

  if (!registrationFields.length && !multiPasswordRegistration && !registrationContext) {
    return null;
  }

  const candidates = getAllVisibleInputs(document)
    .filter((input) => isPasswordInput(input) && !isCurrentPasswordField(input))
    .map((input) => ({
      input,
      score: scorePasswordGeneratorField(input, active)
    }))
    .filter((item) => item.score >= 30)
    .sort((left, right) => right.score - left.score);

  const anchor = candidates[0]?.input;
  if (!anchor) return null;

  const scope = getPasswordGeneratorScope(passwordFields, anchor);
  const scopedPasswordFields = samePasswordScopeFields(scope);
  const usablePasswordFields = scopedPasswordFields.length >= 2 ? scopedPasswordFields : passwordFields;
  const passwordField = isConfirmPasswordField(anchor)
    ? usablePasswordFields.find((input) => input !== anchor && !isConfirmPasswordField(input)) ?? anchor
    : anchor;
  const confirmField = findConfirmPasswordField(usablePasswordFields, passwordField, anchor);

  return {
    scope,
    passwordField,
    confirmField,
    usernameField: findUsernameField(scope, passwordField)
  };
}

function getPasswordGeneratorAnchor(context = findPasswordGeneratorContext()): HTMLInputElement | null {
  if (!context) return null;

  const active = document.activeElement instanceof HTMLInputElement && elementContains(context.scope, document.activeElement)
    ? document.activeElement
    : null;

  if (active && active === context.passwordField && isPasswordInput(active) && !isCurrentPasswordField(active)) {
    return active;
  }

  return context.passwordField;
}

function ensurePasswordGeneratorWidget() {
  if (passwordGeneratorHost && passwordGeneratorRoot) return;

  passwordGeneratorHost = document.createElement('div');
  passwordGeneratorHost.id = 'keypilot-password-generator-root';
  passwordGeneratorHost.setAttribute('aria-hidden', 'false');
  passwordGeneratorHost.style.position = 'fixed';
  passwordGeneratorHost.style.zIndex = '2147483647';
  passwordGeneratorHost.style.display = 'none';
  passwordGeneratorHost.style.width = '340px';
  passwordGeneratorHost.style.pointerEvents = 'none';
  passwordGeneratorHost.style.colorScheme = 'light';
  passwordGeneratorRoot = passwordGeneratorHost.attachShadow({ mode: 'open' });
  document.documentElement.appendChild(passwordGeneratorHost);
}

function normalizeGeneratorLength(value: number): number {
  if (!Number.isFinite(value)) return passwordGeneratorOptions.length;
  return Math.min(132, Math.max(4, Math.floor(value)));
}

function normalizePasswordGeneratorOptions(options: Partial<PasswordGeneratorOptions>): PasswordGeneratorOptions {
  const length = Number(options.length ?? defaultGeneratorOptions.length);
  return {
    ...defaultGeneratorOptions,
    ...options,
    length: Number.isFinite(length) ? Math.min(132, Math.max(4, Math.floor(length))) : defaultGeneratorOptions.length,
    uppercase: options.uppercase ?? defaultGeneratorOptions.uppercase,
    lowercase: options.lowercase ?? defaultGeneratorOptions.lowercase,
    numbers: options.numbers ?? defaultGeneratorOptions.numbers,
    symbols: options.symbols ?? defaultGeneratorOptions.symbols,
    excludeSimilar: options.excludeSimilar ?? defaultGeneratorOptions.excludeSimilar,
    requireEveryType: options.requireEveryType ?? defaultGeneratorOptions.requireEveryType,
    excludeCharacters: options.excludeCharacters ?? defaultGeneratorOptions.excludeCharacters,
    requiredCharacters: options.requiredCharacters ?? defaultGeneratorOptions.requiredCharacters
  };
}

function updatePasswordGeneratorOptions(patch: Partial<PasswordGeneratorOptions>, status = '') {
  const nextOptions = normalizePasswordGeneratorOptions({
    ...passwordGeneratorOptions,
    ...patch,
    length: patch.length === undefined ? passwordGeneratorOptions.length : normalizeGeneratorLength(patch.length)
  });

  passwordGeneratorOptions = nextOptions;
  passwordGeneratorValue = generatePassword(nextOptions);
  passwordGeneratorStatus = status;
  renderPasswordGeneratorWidget();
  positionPasswordGeneratorWidget();
}

function renderPasswordGeneratorIcon(): string {
  const iconUrl = getRuntimeAssetUrl('icons/icon32.png');
  return `
    <span class="pg-mark" aria-hidden="true">
      <svg viewBox="0 0 32 32" aria-hidden="true">
        <rect x="3" y="3" width="26" height="26" rx="8" fill="#2563EB"/>
        <path d="M16 7.5 22 9.7v5.1c0 5.1-2.8 8.5-6 9.9-3.2-1.4-6-4.8-6-9.9V9.7l6-2.2Z" fill="#FFFFFF"/>
        <path d="m14.9 17.7-2.4-2.3 1.3-1.4 1.2 1.2 3.4-3.5 1.4 1.4-4.9 4.6Z" fill="#2563EB"/>
      </svg>
      ${iconUrl ? `<img data-pg-icon src="${escapeHtml(iconUrl)}" alt="" draggable="false" />` : ''}
    </span>
  `;
}

function renderPasswordGeneratorButtonIcon(): string {
  const iconUrl = getRuntimeAssetUrl('icons/icon32.png');
  return `
    <svg viewBox="0 0 32 32" aria-hidden="true" style="position:absolute;inset:5px;width:24px;height:24px;display:block;pointer-events:none;user-select:none;-webkit-user-drag:none">
      <rect x="3" y="3" width="26" height="26" rx="8" fill="#2563EB"></rect>
      <path d="M16 7.5 22 9.7v5.1c0 5.1-2.8 8.5-6 9.9-3.2-1.4-6-4.8-6-9.9V9.7l6-2.2Z" fill="#FFFFFF"></path>
      <path d="m14.9 17.7-2.4-2.3 1.3-1.4 1.2 1.2 3.4-3.5 1.4 1.4-4.9 4.6Z" fill="#2563EB"></path>
    </svg>
    ${iconUrl ? `<img data-keypilot-inline-icon src="${escapeHtml(iconUrl)}" alt="" draggable="false" style="position:absolute;inset:5px;width:24px;height:24px;display:block;object-fit:contain;pointer-events:none;user-select:none;-webkit-user-drag:none" />` : ''}
  `;
}

function stylePasswordGeneratorInlineButton(button: HTMLButtonElement) {
  button.type = 'button';
  button.draggable = false;
  button.dataset.keypilotPasswordInlineTrigger = 'true';
  button.setAttribute('aria-label', '打开 KeyPilot 密码生成器');
  button.title = 'KeyPilot 密码生成器：点击打开，拖动调整位置，双击恢复自动跟随';
  button.innerHTML = renderPasswordGeneratorButtonIcon();
  button.style.position = 'relative';
  button.style.display = 'grid';
  button.style.width = '34px';
  button.style.height = '34px';
  button.style.minWidth = '34px';
  button.style.flex = '0 0 34px';
  button.style.placeItems = 'center';
  button.style.border = '1px solid #c9d9f4';
  button.style.borderRadius = '10px';
  button.style.background = '#ffffff';
  button.style.color = '#2563eb';
  button.style.boxShadow = '0 8px 22px rgba(16, 24, 40, 0.16)';
  button.style.cursor = 'grab';
  button.style.touchAction = 'none';
  button.style.userSelect = 'none';
  button.style.setProperty('-webkit-user-drag', 'none');
  button.style.marginLeft = '4px';
  button.style.padding = '0';
  button.style.zIndex = '2';
  button.addEventListener('dragstart', (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  disableNativeDragGhost(button);
}

function removePasswordGeneratorInlineTrigger() {
  if (passwordGeneratorInlineButton) {
    passwordGeneratorInlineButton.remove();
    passwordGeneratorInlineButton = null;
  }
}

function setPasswordGeneratorHostPosition(position: FloatingIconPosition, width: number) {
  if (!passwordGeneratorHost) return;

  passwordGeneratorHost.style.width = `${width}px`;
  passwordGeneratorHost.style.display = 'block';
  passwordGeneratorHost.style.left = `${position.x}px`;
  passwordGeneratorHost.style.top = `${position.y}px`;
}

function ensurePasswordGeneratorInlineTrigger(context: PasswordGeneratorContext): boolean {
  if (passwordGeneratorManualPosition) {
    removePasswordGeneratorInlineTrigger();
    return false;
  }

  const field = context.passwordField;
  const container = field.closest<HTMLElement>('.auth-field-shell, .password-field, .password-entry-control, label, div, span') ?? field.parentElement;

  if (!container) return false;

  if (!passwordGeneratorInlineButton) {
    passwordGeneratorInlineButton = document.createElement('button');
    stylePasswordGeneratorInlineButton(passwordGeneratorInlineButton);
    passwordGeneratorInlineButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (Date.now() < passwordGeneratorDragSuppressClickUntil) return;

      passwordGeneratorOpen = !passwordGeneratorOpen;
      passwordGeneratorStatus = '';
      renderPasswordGeneratorWidget();
      positionPasswordGeneratorWidget();
    });
    passwordGeneratorInlineButton.addEventListener('pointerdown', (event) => {
      beginPasswordGeneratorDrag(event, passwordGeneratorInlineButton!);
    });
    passwordGeneratorInlineButton.addEventListener('dblclick', (event) => {
      event.preventDefault();
      event.stopPropagation();
      resetPasswordGeneratorPosition();
    });
  }

  if (!passwordGeneratorInlineButton.isConnected || passwordGeneratorInlineButton.parentElement !== container) {
    const eyeButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((button) => button !== passwordGeneratorInlineButton);
    container.insertBefore(passwordGeneratorInlineButton, eyeButton ?? null);
  }

  passwordGeneratorInlineButton.querySelectorAll<HTMLImageElement>('img[data-keypilot-inline-icon]').forEach((image) => {
    image.addEventListener('error', () => image.remove(), { once: true });
  });

  return true;
}

function beginPasswordGeneratorDrag(event: PointerEvent, target: HTMLElement) {
  beginFloatingIconDrag(event, target, {
    width: passwordGeneratorOpen ? 340 : 34,
    height: passwordGeneratorOpen ? 460 : 34,
    suppressClick: () => {
      passwordGeneratorDragSuppressClickUntil = Date.now() + 420;
    },
    onStart: () => {
      passwordGeneratorDragInProgress = true;
      passwordGeneratorManualPosition = clampFloatingPosition(
        {
          x: target.getBoundingClientRect().left,
          y: target.getBoundingClientRect().top
        },
        passwordGeneratorOpen ? 340 : 34,
        passwordGeneratorOpen ? 460 : 34
      );
      removePasswordGeneratorInlineTrigger();
      renderPasswordGeneratorWidget();
    },
    onMove: (position) => {
      passwordGeneratorManualPosition = position;
      positionPasswordGeneratorWidget();
    },
    onEnd: (position) => {
      passwordGeneratorDragInProgress = false;
      passwordGeneratorManualPosition = position;
      saveFloatingIconPosition('password-generator', position);
      positionPasswordGeneratorWidget();
    }
  });
}

function beginPasswordGeneratorPanelDrag(event: PointerEvent, handle: HTMLElement) {
  const panel = handle.closest<HTMLElement>('.pg-panel');
  if (!panel) return;

  const rect = panel.getBoundingClientRect();
  const width = Math.max(300, Math.ceil(rect.width || 340));
  const height = Math.max(220, Math.ceil(Math.min(rect.height || 560, Math.max(220, window.innerHeight - 48))));

  beginFloatingSurfaceDrag(event, handle, panel, {
    width,
    height,
    suppressClick: () => {
      passwordGeneratorDragSuppressClickUntil = Date.now() + 420;
    },
    onStart: () => {
      passwordGeneratorDragInProgress = true;
      const position = clampFloatingPosition(
        {
          x: rect.left,
          y: rect.top
        },
        width,
        height
      );
      passwordGeneratorManualPosition = position;
      removePasswordGeneratorInlineTrigger();
      passwordGeneratorRoot?.querySelector<HTMLElement>('.pg-shell')?.classList.add('pg-manual', 'pg-open', 'pg-dragging');
      passwordGeneratorRoot?.querySelector<HTMLElement>('.pg-trigger')?.remove();
      setPasswordGeneratorHostPosition(position, width);
    },
    onMove: (position) => {
      passwordGeneratorManualPosition = position;
      setPasswordGeneratorHostPosition(position, width);
    },
    onEnd: (position) => {
      passwordGeneratorDragInProgress = false;
      passwordGeneratorManualPosition = position;
      saveFloatingIconPosition('password-generator', position);
      passwordGeneratorRoot?.querySelector<HTMLElement>('.pg-shell')?.classList.remove('pg-dragging');
      setPasswordGeneratorHostPosition(position, width);
    }
  });
}

function resetPasswordGeneratorPosition() {
  passwordGeneratorDragInProgress = false;
  passwordGeneratorManualPosition = null;
  saveFloatingIconPosition('password-generator', null);
  passwordGeneratorOpen = false;
  renderPasswordGeneratorWidget();
  positionPasswordGeneratorWidget();
}

function renderPasswordGeneratorStrength(): string {
  const strength = measurePasswordStrength(passwordGeneratorValue);
  return `
    <span class="pg-strength s${strength.score}">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 19 6v5.2c0 4.8-2.7 8.1-7 9.8-4.3-1.7-7-5-7-9.8V6l7-3Z" fill="currentColor"/></svg>
      ${escapeHtml(passwordGeneratorValue ? strength.label : '待生成')}
    </span>
  `;
}

function renderPasswordGeneratorSwitch(label: string, hint: string, key: keyof PasswordGeneratorOptions): string {
  const checked = Boolean(passwordGeneratorOptions[key]);
  return `
    <label class="pg-switch">
      <span><strong>${escapeHtml(label)}</strong><small>${escapeHtml(hint)}</small></span>
      <input type="checkbox" data-pg-option="${String(key)}" ${checked ? 'checked' : ''} />
      <i aria-hidden="true"></i>
    </label>
  `;
}

function renderPasswordGeneratorWidget() {
  ensurePasswordGeneratorWidget();

  if (!passwordGeneratorRoot) return;

  const previousPanel = passwordGeneratorRoot.querySelector<HTMLElement>('.pg-panel');
  const previousScrollTop = previousPanel?.scrollTop ?? 0;
  const activeOption =
    passwordGeneratorRoot.activeElement instanceof HTMLInputElement
      ? {
          key: passwordGeneratorRoot.activeElement.dataset.pgOption,
          selectionStart: passwordGeneratorRoot.activeElement.selectionStart,
          selectionEnd: passwordGeneratorRoot.activeElement.selectionEnd
        }
      : null;
  const stablePanel = passwordGeneratorOpen && Boolean(previousPanel);

  const panel = passwordGeneratorOpen ? `
    <section class="pg-panel" role="dialog" aria-label="KeyPilot 密码生成器">
      <header data-pg-drag-handle="true" title="拖动移动密码生成器，双击恢复自动跟随输入框">
        <span class="pg-brand">${renderPasswordGeneratorIcon()}</span>
        <strong>密码生成器 - KeyPilot</strong>
        <button type="button" class="pg-icon-button" data-pg-action="close" aria-label="关闭密码生成器">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        </button>
      </header>
      <nav class="pg-tabs" aria-label="生成模式">
        <button type="button" class="active">随机密码</button>
        <button type="button" disabled>密匙口令</button>
      </nav>
      <div class="pg-output">
        <code>${escapeHtml(passwordGeneratorValue || '请选择字符类型')}</code>
        <button type="button" data-pg-action="copy" aria-label="复制生成的密码">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 8h10v12H8zM6 16H4V4h12v2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>
        </button>
        <button type="button" data-pg-action="refresh" aria-label="重新生成密码">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5M18.4 10A7 7 0 0 0 6.3 7.5M5.6 14a7 7 0 0 0 12.1 2.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </div>
      <div class="pg-strength-row">
        ${renderPasswordGeneratorStrength()}
        <button type="button" data-pg-action="preset-maximum">更强</button>
      </div>
      <button class="pg-fill" type="button" data-pg-action="fill" ${passwordGeneratorValue ? '' : 'disabled'}>
        以及填写密码
      </button>
      <section class="pg-options">
        <label class="pg-length">
          <span>字符数</span>
          <input type="number" min="4" max="132" value="${passwordGeneratorOptions.length}" data-pg-option="length" aria-label="密码字符数" />
        </label>
        <div class="pg-switches">
          ${renderPasswordGeneratorSwitch('大写', 'A-Z', 'uppercase')}
          ${renderPasswordGeneratorSwitch('小写', 'a-z', 'lowercase')}
          ${renderPasswordGeneratorSwitch('数字', '0-9', 'numbers')}
          ${renderPasswordGeneratorSwitch('符号', '!@#$', 'symbols')}
          ${renderPasswordGeneratorSwitch('排除相似字符', 'I、l、1、O、0', 'excludeSimilar')}
          ${renderPasswordGeneratorSwitch('每类至少 1 个', '启用类型都会出现', 'requireEveryType')}
        </div>
        <label class="pg-text-rule">
          <span>必须包含</span>
          <input type="text" value="${escapeHtml(passwordGeneratorOptions.requiredCharacters ?? '')}" data-pg-option="requiredCharacters" placeholder="@#A9" />
        </label>
        <label class="pg-text-rule">
          <span>排除字符</span>
          <input type="text" value="${escapeHtml(passwordGeneratorOptions.excludeCharacters ?? '')}" data-pg-option="excludeCharacters" placeholder="{}[]&quot;" />
        </label>
      </section>
      ${passwordGeneratorStatus ? `<p class="pg-status">${escapeHtml(passwordGeneratorStatus)}</p>` : ''}
    </section>
  ` : '';
  const fixedTrigger = passwordGeneratorManualPosition && passwordGeneratorOpen ? '' : passwordGeneratorInlineButton?.isConnected ? '' : `
    <button class="pg-trigger" type="button" data-pg-action="toggle" aria-label="打开 KeyPilot 密码生成器" title="点击打开；拖动调整位置；双击恢复自动跟随">
      ${renderPasswordGeneratorIcon()}
    </button>
  `;
  const shellClass = `pg-shell${passwordGeneratorManualPosition ? ' pg-manual' : ''}${passwordGeneratorOpen ? ' pg-open' : ''}${passwordGeneratorDragInProgress ? ' pg-dragging' : ''}${stablePanel ? ' pg-stable' : ''}`;

  passwordGeneratorRoot.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; }
      button, input { font: inherit; }
      button { cursor: pointer; }
      button:disabled { cursor: not-allowed; opacity: .55; }
      .pg-shell {
        position: relative;
        width: 100%;
        min-height: 34px;
      }
      .pg-trigger {
        position: absolute;
        top: 0;
        right: 0;
        display: grid;
        width: 34px;
        height: 34px;
        place-items: center;
        border: 1px solid #c9d9f4;
        border-radius: 10px;
        background: #ffffff;
        color: #2563eb;
        box-shadow: 0 10px 26px rgba(16, 24, 40, .18);
        pointer-events: auto;
        cursor: grab;
        touch-action: none;
        user-select: none;
        -webkit-user-drag: none;
        transition: transform 120ms ease-out, border-color 140ms ease-out, background 140ms ease-out;
      }
      .pg-trigger *,
      .pg-mark *,
      .pg-brand * {
        pointer-events: none;
        user-select: none;
        -webkit-user-drag: none;
      }
      .pg-trigger:active { cursor: grabbing; }
      .pg-trigger:hover { border-color: #9db9ef; background: #f8fbff; transform: translateY(-1px); }
      .pg-trigger:active { transform: translateY(1px); }
      .pg-manual .pg-trigger {
        left: 0;
        right: auto;
      }
      .pg-mark {
        position: relative;
        display: grid;
        width: 24px;
        height: 24px;
        place-items: center;
      }
      .pg-mark svg,
      .pg-mark img {
        position: absolute;
        inset: 0;
        width: 24px;
        height: 24px;
        display: block;
      }
      .pg-mark img { object-fit: contain; }
      .pg-panel {
        position: absolute;
        top: 42px;
        right: 0;
        display: grid;
        width: 340px;
        max-width: calc(100vw - 16px);
        max-height: min(620px, calc(100vh - 48px));
        overflow-x: hidden;
        overflow-y: auto;
        overscroll-behavior: contain;
        border: 1px solid #dfe7f3;
        border-radius: 12px;
        background: #ffffff;
        box-shadow: 0 20px 48px rgba(16, 24, 40, .22);
        color: #101828;
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
        pointer-events: auto;
        animation: pg-in 140ms ease-out both;
      }
      .pg-manual .pg-panel {
        left: 0;
        right: auto;
      }
      .pg-manual.pg-open .pg-panel {
        top: 0;
      }
      .pg-dragging .pg-panel {
        animation: none;
      }
      .pg-stable .pg-panel {
        animation: none;
      }
      .pg-panel::-webkit-scrollbar { width: 8px; }
      .pg-panel::-webkit-scrollbar-thumb {
        border: 2px solid transparent;
        border-radius: 999px;
        background: #cbd5e1;
        background-clip: padding-box;
      }
      @keyframes pg-in {
        from { opacity: 0; transform: translateY(-4px) scale(.98); }
        to { opacity: 1; transform: translateY(0) scale(1); }
      }
      @media (prefers-reduced-motion: reduce) {
        .pg-panel { animation: none; }
        .pg-trigger, .pg-fill, .pg-output button, .pg-strength-row button { transition: none; }
      }
      .pg-panel header {
        display: grid;
        grid-template-columns: 28px minmax(0, 1fr) 30px;
        align-items: center;
        gap: 9px;
        min-height: 46px;
        border-bottom: 1px solid #edf2f8;
        padding: 8px 10px;
        cursor: grab;
        user-select: none;
        touch-action: none;
      }
      .pg-panel header:active { cursor: grabbing; }
      .pg-brand {
        display: grid;
        width: 28px;
        height: 28px;
        place-items: center;
        border-radius: 8px;
        background: #eff6ff;
      }
      .pg-brand .pg-mark,
      .pg-brand .pg-mark svg,
      .pg-brand .pg-mark img {
        width: 24px;
        height: 24px;
      }
      .pg-panel header strong {
        overflow: hidden;
        color: #101828;
        font-size: 14px;
        font-weight: 760;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .pg-icon-button,
      .pg-output button {
        display: grid;
        place-items: center;
        border: 0;
        border-radius: 8px;
        background: transparent;
        color: #475467;
      }
      .pg-icon-button { width: 30px; height: 30px; }
      .pg-panel header .pg-icon-button { cursor: pointer; }
      .pg-icon-button:hover,
      .pg-output button:hover { background: #f2f6fc; color: #101828; }
      .pg-icon-button svg,
      .pg-output button svg { width: 18px; height: 18px; }
      .pg-tabs {
        display: grid;
        grid-template-columns: 1fr 1fr;
        border-bottom: 1px solid #edf2f8;
        background: #f8fafc;
      }
      .pg-tabs button {
        height: 38px;
        border: 0;
        background: transparent;
        color: #475467;
        font-size: 13px;
        font-weight: 700;
      }
      .pg-tabs .active {
        color: #2563eb;
        box-shadow: inset 0 -2px 0 #2563eb;
        background: #ffffff;
      }
      .pg-output {
        display: grid;
        grid-template-columns: minmax(0, 1fr) 34px 34px;
        align-items: center;
        gap: 6px;
        margin: 10px;
        border: 1px solid #e2e8f0;
        border-radius: 12px;
        background: #ffffff;
        padding: 10px 8px 10px 12px;
      }
      .pg-output code {
        overflow: hidden;
        color: #0f172a;
        font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
        font-size: 15px;
        font-weight: 760;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .pg-output button { width: 34px; height: 34px; }
      .pg-strength-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding: 0 12px 10px;
      }
      .pg-strength {
        display: inline-flex;
        align-items: center;
        gap: 7px;
        color: #dc2626;
        font-size: 13px;
        font-weight: 760;
      }
      .pg-strength.s3 { color: #d97706; }
      .pg-strength.s4,
      .pg-strength.s5 { color: #16a34a; }
      .pg-strength svg { width: 18px; height: 18px; }
      .pg-strength-row button {
        border: 0;
        background: transparent;
        color: #667085;
        font-size: 12px;
        font-weight: 700;
      }
      .pg-strength-row button:hover { color: #2563eb; }
      .pg-fill {
        min-height: 42px;
        margin: 0 10px 10px;
        border: 1px solid #dbe3ef;
        border-radius: 11px;
        background: #ffffff;
        color: #101828;
        font-size: 15px;
        font-weight: 760;
        transition: transform 120ms ease-out, border-color 140ms ease-out, background 140ms ease-out;
      }
      .pg-fill:hover { border-color: #bfdbfe; background: #f8fbff; transform: translateY(-1px); }
      .pg-fill:active { transform: translateY(1px); }
      .pg-options {
        display: grid;
        gap: 10px;
        margin: 0 10px 10px;
        border-radius: 12px;
        background: #f8fafc;
        padding: 12px;
      }
      .pg-length,
      .pg-text-rule {
        display: grid;
        gap: 6px;
      }
      .pg-length span,
      .pg-text-rule span {
        color: #344054;
        font-size: 12px;
        font-weight: 720;
      }
      .pg-length input,
      .pg-text-rule input {
        width: 100%;
        border: 1px solid #dbe3ef;
        border-radius: 9px;
        background: #ffffff;
        color: #101828;
        outline: 0;
        padding: 8px 10px;
        font-size: 13px;
      }
      .pg-length input:focus,
      .pg-text-rule input:focus {
        border-color: #2563eb;
        box-shadow: 0 0 0 3px rgba(37, 99, 235, .12);
      }
      .pg-switches {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
      }
      .pg-switch {
        position: relative;
        display: grid;
        grid-template-columns: minmax(0, 1fr) 34px;
        align-items: center;
        gap: 8px;
        min-height: 48px;
        border: 1px solid #e2e8f0;
        border-radius: 10px;
        background: #ffffff;
        padding: 8px;
        cursor: pointer;
      }
      .pg-switch strong,
      .pg-switch small {
        display: block;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .pg-switch strong { color: #101828; font-size: 12px; font-weight: 760; }
      .pg-switch small { margin-top: 2px; color: #667085; font-size: 11px; }
      .pg-switch input {
        position: absolute;
        opacity: 0;
        pointer-events: none;
      }
      .pg-switch i {
        position: relative;
        width: 34px;
        height: 20px;
        border-radius: 999px;
        background: #cbd5e1;
        transition: background 140ms ease-out;
      }
      .pg-switch i::after {
        content: "";
        position: absolute;
        top: 3px;
        left: 3px;
        width: 14px;
        height: 14px;
        border-radius: 999px;
        background: #ffffff;
        box-shadow: 0 1px 3px rgba(15, 23, 42, .22);
        transition: transform 140ms ease-out;
      }
      .pg-switch input:checked + i { background: #2563eb; }
      .pg-switch input:checked + i::after { transform: translateX(14px); }
      .pg-status {
        margin: 0;
        border-top: 1px solid #edf2f8;
        padding: 9px 12px;
        color: #2563eb;
        font-size: 12px;
        line-height: 1.45;
      }
    </style>
    <div class="${shellClass}">
      ${fixedTrigger}
      ${panel}
    </div>
  `;

  disableNativeDragGhost(passwordGeneratorRoot);

  if (stablePanel) {
    const nextPanel = passwordGeneratorRoot.querySelector<HTMLElement>('.pg-panel');
    if (nextPanel) nextPanel.scrollTop = previousScrollTop;

    if (activeOption?.key) {
      const nextInput = passwordGeneratorRoot.querySelector<HTMLInputElement>(`[data-pg-option="${cssAttr(activeOption.key)}"]`);
      if (nextInput && nextInput.type !== 'checkbox') {
        nextInput.focus({ preventScroll: true });
        if (activeOption.selectionStart !== null && activeOption.selectionEnd !== null) {
          try {
            nextInput.setSelectionRange(activeOption.selectionStart, activeOption.selectionEnd);
          } catch {
            // Some input types such as number do not support selection ranges.
          }
        }
      }
    }
  }

  passwordGeneratorRoot.querySelectorAll<HTMLElement>('[data-pg-action]').forEach((element) => {
    element.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (Date.now() < passwordGeneratorDragSuppressClickUntil) return;

      const action = element.dataset.pgAction;

      if (action === 'toggle') {
        passwordGeneratorOpen = !passwordGeneratorOpen;
        passwordGeneratorStatus = '';
        renderPasswordGeneratorWidget();
        positionPasswordGeneratorWidget();
        return;
      }

      if (action === 'close') {
        passwordGeneratorOpen = false;
        passwordGeneratorStatus = '';
        renderPasswordGeneratorWidget();
        positionPasswordGeneratorWidget();
        return;
      }

      if (action === 'refresh') {
        passwordGeneratorValue = generatePassword(passwordGeneratorOptions);
        passwordGeneratorStatus = '已重新生成。';
        renderPasswordGeneratorWidget();
        return;
      }

      if (action === 'preset-maximum') {
        updatePasswordGeneratorOptions({
          length: 28,
          symbols: true,
          excludeSimilar: false,
          requireEveryType: true
        });
        passwordGeneratorStatus = '已切换为更高强度。';
        renderPasswordGeneratorWidget();
        return;
      }

      if (action === 'copy') {
        void copyPasswordGeneratorValue();
        return;
      }

      if (action === 'fill') {
        fillPasswordGeneratorValue();
      }
    });
  });

  attachPasswordGeneratorDragHandlers();

  passwordGeneratorRoot.querySelectorAll<HTMLImageElement>('img[data-pg-icon]').forEach((image) => {
    image.addEventListener('error', () => image.remove());
  });

  passwordGeneratorRoot.querySelectorAll<HTMLInputElement>('[data-pg-option]').forEach((input) => {
    const commit = () => {
      const key = input.dataset.pgOption as keyof PasswordGeneratorOptions | undefined;
      if (!key) return;

      if (input.type === 'checkbox') {
        updatePasswordGeneratorOptions({ [key]: input.checked } as Partial<PasswordGeneratorOptions>);
        return;
      }

      if (key === 'length') {
        updatePasswordGeneratorOptions({ length: Number(input.value) });
        return;
      }

      updatePasswordGeneratorOptions({ [key]: input.value } as Partial<PasswordGeneratorOptions>);
    };

    input.addEventListener('change', commit);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        commit();
      }
    });
  });
}

function attachPasswordGeneratorDragHandlers() {
  const trigger = passwordGeneratorRoot?.querySelector<HTMLElement>('.pg-trigger');

  if (trigger) {
    trigger.addEventListener('pointerdown', (event) => {
      beginPasswordGeneratorDrag(event, trigger);
    });

    trigger.addEventListener('dblclick', (event) => {
      event.preventDefault();
      event.stopPropagation();
      resetPasswordGeneratorPosition();
    });
  }

  const panelHandle = passwordGeneratorRoot?.querySelector<HTMLElement>('[data-pg-drag-handle]');

  if (panelHandle) {
    panelHandle.addEventListener('pointerdown', (event) => {
      beginPasswordGeneratorPanelDrag(event, panelHandle);
    });

    panelHandle.addEventListener('dblclick', (event) => {
      event.preventDefault();
      event.stopPropagation();
      resetPasswordGeneratorPosition();
    });
  }
}

async function copyPasswordGeneratorValue() {
  if (!passwordGeneratorValue) return;

  try {
    await navigator.clipboard.writeText(passwordGeneratorValue);
    passwordGeneratorStatus = '已复制到剪贴板。';
  } catch {
    passwordGeneratorStatus = '复制失败，请手动选中密码复制。';
  }

  renderPasswordGeneratorWidget();
}

function fillPasswordGeneratorValue() {
  const context = findPasswordGeneratorContext();

  if (!context || !passwordGeneratorValue) {
    passwordGeneratorStatus = '没有找到可以填写的新密码框。';
    renderPasswordGeneratorWidget();
    positionPasswordGeneratorWidget();
    return;
  }

  setNativeValue(context.passwordField, passwordGeneratorValue);

  if (context.confirmField && context.confirmField !== context.passwordField) {
    setNativeValue(context.confirmField, passwordGeneratorValue);
  }

  rememberCandidate('input');
  passwordGeneratorStatus = context.confirmField
    ? '已填写密码和确认密码。注册或登录成功后会提示保存。'
    : '已填写密码。注册或登录成功后会提示保存。';
  renderPasswordGeneratorWidget();
  positionPasswordGeneratorWidget();
}

function positionPasswordGeneratorWidget() {
  if (!passwordGeneratorHost) return;

  const context = findPasswordGeneratorContext();
  const anchor = getPasswordGeneratorAnchor(context);

  if (!context || !anchor) {
    removePasswordGeneratorInlineTrigger();
    passwordGeneratorHost.style.display = 'none';
    passwordGeneratorOpen = false;
    return;
  }

  if (passwordGeneratorManualPosition) {
    removePasswordGeneratorInlineTrigger();
    const panel = passwordGeneratorRoot?.querySelector<HTMLElement>('.pg-panel');
    const panelRect = panel?.getBoundingClientRect();
    const width = passwordGeneratorOpen ? Math.max(300, Math.ceil(panelRect?.width || 340)) : 34;
    const height = passwordGeneratorOpen
      ? Math.max(220, Math.ceil(Math.min(panelRect?.height || 560, Math.max(220, window.innerHeight - 48))))
      : 34;
    const position = clampFloatingPosition(passwordGeneratorManualPosition, width, height);
    passwordGeneratorManualPosition = position;
    passwordGeneratorHost.style.width = `${width}px`;
    passwordGeneratorHost.style.display = 'block';
    passwordGeneratorHost.style.left = `${position.x}px`;
    passwordGeneratorHost.style.top = `${position.y}px`;
    return;
  }

  const hadInlineTrigger = Boolean(passwordGeneratorInlineButton?.isConnected);
  const hasInlineTrigger = ensurePasswordGeneratorInlineTrigger(context);

  if (hadInlineTrigger !== hasInlineTrigger) {
    renderPasswordGeneratorWidget();
  }

  const rect = anchor.getBoundingClientRect();

  if (rect.width <= 0 || rect.height <= 0 || rect.bottom < 0 || rect.top > window.innerHeight) {
    passwordGeneratorHost.style.display = 'none';
    passwordGeneratorOpen = false;
    return;
  }

  const width = passwordGeneratorOpen ? 340 : 34;
  const left = Math.max(8, Math.min(window.innerWidth - width - 8, rect.right - width - 6));
  const top = Math.max(8, Math.min(window.innerHeight - 44, rect.top + Math.max(0, (rect.height - 34) / 2)));

  passwordGeneratorHost.style.width = `${width}px`;
  passwordGeneratorHost.style.display = hasInlineTrigger && !passwordGeneratorOpen ? 'none' : 'block';
  passwordGeneratorHost.style.left = `${left}px`;
  passwordGeneratorHost.style.top = `${top}px`;
}

function schedulePasswordGeneratorPosition() {
  if (passwordGeneratorDragInProgress || (passwordGeneratorManualPosition && passwordGeneratorOpen)) return;

  if (passwordGeneratorPositionTimer) {
    window.clearTimeout(passwordGeneratorPositionTimer);
  }

  passwordGeneratorPositionTimer = window.setTimeout(() => {
    if (passwordGeneratorDragInProgress || (passwordGeneratorManualPosition && passwordGeneratorOpen)) return;

    renderPasswordGeneratorWidget();
    positionPasswordGeneratorWidget();
  }, 60);
}

function startInlinePasswordGenerator() {
  if (!document.documentElement) return;

  ensurePasswordGeneratorWidget();
  renderPasswordGeneratorWidget();
  schedulePasswordGeneratorPosition();

  document.addEventListener('focusin', (event) => {
    if (event.target instanceof HTMLInputElement) {
      schedulePasswordGeneratorPosition();
    }
  }, true);

  document.addEventListener('input', (event) => {
    if (event.target instanceof HTMLInputElement) {
      schedulePasswordGeneratorPosition();
    }
  }, true);

  document.addEventListener('pointerdown', (event) => {
    if (!passwordGeneratorHost || !passwordGeneratorOpen) return;
    const path = event.composedPath();
    if (!path.includes(passwordGeneratorHost)) {
      passwordGeneratorOpen = false;
      passwordGeneratorStatus = '';
      renderPasswordGeneratorWidget();
      positionPasswordGeneratorWidget();
    }
  }, true);

  window.addEventListener('scroll', schedulePasswordGeneratorPosition, true);
  window.addEventListener('resize', schedulePasswordGeneratorPosition);

  const observer = new MutationObserver((mutations) => {
    if (shouldIgnoreKeyPilotMutations(mutations)) return;
    schedulePasswordGeneratorPosition();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'type', 'autocomplete'] });
}

function getPasswordGeneratorDiagnostic() {
  const passwordFields = getAllVisibleInputs(document).filter((input) => isPasswordInput(input) && !isCurrentPasswordField(input));
  const context = findPasswordGeneratorContext();
  const anchor = getPasswordGeneratorAnchor(context);

  return {
    ok: true,
    url: window.location.href,
    title: document.title,
    pageLooksLikeRegistration: pageLooksLikeRegistration(),
    passwordFieldsLookLikeRegistration: passwordFieldsLookLikeRegistration(passwordFields),
    passwordFieldCount: passwordFields.length,
    fields: passwordFields.map((input) => {
      const rect = input.getBoundingClientRect();
      return {
        name: input.name,
        type: input.type,
        autocomplete: input.autocomplete,
        placeholder: input.placeholder,
        label: fieldLabel(input),
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        },
        registrationSignal: hasRegistrationPasswordSignal(input),
        confirmSignal: isConfirmPasswordField(input)
      };
    }),
    hasContext: Boolean(context),
    passwordFieldName: context?.passwordField.name,
    confirmFieldName: context?.confirmField?.name,
    anchorName: anchor?.name,
    hostDisplay: passwordGeneratorHost?.style.display,
    hostLeft: passwordGeneratorHost?.style.left,
    hostTop: passwordGeneratorHost?.style.top,
    inlineSuppressed: !getInlineAnchor()
  };
}

function truncateDebugText(value: string | null | undefined, maxLength = 140): string | undefined {
  const text = compactText(value ?? '');
  if (!text) return undefined;
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function debugRect(element: Element): DebugRect {
  const rect = element.getBoundingClientRect();

  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
    right: Math.round(rect.right),
    bottom: Math.round(rect.bottom),
    inViewport: rect.bottom >= 0 && rect.right >= 0 && rect.top <= window.innerHeight && rect.left <= window.innerWidth
  };
}

function debugClassName(element: Element): string | undefined {
  const className = element instanceof HTMLElement ? element.className : '';
  return typeof className === 'string' ? truncateDebugText(className, 90) : undefined;
}

function debugElementSummary(element: Element | null | undefined): DebugElementSummary | undefined {
  if (!element) return undefined;

  return {
    selector: elementSelector(element),
    tagName: element.tagName.toLowerCase(),
    id: element.id || undefined,
    name: element.getAttribute('name') || undefined,
    className: debugClassName(element),
    text: truncateDebugText(element.textContent, 120),
    rect: debugRect(element)
  };
}

function debugScopeSummary(scope: ParentNode | null | undefined): DebugElementSummary | undefined {
  if (!scope) return undefined;
  if (scope === document) {
    return {
      tagName: 'document',
      text: 'document'
    };
  }

  return scope instanceof Element ? debugElementSummary(scope) : undefined;
}

function getInputDebugInfo(input: HTMLInputElement, index: number): RecognitionInputDebug {
  const autocomplete = input.getAttribute('autocomplete') || input.autocomplete || undefined;

  return {
    index,
    selector: elementSelector(input),
    type: input.type || 'text',
    name: input.name || undefined,
    id: input.id || undefined,
    autocomplete,
    placeholder: truncateDebugText(input.placeholder, 90),
    ariaLabel: truncateDebugText(input.getAttribute('aria-label'), 90),
    label: truncateDebugText(fieldLabel(input), 90),
    className: debugClassName(input),
    visible: isVisibleInput(input),
    disabled: input.disabled,
    readOnly: input.readOnly,
    hasValue: Boolean(input.value),
    valueLength: input.value.length,
    usernameCandidate: isUsernameInput(input),
    usernameScore: Math.round(scoreUsernameInput(input)),
    passwordCandidate: isPasswordInput(input),
    unsafeReason: getUnsafeReason(input),
    currentPasswordSignal: isCurrentPasswordField(input),
    registrationSignal: hasRegistrationPasswordSignal(input),
    explicitRegistrationSignal: hasExplicitRegistrationPasswordSignal(input),
    confirmSignal: isConfirmPasswordField(input),
    rect: debugRect(input),
    form: debugElementSummary(input.closest('form'))
  };
}

function getInlineLoginAnchorDecision() {
  if (pageLooksLikeRegistration()) {
    return {
      available: false,
      reason: 'pageLooksLikeRegistration=true, 当前页面被判定为注册/申请页。'
    };
  }

  const passwordFields = getAllVisibleInputs(document).filter((input) => isPasswordInput(input) && !isCurrentPasswordField(input));
  if (passwordFieldsLookLikeRegistration(passwordFields)) {
    return {
      available: false,
      reason: 'passwordFieldsLookLikeRegistration=true, 密码框被判定为新密码/确认密码。'
    };
  }

  const context = findLoginContext();
  if (!context?.usernameField && !context?.passwordField) {
    return {
      available: false,
      reason: 'findLoginContext 没有找到用户名框或密码框。'
    };
  }

  const generatorContext = findPasswordGeneratorContext();
  if (generatorContext) {
    return {
      available: false,
      reason: 'findPasswordGeneratorContext 命中，页面当前被密码生成器占用。',
      anchor: generatorContext.passwordField
    };
  }

  return {
    available: true,
    reason: '登录图标应该显示。',
    anchor: context.usernameField ?? context.passwordField
  };
}

function getRecognitionDebugSnapshot() {
  const allInputs = Array.from(document.querySelectorAll<HTMLInputElement>('input'));
  const inputIndex = new Map(allInputs.map((input, index) => [input, index]));
  const visibleInputs = getAllVisibleInputs(document);
  const passwordFields = visibleInputs.filter(isPasswordInput);
  const nonCurrentPasswordFields = passwordFields.filter((input) => !isCurrentPasswordField(input));
  const usernameCandidates = visibleInputs
    .filter((input) => isUsernameInput(input))
    .sort((left, right) => scoreUsernameInput(right) - scoreUsernameInput(left));
  const loginContext = findLoginContext();
  const generatorContext = findPasswordGeneratorContext();
  const inlineLoginDecision = getInlineLoginAnchorDecision();
  const inlineLoginAnchor = inlineLoginDecision.anchor ?? null;
  const fillProfileAnchor = getFillProfileInlineAnchor();
  const finalInlineAnchor = getInlineAnchor();
  const passwordGeneratorAnchor = getPasswordGeneratorAnchor(generatorContext);
  const inputDebugIndex = (input?: HTMLInputElement | null) => (input ? inputIndex.get(input) : undefined);

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    frame: {
      isTopFrame: window.top === window,
      url: window.location.href,
      domain: window.location.hostname.replace(/^www\./i, '').toLowerCase(),
      title: document.title,
      readyState: document.readyState,
      visibilityState: document.visibilityState,
      referrer: document.referrer || undefined,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        scrollX: Math.round(window.scrollX),
        scrollY: Math.round(window.scrollY)
      }
    },
    signals: {
      loginUrl: pageLooksLikeLoginUrl(),
      registrationPage: pageLooksLikeRegistration(),
      passwordFieldsLookLikeRegistration: passwordFieldsLookLikeRegistration(nonCurrentPasswordFields),
      activeElement: document.activeElement instanceof Element ? debugElementSummary(document.activeElement) : undefined
    },
    counts: {
      inputs: allInputs.length,
      visibleInputs: visibleInputs.length,
      usernameCandidates: usernameCandidates.length,
      passwordFields: passwordFields.length,
      nonCurrentPasswordFields: nonCurrentPasswordFields.length,
      inlineCredentialMatches: inlineMatches.length,
      inlineFillProfiles: inlineFillProfiles.length
    },
    decisions: {
      inlineLoginAnchor: {
        available: inlineLoginDecision.available,
        reason: inlineLoginDecision.reason,
        inputIndex: inputDebugIndex(inlineLoginAnchor),
        element: debugElementSummary(inlineLoginAnchor)
      },
      fillProfileAnchor: {
        available: Boolean(fillProfileAnchor),
        inputIndex: inputDebugIndex(fillProfileAnchor),
        element: debugElementSummary(fillProfileAnchor)
      },
      finalInlineAnchor: {
        available: Boolean(finalInlineAnchor),
        inputIndex: inputDebugIndex(finalInlineAnchor),
        element: debugElementSummary(finalInlineAnchor)
      },
      passwordGenerator: {
        hasContext: Boolean(generatorContext),
        anchorIndex: inputDebugIndex(passwordGeneratorAnchor),
        passwordFieldIndex: inputDebugIndex(generatorContext?.passwordField),
        confirmFieldIndex: inputDebugIndex(generatorContext?.confirmField),
        usernameFieldIndex: inputDebugIndex(generatorContext?.usernameField),
        anchor: debugElementSummary(passwordGeneratorAnchor)
      }
    },
    contexts: {
      login: {
        hasContext: Boolean(loginContext),
        unsafeReason: loginContext?.unsafeReason,
        form: debugElementSummary(loginContext?.form),
        scope: debugScopeSummary(loginContext?.scope),
        usernameFieldIndex: inputDebugIndex(loginContext?.usernameField),
        passwordFieldIndex: inputDebugIndex(loginContext?.passwordField),
        usernameField: debugElementSummary(loginContext?.usernameField),
        passwordField: debugElementSummary(loginContext?.passwordField)
      },
      generator: {
        hasContext: Boolean(generatorContext),
        scope: debugScopeSummary(generatorContext?.scope),
        passwordField: debugElementSummary(generatorContext?.passwordField),
        confirmField: debugElementSummary(generatorContext?.confirmField),
        usernameField: debugElementSummary(generatorContext?.usernameField)
      }
    },
    inline: {
      locked: inlineLocked,
      suppressed: inlineSuppressed,
      menuOpen: inlineMenuOpen,
      status: inlineStatus || undefined,
      hostDisplay: inlineHost?.style.display,
      hostLeft: inlineHost?.style.left,
      hostTop: inlineHost?.style.top,
      hostWidth: inlineHost?.style.width,
      matches: inlineMatches.map((match) => ({
        title: match.title,
        domain: match.domain,
        hasUsername: Boolean(match.username),
        hasIcon: Boolean(match.iconUrl),
        lastUsedAt: match.lastUsedAt
      })),
      fillProfiles: inlineFillProfiles.map((profile) => ({
        title: profile.title,
        category: profile.category,
        countryCode: profile.countryCode,
        fieldCount: profile.fieldCount,
        hasSiteBinding: Boolean(profile.siteBinding)
      }))
    },
    passwordGenerator: getPasswordGeneratorDiagnostic(),
    inputs: allInputs.map((input, index) => getInputDebugInfo(input, index))
  };
}

function renderDebugBadge(label: string, value: boolean): string {
  return `<span class="badge ${value ? 'ok' : 'bad'}"><b>${escapeHtml(label)}</b>${value ? '是' : '否'}</span>`;
}

function renderDebugElementLink(label: string, inputIndex: number | undefined, element: DebugElementSummary | undefined): string {
  const title = element?.selector ?? element?.tagName ?? '未识别';
  const button = typeof inputIndex === 'number'
    ? `<button type="button" data-debug-field-index="${inputIndex}">定位 #${inputIndex}</button>`
    : '<span>无</span>';

  return `
    <div class="anchor-row">
      <span>${escapeHtml(label)}</span>
      <strong title="${escapeHtml(title)}">${escapeHtml(title)}</strong>
      ${button}
    </div>
  `;
}

function renderRecognitionInputs(inputs: RecognitionInputDebug[]): string {
  return inputs
    .map((input) => {
      const role = input.passwordCandidate
        ? '密码'
        : input.usernameCandidate
          ? '登录名'
          : input.registrationSignal
            ? '注册信号'
            : '输入框';
      const flags = [
        input.visible ? 'visible' : 'hidden',
        input.disabled ? 'disabled' : '',
        input.readOnly ? 'readonly' : '',
        input.unsafeReason ? `unsafe:${input.unsafeReason}` : '',
        input.currentPasswordSignal ? 'current-password' : '',
        input.registrationSignal ? 'registration' : '',
        input.explicitRegistrationSignal ? 'explicit-registration' : '',
        input.confirmSignal ? 'confirm' : '',
        input.hasValue ? `value:${input.valueLength}` : 'empty'
      ].filter(Boolean);

      return `
        <button class="field-row" type="button" data-debug-field-index="${input.index}">
          <span class="field-index">#${input.index}</span>
          <span class="field-main">
            <strong>${escapeHtml(input.label || input.name || input.id || input.placeholder || input.type)}</strong>
            <small>${escapeHtml(input.selector || `${input.type} input`)}</small>
          </span>
          <span class="field-role">${escapeHtml(role)}</span>
          <span class="field-flags">${escapeHtml(flags.join(' · '))}</span>
        </button>
      `;
    })
    .join('');
}

function ensureRecognitionDebugPanel() {
  if (recognitionDebugHost && recognitionDebugRoot) return;

  recognitionDebugHost = document.createElement('div');
  recognitionDebugHost.id = 'keypilot-recognition-debug-root';
  recognitionDebugHost.style.position = 'fixed';
  recognitionDebugHost.style.zIndex = '2147483647';
  recognitionDebugHost.style.top = '18px';
  recognitionDebugHost.style.right = '18px';
  recognitionDebugHost.style.width = '440px';
  recognitionDebugHost.style.maxWidth = 'calc(100vw - 24px)';
  recognitionDebugHost.style.maxHeight = 'calc(100vh - 36px)';
  recognitionDebugHost.style.display = 'none';
  recognitionDebugHost.style.colorScheme = 'light';
  recognitionDebugRoot = recognitionDebugHost.attachShadow({ mode: 'open' });
  recognitionDebugRoot.addEventListener('click', handleRecognitionDebugClick);
  document.documentElement.appendChild(recognitionDebugHost);

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && recognitionDebugOpen) {
      void toggleRecognitionDebugPanel(false);
    }
  });
}

function renderRecognitionDebugPanel() {
  if (!recognitionDebugRoot || !recognitionDebugHost) return;

  const snapshot = getRecognitionDebugSnapshot();
  const loginAvailable = snapshot.decisions.inlineLoginAnchor.available;
  const generatorActive = snapshot.decisions.passwordGenerator.hasContext;
  const conclusion = loginAvailable
    ? '当前页面应显示登录填充按钮。如果网页上看不到，重点检查 floating host 位置或页面遮挡。'
    : generatorActive
      ? '当前页面被识别成密码生成场景，登录图标被压制。请查看下面的注册/新密码信号。'
      : snapshot.signals.registrationPage || snapshot.signals.passwordFieldsLookLikeRegistration
        ? '当前页面被识别成注册/新密码页面，所以不会显示登录按钮。'
        : '没有得到可用的登录锚点，请查看输入框可见性、字段类型和用户名候选评分。';

  recognitionDebugHost.style.display = recognitionDebugOpen ? 'block' : 'none';
  recognitionDebugRoot.innerHTML = `
    <style>
      :host {
        all: initial;
        color-scheme: light;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
      }

      * {
        box-sizing: border-box;
      }

      .panel {
        overflow: hidden;
        border: 1px solid #d8e2ef;
        border-radius: 12px;
        background: #ffffff;
        color: #0f172a;
        box-shadow: 0 18px 42px rgba(15, 23, 42, 0.18);
        animation: panel-in 150ms ease-out both;
      }

      header {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto auto auto auto;
        align-items: center;
        gap: 8px;
        border-bottom: 1px solid #e7edf5;
        padding: 12px;
      }

      header strong,
      header span {
        display: block;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      header strong {
        color: #071432;
        font-size: 15px;
        font-weight: 760;
        line-height: 1.2;
      }

      header span {
        margin-top: 2px;
        color: #607089;
        font-size: 12px;
      }

      button {
        border: 1px solid #d7e2f2;
        border-radius: 8px;
        background: #ffffff;
        color: #1f3556;
        font: inherit;
        font-size: 12px;
        font-weight: 700;
        cursor: pointer;
        transition: transform 120ms ease, border-color 150ms ease, background-color 150ms ease, color 150ms ease;
      }

      button:hover {
        border-color: #9bbcff;
        background: #f7faff;
        color: #165dff;
      }

      button:active {
        transform: translateY(1px);
      }

      .header-button {
        height: 32px;
        padding: 0 10px;
      }

      .close-button {
        width: 32px;
        padding: 0;
        font-size: 18px;
      }

      main {
        max-height: calc(100vh - 106px);
        overflow: auto;
        scrollbar-gutter: stable;
        background: #f6f8fc;
      }

      main::-webkit-scrollbar {
        width: 9px;
      }

      main::-webkit-scrollbar-thumb {
        border: 2px solid #f6f8fc;
        border-radius: 999px;
        background: #aebbd0;
        background-clip: content-box;
      }

      section {
        margin: 10px;
        border: 1px solid #e1e8f3;
        border-radius: 10px;
        background: #ffffff;
      }

      section h3 {
        margin: 0;
        border-bottom: 1px solid #edf2f8;
        padding: 10px 12px;
        color: #1f3556;
        font-size: 13px;
        font-weight: 760;
      }

      .bad-box,
      .ok-box {
        padding: 12px;
      }

      .ok-box {
        border-left: 3px solid #16a34a;
      }

      .bad-box {
        border-left: 3px solid #f59e0b;
      }

      .bad-box p,
      .ok-box p {
        margin: 0;
        color: #344054;
        font-size: 12px;
        line-height: 1.55;
      }

      .badge-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 8px;
        padding: 10px;
      }

      .badge {
        display: flex;
        min-width: 0;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        border-radius: 8px;
        padding: 8px 10px;
        font-size: 12px;
        font-weight: 700;
      }

      .badge b {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .badge.ok {
        background: #ecfdf3;
        color: #12823c;
      }

      .badge.bad {
        background: #fff7ed;
        color: #b45309;
      }

      .kv,
      .anchor-row {
        display: grid;
        grid-template-columns: 105px minmax(0, 1fr) auto;
        align-items: center;
        gap: 8px;
        border-bottom: 1px solid #edf2f8;
        padding: 9px 12px;
        color: #344054;
        font-size: 12px;
      }

      .kv:last-child,
      .anchor-row:last-child {
        border-bottom: 0;
      }

      .kv span,
      .anchor-row span {
        color: #667085;
      }

      .kv strong,
      .anchor-row strong {
        overflow: hidden;
        color: #0f172a;
        font-size: 12px;
        font-weight: 720;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .anchor-row button {
        min-height: 28px;
        padding: 0 9px;
      }

      .field-list {
        display: grid;
        max-height: 320px;
        overflow: auto;
      }

      .field-list::-webkit-scrollbar {
        width: 8px;
      }

      .field-list::-webkit-scrollbar-thumb {
        border: 2px solid #ffffff;
        border-radius: 999px;
        background: #aebbd0;
        background-clip: content-box;
      }

      .field-row {
        display: grid;
        grid-template-columns: 42px minmax(0, 1fr) 58px;
        gap: 8px;
        align-items: center;
        width: 100%;
        min-height: 54px;
        border: 0;
        border-bottom: 1px solid #edf2f8;
        border-radius: 0;
        padding: 8px 10px;
        background: #ffffff;
        color: #0f172a;
        text-align: left;
      }

      .field-row:hover {
        background: #f8fbff;
      }

      .field-index {
        display: inline-grid;
        width: 32px;
        height: 28px;
        place-items: center;
        border: 1px solid #cfe0ff;
        border-radius: 8px;
        background: #eff6ff;
        color: #165dff;
        font-size: 12px;
        font-weight: 760;
      }

      .field-main {
        display: grid;
        min-width: 0;
        gap: 2px;
      }

      .field-main strong,
      .field-main small,
      .field-flags {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .field-main strong {
        color: #0f172a;
        font-size: 12px;
        font-weight: 760;
      }

      .field-main small,
      .field-flags {
        color: #667085;
        font-size: 11px;
      }

      .field-role {
        justify-self: end;
        border-radius: 999px;
        padding: 4px 7px;
        background: #eef4ff;
        color: #165dff;
        font-size: 11px;
        font-weight: 760;
      }

      .field-flags {
        grid-column: 2 / 4;
      }

      .status {
        min-height: 30px;
        padding: 0 12px 12px;
        color: #16a34a;
        font-size: 12px;
        font-weight: 700;
      }

      @keyframes panel-in {
        from {
          opacity: 0;
          transform: translate3d(10px, -8px, 0);
        }

        to {
          opacity: 1;
          transform: translate3d(0, 0, 0);
        }
      }

      @media (prefers-reduced-motion: reduce) {
        .panel {
          animation: none;
        }

        button {
          transition: none;
        }
      }
    </style>
    <div class="panel" role="dialog" aria-label="KeyPilot 页面识别调试">
      <header>
        <div>
          <strong>KeyPilot 页面识别调试</strong>
          <span>${escapeHtml(snapshot.frame.domain || snapshot.frame.url)}</span>
        </div>
        <button class="header-button" type="button" data-debug-action="apply-login-rule">设为登录页</button>
        <button class="header-button" type="button" data-debug-action="refresh">刷新</button>
        <button class="header-button" type="button" data-debug-action="copy">复制诊断</button>
        <button class="close-button" type="button" data-debug-action="close" aria-label="关闭">×</button>
      </header>
      <main>
        <section>
          <div class="${loginAvailable ? 'ok-box' : 'bad-box'}">
            <p>${escapeHtml(conclusion)}</p>
            <p>${escapeHtml(snapshot.decisions.inlineLoginAnchor.reason)}</p>
          </div>
          <div class="badge-grid">
            ${renderDebugBadge('登录 URL', snapshot.signals.loginUrl)}
            ${renderDebugBadge('注册页面', snapshot.signals.registrationPage)}
            ${renderDebugBadge('密码框像注册', snapshot.signals.passwordFieldsLookLikeRegistration)}
            ${renderDebugBadge('登录图标可用', loginAvailable)}
            ${renderDebugBadge('生成器命中', generatorActive)}
            ${renderDebugBadge('最终有锚点', snapshot.decisions.finalInlineAnchor.available)}
          </div>
        </section>

        <section>
          <h3>当前状态</h3>
          <div class="kv"><span>输入框</span><strong>${snapshot.counts.visibleInputs}/${snapshot.counts.inputs} 可见</strong><span></span></div>
          <div class="kv"><span>用户名候选</span><strong>${snapshot.counts.usernameCandidates}</strong><span></span></div>
          <div class="kv"><span>密码框</span><strong>${snapshot.counts.nonCurrentPasswordFields}</strong><span></span></div>
          <div class="kv"><span>匹配账号</span><strong>${snapshot.counts.inlineCredentialMatches}</strong><span></span></div>
          <div class="kv"><span>身份资料</span><strong>${snapshot.counts.inlineFillProfiles}</strong><span></span></div>
          <div class="kv"><span>浮动容器</span><strong>${escapeHtml(snapshot.inline.hostDisplay || 'none')} ${escapeHtml(snapshot.inline.hostLeft || '')} ${escapeHtml(snapshot.inline.hostTop || '')}</strong><span></span></div>
        </section>

        <section>
          <h3>锚点判断</h3>
          ${renderDebugElementLink('登录锚点', snapshot.decisions.inlineLoginAnchor.inputIndex, snapshot.decisions.inlineLoginAnchor.element)}
          ${renderDebugElementLink('身份锚点', snapshot.decisions.fillProfileAnchor.inputIndex, snapshot.decisions.fillProfileAnchor.element)}
          ${renderDebugElementLink('最终锚点', snapshot.decisions.finalInlineAnchor.inputIndex, snapshot.decisions.finalInlineAnchor.element)}
          ${renderDebugElementLink('生成器锚点', snapshot.decisions.passwordGenerator.anchorIndex, snapshot.decisions.passwordGenerator.anchor)}
        </section>

        <section>
          <h3>登录上下文</h3>
          ${renderDebugElementLink('用户名框', snapshot.contexts.login.usernameFieldIndex, snapshot.contexts.login.usernameField)}
          ${renderDebugElementLink('密码框', snapshot.contexts.login.passwordFieldIndex, snapshot.contexts.login.passwordField)}
          <div class="kv"><span>表单</span><strong>${escapeHtml(snapshot.contexts.login.form?.selector || snapshot.contexts.login.form?.tagName || '无')}</strong><span></span></div>
          <div class="kv"><span>作用域</span><strong>${escapeHtml(snapshot.contexts.login.scope?.selector || snapshot.contexts.login.scope?.tagName || '无')}</strong><span></span></div>
          <div class="kv"><span>安全字段</span><strong>${escapeHtml(snapshot.contexts.login.unsafeReason || '无')}</strong><span></span></div>
        </section>

        <section>
          <h3>输入框明细，点击可定位</h3>
          <div class="field-list">
            ${renderRecognitionInputs(snapshot.inputs)}
          </div>
        </section>
        ${recognitionDebugCopyStatus ? `<div class="status">${escapeHtml(recognitionDebugCopyStatus)}</div>` : ''}
      </main>
    </div>
  `;
}

function highlightDebugElement(element: HTMLElement) {
  const previousOutline = element.style.outline;
  const previousOutlineOffset = element.style.outlineOffset;

  element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
  element.style.outline = '3px solid #2563eb';
  element.style.outlineOffset = '3px';

  window.setTimeout(() => {
    element.style.outline = previousOutline;
    element.style.outlineOffset = previousOutlineOffset;
  }, 1600);
}

async function copyRecognitionDebugSnapshot() {
  const snapshot = getRecognitionDebugSnapshot();
  const text = JSON.stringify(snapshot, null, 2);

  try {
    await navigator.clipboard.writeText(text);
    recognitionDebugCopyStatus = '已复制诊断结果，里面不包含输入框真实内容，只包含字段结构和长度。';
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    document.documentElement.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    textarea.remove();
    recognitionDebugCopyStatus = '已复制诊断结果。';
  }

  renderRecognitionDebugPanel();
}

async function refreshRecognitionDebugPanel() {
  recognitionDebugCopyStatus = '正在刷新识别状态...';
  renderRecognitionDebugPanel();
  await refreshInlineMatches().catch(() => undefined);
  positionInlineWidget();
  positionPasswordGeneratorWidget();
  recognitionDebugCopyStatus = '已刷新识别状态。';
  renderRecognitionDebugPanel();
}

function handleRecognitionDebugClick(event: Event) {
  const target = event.target instanceof Element ? event.target : null;
  const action = target?.closest<HTMLElement>('[data-debug-action]')?.dataset.debugAction;

  if (action === 'close') {
    void toggleRecognitionDebugPanel(false);
    return;
  }

  if (action === 'refresh') {
    void refreshRecognitionDebugPanel();
    return;
  }

  if (action === 'copy') {
    void copyRecognitionDebugSnapshot();
    return;
  }

  if (action === 'apply-login-rule') {
    void applyLoginRecognitionRule();
    return;
  }

  const fieldButton = target?.closest<HTMLElement>('[data-debug-field-index]');
  if (!fieldButton) return;

  const index = Number(fieldButton.dataset.debugFieldIndex);
  const input = Number.isFinite(index) ? Array.from(document.querySelectorAll<HTMLInputElement>('input'))[index] : undefined;
  if (input) {
    highlightDebugElement(input);
  }
}

async function toggleRecognitionDebugPanel(open = !recognitionDebugOpen) {
  ensureRecognitionDebugPanel();
  recognitionDebugOpen = open;

  if (!recognitionDebugOpen) {
    if (recognitionDebugHost) recognitionDebugHost.style.display = 'none';
    return { ok: true, open: false };
  }

  recognitionDebugCopyStatus = '';
  renderRecognitionDebugPanel();
  await refreshInlineMatches().catch(() => undefined);
  renderRecognitionDebugPanel();
  return {
    ok: true,
    open: true,
    snapshot: getRecognitionDebugSnapshot()
  };
}

function positionInlineWidget() {
  if (!inlineHost) return;

  if (inlineStateLoaded && !hasInlineContextualItems()) {
    hideInlineWidget();
    return;
  }

  const anchor = getInlineAnchor();

  if (!anchor) {
    hideInlineWidget();
    return;
  }

  if (inlineManualPosition) {
    const width = inlineMenuOpen ? INLINE_MENU_WIDTH : INLINE_TRIGGER_SIZE;
    const height = inlineMenuOpen ? INLINE_MENU_MAX_HEIGHT + 58 : INLINE_TRIGGER_SIZE;
    const position = clampFloatingPosition(inlineManualPosition, width, height);
    inlineManualPosition = position;
    inlineHost.style.width = `${width}px`;
    inlineHost.style.display = 'block';
    inlineHost.style.left = `${position.x}px`;
    inlineHost.style.top = `${position.y}px`;
    positionInlineMorePopover();
    return;
  }

  const rect = anchor.getBoundingClientRect();

  if (rect.width <= 0 || rect.height <= 0 || rect.bottom < 0 || rect.top > window.innerHeight) {
    hideInlineWidget();
    return;
  }

  const width = INLINE_MENU_WIDTH;
  const triggerSize = INLINE_TRIGGER_SIZE;
  const triggerLeftInHost = width - INLINE_TRIGGER_RIGHT_OFFSET - triggerSize;
  const desiredTriggerLeft = rect.right - Math.floor(triggerSize / 2);
  const desiredHostLeft = desiredTriggerLeft - triggerLeftInHost;
  const desiredHostTop = rect.top + rect.height / 2 - triggerSize / 2;
  const left = Math.max(8, Math.min(window.innerWidth - width - 8, desiredHostLeft));
  const top = Math.max(8, Math.min(window.innerHeight - triggerSize - 8, desiredHostTop));

  inlineHost.style.width = `${INLINE_MENU_WIDTH}px`;
  inlineHost.style.display = 'block';
  inlineHost.style.left = `${left}px`;
  inlineHost.style.top = `${top}px`;
  positionInlineMorePopover();
}

function scheduleInlinePosition() {
  if (inlinePositionTimer) {
    window.clearTimeout(inlinePositionTimer);
  }

  inlinePositionTimer = window.setTimeout(() => {
    positionInlineWidget();
  }, 50);
}

function scheduleInlineRefresh(delay = 160) {
  if (Date.now() < inlineRefreshSuppressedUntil) {
    return;
  }

  if (inlineRefreshTimer) {
    window.clearTimeout(inlineRefreshTimer);
  }

  inlineRefreshTimer = window.setTimeout(() => {
    if (Date.now() < inlineRefreshSuppressedUntil) {
      inlineRefreshTimer = null;
      return;
    }

    void refreshInlineMatches();
  }, delay);
}

function stabilizeInlineMatches(nextMatches: InlineCredentialSummary[]): InlineCredentialSummary[] {
  if (!inlineMenuOpen || inlineMatches.length <= 1 || nextMatches.length <= 1) {
    return nextMatches;
  }

  const previousOrder = new Map(inlineMatches.map((match, index) => [match.id, index]));
  const nextOrder = new Map(nextMatches.map((match, index) => [match.id, index]));

  return [...nextMatches].sort((left, right) => {
    const leftPrevious = previousOrder.get(left.id);
    const rightPrevious = previousOrder.get(right.id);

    if (leftPrevious !== undefined && rightPrevious !== undefined) {
      return leftPrevious - rightPrevious;
    }

    if (leftPrevious !== undefined) return -1;
    if (rightPrevious !== undefined) return 1;

    return (nextOrder.get(left.id) ?? 0) - (nextOrder.get(right.id) ?? 0);
  });
}

async function refreshInlineMatches() {
  if (Date.now() < inlineRefreshSuppressedUntil) {
    return;
  }

  if (inlineSuppressed) {
    inlineMatches = [];
    inlineFillProfiles = [];
    inlineMoreCredentialId = null;
    inlineMoreProfileId = null;
    hideInlineWidget();
    return;
  }

  const needsLoadingRender = inlineMenuOpen && !inlineMatches.length && !inlineFillProfiles.length;

  if (needsLoadingRender) {
    inlineStatus = '正在读取 KeyPilot 状态...';
    renderInlineWidget();
    positionInlineWidget();
  }

  try {
    const response = await sendRuntimeMessage<InlineCredentialMatchesResult>({
      type: 'KEYPILOT_GET_INLINE_MATCHES'
    });

    if (Date.now() < inlineRefreshSuppressedUntil) {
      return;
    }

    inlineStateLoaded = true;
    inlineSiteRule = response.ok ? response.siteRule ?? null : null;

    if (response.hidden) {
      inlineSuppressed = true;
      inlineMatches = [];
      inlineFillProfiles = [];
      inlineMoreCredentialId = null;
      inlineMoreProfileId = null;
      hideInlineWidget();
      return;
    }

    inlineSuppressed = false;
    inlineMatches = stabilizeInlineMatches(response.ok ? response.matches ?? [] : []);
    inlineFillProfiles = response.ok ? response.fillProfiles ?? [] : [];
    inlineLocked = Boolean(response.locked);
    if (!getInlineAnchor() || !hasInlineContextualItems()) {
      inlineStatus = '';
      hideInlineWidget();
      return;
    }
    inlineStatus = response.locked
      ? 'KeyPilot 已锁定，请先打开插件解锁。'
      : inlineMatches.length || inlineFillProfiles.length
        ? ''
        : '当前网页没有匹配账号或身份资料。';
    renderInlineWidget();
    positionInlineWidget();
  } catch {
    inlineStateLoaded = true;
    inlineSiteRule = null;
    inlineMatches = [];
    inlineFillProfiles = [];
    inlineLocked = false;
    inlineStatus = '无法读取 KeyPilot 状态，请刷新网页或扩展。';
    renderInlineWidget();
    positionInlineWidget();
  }
}

async function handleInlineFill(credentialId: string, action: InlineCredentialFillRequest['action'], silent = false) {
  if (!silent) {
    inlineStatus = action === 'login' ? '正在填写并提交...' : '正在填表...';
    renderInlineWidget();
  }

  try {
    const response = await sendRuntimeMessage<FillCredentialResult & { locked?: boolean }>({
      type: 'KEYPILOT_INLINE_FILL',
      request: { credentialId, action } satisfies InlineCredentialFillRequest
    });

    if (!response.ok) {
      throw new Error(response.error ?? (response.locked ? 'VAULT_LOCKED' : 'INLINE_FILL_FAILED'));
    }

    if (!silent) {
      if (response.skippedSubmit) {
        inlineStatus = '已填表。检测到验证码或敏感字段，未自动提交。';
      } else if (response.submitButtonMissing && action === 'login') {
        inlineStatus = '已填表，但没有找到可靠的登录按钮。点账号更多里的“绑定字段”重新选择按钮。';
      } else if (response.stage === 'usernameOnly') {
        inlineStatus = response.submitOutcome?.message ?? (response.submitted ? '已填写用户名，正在判断下一步...' : '已填写用户名。');
      } else if (response.submitOutcome?.status === 'checking') {
        inlineStatus = response.submitOutcome.message;
      } else {
        inlineStatus = action === 'login' ? '已发送登录指令。' : '已填入账号和密码。';
      }

      renderInlineWidget();
    }

    if (!silent && response.submitOutcome?.status === 'checking') {
      window.setTimeout(() => {
        const outcome = recentSubmitOutcome();
        if (outcome?.credentialId === credentialId) {
          inlineStatus = outcome.message;
          renderInlineWidget();
        }
      }, SUBMIT_OUTCOME_DELAY + 160);
    }
    if (!silent) {
      scheduleInlineRefresh(900);
    }
  } catch (error) {
    if (!silent) {
      inlineStatus = inlineErrorMessage(error);
      renderInlineWidget();
    }
  } finally {
    if (silent) {
      suppressInlineRefreshFor(700);
    }
  }
}

async function handleInlineBind(credentialId: string) {
  inlineMoreCredentialId = null;
  inlineMenuOpen = false;
  inlineStatus = '正在启动字段绑定...';
  renderInlineWidget();

  try {
    const response = await sendRuntimeMessage<{ ok: boolean; credential?: FillCredentialPayload; error?: string; locked?: boolean }>({
      type: 'KEYPILOT_GET_BINDING_CREDENTIAL',
      credentialId
    });

    if (!response.ok || !response.credential) {
      throw new Error(response.error ?? (response.locked ? 'VAULT_LOCKED' : 'BINDING_CREDENTIAL_MISSING'));
    }

    startManualBinding(response.credential);
  } catch (error) {
    inlineMenuOpen = true;
    inlineStatus = inlineErrorMessage(error);
    renderInlineWidget();
  }
}

async function handleInlineFillProfile(profileId: string, silent = false, onlyEmpty = false) {
  if (silent) {
    suppressInlineRefreshFor(1600);

    try {
      await sendRuntimeMessage<FillProfileFillResult & { locked?: boolean }>({
        type: 'KEYPILOT_INLINE_FILL_PROFILE',
        request: { profileId, onlyEmpty, recordUse: false } satisfies InlineFillProfileFillRequest
      });
    } catch {
      // Hover fill is intentionally quiet; explicit clicks still show errors.
    } finally {
      suppressInlineRefreshFor(700);
    }

    return;
  }

  inlineStatus = '正在填写身份资料...';
  renderInlineWidget();

  try {
    const response = await sendRuntimeMessage<FillProfileFillResult & { locked?: boolean }>({
      type: 'KEYPILOT_INLINE_FILL_PROFILE',
      request: { profileId, onlyEmpty, recordUse: true } satisfies InlineFillProfileFillRequest
    });

    if (!response.ok) {
      const matched = response.matchedCount ?? 0;
      throw new Error(matched > 0 ? 'FILL_PROFILE_MATCHED_NOT_FILLED' : response.error ?? (response.locked ? 'VAULT_LOCKED' : 'NO_FILL_PROFILE_FIELDS'));
    }

    inlineMenuOpen = false;
    inlineStatus = '';
    inlineFilterQuery = '';
    inlineMoreCredentialId = null;
    inlineMoreProfileId = null;
    renderInlineWidget();
    positionInlineWidget();
    return;

    const missingCount = response.diagnostics?.filter((item) => item.status === 'missing').length ?? 0;
    inlineStatus = missingCount > 0 ? `已填写 ${response.filledCount} 个字段，${missingCount} 个字段未匹配。` : `已填写 ${response.filledCount} 个字段。`;
    renderInlineWidget();
    scheduleInlineRefresh(900);
  } catch (error) {
    const message = error instanceof Error && error.message === 'FILL_PROFILE_MATCHED_NOT_FILLED'
      ? '检测到候选字段但没有成功填写，请点资料右侧齿轮绑定字段。'
      : inlineErrorMessage(error).replace('NO_FILL_PROFILE_FIELDS', '当前页面没有匹配到这条身份资料字段，请点资料右侧齿轮绑定字段。');
    inlineStatus = message;
    renderInlineWidget();
  }
}

async function handleInlineBindProfile(profileId: string) {
  inlineMoreProfileId = null;
  inlineMenuOpen = false;
  inlineStatus = '正在启动身份字段绑定...';
  renderInlineWidget();

  try {
    const response = await sendRuntimeMessage<{ ok: boolean; error?: string; locked?: boolean }>({
      type: 'KEYPILOT_START_FILL_PROFILE_BINDING',
      profileId
    });

    if (!response.ok) {
      throw new Error(response.error ?? (response.locked ? 'VAULT_LOCKED' : 'FILL_BINDING_START_FAILED'));
    }

    inlineStatus = '已启动身份字段绑定。';
    renderInlineWidget();
  } catch (error) {
    inlineMenuOpen = true;
    inlineStatus = inlineErrorMessage(error);
    renderInlineWidget();
  }
}

function openInlineProfileHome() {
  inlineMoreProfileId = null;
  inlineMoreCredentialId = null;
  inlineMenuOpen = false;
  inlineStatus = '';
  renderInlineWidget();

  try {
    const url = chrome.runtime.getURL('vault.html#identities');
    window.open(url, '_blank', 'noopener,noreferrer');
  } catch {
    window.open('vault.html#identities', '_blank', 'noopener,noreferrer');
  }
}

function openInlineVaultHome() {
  inlineMoreProfileId = null;
  inlineMoreCredentialId = null;
  inlineMenuOpen = false;
  inlineStatus = '';
  renderInlineWidget();

  try {
    const url = chrome.runtime.getURL('vault.html');
    window.open(url, '_blank', 'noopener,noreferrer');
  } catch {
    window.open('vault.html', '_blank', 'noopener,noreferrer');
  }
}

async function handleInlineRenameProfile(profileId: string) {
  const profile = inlineFillProfiles.find((item) => item.id === profileId);
  const nextTitle = window.prompt('重命名身份资料', profile?.title ?? '')?.trim();

  if (!nextTitle) return;

  inlineMoreProfileId = null;
  inlineStatus = '正在重命名身份资料...';
  renderInlineWidget();

  try {
    const response = await sendRuntimeMessage<{ ok: boolean; error?: string; locked?: boolean; message?: string; title?: string }>({
      type: 'KEYPILOT_RENAME_FILL_PROFILE',
      profileId,
      title: nextTitle
    });

    if (!response.ok) {
      throw new Error(response.error ?? (response.locked ? 'VAULT_LOCKED' : 'RENAME_FILL_PROFILE_FAILED'));
    }

    inlineFillProfiles = inlineFillProfiles.map((item) => (item.id === profileId ? { ...item, title: response.title ?? nextTitle } : item));
    inlineStatus = response.message ?? '身份资料已重命名。';
    renderInlineWidget();
    scheduleInlineRefresh(700);
  } catch (error) {
    inlineStatus = inlineErrorMessage(error);
    renderInlineWidget();
  }
}

async function handleInlineDeleteProfile(profileId: string) {
  const profile = inlineFillProfiles.find((item) => item.id === profileId);
  const confirmed = window.confirm(`确定删除“${profile?.title ?? '这条身份资料'}”吗？删除后可在 KeyPilot 主页回收站恢复。`);

  if (!confirmed) return;

  inlineMoreProfileId = null;
  inlineStatus = '正在删除身份资料...';
  renderInlineWidget();

  try {
    const response = await sendRuntimeMessage<{ ok: boolean; error?: string; locked?: boolean; message?: string }>({
      type: 'KEYPILOT_DELETE_FILL_PROFILE',
      profileId
    });

    if (!response.ok) {
      throw new Error(response.error ?? (response.locked ? 'VAULT_LOCKED' : 'DELETE_FILL_PROFILE_FAILED'));
    }

    inlineFillProfiles = inlineFillProfiles.filter((item) => item.id !== profileId);
    inlineStatus = response.message ?? '身份资料已移到回收站。';
    renderInlineWidget();
    scheduleInlineRefresh(700);
  } catch (error) {
    inlineStatus = inlineErrorMessage(error);
    renderInlineWidget();
  }
}

async function handleInlineCommand(credentialId: string, command: InlineCredentialCommand) {
  if (command === 'edit' || command === 'rename') {
    void openInlineCredentialEditor(credentialId);
    return;
  }

  if (command === 'delete') {
    const confirmed = window.confirm('确定删除这个 KeyPilot 账号吗？删除后只能从备份恢复。');
    if (!confirmed) return;
  }

  inlineStatus =
    command === 'goto'
      ? '正在打开起始页...'
      : command === 'delete'
        ? '正在删除账号...'
        : command === 'hide-domain'
          ? '正在隐藏此域...'
          : '正在打开账号编辑页...';
  renderInlineWidget();

  try {
    const response = await sendRuntimeMessage<InlineCredentialCommandResult>({
      type: 'KEYPILOT_INLINE_COMMAND',
      credentialId,
      command
    });

    if (!response.ok) {
      throw new Error(response.error ?? (response.locked ? 'VAULT_LOCKED' : 'INLINE_COMMAND_FAILED'));
    }

    if (response.hidden || command === 'hide-domain') {
      inlineSuppressed = true;
      inlineMenuOpen = false;
      inlineMoreCredentialId = null;
      inlineMoreProfileId = null;
      if (inlineHost) inlineHost.style.display = 'none';
      return;
    }

    inlineStatus = response.message ?? '操作已完成。';
    if (command === 'delete') {
      inlineMatches = inlineMatches.filter((match) => match.id !== credentialId);
      inlineMoreCredentialId = null;
    }
    renderInlineWidget();
    scheduleInlineRefresh(700);
  } catch (error) {
    inlineStatus = inlineErrorMessage(error);
    renderInlineWidget();
  }
}

async function refreshInlineMatchesLegacy() {
  const anchor = getInlineAnchor();

  if (!anchor) {
    inlineMatches = [];
    inlineLocked = false;
    inlineMenuOpen = false;
    inlineMoreCredentialId = null;
    inlineMoreProfileId = null;
    positionInlineWidget();
    return;
  }

  if (inlineMenuOpen) {
    inlineStatus = '正在读取 KeyPilot 状态...';
  }
  renderInlineWidget();
  positionInlineWidget();

  try {
    const response = await sendRuntimeMessage<InlineCredentialMatchesResult>({
      type: 'KEYPILOT_GET_INLINE_MATCHES'
    });

    inlineMatches = response.ok ? response.matches ?? [] : [];
    inlineLocked = Boolean(response.locked);
    inlineStatus = response.locked
      ? 'KeyPilot 已锁定，请先打开插件解锁。'
      : inlineMatches.length
        ? ''
        : '当前网页没有匹配账号。';
    renderInlineWidget();
    positionInlineWidget();
  } catch {
    inlineMatches = [];
    inlineLocked = false;
    inlineStatus = '无法读取 KeyPilot 状态，请刷新网页或扩展。';
    renderInlineWidget();
    positionInlineWidget();
  }
}

async function handleInlineFillLegacy(credentialId: string, action: InlineCredentialFillRequest['action']) {
  inlineStatus = action === 'login' ? '正在登录...' : '正在填充...';
  renderInlineWidget();

  try {
    const response = await sendRuntimeMessage<FillCredentialResult & { locked?: boolean }>({
      type: 'KEYPILOT_INLINE_FILL',
      request: { credentialId, action } satisfies InlineCredentialFillRequest
    });

    if (!response.ok) {
      throw new Error(response.error ?? (response.locked ? 'VAULT_LOCKED' : 'INLINE_FILL_FAILED'));
    }

    if (response.skippedSubmit) {
      inlineStatus = '已填充。检测到验证码或敏感字段，未自动提交。';
    } else if (response.submitButtonMissing && action === 'login') {
      inlineStatus = '已填充，但没有找到可靠的登录按钮。';
    } else if (response.stage === 'usernameOnly') {
      inlineStatus = response.submitted ? '已填写用户名，等待密码框出现。' : '已填写用户名。';
    } else {
      inlineStatus = action === 'login' ? '已发送登录指令。' : '已填充账号密码。';
    }

    renderInlineWidget();
    scheduleInlineRefresh(900);
  } catch (error) {
    inlineStatus = inlineErrorMessage(error);
    renderInlineWidget();
  }
}

function startInlineCredentialWidget() {
  if (!document.documentElement) return;

  ensureInlineWidget();
  scheduleInlineRefresh(300);

  document.addEventListener('focusin', (event) => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || event.target instanceof HTMLTextAreaElement) {
      scheduleInlineRefresh(80);
    }
  }, true);

  document.addEventListener('pointerdown', (event) => {
    if (!inlineHost || !inlineMenuOpen) return;
    const path = event.composedPath();
    if (!path.includes(inlineHost)) {
      inlineMenuOpen = false;
      inlineStatus = '';
      renderInlineWidget();
      positionInlineWidget();
    }
  }, true);

  window.addEventListener('scroll', scheduleInlinePosition, true);
  window.addEventListener('resize', scheduleInlinePosition);
  window.setInterval(() => {
    scheduleInlineRefresh(0);
  }, 10000);

  const observer = new MutationObserver((mutations) => {
    if (shouldIgnoreKeyPilotMutations(mutations)) return;
    scheduleInlineRefresh(180);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'type'] });
}

function startContentModule(name: string, callback: () => void) {
  try {
    callback();
  } catch (error) {
    try {
      document.documentElement.dataset[`keypilot${name}Error`] = error instanceof Error ? error.message : String(error);
    } catch {
      // Diagnostics only.
    }

    console.warn(`[KeyPilot] ${name} failed to start`, error);
  }
}

startContentModule('PasswordGenerator', startInlinePasswordGenerator);
startContentModule('InlineCredential', startInlineCredentialWidget);
loadFloatingIconPositions();

function ensureSavePrompt() {
  if (savePromptHost && savePromptRoot) return;

  savePromptHost = document.createElement('div');
  savePromptHost.id = 'keypilot-save-prompt-root';
  savePromptHost.style.position = 'fixed';
  savePromptHost.style.zIndex = '2147483647';
  savePromptHost.style.top = '16px';
  savePromptHost.style.right = '18px';
  savePromptHost.style.width = 'min(456px, calc(100vw - 36px))';
  savePromptHost.style.display = 'none';
  savePromptHost.style.colorScheme = 'light';
  savePromptRoot = savePromptHost.attachShadow({ mode: 'open' });
  document.documentElement.appendChild(savePromptHost);
}

function hideSavePrompt() {
  savePromptCandidate = null;
  savePromptContext = null;
  savePromptMode = 'save';
  savePromptDraftTitle = '';
  savePromptDropdownOpen = false;

  if (savePromptHost) {
    savePromptHost.style.display = 'none';
  }
}

function showSavePrompt(candidate: PendingLoginCandidate, context: SavePromptContext) {
  if (context.ignored || context.duplicate) {
    hideSavePrompt();
    return;
  }

  savePromptCandidate = candidate;
  savePromptContext = context;
  savePromptMode = context.existing ? 'update' : 'save';
  savePromptDraftTitle = (context.existing?.title || candidate.title || candidate.domain).trim();
  savePromptDropdownOpen = false;
  renderSavePrompt();
}

function renderSavePrompt(status = '') {
  ensureSavePrompt();

  if (!savePromptHost || !savePromptRoot || !savePromptCandidate || !savePromptContext) return;

  const candidate = savePromptCandidate;
  const context = savePromptContext;
  const hasExisting = Boolean(context.existing);
  const selectedSaveMode: SaveCandidateMode = savePromptMode === 'new' && !hasExisting ? 'save' : savePromptMode;
  const primaryAction = hasExisting ? selectedSaveMode : 'save';
  const title = '保存到 KeyPilot?';
  const displayName = `${candidate.title || candidate.domain}${candidate.username ? ` (${candidate.username})` : ''}`;
  const draftTitle = (savePromptDraftTitle || context.existing?.title || candidate.title || candidate.domain).trim();
  const existingName = `${context.existing?.title || candidate.domain}${candidate.username ? ` (${candidate.username})` : ''}`;
  const newName = `${draftTitle || candidate.title || candidate.domain}${candidate.username ? ` (${candidate.username})` : ''}`;
  const selectedTargetLabel = primaryAction === 'update' ? `更新已有账号：${existingName}` : `保存为新账号：${newName}`;
  const actionLabel = primaryAction === 'update' ? '更新' : primaryAction === 'new' ? '保存为新记录' : '保存';
  const targetOptions = hasExisting
    ? `
      <button type="button" class="${primaryAction === 'update' ? 'active' : ''}" data-save-action="select-update">
        <strong>更新已有账号</strong>
        <span>${escapeHtml(existingName)}</span>
      </button>
      <button type="button" class="${primaryAction === 'new' ? 'active' : ''}" data-save-action="select-new">
        <strong>保存为新账号</strong>
        <span>${escapeHtml(newName)}</span>
      </button>
    `
    : `
      <button type="button" class="active" data-save-action="select-save">
        <strong>保存为新账号</strong>
        <span>${escapeHtml(newName)}</span>
      </button>
    `;

  savePromptRoot.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; }
      button { font: inherit; }
      .card {
        overflow: hidden;
        border: 1px solid #dfe7f3;
        border-radius: 14px;
        background: #ffffff;
        box-shadow: 0 18px 45px rgba(15, 23, 42, 0.18);
        color: #111827;
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
      }
      header {
        display: grid;
        grid-template-columns: 30px minmax(0, 1fr) auto;
        align-items: center;
        gap: 10px;
        padding: 14px 16px 10px;
        border-bottom: 1px solid #eef2f7;
      }
      .bot {
        display: grid;
        width: 28px;
        height: 28px;
        place-items: center;
        border: 1px solid #bbf7d0;
        border-radius: 9px;
        background: #f0fdf4;
      }
      .bot::before {
        content: "";
        width: 14px;
        height: 14px;
        border: 2px solid #16a34a;
        border-radius: 4px;
        box-shadow: inset 0 -4px 0 rgba(22, 163, 74, 0.14);
      }
      h3 {
        margin: 0;
        overflow: hidden;
        color: #111827;
        font-size: 16px;
        font-weight: 720;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .report {
        border: 0;
        background: transparent;
        color: #64748b;
        cursor: pointer;
        font-size: 12px;
        font-weight: 560;
      }
      .report:hover { text-decoration: underline; }
      .body {
        display: grid;
        gap: 12px;
        padding: 12px 16px 16px;
      }
      .select-row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) 22px;
        align-items: center;
        min-height: 50px;
        border: 1px solid #dfe7f3;
        border-radius: 10px;
        background: #f8fafc;
        padding: 0 12px 0 13px;
      }
      .select-row strong {
        overflow: hidden;
        color: #0f172a;
        font-size: 13px;
        font-weight: 650;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .name-field {
        display: grid;
        gap: 5px;
      }
      .name-field span {
        color: #64748b;
        font-size: 12px;
        font-weight: 600;
      }
      .name-field input {
        width: 100%;
        min-height: 36px;
        border: 1px solid #dfe7f3;
        border-radius: 9px;
        background: #ffffff;
        color: #0f172a;
        font: 13px ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
        padding: 0 10px;
      }
      .name-field input:focus {
        border-color: #2563eb;
        box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.14);
        outline: none;
      }
      .target-select {
        position: relative;
      }
      .target-button {
        width: 100%;
        border: 1px solid #dfe7f3;
        border-radius: 10px;
        background: #ffffff;
        color: #0f172a;
        cursor: pointer;
        text-align: left;
      }
      .target-menu {
        position: absolute;
        z-index: 4;
        right: 0;
        left: 0;
        top: calc(100% + 6px);
        display: grid;
        overflow: hidden;
        border: 1px solid #dfe7f3;
        border-radius: 10px;
        background: #ffffff;
        box-shadow: 0 14px 28px rgba(16, 24, 40, 0.13);
      }
      .target-menu button {
        display: grid;
        gap: 3px;
        border: 0;
        border-bottom: 1px solid #eef2f7;
        background: #ffffff;
        cursor: pointer;
        padding: 9px 12px;
        text-align: left;
      }
      .target-menu button:last-child { border-bottom: 0; }
      .target-menu button:hover,
      .target-menu button.active {
        background: #f3f7ff;
      }
      .target-menu strong {
        color: #111827;
        font-size: 13px;
        font-weight: 650;
      }
      .target-menu span {
        overflow: hidden;
        color: #59616d;
        font-size: 12px;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .chevron {
        width: 16px;
        height: 16px;
        border-right: 3px solid #334155;
        border-bottom: 3px solid #334155;
        transform: rotate(45deg) translateY(-3px);
        justify-self: center;
      }
      .actions {
        display: grid;
        grid-template-columns: 1fr 1fr 100px;
        align-items: center;
        gap: 8px;
      }
      .actions button {
        min-height: 40px;
        border: 1px solid #e2e8f0;
        border-radius: 10px;
        background: #ffffff;
        color: #334155;
        cursor: pointer;
        font-size: 13px;
        font-weight: 620;
      }
      .actions button:hover { background: #f8fafc; }
      .actions .primary {
        border-color: #165dff;
        background: #165dff;
        color: #ffffff;
      }
      .actions .primary:hover { background: #0f4fd8; }
      .status {
        margin: -4px 16px 14px;
        color: #2563eb;
        font-size: 12px;
      }
      @media (max-width: 430px) {
        .actions { grid-template-columns: 1fr; }
        .actions button { min-height: 42px; }
      }
    </style>
    <section class="card" role="dialog" aria-label="${escapeHtml(title)}">
      <header>
        <span class="bot" aria-hidden="true"></span>
        <h3>${escapeHtml(title)}</h3>
        <button class="report" type="button" data-save-action="report">报告一个问题</button>
      </header>
      <div class="body">
        <label class="name-field">
          <span>保存名称</span>
          <input data-save-name type="text" value="${escapeHtml(draftTitle)}" autocomplete="off" />
        </label>
        <div class="target-select">
          <button class="select-row target-button" type="button" data-save-action="toggle-target-menu" title="${escapeHtml(displayName)}">
            <strong>${escapeHtml(selectedTargetLabel)}</strong>
            <span class="chevron" aria-hidden="true"></span>
          </button>
          ${savePromptDropdownOpen ? `<div class="target-menu">${targetOptions}</div>` : ''}
        </div>
        <div class="actions">
          ${
            context.locked
              ? `<button type="button" data-save-action="skip">现在不行</button><button type="button" data-save-action="blacklist">不再提示</button><button class="primary" type="button" data-save-action="open">${actionLabel}</button>`
              : `<button type="button" data-save-action="blacklist">不要保存这个网页</button><button type="button" data-save-action="skip">现在不行</button><button class="primary" type="button" data-save-action="${primaryAction}">${actionLabel}</button>`
          }
        </div>
      </div>
      ${status ? `<div class="status">${escapeHtml(status)}</div>` : ''}
    </section>
  `;

  savePromptRoot.querySelectorAll<HTMLElement>('[data-save-action]').forEach((element) => {
    element.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const action = element.dataset.saveAction as SaveCandidateMode | 'open' | 'report' | 'toggle-target-menu' | 'select-update' | 'select-new' | 'select-save' | undefined;
      const nameInput = savePromptRoot?.querySelector<HTMLInputElement>('[data-save-name]');
      if (nameInput) {
        savePromptDraftTitle = nameInput.value.trim();
      }

      if (action === 'open') {
        window.open(chrome.runtime.getURL('popup.html'), '_blank', 'noopener,noreferrer');
        return;
      }

      if (action === 'report') {
        renderSavePrompt('请在 KeyPilot 弹窗的当前网站诊断里查看详情。');
        return;
      }

      if (action === 'toggle-target-menu') {
        savePromptDropdownOpen = !savePromptDropdownOpen;
        renderSavePrompt(status);
        return;
      }

      if (action === 'select-update') {
        savePromptMode = 'update';
        savePromptDropdownOpen = false;
        renderSavePrompt(status);
        return;
      }

      if (action === 'select-new') {
        savePromptMode = 'new';
        savePromptDropdownOpen = false;
        renderSavePrompt(status);
        return;
      }

      if (action === 'select-save') {
        savePromptMode = 'save';
        savePromptDropdownOpen = false;
        renderSavePrompt(status);
        return;
      }

      if (action) {
        void resolveSavePrompt(action);
      }
    });
  });

  savePromptHost.style.display = 'block';
}

function renderSavePromptLegacy(status = '') {
  ensureSavePrompt();

  if (!savePromptHost || !savePromptRoot || !savePromptCandidate || !savePromptContext) return;

  const candidate = savePromptCandidate;
  const context = savePromptContext;
  const hasExisting = Boolean(context.existing);
  const title = context.locked ? '检测到登录信息' : hasExisting ? '更新保存的密码？' : '保存登录信息？';
  const body = context.locked
    ? 'KeyPilot 当前未解锁。请先打开插件解锁 Vault，再保存这条登录信息。'
    : hasExisting
      ? `发现同一网站和用户名已有记录：${context.existing?.title ?? candidate.domain}`
      : '是否把这次登录的账号保存到 KeyPilot？';
  const primaryAction = hasExisting ? 'update' : 'save';
  const primaryLabel = hasExisting ? '更新密码' : '保存';

  savePromptRoot.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; }
      button { font: inherit; }
      .card {
        overflow: hidden;
        border: 1px solid #dfe7f3;
        border-radius: 10px;
        background: #ffffff;
        box-shadow: 0 18px 46px rgba(16, 24, 40, 0.2);
        color: #101828;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
      }
      header {
        display: grid;
        grid-template-columns: 30px minmax(0, 1fr) 30px;
        align-items: center;
        gap: 10px;
        padding: 12px;
        border-bottom: 1px solid #edf2f8;
      }
      .mark {
        display: grid;
        width: 30px;
        height: 30px;
        place-items: center;
        border: 1px solid #cfe0ff;
        border-radius: 8px;
        background: #eaf2ff;
        color: #2563eb;
        font-size: 14px;
        font-weight: 850;
      }
      h3 {
        margin: 0;
        overflow: hidden;
        font-size: 14px;
        font-weight: 850;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .close {
        display: grid;
        width: 30px;
        height: 30px;
        place-items: center;
        border: 0;
        border-radius: 8px;
        background: transparent;
        color: #dc2626;
        cursor: pointer;
        font-size: 22px;
      }
      .close:hover { background: #fff1f1; }
      .body {
        display: grid;
        gap: 10px;
        padding: 12px;
      }
      p {
        margin: 0;
        color: #475467;
        font-size: 12px;
        line-height: 1.45;
      }
      .candidate {
        display: grid;
        grid-template-columns: 30px minmax(0, 1fr);
        gap: 10px;
        align-items: center;
        border: 1px solid #edf2f8;
        border-radius: 9px;
        padding: 9px;
        background: #f8fbff;
      }
      .candidate strong,
      .candidate span,
      .candidate code {
        display: block;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .candidate strong { font-size: 13px; }
      .candidate span { color: #475467; font-size: 12px; }
      .candidate code { margin-top: 2px; color: #667085; font-size: 12px; }
      .actions {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
      }
      .actions button {
        min-height: 34px;
        border: 1px solid #dfe7f3;
        border-radius: 8px;
        background: #ffffff;
        color: #344054;
        cursor: pointer;
        font-size: 12px;
        font-weight: 780;
      }
      .actions .primary {
        border-color: #2563eb;
        background: #2563eb;
        color: #ffffff;
      }
      .link-row {
        display: flex;
        justify-content: space-between;
        gap: 8px;
      }
      .link-row button {
        border: 0;
        background: transparent;
        color: #667085;
        cursor: pointer;
        font-size: 12px;
        text-decoration: underline;
      }
      .link-row .danger { color: #dc2626; }
      .status {
        border-top: 1px solid #edf2f8;
        padding: 8px 12px;
        color: #2563eb;
        font-size: 12px;
      }
    </style>
    <section class="card" role="dialog" aria-label="${escapeHtml(title)}">
      <header>
        <span class="mark">K</span>
        <h3>${escapeHtml(title)}</h3>
        <button class="close" type="button" data-save-action="skip" aria-label="关闭保存提示">×</button>
      </header>
      <div class="body">
        <p>${escapeHtml(body)}</p>
        <div class="candidate">
          <span class="mark">${escapeHtml((candidate.title || candidate.domain || 'K').slice(0, 1).toUpperCase())}</span>
          <div>
            <strong>${escapeHtml(candidate.domain)}</strong>
            <span>${escapeHtml(candidate.username)}</span>
            <code>••••••••••••</code>
          </div>
        </div>
        <div class="actions">
          ${
            context.locked
              ? '<button class="primary" type="button" data-save-action="open">打开 KeyPilot</button><button type="button" data-save-action="skip">暂不保存</button>'
              : `<button class="primary" type="button" data-save-action="${primaryAction}">${primaryLabel}</button><button type="button" data-save-action="skip">暂不保存</button>`
          }
        </div>
        ${
          context.locked
            ? ''
            : `<div class="link-row">
                ${hasExisting ? '<button type="button" data-save-action="new">另存为新记录</button>' : '<span></span>'}
                <button class="danger" type="button" data-save-action="blacklist">从不保存此网站</button>
              </div>`
        }
      </div>
      ${status ? `<div class="status">${escapeHtml(status)}</div>` : ''}
    </section>
  `;

  savePromptRoot.querySelectorAll<HTMLElement>('[data-save-action]').forEach((element) => {
    element.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const action = element.dataset.saveAction as SaveCandidateMode | 'open' | undefined;

      if (action === 'open') {
        window.open(chrome.runtime.getURL('popup.html'), '_blank', 'noopener,noreferrer');
        return;
      }

      if (action) {
        void resolveSavePrompt(action);
      }
    });
  });

  savePromptHost.style.display = 'block';
}

async function resolveSavePrompt(mode: SaveCandidateMode) {
  if (!savePromptCandidate || !savePromptContext) return;

  const nameInput = savePromptRoot?.querySelector<HTMLInputElement>('[data-save-name]');
  if (nameInput) {
    savePromptDraftTitle = nameInput.value.trim();
  }

  if (mode === 'blacklist') {
    const confirmed = window.confirm('以后不再提示保存这个网站的登录信息？');
    if (!confirmed) return;
  }

  const candidateToSave: PendingLoginCandidate = {
    ...savePromptCandidate,
    title: savePromptDraftTitle || savePromptCandidate.title || savePromptCandidate.domain
  };

  renderSavePrompt(mode === 'skip' ? '正在关闭...' : '正在保存...');

  try {
    const response = await sendRuntimeMessage<{ ok: boolean; locked?: boolean; error?: string; duplicate?: boolean; updated?: boolean; blacklisted?: boolean }>({
      type: 'KEYPILOT_RESOLVE_SAVE_CANDIDATE',
      mode,
      candidateId: savePromptContext.candidateId,
      candidate: candidateToSave
    });

    if (!response.ok) {
      throw new Error(response.error ?? (response.locked ? 'VAULT_LOCKED' : 'SAVE_FAILED'));
    }

    if (mode === 'skip') {
      hideSavePrompt();
      return;
    }

    const text = response.duplicate
      ? '这条登录信息已经存在。'
      : response.blacklisted
        ? '已加入不保存网站列表。'
        : response.updated
          ? '已更新保存的密码。'
          : '登录信息已保存。';
    renderSavePrompt(text);
    window.setTimeout(hideSavePrompt, 1600);
  } catch (error) {
    renderSavePrompt(inlineErrorMessage(error));
  }
}

async function checkPendingSavePrompt() {
  try {
    const response = await sendRuntimeMessage<SavePromptResponse>({ type: 'KEYPILOT_GET_SAVE_PROMPT' });

    if (response.ok && response.candidate) {
      showSavePrompt(response.candidate, response);
    }
  } catch {
    // The page can still work without a proactive save prompt.
  }
}

[100, 360, 900, 1800, 3200].forEach((delay) => {
  window.setTimeout(() => {
    void checkPendingSavePrompt();
  }, delay);
});

document.addEventListener(
  'visibilitychange',
  () => {
    if (!document.hidden) {
      void checkPendingSavePrompt();
    }
  },
  true
);

function buildCandidateFromScope(scope: ParentNode, source: PendingLoginCandidate['source'], submitter?: HTMLElement): PendingLoginCandidate | null {
  const passwordField = getAllVisibleInputs(scope).find((input) => input.value && isPasswordInput(input));

  if (!passwordField) {
    return null;
  }

  const usernameField = findUsernameField(scope, passwordField);
  const username = usernameField?.value?.trim() ?? '';

  if (!username || !passwordField.value) {
    return null;
  }

  const url = window.location.href;

  return {
    id: crypto.randomUUID(),
    title: getBestPageTitle(scope),
    url,
    domain: window.location.hostname.replace(/^www\./i, '').toLowerCase(),
    ...getPageIcon(),
    username,
    password: passwordField.value,
    formFields: captureFormFields(scope, usernameField, passwordField),
    formProfile: captureFormProfile(scope, usernameField, passwordField, submitter),
    capturedAt: Date.now(),
    source
  };
}

function buildCandidate(source: PendingLoginCandidate['source'], submitter?: HTMLElement): PendingLoginCandidate | null {
  const context = findLoginContext();

  if (context?.scope) {
    const scoped = buildCandidateFromScope(context.scope, source, submitter);
    if (scoped) return scoped;
  }

  return buildCandidateFromScope(document, source, submitter);
}

function rememberCandidate(source: PendingLoginCandidate['source'], submitter?: HTMLElement) {
  const candidate = buildCandidate(source, submitter);

  if (!candidate) {
    return;
  }

  lastCandidate = candidate;

  if (clearCandidateTimer) {
    window.clearTimeout(clearCandidateTimer);
  }

  clearCandidateTimer = window.setTimeout(() => {
    lastCandidate = null;
  }, 60000);
}

function clearSaveCandidateState() {
  lastCandidate = null;

  chrome.runtime.sendMessage({ type: 'KEYPILOT_CLEAR_SAVE_CANDIDATE' }, () => {
    void chrome.runtime.lastError;
  });
}

function nodeContains(scope: ParentNode, element: HTMLElement): boolean {
  return scope === document || (scope instanceof Element && scope.contains(element));
}

function isLikelyCredentialSubmitElement(element: HTMLElement): boolean {
  if (NEXT_BUTTON_PATTERN.test(buttonText(element))) {
    return true;
  }

  const context = findLoginContext();

  if (!context?.passwordField || !nodeContains(context.scope, element)) {
    return false;
  }

  return Boolean(
    element.matches('button, input[type="submit"], input[type="button"], [role="button"]') ||
      element.closest('button, input[type="submit"], input[type="button"], [role="button"]')
  );
}

function sendCandidateAfterLikelySuccess(source: PendingLoginCandidate['source'], submitter?: HTMLElement) {
  rememberCandidate(source, submitter);

  const candidate = lastCandidate;

  if (!candidate) {
    return;
  }

  chrome.runtime.sendMessage(
    {
      type: 'KEYPILOT_STAGE_SAVE_CANDIDATE',
      candidate
    },
    () => {
      // Best effort only. If the page navigates immediately, the staged candidate in
      // the background service worker is enough for the next page to show the prompt.
      void chrome.runtime.lastError;
    }
  );

  [320, 850, 1600, 2800].forEach((delay, index, delays) => {
    window.setTimeout(() => {
      const currentCandidate = lastCandidate;

      if (!currentCandidate) {
        return;
      }

      const context = findLoginContext();
      const errorText = (context ? visibleErrorText(context.scope) : undefined) ?? visibleErrorText(document);
      const isFinalAttempt = index === delays.length - 1;
      const urlChanged = window.location.href !== currentCandidate.url;
      const stillOnLoginForm = Boolean(context?.passwordField && !urlChanged);

      if (errorText || stillOnLoginForm) {
        if (errorText || isFinalAttempt) {
          clearSaveCandidateState();
        }
        return;
      }

      chrome.runtime.sendMessage(
        {
          type: 'KEYPILOT_SAVE_CANDIDATE',
          candidate: {
            ...currentCandidate,
            url: window.location.href,
            domain: window.location.hostname.replace(/^www\./i, '').toLowerCase(),
            capturedAt: Date.now()
          }
        },
        (response: SavePromptContext | undefined) => {
          if (chrome.runtime.lastError || !response?.ok || response.ignored || response.duplicate) {
            return;
          }

          showSavePrompt(currentCandidate, response);
        }
      );

      lastCandidate = null;
    }, delay);
  });
}

document.addEventListener(
  'input',
  (event) => {
    const input = event.target instanceof HTMLInputElement ? event.target : null;

    if (input?.type === 'password') {
      rememberCandidate('input');
    }
  },
  true
);

document.addEventListener(
  'keydown',
  (event) => {
    if (event.key === 'Enter') {
      sendCandidateAfterLikelySuccess('enter');
    }
  },
  true
);

document.addEventListener(
  'click',
  (event) => {
    const element = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>('button, input[type="submit"], a, [role="button"]') : null;

    if (element && isLikelyCredentialSubmitElement(element)) {
      sendCandidateAfterLikelySuccess('click', element);
    }
  },
  true
);

document.addEventListener(
  'submit',
  (event) => {
    const submitter = event instanceof SubmitEvent && event.submitter instanceof HTMLElement ? event.submitter : undefined;
    sendCandidateAfterLikelySuccess('submit', submitter);
  },
  true
);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  try {
    if (message?.type === 'KEYPILOT_CONTENT_PING') {
      sendResponse(getPageMeta());
      return true;
    }

    if (message?.type === 'KEYPILOT_GET_PAGE_META') {
      sendResponse(getPageMeta());
      return true;
    }

    if (message?.type === 'KEYPILOT_INLINE_DIAGNOSTICS') {
      sendResponse(getInlineFrameDiagnostic());
      return true;
    }

    if (message?.type === 'KEYPILOT_PASSWORD_GENERATOR_DIAGNOSTICS') {
      sendResponse(getPasswordGeneratorDiagnostic());
      return true;
    }

    if (message?.type === 'KEYPILOT_TOGGLE_RECOGNITION_DEBUG') {
      void toggleRecognitionDebugPanel(typeof message.open === 'boolean' ? message.open : undefined)
        .then((response) => sendResponse(response))
        .catch((error) => {
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : 'RECOGNITION_DEBUG_FAILED'
          });
        });
      return true;
    }

    if (message?.type === 'KEYPILOT_FILL_CREDENTIAL') {
      sendResponse(fillCredential(message.credential as FillCredentialPayload));
      return true;
    }

    if (message?.type === 'KEYPILOT_FILL_PROFILE') {
      sendResponse(fillProfile(message.profile as FillProfilePayload));
      return true;
    }

    if (message?.type === 'KEYPILOT_DIAGNOSE_FILL_PROFILE') {
      sendResponse(diagnoseFillProfile(message.profile as FillProfilePayload));
      return true;
    }

    if (message?.type === 'KEYPILOT_START_FILL_PROFILE_BINDING') {
      const profile = message.profile as FillProfilePayload | undefined;
      if (!profile?.id || !profile.fields?.length) {
        sendResponse({ ok: false, error: 'INVALID_FILL_PROFILE' });
        return true;
      }

      startFillProfileBinding(profile);
      sendResponse({ ok: true });
      return true;
    }

    if (message?.type === 'KEYPILOT_START_MANUAL_BINDING') {
      const credential = message.credential as FillCredentialPayload | undefined;
      if (!credential?.id) {
        sendResponse({ ok: false, error: 'INVALID_BINDING_CREDENTIAL' });
        return true;
      }

      startManualBinding(credential);
      sendResponse({ ok: true });
      return true;
    }

    if (message?.type === 'KEYPILOT_TEST_BINDING') {
      const credential = message.credential as FillCredentialPayload | undefined;
      if (!credential?.id) {
        sendResponse({ ok: false, error: 'INVALID_BINDING_CREDENTIAL' });
        return true;
      }

      sendResponse(testCredentialBinding(credential));
      return true;
    }
  } catch (error) {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : 'CONTENT_SCRIPT_ERROR'
    });
    return true;
  }

  return false;
});
