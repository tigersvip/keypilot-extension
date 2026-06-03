import { domainsMatch } from './domain';
import { buildCredential } from './vault';
import type { Credential, CredentialFormField, CredentialSource } from './types';

export type ImportSource = 'roboform' | 'chrome' | 'edge' | 'generic';
export type ImportRowStatus = 'ready' | 'duplicate' | 'conflict' | 'invalid';
export type ImportIssueSeverity = 'warning' | 'error';

export interface ImportIssue {
  code:
    | 'missing_url'
    | 'missing_username'
    | 'missing_password'
    | 'missing_identity'
    | 'duplicate_existing'
    | 'duplicate_file'
    | 'conflict_existing';
  message: string;
  severity: ImportIssueSeverity;
}

export interface ImportPreviewRow {
  rowNumber: number;
  status: ImportRowStatus;
  title: string;
  url: string;
  domain: string;
  username: string;
  issues: ImportIssue[];
  credential?: Credential;
  existingCredentialId?: string;
  existingTitle?: string;
  existingUsername?: string;
}

export interface ImportPreview {
  total: number;
  importable: Credential[];
  rows: ImportPreviewRow[];
  duplicates: number;
  conflicts: number;
  missingUrl: number;
  missingUsername: number;
  missingPassword: number;
  invalid: number;
}

const TITLE_HEADERS = ['title', 'name', 'login', 'login name', 'passcard', 'caption', '名称', '标题', '登录名'];
const URL_HEADERS = [
  'url',
  'login url',
  'login_url',
  'loginurl',
  'web site',
  'website',
  'site',
  'site url',
  'web address',
  'domain',
  '网址',
  '网站',
  '域名'
];
const MATCH_URL_HEADERS = [
  'matchurl',
  'match url',
  'match_url',
  'matching url',
  'matching_url',
  'url match',
  'match pattern',
  'match_pattern'
];
const USERNAME_HEADERS = [
  'username',
  'user name',
  'user',
  'userid',
  'user id',
  'login',
  'login id',
  'login name',
  'login username',
  'email',
  'email address',
  'account',
  '用户名',
  '用户',
  '账号',
  '帐号',
  '账户',
  '邮箱'
];
const PASSWORD_HEADERS = ['password', 'pass', 'pwd', 'passwd', 'psw', 'pass word', 'login password', 'web password', 'passcard password', '密码', '口令'];
const NOTE_HEADERS = ['notes', 'note', 'memo', 'comment', 'comments', '备注', '说明'];
const FOLDER_HEADERS = ['folder', 'group', 'category', 'path', '文件夹', '分组', '分类'];
const ROBOFORM_FIELDS_HEADERS = ['rffieldsv2', 'rf fields v2', 'rf fields'];

function detectDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/)[0] ?? '';
  const delimiters = [',', ';', '\t'];

  return delimiters
    .map((delimiter) => ({ delimiter, count: firstLine.split(delimiter).length }))
    .sort((left, right) => right.count - left.count)[0]?.delimiter ?? ',';
}

function parseCsvRows(text: string): string[][] {
  const delimiter = detectDelimiter(text);
  const rows: string[][] = [];
  let current = '';
  let row: string[] = [];
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === '"' && quoted && next === '"') {
      current += '"';
      index += 1;
      continue;
    }

    if (char === '"') {
      quoted = !quoted;
      continue;
    }

    if (char === delimiter && !quoted) {
      row.push(current.trim());
      current = '';
      continue;
    }

    if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && next === '\n') index += 1;

      row.push(current.trim());
      current = '';

      if (row.some(Boolean)) rows.push(row);

      row = [];
      continue;
    }

    current += char;
  }

  row.push(current.trim());

  if (row.some(Boolean)) rows.push(row);

  return rows;
}

