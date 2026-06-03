export function toHttpIconUrl(value?: string): string | undefined {
  if (!value) return undefined;

  try {
    const parsed = new URL(value);
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

export function getRootFaviconUrl(urlOrDomain?: string): string | undefined {
  const origin = getHttpOrigin(urlOrDomain);
  return origin ? `${origin}/favicon.ico` : undefined;
}

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

function getSameOriginIconUrls(urlOrDomain?: string): string[] {
  const origin = getHttpOrigin(urlOrDomain);
  if (!origin) return [];

  return SAME_ORIGIN_ICON_PATHS.map((path) => `${origin}${path}`);
}

export function getIconCandidates(iconUrl?: string, urlOrDomain?: string): string[] {
  return Array.from(
    new Set(
      [toHttpIconUrl(iconUrl), ...getSameOriginIconUrls(urlOrDomain)]
        .filter((candidate): candidate is string => Boolean(candidate))
    )
  );
}
