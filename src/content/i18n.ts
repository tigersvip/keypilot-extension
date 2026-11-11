// Kept independent of the extension-page module: manifest content scripts are
// classic scripts and must not acquire shared ESM imports from the UI bundles.
let messages: Record<string, string> = {};
let initialization: Promise<void> | undefined;
export function t(source: string, values: readonly unknown[] = []): string {
  const translated = Object.hasOwn(messages, source) ? messages[source] : Object.hasOwn(messages, source.trim()) ? messages[source.trim()] : undefined;
  const text = translated === undefined ? source : `${source.match(/^\s*/)?.[0] ?? ''}${translated}${source.match(/\s*$/)?.[0] ?? ''}`;
  return text.replace(/\{(\d+)\}/g, (token, index: string) => Number(index) < values.length ? String(values[Number(index)] ?? '') : token);
}
export function htmlText(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}
export function initContentLanguage(): Promise<void> {
  return initialization ??= (async () => {
    try {
      const result = await chrome.runtime.sendMessage({ type: 'KEYPILOT_LANGUAGE' });
      if (result?.ok) messages = result.messages;
    } catch { /* Extension reloads must not break the website. Chinese is the fallback. */ }
  })();
}
