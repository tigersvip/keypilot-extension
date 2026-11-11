import { getDomain } from 'tldts';
export function normalizeUrl(url: string): string {
  const value = url.trim();
  if (!value) return '';
  if (value.startsWith('//')) return 'https:' + value;
  // A bare hostname may include a port; explicit schemes must never become hostnames.
  const hasPort = /^[^/?#:\s]+:\d+(?:[/?#]|$)/.test(value);
  return !hasPort && /^[a-z][a-z\d+.-]*:/i.test(value) ? value : 'https://' + value;
}
export function extractDomain(url: string): string {
  try {
    const parsed = new URL(normalizeUrl(url));
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.hostname.toLowerCase().replace(/\.$/, '') : '';
  }
  catch { return ''; }
}
export function getRegistrableDomain(value: string): string {
  const domain = extractDomain(value);
  return getDomain(domain, { allowPrivateDomains: true }) ?? domain;
}
// Credentials and learned site rules are exact-host by default.
export function domainsMatch(savedDomain: string, currentDomain: string): boolean {
  const saved = extractDomain(savedDomain);
  return Boolean(saved && saved === extractDomain(currentDomain));
}
export interface CredentialMatchTarget { domain: string; url?: string; matchUrl?: string; matchDomain?: string }
export function normalizeMatchUrl(value?: string): string | undefined {
  return value?.trim() ? normalizeUrl(value) : undefined;
}
export function extractMatchDomain(matchUrl?: string): string {
  return matchUrl ? extractDomain(matchUrl.replace('://*.', '://').replace(/^\*\./, '')) : '';
}
function pathMatches(pattern: URL, target: URL): boolean {
  if (pattern.pathname.includes('*')) {
    const escaped = pattern.pathname.split('*').map(part => part.replace(/[.*+?^\x24{}()|[\]\\]/g, '\\$&')).join('.*');
    if (!new RegExp('^' + escaped + '$').test(target.pathname)) return false;
  } else {
    const path = pattern.pathname.replace(/\/+$/, '');
    if (path && target.pathname !== path && !target.pathname.startsWith(path + '/')) return false;
  }
  return (!pattern.search || pattern.search === target.search) && (!pattern.hash || pattern.hash === target.hash);
}
export function credentialMatchesUrl(credential: CredentialMatchTarget, currentUrl?: string): boolean {
  try {
    const target = new URL(normalizeUrl(currentUrl ?? ''));
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) return false;
    const source = credential.matchUrl || credential.url;
    if (!credential.matchUrl) {
      if (!domainsMatch(credential.matchDomain || (source ? extractDomain(source) : credential.domain), target.hostname)) return false;
      if (source) {
        const saved = new URL(normalizeUrl(source));
        if (saved.protocol === 'https:' && target.protocol !== 'https:') return false;
        if (saved.port !== target.port) return false;
      }
      return true;
    }
    const raw = normalizeUrl(credential.matchUrl);
    const subdomains = /^https?:\/\/\*\./i.test(raw);
    const pattern = new URL(raw.replace('://*.', '://'));
    if (pattern.hostname.includes('*') || pattern.username || pattern.password) return false;
    if (pattern.protocol !== target.protocol || pattern.port !== target.port) return false;
    if (subdomains) {
      if (!getDomain(pattern.hostname, { allowPrivateDomains: true })) return false;
      if (target.hostname !== pattern.hostname && !target.hostname.endsWith('.' + pattern.hostname)) return false;
    } else if (pattern.hostname !== target.hostname) return false;
    return pathMatches(pattern, target);
  } catch { return false; }
}
