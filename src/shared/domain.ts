export function normalizeUrl(url: string): string {
  const trimmed = url.trim();

  if (!trimmed) {
    return '';
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  return `https://${trimmed}`;
}

export function extractDomain(url: string): string {
  const normalized = normalizeUrl(url);

  if (!normalized) {
    return '';
  }

  try {
    const parsed = new URL(normalized);
    return parsed.hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return '';
  }
}

const KNOWN_PUBLIC_SUFFIXES = new Set([
  'com.cn',
  'net.cn',
  'org.cn',
  'gov.cn',
  'edu.cn',
  'co.uk',
  'org.uk',
  'ac.uk',
  'com.au',
  'net.au',
  'org.au',
  'co.jp',
  'ne.jp',
  'or.jp',
  'com.hk',
  'com.tw',
  'com.br',
  'com.sg',
  'co.kr',
  'github.io',
  'vercel.app',
  'netlify.app',
  'pages.dev',
  'web.app',
  'firebaseapp.com',
  'herokuapp.com',
  'workers.dev',
  'fly.dev',
  'glitch.me',
  'replit.app',
  'repl.co',
  'surge.sh',
  'ngrok.io',
  'ngrok-free.app',
  'trycloudflare.com',
  'myshopify.com'
]);

function normalizeDomain(value: string): string {
  const trimmed = value.trim().toLowerCase().replace(/\.$/, '');

  if (!trimmed) return '';

  if (/^https?:\/\//i.test(trimmed)) {
    return extractDomain(trimmed);
  }

  return trimmed.replace(/^www\./i, '');
}

function isIpv4(domain: string): boolean {
  return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(domain);
}

function isLocalDomain(domain: string): boolean {
  return domain === 'localhost' || isIpv4(domain) || domain.includes(':');
}

function isSafeDomainScope(domain: string): boolean {
  const normalized = normalizeDomain(domain);
  return Boolean(
    normalized &&
      !isLocalDomain(normalized) &&
      normalized.includes('.') &&
      !KNOWN_PUBLIC_SUFFIXES.has(normalized)
  );
}

export function getRegistrableDomain(value: string): string {
  const domain = normalizeDomain(value);

  if (!domain || isLocalDomain(domain)) {
    return domain;
  }

  const labels = domain.split('.').filter(Boolean);

  if (labels.length <= 2) {
    return domain;
  }

  for (const suffix of KNOWN_PUBLIC_SUFFIXES) {
    if (domain === suffix || domain.endsWith(`.${suffix}`)) {
      const suffixLabels = suffix.split('.').length;
      const start = labels.length - suffixLabels - 1;
      return start >= 0 ? labels.slice(start).join('.') : domain;
    }
  }

  return labels.slice(-2).join('.');
}

export function domainsMatch(savedDomain: string, currentDomain: string): boolean {
  const saved = normalizeDomain(savedDomain);
  const current = normalizeDomain(currentDomain);

  if (!saved || !current) return false;
  if (saved === current) return true;
  if (isLocalDomain(saved) || isLocalDomain(current)) return false;

  if (isSafeDomainScope(saved) && current.endsWith(`.${saved}`)) return true;
  if (isSafeDomainScope(current) && saved.endsWith(`.${current}`)) return true;

  const savedRoot = getRegistrableDomain(saved);
  const currentRoot = getRegistrableDomain(current);

  return Boolean(savedRoot && currentRoot && savedRoot === currentRoot && isSafeDomainScope(savedRoot));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function hasExplicitPath(value: string): boolean {
  try {
    const parsed = new URL(normalizeUrl(value));
    return parsed.pathname !== '/' || Boolean(parsed.search || parsed.hash);
  } catch {
    return false;
  }
}

function wildcardUrlMatches(pattern: string, currentUrl: string): boolean {
  const normalizedPattern = normalizeUrl(pattern);
  const normalizedCurrent = normalizeUrl(currentUrl);

  if (!normalizedPattern || !normalizedCurrent) return false;

  const escaped = escapeRegExp(normalizedPattern).replace(/\\\*/g, '.*');
  const source = escaped.replace(/^https:\\\/\\\//i, 'https?:\\/\\/');
  return new RegExp(`^${source}$`, 'i').test(normalizedCurrent);
}

export interface CredentialMatchTarget {
  domain: string;
  matchUrl?: string;
  matchDomain?: string;
}

export function normalizeMatchUrl(value?: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return normalizeUrl(trimmed);
}

export function extractMatchDomain(matchUrl?: string): string {
  if (!matchUrl?.trim()) return '';

  const wildcardDomain = matchUrl
    .trim()
    .replace(/^https?:\/\//i, '')
    .split(/[/?#]/)[0]
    ?.replace(/^\*\./, '');

  return normalizeDomain(wildcardDomain || matchUrl);
}

export function credentialMatchesUrl(credential: CredentialMatchTarget, currentUrl?: string): boolean {
  const normalizedCurrentUrl = normalizeUrl(currentUrl ?? '');
  const currentDomain = extractDomain(normalizedCurrentUrl);

  if (!currentDomain) return false;

  const matchUrl = credential.matchUrl?.trim();
  if (!matchUrl) {
    return domainsMatch(credential.matchDomain || credential.domain, currentDomain);
  }

  if (matchUrl.includes('*')) {
    return wildcardUrlMatches(matchUrl, normalizedCurrentUrl);
  }

  const matchDomain = credential.matchDomain || extractMatchDomain(matchUrl);
  if (!matchDomain || !domainsMatch(matchDomain, currentDomain)) {
    return false;
  }

  if (!hasExplicitPath(matchUrl)) {
    return true;
  }

  const normalizedMatchUrl = normalizeUrl(matchUrl);
  return trimTrailingSlash(normalizedCurrentUrl).startsWith(trimTrailingSlash(normalizedMatchUrl));
}
