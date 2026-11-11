import type { BrowserContext } from '@playwright/test';

// Extension-page image requests bypass Playwright's network routing. Replace
// only synthetic root favicons before loading; keep console error assertions.
export async function mockSyntheticIcons(context: BrowserContext) {
  await context.addInitScript(() => {
    if (location.protocol !== 'chrome-extension:') return;
    const icon = 'data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="#2563eb"/></svg>');
    const source = (value: string) => {
      try { const url = new URL(value); return url.hostname.endsWith('.test') && url.pathname === '/favicon.ico' ? icon : value; }
      catch { return value; }
    };
    const descriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src')!;
    Object.defineProperty(HTMLImageElement.prototype, 'src', {...descriptor, set(value: string) { descriptor.set!.call(this, source(String(value))); }});
    const setAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function(name: string, value: string) {
      setAttribute.call(this, name, this instanceof HTMLImageElement && name.toLowerCase() === 'src' ? source(String(value)) : value);
    };
  });
}
