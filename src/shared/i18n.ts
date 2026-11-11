import { formatMessage, LANGUAGE_KEY, normalizeLanguage, resolveLanguage, type Language, type LanguagePreference } from './language';

type Catalog = Record<string, string>;
let language: Language = 'zh-CN';
let preference: LanguagePreference = 'zh-CN';
let messages: Catalog = {};
let initialization: Promise<void> | undefined;
type LanguagePack = { messages: Record<string, (string | null)[]>; contentKeys: string[] };
let packPromise: Promise<LanguagePack> | undefined;
export const getLanguage = () => language;
export const getLanguagePreference = () => preference;
export const t = (source: string, values?: readonly unknown[]): string => {
  const translated = Object.hasOwn(messages, source) ? messages[source] : Object.hasOwn(messages, source.trim()) ? messages[source.trim()] : undefined;
  return formatMessage(translated === undefined ? source : `${source.match(/^\s*/)?.[0] ?? ''}${translated}${source.match(/\s*$/)?.[0] ?? ''}`, values);
};

export async function readLanguagePreference(): Promise<LanguagePreference | undefined> {
  const local = globalThis.localStorage ?? globalThis.window?.localStorage;
  const value = globalThis.chrome?.storage?.local
    ? (await chrome.storage.local.get(LANGUAGE_KEY))[LANGUAGE_KEY]
    : local?.getItem(LANGUAGE_KEY);
  return value == null ? undefined : normalizeLanguage(value);
}
export async function saveLanguagePreference(value: LanguagePreference): Promise<void> {
  const normalized = normalizeLanguage(value);
  if (globalThis.chrome?.storage?.local) await chrome.storage.local.set({ [LANGUAGE_KEY]: normalized });
  else (globalThis.localStorage ?? globalThis.window?.localStorage)?.setItem(LANGUAGE_KEY, normalized);
}
export async function loadLanguageSnapshot(contentOnly = false, preferred?: LanguagePreference): Promise<{ language: Language; messages: Catalog }> {
  const selected = resolveLanguage(preferred ?? await readLanguagePreference() ?? 'zh-CN', globalThis.navigator?.languages ?? []);
  if (selected === 'zh-CN') return { language: selected, messages: {} };
  packPromise ??= (async () => {
    const url = globalThis.chrome?.runtime?.getURL?.('locales/messages.json') ?? '/locales/messages.json';
    const response = await fetch(url);
    if (!response.ok) throw new Error('Language pack unavailable');
    return response.json() as Promise<LanguagePack>;
  })().catch(error => { packPromise = undefined; throw error; });
  const pack = await packPromise;
  const column = ['en-US', 'zh-TW', 'ja', 'es'].indexOf(selected);
  const keys = contentOnly ? pack.contentKeys : Object.keys(pack.messages);
  return { language: selected, messages: Object.fromEntries(keys.map(key => [key, pack.messages[key][column] ?? pack.messages[key][0] ?? key])) };
}
export function initLanguage(): Promise<void> {
  return initialization ??= (async () => {
    preference = await readLanguagePreference() ?? 'zh-CN';
    ({ language, messages } = await loadLanguageSnapshot(false, preference));
    if (typeof document !== 'undefined') {
      document.documentElement.lang = language;
      const title = ({ '/vault.html': '密码库', '/options.html': '设置', '/reminder.html': '提醒中心', '/login-status.html': '登录状态' } as Record<string, string>)[location.pathname];
      document.title = title ? `KeyPilot · ${t(title)}` : 'KeyPilot';
    }
  })().catch(error => {
    // A missing/corrupt pack must never prevent unlocking the local vault.
    language = 'zh-CN'; messages = {}; console.warn('KeyPilot language pack could not be loaded.', error);
    if (typeof document !== 'undefined') document.documentElement.lang = language;
  });
}
