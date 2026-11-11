import type { BrowserContext } from '@playwright/test';

// Synthetic .test hosts have no DNS records. Serve their first icon locally so
// unrelated network errors cannot mask real application console errors in CI.
export async function mockSyntheticIcons(context: BrowserContext) {
  await context.route(url => url.hostname.endsWith('.test') && url.pathname === '/favicon.ico', route => route.fulfill({
    contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="#2563eb"/></svg>'
  }));
}
