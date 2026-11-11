import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { formatMessage, normalizeLanguage, resolveLanguage } from '../src/shared/language';
import { buildLocaleAsset, localeOrder } from '../tools/locale-assets';
import { createEmptyVault } from '../src/shared/defaults';
import { createEncryptedVault, unlockEncryptedVault } from '../src/shared/crypto';
import { normalizeVault } from '../src/shared/vault';
import { mergeBackupSettings } from '../src/shared/backupSettings';

test('language preferences resolve browser regions, keep legacy Chinese and reject unknown values', () => {
  assert.equal(normalizeLanguage(undefined), 'zh-CN');
  assert.equal(normalizeLanguage('../../other'), 'zh-CN');
  assert.equal(resolveLanguage('zh-CN', ['en-US']), 'zh-CN');
  for (const [input, expected] of [['zh-Hant-HK', 'zh-TW'], ['zh-Hans-SG', 'zh-CN'], ['ja-JP', 'ja'], ['es-MX', 'es'], ['en-GB', 'en-US'], ['de-DE', 'en-US']]) {
    assert.equal(resolveLanguage('auto', [input]), expected);
  }
  assert.equal(resolveLanguage('auto', ['de', 'es-AR']), 'es');
});

test('message interpolation preserves user text and never recursively expands placeholders', () => {
  assert.equal(formatMessage('View {0} · {1}', ['密码 <img> {1}', 'demo']), 'View 密码 <img> {1} · demo');
  assert.equal(formatMessage('{0}: {0}, {2}', [0]), '0: 0, {2}');
});

test('every explicit UI translation has English coverage and every locale keeps its placeholders', () => {
  const catalogs = Object.fromEntries(localeOrder.map(locale => [locale, JSON.parse(readFileSync(`src/locales/${locale}.json`, 'utf8')) as Record<string, string>]));
  const english = catalogs['en-US'];
  const placeholders = (text: string) => [...text.matchAll(/\{\d+\}/g)].map(match => match[0]).sort();
  for (const [locale, catalog] of Object.entries(catalogs)) for (const [key, value] of Object.entries(catalog)) {
    assert.ok(english[key], `${locale}: unknown message ${key}`);
    assert.ok(value.trim(), `${locale}: empty message ${key}`);
    assert.deepEqual(placeholders(value), placeholders(key), `${locale}: placeholders for ${key}`);
  }
  function walk(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { walk(path); continue; }
      if (!/\.tsx?$/.test(path)) continue;
      const file = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
      function visit(node: ts.Node) {
        if (ts.isCallExpression(node) && node.expression.getText(file) === 't' && ts.isStringLiteralLike(node.arguments[0])) {
          const key = node.arguments[0].text;
          assert.ok(english[key] || english[key.trim()], `Missing English message in ${path}: ${key}`);
        }
        ts.forEachChild(node, visit);
      }
      visit(file);
    }
  }
  walk('src');
  const packed = JSON.parse(buildLocaleAsset(resolve('.')));
  assert.equal(packed.messages['保存'][0], 'Save');
  assert.ok(packed.contentKeys.includes('确认填写'));
});

test('language travels with encrypted backups and respects selective settings restore', async () => {
  const vault = createEmptyVault(); vault.settings.language = 'es';
  const encrypted = await createEncryptedVault('Synthetic-master!42', vault);
  const restored = await unlockEncryptedVault('Synthetic-master!42', encrypted.encryptedVault);
  assert.equal(normalizeVault(restored.vault).settings.language, 'es');
  const existing = createEmptyVault(); existing.settings.language = 'ja';
  assert.equal(mergeBackupSettings(existing.settings, restored.vault.settings, {}).language, 'ja');
  assert.equal(mergeBackupSettings(existing.settings, restored.vault.settings, { preferences: true }).language, 'es');
  assert.equal(normalizeVault({ ...vault, settings: { ...vault.settings, language: 'unsupported' as 'es' } }).settings.language, 'zh-CN');
});
