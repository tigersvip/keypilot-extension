import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const localeOrder = ['en-US', 'zh-TW', 'ja', 'es'];
export function buildLocaleAsset(root: string): string {
  const catalogs = localeOrder.map(locale => JSON.parse(readFileSync(join(root, 'src/locales', `${locale}.json`), 'utf8')) as Record<string, string>);
  const contentSource = readdirSync(join(root, 'src/content')).filter(name => name.endsWith('.ts')).map(name => readFileSync(join(root, 'src/content', name), 'utf8')).join('\n');
  const messages = Object.fromEntries(Object.keys(catalogs[0]).map(source => {
    const values: (string | null)[] = catalogs.map(catalog => catalog[source] ?? null);
    while (values.at(-1) === null) values.pop();
    return [source, values];
  }));
  const contentKeys = Object.keys(messages).filter(source => contentSource.includes(source));
  // A single asset shares Chinese keys across languages and compresses efficiently.
  return JSON.stringify({ messages, contentKeys });
}
