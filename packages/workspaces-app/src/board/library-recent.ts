/**
 * The Library front page's two lists, as two tabs in one row (Bryan,
 * 2026-11-13): Recently Viewed, what the person reading opened, by when they
 * opened it (`packages/server/src/library-views.ts` keeps that, one list per
 * person, and never an agent's reads), and Recently Created, the board's
 * items by when each was made.
 *
 * Markup and the stored tab choice; `library-page.ts` wires the events.
 */
import { escapeHtml } from '@claude-workspaces/core';
import { recentRows } from './library-folders-model.ts';
import {
  LIBRARY_RECENT,
  type LibraryFileEntry,
  type LibraryPayload,
  type LibraryRow,
  type LibrarySort,
  fileEntries,
} from './library-model.ts';

/** Which of the two lists the tab row shows. */
export type RecentTab = 'viewed' | 'created';

/** Where this device keeps the tab last picked: a per-device choice. */
export const RECENT_TAB_KEY = 'cw-library-recent-tab';

export interface RecentTabStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The stored tab, or Recently Viewed when none is stored or storage is blocked. */
export function readRecentTab(storage: RecentTabStorage | undefined): RecentTab {
  try {
    return storage?.getItem(RECENT_TAB_KEY) === 'created' ? 'created' : 'viewed';
  } catch {
    return 'viewed';
  }
}

export function writeRecentTab(storage: RecentTabStorage | undefined, tab: RecentTab): void {
  try {
    storage?.setItem(RECENT_TAB_KEY, tab);
  } catch {
    // Blocked storage (Safari private mode): the choice lasts this page only.
  }
}

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

type RowHtml = (row: LibraryRow, opts: { clock: LibrarySort; showFolder?: boolean }) => string;

const TAB_LABEL: Record<RecentTab, string> = {
  viewed: 'Recently Viewed',
  created: 'Recently Created',
};

/**
 * The two tabs, then the chosen list. The tabs keep their place and width
 * whichever is chosen: one weight for both labels, the underline always
 * drawn and only coloured. Recently Viewed's "Show more" sits at the row's
 * right, sized for its longer label, so it moves nothing either.
 */
export function recentTabsHtml(
  tab: RecentTab,
  payload: LibraryPayload,
  opts: {
    viewedOpen: boolean;
    rowHtml: RowHtml;
    entryHtml: (entry: LibraryFileEntry) => string;
  },
): string {
  const tabs = (['viewed', 'created'] as const)
    .map(
      (t) =>
        `<button type="button" role="tab" class="board-detail-tab lf-recent-tab" id="lf-tab-${t}" data-lf-tab="${t}" aria-selected="${t === tab}" aria-controls="lf-panel-${t}" tabindex="${t === tab ? 0 : -1}">${TAB_LABEL[t]}</button>`,
    )
    .join('');
  const viewed = viewedRows(payload);
  const toggle =
    tab === 'viewed' && viewed.length > LIBRARY_VIEWED
      ? `<button type="button" class="lf-newfolder lf-viewmore" data-lf-viewmore aria-expanded="${opts.viewedOpen}">${opts.viewedOpen ? 'Show less' : 'Show more'}</button>`
      : '';
  const panel =
    tab === 'viewed'
      ? viewedPanelHtml(viewed, opts.viewedOpen, opts.rowHtml)
      : createdPanelHtml(payload, opts.entryHtml);
  return `<div class="lf-section-head lf-recent-tabs"><div class="lf-tablist" role="tablist" aria-label="Recent files">${tabs}</div>${toggle}</div><div class="lf-recent-panel" role="tabpanel" id="lf-panel-${tab}" aria-labelledby="lf-tab-${tab}" data-lf-panel="${tab}">${panel}</div>`;
}

function viewedPanelHtml(rows: readonly LibraryRow[], open: boolean, rowHtml: RowHtml): string {
  const shown = rows.slice(0, open ? LIBRARY_VIEWED_MORE : LIBRARY_VIEWED);
  const inner = shown.map((r) => rowHtml(r, { clock: 'modified', showFolder: true })).join('');
  return fixedTable('Viewed', inner, 'Nothing opened yet.');
}

/**
 * Recently Created, counted in ENTRIES: a burst is one line of the ten, so a
 * generator's run cannot push everything else off the front page.
 */
function createdPanelHtml(
  payload: LibraryPayload,
  entryHtml: (entry: LibraryFileEntry) => string,
): string {
  const meetings = new Set(payload.meetings);
  const entries = fileEntries(recentRows(payload, 'created'), 'created', (r) => meetings.has(r));
  const more =
    entries.length > LIBRARY_RECENT.files
      ? '<button type="button" class="library-more" data-list="files">See all files</button>'
      : '';
  const shown = entries.slice(0, LIBRARY_RECENT.files).map(entryHtml).join('');
  return `${fixedTable('Created', shown, 'No files yet.')}${more}`;
}

/**
 * A tap on a tab picks it; on a focused tab, Left/Right/Home/End pick the
 * other one (the ARIA tabs pattern, where only the chosen tab is a Tab stop).
 * Focus follows the pick onto the re-rendered tab.
 */
export function wireRecentTabs(root: HTMLElement, pick: (tab: RecentTab) => void): void {
  const choose = (tab: RecentTab) => {
    pick(tab);
    root.querySelector<HTMLElement>(`[data-lf-tab=${tab}]`)?.focus();
  };
  root.addEventListener('click', (e) => {
    const hit = (e.target as Element).closest<HTMLElement>('[data-lf-tab]');
    if (hit) choose(hit.dataset.lfTab === 'created' ? 'created' : 'viewed');
  });
  root.addEventListener('keydown', (e) => {
    const on = (e.target as Element).closest<HTMLElement>('[data-lf-tab]');
    if (!on) return;
    const next: Record<string, RecentTab> = {
      ArrowLeft: 'viewed',
      Home: 'viewed',
      ArrowRight: 'created',
      End: 'created',
    };
    const tab = next[e.key];
    if (!tab) return;
    e.preventDefault();
    choose(tab);
  });
}
