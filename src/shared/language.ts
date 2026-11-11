export const languages = [
  { code: 'zh-CN', label: '简体中文' },
  { code: 'en-US', label: 'English' },
  { code: 'zh-TW', label: '繁體中文' },
  { code: 'ja', label: '日本語' },
  { code: 'es', label: 'Español' }
] as const;
export type Language = typeof languages[number]['code'];
export type LanguagePreference = Language | 'auto';
export const LANGUAGE_KEY = 'keypilot.language';

export function normalizeLanguage(value: unknown): LanguagePreference {
  return value === 'auto' || languages.some(item => item.code === value) ? value as LanguagePreference : 'zh-CN';
}
export function resolveLanguage(value: unknown, browserLanguages: readonly string[] = []): Language {
  const preference = normalizeLanguage(value);
  if (preference !== 'auto') return preference;
  for (const raw of browserLanguages) {
    const code = raw.toLowerCase();
    if (/^zh-(tw|hk|mo|hant)/.test(code)) return 'zh-TW';
    if (code === 'zh' || code.startsWith('zh-')) return 'zh-CN';
    if (code === 'ja' || code.startsWith('ja-')) return 'ja';
    if (code === 'es' || code.startsWith('es-')) return 'es';
    if (code === 'en' || code.startsWith('en-')) return 'en-US';
  }
  return 'en-US';
}

export function formatMessage(message: string, values: readonly unknown[] = []): string {
  // One pass: a value containing another placeholder remains user data.
  return message.replace(/\{(\d+)\}/g, (token, index: string) => Number(index) < values.length ? String(values[Number(index)] ?? '') : token);
}
