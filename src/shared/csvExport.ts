import type { Credential, CredentialFormField } from './types';

const ROBOFORM_HEADERS = ['Name', 'Url', 'MatchUrl', 'Login', 'Pwd', 'Note', 'Folder', 'RfFieldsV2', '', '', '', '', '', '', '', '', '', ''];
const CHROME_HEADERS = ['name', 'url', 'username', 'password'];
const GENERIC_HEADERS = ['Title', 'Url', 'MatchUrl', 'Domain', 'Username', 'Password', 'Notes', 'Folder', 'Tags', 'CreatedAt', 'UpdatedAt'];

export type CredentialExportFormat = 'roboform-csv' | 'chrome-csv' | 'edge-csv' | 'generic-csv' | 'keypilot-json';

export interface CredentialExportResult {
  body: string;
  mimeType: string;
  extension: 'csv' | 'json';
  filenamePrefix: string;
  label: string;
  addBom?: boolean;
}

function csvCell(value: string | undefined): string {
  const text = value ?? '';

  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }

  return text;
}

function roboFormFieldType(field: CredentialFormField): string {
  return field.kind === 'password' || field.type === 'password' ? 'pwd' : 'txt';
}

function roboFormPart(value: string): string {
  return value.replace(/[,\r\n]/g, ' ').trim();
}

function fallbackFields(credential: Credential): CredentialFormField[] {
  const fields: CredentialFormField[] = [
    {
      label: 'User ID',
      name: 'User ID',
      type: 'text',
      value: credential.username,
      kind: 'username',
      index: 0
    },
    {
      label: 'Password',
      name: 'Password',
      type: 'password',
      value: credential.password,
      kind: 'password',
      index: 1
    }
  ];

  return fields.filter((field) => field.value);
}

function roboFormFieldValue(credential: Credential): string {
  const fields = credential.formFields?.length ? credential.formFields : fallbackFields(credential);

  return fields
    .filter((field) => field.value)
    .slice(0, 40)
    .map((field) => {
      const label = roboFormPart(field.label || field.name || (field.kind === 'password' ? 'Password' : 'User ID')).replace(/\$$/, '');
      const name = roboFormPart(field.name || label);
      return `${label}$,${name},,${roboFormFieldType(field)},${roboFormPart(field.value)}`;
    })
    .join(',');
}

export function exportRoboFormCsv(credentials: Credential[]): string {
  const rows = credentials.map((credential) => {
    const row = [
      credential.title,
      credential.url,
      credential.matchUrl || credential.url,
      credential.username,
      credential.password,
      credential.notes ?? '',
      credential.folder ?? '',
      roboFormFieldValue(credential),
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      ''
    ];

    return row.map(csvCell).join(',');
  });

  return [ROBOFORM_HEADERS.join(','), ...rows].join('\r\n');
}

export function exportBrowserPasswordCsv(credentials: Credential[]): string {
  const rows = credentials.map((credential) =>
    [
      credential.title || credential.domain || credential.url,
      credential.url || credential.matchUrl,
      credential.username,
      credential.password
    ].map(csvCell).join(',')
  );

  return [CHROME_HEADERS.join(','), ...rows].join('\r\n');
}

export function exportGenericCredentialCsv(credentials: Credential[]): string {
  const rows = credentials.map((credential) =>
    [
      credential.title,
      credential.url,
      credential.matchUrl || credential.url,
      credential.domain,
      credential.username,
      credential.password,
      credential.notes ?? '',
      credential.folder ?? '',
      (credential.tags ?? []).join('; '),
      credential.createdAt ? new Date(credential.createdAt).toISOString() : '',
      credential.updatedAt ? new Date(credential.updatedAt).toISOString() : ''
    ].map(csvCell).join(',')
  );

  return [GENERIC_HEADERS.join(','), ...rows].join('\r\n');
}

export function exportKeyPilotCredentialsJson(credentials: Credential[]): string {
  return JSON.stringify(
    {
      format: 'keypilot-credentials',
      version: 1,
      exportedAt: new Date().toISOString(),
      credentials: credentials.map(({passwordHistory: _history,recoveryCodes: _codes,...credential})=>credential)
    },
    null,
    2
  );
}

export function exportCredentialsByFormat(credentials: Credential[], format: CredentialExportFormat): CredentialExportResult {
  if (format === 'chrome-csv') {
    return {
      body: exportBrowserPasswordCsv(credentials),
      mimeType: 'text/csv;charset=utf-8',
      extension: 'csv',
      filenamePrefix: 'keypilot-chrome-passwords',
      label: 'Chrome CSV',
      addBom: true
    };
  }

  if (format === 'edge-csv') {
    return {
      body: exportBrowserPasswordCsv(credentials),
      mimeType: 'text/csv;charset=utf-8',
      extension: 'csv',
      filenamePrefix: 'keypilot-edge-passwords',
      label: 'Edge CSV',
      addBom: true
    };
  }

  if (format === 'generic-csv') {
    return {
      body: exportGenericCredentialCsv(credentials),
      mimeType: 'text/csv;charset=utf-8',
      extension: 'csv',
      filenamePrefix: 'keypilot-credentials',
      label: '通用 CSV',
      addBom: true
    };
  }

  if (format === 'keypilot-json') {
    return {
      body: exportKeyPilotCredentialsJson(credentials),
      mimeType: 'application/json;charset=utf-8',
      extension: 'json',
      filenamePrefix: 'keypilot-credentials',
      label: 'KeyPilot JSON'
    };
  }

  return {
    body: exportRoboFormCsv(credentials),
    mimeType: 'text/csv;charset=utf-8',
    extension: 'csv',
    filenamePrefix: 'keypilot-roboform-export',
    label: 'RoboForm CSV',
    addBom: true
  };
}
