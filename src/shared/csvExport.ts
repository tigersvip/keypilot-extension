import type { Credential, CredentialFormField } from './types';

const ROBOFORM_HEADERS = ['Name', 'Url', 'MatchUrl', 'Login', 'Pwd', 'Note', 'Folder', 'RfFieldsV2', '', '', '', '', '', '', '', '', '', ''];

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
