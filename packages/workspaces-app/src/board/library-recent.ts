/**
 * The Library front page's two lists: Recently Created, the board's items by
 * when each was made, and Recently Viewed, what the person reading opened,
 * by when they opened it (`packages/server/src/library-views.ts` keeps that,
 * one list per person, and never an agent's reads).
 *
 * Markup only; `library-page.ts` decides what to show and wires the events.
 */
import { escapeHtml } from '@claude-workspaces/core';
import type { LibraryPayload, LibraryRow, LibrarySort } from './library-model.ts';

/** How many views show before "Show more". */
export const LIBRARY_VIEWED = 5;
/** How many views "Show more" opens onto. */
export const LIBRARY_VIEWED_MORE = 25;

/**
 * The reader's views as rows, newest first: each item's own row, with its
 * clock replaced by when it was opened. A view of an item the payload no
 * longer lists is dropped.
 */
export function viewedRows(payload: LibraryPayload): LibraryRow[] {
  const byDoc = new Map<string, LibraryRow>();
  for (const row of [...payload.meetings, ...payload.files]) {
    if (row.docId && !byDoc.has(row.docId)) byDoc.set(row.docId, row);
  }
  const out: LibraryRow[] = [];
  for (const v of payload.viewed ?? []) {
    const row = byDoc.get(v.docId);
    if (row) out.push({ ...row, at: v.at });
  }
  return out;
}

/** A front-page table: two fixed headers, no sort to choose. */
export function fixedTable(timeHeader: string, inner: string, empty: string): string {
  const list = inner || `<div class="library-empty">${escapeHtml(empty)}</div>`;
  return `<div class="library-tbl lf-tbl"><div class="library-cols"><span aria-hidden="true">Name</span><span class="lf-colhead">${escapeHtml(timeHeader)}</span><span aria-hidden="true"></span></div><div class="library-list">${list}</div></div>`;
}

/**
 * Recently Viewed. "Show more" sits in the heading's row, sized for its
 * longer label, so opening the list moves neither it nor anything above.
 */
export function viewedSectionHtml(
  rows: readonly LibraryRow[],
  open: boolean,
  rowHtml: (row: LibraryRow, opts: { clock: LibrarySort; showFolder?: boolean }) => string,
): string {
  const shown = rows.slice(0, open ? LIBRARY_VIEWED_MORE : LIBRARY_VIEWED);
  const toggle =
    rows.length > LIBRARY_VIEWED
      ? `<button type="button" class="lf-newfolder lf-viewmore" data-lf-viewmore aria-expanded="${open}">${open ? 'Show less' : 'Show more'}</button>`
      : '';
  const inner = shown.map((r) => rowHtml(r, { clock: 'modified', showFolder: true })).join('');
  return `<div class="lf-section-head lf-viewed-head"><h2>Recently Viewed</h2>${toggle}</div>${fixedTable('Viewed', inner, 'Nothing opened yet.')}`;
}