function normalizeHeader(value: string): string {
  return value
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function pick(record: Record<string, string>, candidates: string[]): string {
  for (const candidate of candidates) {
    const value = record[normalizeHeader(candidate)];
    if (value) return value;
  }

  return '';
}

function toRecord(headers: string[], row: string[]): Record<string, string> {
  return headers.reduce<Record<string, string>>((record, header, index) => {
    record[normalizeHeader(header)] = row[index]?.trim() ?? '';
    return record;
  }, {});
}

function isUsernameLabel(label: string): boolean {
  return /user|login|email|mail|account|id|用户名|用户|账号|帐号|账户|邮箱/i.test(label);
}

function parseRoboFormFieldsV2(value: string): { username: string; password: string; formFields: CredentialFormField[] } {
  if (!value) return { username: '', password: '', formFields: [] };

  const parts = value.split(',');
  const formFields: CredentialFormField[] = [];
  let username = '';
  let password = '';

  for (let index = 0; index + 4 < parts.length; index += 5) {
    const label = (parts[index] ?? '').replace(/\$$/, '').trim() || parts[index + 1]?.trim() || '';
    const name = parts[index + 1]?.trim() || label;
    const type = parts[index + 3]?.trim().toLowerCase() || 'txt';
    const fieldValue = parts[index + 4]?.trim() ?? '';

    if (!fieldValue) continue;

    const kind: CredentialFormField['kind'] = type === 'pwd' ? 'password' : isUsernameLabel(`${label} ${name}`) ? 'username' : 'text';

    if (kind === 'password' && !password) password = fieldValue;
    if (kind === 'username' && !username) username = fieldValue;

    formFields.push({
      label: label || name || (kind === 'password' ? 'Password' : 'Field'),
      name: name || undefined,
      type: kind === 'password' ? 'password' : 'text',
      value: fieldValue,
      kind,
      index: formFields.length
    });
  }

  return { username, password, formFields };
}

function mapRecord(record: Record<string, string>, source: ImportSource) {
  if (source === 'roboform') {
    const fields = parseRoboFormFieldsV2(pick(record, ROBOFORM_FIELDS_HEADERS));

    return {
      title: pick(record, TITLE_HEADERS),
      url: pick(record, URL_HEADERS),
      matchUrl: pick(record, MATCH_URL_HEADERS),
      username: pick(record, USERNAME_HEADERS) || fields.username,
      password: pick(record, PASSWORD_HEADERS) || fields.password,
      notes: pick(record, NOTE_HEADERS),
      folder: pick(record, FOLDER_HEADERS),
      formFields: fields.formFields
    };
  }

  return {
    title: pick(record, TITLE_HEADERS),
    url: pick(record, URL_HEADERS),
    matchUrl: pick(record, MATCH_URL_HEADERS),
    username: pick(record, USERNAME_HEADERS),
    password: pick(record, PASSWORD_HEADERS),
    notes: pick(record, NOTE_HEADERS),
    folder: pick(record, FOLDER_HEADERS),
    formFields: [] as CredentialFormField[]
  };
}

function sameLocation(left: Credential, right: Credential): boolean {
  if (left.domain || right.domain) return domainsMatch(left.domain, right.domain);
  return left.url === right.url;
}

function sameAccount(left: Credential, right: Credential): boolean {
  return Boolean(sameLocation(left, right) && left.username && left.username === right.username);
}

function sameAccountPassword(left: Credential, right: Credential): boolean {
  return sameLocation(left, right) && left.username === right.username && left.password === right.password;
}

function importFingerprint(credential: Credential): string {
  return [credential.domain || credential.url, credential.username, credential.password].join('\u001F').toLowerCase();
}

export function parseCredentialCsv(text: string, source: ImportSource, existing: Credential[]): ImportPreview {
  const rows = parseCsvRows(text.trim());
  const [headers, ...dataRows] = rows;

  if (!headers || headers.length < 2) throw new Error('CSV_FORMAT_ERROR');

  const preview: ImportPreview = {
    total: dataRows.length,
    importable: [],
    rows: [],
    duplicates: 0,
    conflicts: 0,
    missingUrl: 0,
    missingUsername: 0,
    missingPassword: 0,
    invalid: 0
  };
  const importedFingerprints = new Set<string>();

  for (const [index, row] of dataRows.entries()) {
    const record = mapRecord(toRecord(headers, row), source);
    const issues: ImportIssue[] = [];

    if (!record.url) {
      preview.missingUrl += 1;
      issues.push({ code: 'missing_url', message: '缺少网址，可导入但后续无法按网站自动匹配。', severity: 'warning' });
    }

    if (!record.username) {
      preview.missingUsername += 1;
      issues.push({ code: 'missing_username', message: '缺少用户名，可导入但需要后续手动补全。', severity: 'warning' });
    }

    if (!record.password) {
      preview.missingPassword += 1;
      preview.invalid += 1;
      issues.push({ code: 'missing_password', message: '缺少密码，默认不导入。', severity: 'error' });
      preview.rows.push({
        rowNumber: index + 2,
        status: 'invalid',
        title: record.title,
        url: record.url,
        domain: '',
        username: record.username,
        issues
      });
      continue;
    }

    if (!record.username && !record.url && !record.title) {
      preview.invalid += 1;
      issues.push({ code: 'missing_identity', message: '缺少网址、标题和用户名，无法判断这条记录属于哪个账号。', severity: 'error' });
      preview.rows.push({
        rowNumber: index + 2,
        status: 'invalid',
        title: record.title,
        url: record.url,
        domain: '',
        username: record.username,
        issues
      });
      continue;
    }

    const credential = buildCredential({
      ...record,
      source: source as CredentialSource
    });
    const existingDuplicate = existing.find((item) => sameAccountPassword(item, credential));
    const fingerprint = importFingerprint(credential);
    const duplicateInFile = importedFingerprints.has(fingerprint);

    if (existingDuplicate || duplicateInFile) {
      preview.duplicates += 1;
      issues.push({
        code: existingDuplicate ? 'duplicate_existing' : 'duplicate_file',
        message: existingDuplicate ? '与当前 Vault 中的账号完全重复，已跳过。' : '与本次 CSV 中前面的记录完全重复，已跳过。',
        severity: 'warning'
      });
      preview.rows.push({
        rowNumber: index + 2,
        status: 'duplicate',
        title: credential.title,
        url: credential.url,
        domain: credential.domain,
        username: credential.username,
        credential,
        existingCredentialId: existingDuplicate?.id,
        existingTitle: existingDuplicate?.title,
        existingUsername: existingDuplicate?.username,
        issues
      });
      continue;
    }

    const conflict = existing.find((item) => sameAccount(item, credential) && item.password !== credential.password);

    if (conflict) {
      preview.conflicts += 1;
      issues.push({
        code: 'conflict_existing',
        message: `与现有账号“${conflict.title}”用户名相同但密码不同。`,
        severity: 'warning'
      });
    }

    importedFingerprints.add(fingerprint);
    preview.importable.push(credential);
    preview.rows.push({
      rowNumber: index + 2,
      status: conflict ? 'conflict' : 'ready',
      title: credential.title,
      url: credential.url,
      domain: credential.domain,
      username: credential.username,
      credential,
      existingCredentialId: conflict?.id,
      existingTitle: conflict?.title,
      existingUsername: conflict?.username,
      issues
    });
  }

  return preview;
}
