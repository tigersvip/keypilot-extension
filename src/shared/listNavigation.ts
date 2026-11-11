import type { KeyboardEvent } from 'react';

/** Move between native row buttons without changing their Enter/Space actions. */
export function navigateAccountList(event: KeyboardEvent<HTMLElement>, searchSelector: string, rowSelector: string, clearSearch: () => void) {
  if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const root = event.currentTarget;
  const search = root.querySelector<HTMLInputElement>(searchSelector);
  const target = event.target as HTMLElement;
  const rows = Array.from(root.querySelectorAll<HTMLButtonElement>(rowSelector)).filter(button => !button.disabled && button.getClientRects().length > 0);
  const index = rows.indexOf(target as HTMLButtonElement);
  if (target !== search && index < 0) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    if (target === search) clearSearch();
    else search?.focus({ preventScroll: true });
  } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    if (!rows.length) return;
    event.preventDefault();
    const next = index < 0 ? (event.key === 'ArrowDown' ? 0 : rows.length - 1) : Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
    rows[next].focus({ preventScroll: true });
    rows[next].scrollIntoView({ block: 'nearest' });
  }
}
