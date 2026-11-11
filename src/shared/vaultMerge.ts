import type { VaultPlain } from './types';

function same(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value,index) => same(value,right[index]));
  }
  // chrome.storage can reorder object keys, including objects inside history/code arrays.
  const a = left as Record<string,unknown>, b = right as Record<string,unknown>;
  const keys = Object.keys(a).filter(key => a[key] !== undefined);
  return keys.length === Object.keys(b).filter(key => b[key] !== undefined).length && keys.every(key => same(a[key],b[key]));
}

export { same as sameVaultValue };

// Three-way merge: unrelated changes survive; competing edits are never silently lost.
function mergeValue(base: unknown, next: unknown, current: unknown): unknown {
  if (same(base, next)) return current;
  if (same(base, current) || same(next, current)) return next;
  if (base && next && current && !Array.isArray(base) && !Array.isArray(next) && !Array.isArray(current) &&
      typeof base === 'object' && typeof next === 'object' && typeof current === 'object') {
    return mergeObject(base, next, current);
  }
  throw new Error('VAULT_WRITE_CONFLICT');
}

function mergeObject(base: object, next: object, current: object): Record<string, unknown> {
  const b = base as Record<string, unknown>;
  const n = next as Record<string, unknown>;
  const c = current as Record<string, unknown>;
  const result = { ...c };
  for (const key of new Set([...Object.keys(b), ...Object.keys(n)])) {
    // Timestamps are metadata, not competing user edits.
    if (key === 'updatedAt' || key === 'lastUsedAt') {
      result[key] = Math.max(Number(n[key]) || 0, Number(c[key]) || 0) || undefined;
    } else {
      result[key] = mergeValue(b[key], n[key], c[key]);
    }
  }
  return result;
}

function mergeItems(base: { id: string }[], next: { id: string }[], current: { id: string }[]) {
  const b = new Map(base.map(item => [item.id, item]));
  const n = new Map(next.map(item => [item.id, item]));
  const c = new Map(current.map(item => [item.id, item]));
  for (const id of new Set([...b.keys(), ...n.keys()])) {
    const merged = mergeValue(b.get(id), n.get(id), c.get(id)) as { id: string } | undefined;
    if (merged) c.set(id, merged); else c.delete(id);
  }
  return [...c.values()];
}

export function mergeVaultChanges(base: VaultPlain, next: VaultPlain, current: VaultPlain): VaultPlain {
  const result = { ...current, settings: mergeObject(base.settings, next.settings, current.settings) } as unknown as VaultPlain;
  for (const key of ['credentials', 'totpAccounts', 'reminders', 'secureNotes', 'identities', 'fillProfiles', 'folders', 'deletedItems'] as const) {
    (result as unknown as Record<string, unknown>)[key] = mergeItems(base[key] ?? [], next[key] ?? [], current[key] ?? []);
  }
  return result;
}
