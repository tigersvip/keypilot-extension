export interface PasswordGeneratorOptions {
  length: number;
  uppercase: boolean;
  lowercase: boolean;
  numbers: boolean;
  symbols: boolean;
  excludeSimilar: boolean;
  requireEveryType?: boolean;
  excludeCharacters?: string;
  requiredCharacters?: string;
}

const UPPERCASE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const LOWERCASE = 'abcdefghijklmnopqrstuvwxyz';
const NUMBERS = '0123456789';
const SYMBOLS = '!@#$%^&*()-_=+[]{};:,.?';
const SIMILAR = /[il1LoO0]/g;
const MIN_LENGTH = 4;
const MAX_LENGTH = 132;

export const defaultGeneratorOptions: PasswordGeneratorOptions = {
  length: 16,
  uppercase: true,
  lowercase: true,
  numbers: true,
  symbols: true,
  excludeSimilar: true,
  requireEveryType: true,
  excludeCharacters: '',
  requiredCharacters: ''
};

function getRandomIndex(max: number): number {
  const buffer = new Uint32Array(1);
  crypto.getRandomValues(buffer);
  return buffer[0] % max;
}

function cleanCharset(value: string, excludeSimilar: boolean): string {
  return excludeSimilar ? value.replace(SIMILAR, '') : value;
}

function uniqueCharacters(value: string): string {
  return Array.from(new Set(Array.from(value))).join('');
}

function withoutCharacters(value: string, excluded: string): string {
  if (!excluded) return value;

  const excludedSet = new Set(Array.from(excluded));
  return Array.from(value).filter((char) => !excludedSet.has(char)).join('');
}

function normalizeLength(value: number): number {
  if (!Number.isFinite(value)) return defaultGeneratorOptions.length;
  return Math.min(MAX_LENGTH, Math.max(MIN_LENGTH, Math.floor(value)));
}

export function generatePassword(options: PasswordGeneratorOptions): string {
  const excluded = uniqueCharacters(options.excludeCharacters ?? '');
  const requiredCharacters = withoutCharacters(
    cleanCharset(uniqueCharacters(options.requiredCharacters ?? ''), options.excludeSimilar),
    excluded
  );
  const groups = [
    options.uppercase ? cleanCharset(UPPERCASE, options.excludeSimilar) : '',
    options.lowercase ? cleanCharset(LOWERCASE, options.excludeSimilar) : '',
    options.numbers ? cleanCharset(NUMBERS, options.excludeSimilar) : '',
    options.symbols ? SYMBOLS : ''
  ]
    .map((group) => withoutCharacters(group, excluded))
    .filter(Boolean);

  const charset = uniqueCharacters(`${groups.join('')}${requiredCharacters}`);

  if (!charset) {
    return '';
  }

  const required = options.requireEveryType === false ? [] : groups.map((group) => group[getRandomIndex(group.length)]);

  for (const char of requiredCharacters) {
    if (!required.includes(char)) {
      required.push(char);
    }
  }

  const targetLength = Math.max(normalizeLength(options.length), required.length);
  const remainingLength = targetLength - required.length;
  const password = [...required];

  for (let index = 0; index < remainingLength; index += 1) {
    password.push(charset[getRandomIndex(charset.length)]);
  }

  for (let index = password.length - 1; index > 0; index -= 1) {
    const swapIndex = getRandomIndex(index + 1);
    [password[index], password[swapIndex]] = [password[swapIndex], password[index]];
  }

  return password.join('');
}

export function measurePasswordStrength(value: string): { score: number; label: '弱' | '中' | '强' | '极强' } {
  let score = 0;

  if (value.length >= 10) score += 1;
  if (value.length >= 14) score += 1;
  if (/[A-Z]/.test(value) && /[a-z]/.test(value)) score += 1;
  if (/\d/.test(value)) score += 1;
  if (/[^A-Za-z0-9]/.test(value)) score += 1;

  if (score <= 1) return { score, label: '弱' };
  if (score <= 3) return { score, label: '中' };
  if (score === 4) return { score, label: '强' };
  return { score, label: '极强' };
}
