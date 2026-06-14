import type { DiagnosticLogEntry } from './types';

const DIAGNOSTIC_LOG_STORAGE_KEY = 'keypilot.diagnosticLogs';

export const DEFAULT_DIAGNOSTIC_LOG_LIMIT = 50;
export const DEFAULT_DIAGNOSTIC_LOG_RETENTION_DAYS = 7;
export const MAX_DIAGNOSTIC_LOG_LIMIT = 100;
export const MAX_DIAGNOSTIC_LOG_RETENTION_DAYS = 30;

export interface DiagnosticLogOptions {
  limit?: number;
  retentionDays?: number;
}

type DiagnosticLogDraft = Omit<DiagnosticLogEntry, 'id' | 'createdAt'> & Partial<Pick<DiagnosticLogEntry, 'id' | 'createdAt'>>;

function hasChromeStorage(): boolean {
  return Boolean(globalThis.chrome?.storage?.local);
}

function normalizeLimit(value = DEFAULT_DIAGNOSTIC_LOG_LIMIT): number {
  const numeric = Number.isFinite(value) ? Math.floor(value) : DEFAULT_DIAGNOSTIC_LOG_LIMIT;
  return Math.min(MAX_DIAGNOSTIC_LOG_LIMIT, Math.max(1, numeric));
}

function normalizeRetentionDays(value = DEFAULT_DIAGNOSTIC_LOG_RETENTION_DAYS): number {
  const numeric = Number.isFinite(value) ? Math.floor(value) : DEFAULT_DIAGNOSTIC_LOG_RETENTION_DAYS;
  return Math.min(MAX_DIAGNOSTIC_LOG_RETENTION_DAYS, Math.max(1, numeric));
}

function truncate(value: string | undefined, maxLength: number): string | undefined {
  if (!value) return undefined;
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

function sanitizeCounts(counts: DiagnosticLogEntry['counts']): DiagnosticLogEntry['counts'] {
  if (!counts) return undefined;

  return Object.fromEntries(
    Object.entries(counts)
      .slice(0, 14)
      .map(([key, value]) => [
        truncate(key.replace(/[^\w.-]/g, '_'), 40) ?? 'value',
        typeof value === 'string' ? truncate(value, 90) ?? '' : value
      ])
  );
}

function sanitizeEntry(entry: DiagnosticLogDraft): DiagnosticLogEntry {
  return {
    id: entry.id || crypto.randomUUID(),
    createdAt: entry.createdAt || Date.now(),
    area: entry.area,
    event: truncate(entry.event, 80) || 'event',
    outcome: entry.outcome,
    domain: truncate(entry.domain.replace(/^www\./i, '').toLowerCase(), 160) || 'unknown',
    reason: truncate(entry.reason, 260),
    signal: truncate(entry.signal, 80),
    source: truncate(entry.source, 80),
    counts: sanitizeCounts(entry.counts)
  };
}

function pruneEntries(entries: DiagnosticLogEntry[], options: DiagnosticLogOptions = {}): DiagnosticLogEntry[] {
  const limit = normalizeLimit(options.limit);
  const retentionDays = normalizeRetentionDays(options.retentionDays);
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

  return entries
    .filter((entry) => entry.createdAt >= cutoff)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit);
}

async function readEntries(): Promise<DiagnosticLogEntry[]> {
  if (hasChromeStorage()) {
    const result = await chrome.storage.local.get(DIAGNOSTIC_LOG_STORAGE_KEY);
    const value = result[DIAGNOSTIC_LOG_STORAGE_KEY];
    return Array.isArray(value) ? (value as DiagnosticLogEntry[]) : [];
  }

  const value = globalThis.localStorage?.getItem(DIAGNOSTIC_LOG_STORAGE_KEY);
  return value ? (JSON.parse(value) as DiagnosticLogEntry[]) : [];
}

async function writeEntries(entries: DiagnosticLogEntry[]): Promise<void> {
  if (hasChromeStorage()) {
    await chrome.storage.local.set({ [DIAGNOSTIC_LOG_STORAGE_KEY]: entries });
    return;
  }

  globalThis.localStorage?.setItem(DIAGNOSTIC_LOG_STORAGE_KEY, JSON.stringify(entries));
}

export async function getDiagnosticLogEntries(options: DiagnosticLogOptions = {}): Promise<DiagnosticLogEntry[]> {
  const entries = await readEntries();
  const pruned = pruneEntries(entries, options);

  if (pruned.length !== entries.length) {
    await writeEntries(pruned);
  }

  return pruned;
}

export async function appendDiagnosticLogEntry(entry: DiagnosticLogDraft, options: DiagnosticLogOptions = {}): Promise<DiagnosticLogEntry[]> {
  const entries = await readEntries();
  const nextEntries = pruneEntries([sanitizeEntry(entry), ...entries], options);
  await writeEntries(nextEntries);
  return nextEntries;
}

export async function clearDiagnosticLogEntries(): Promise<void> {
  if (hasChromeStorage()) {
    await chrome.storage.local.remove(DIAGNOSTIC_LOG_STORAGE_KEY);
    return;
  }

  globalThis.localStorage?.removeItem(DIAGNOSTIC_LOG_STORAGE_KEY);
}
