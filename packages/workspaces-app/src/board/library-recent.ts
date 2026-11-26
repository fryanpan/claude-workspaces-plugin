/**
 * The Library front page's three lists, as tabs in one row (Bryan,
 * 2026-11-13, and a third on the hub feedback doc): Recently Viewed, what
 * the person reading opened, by when they opened it
 * (`packages/server/src/library-views.ts` keeps that, one list per person,
 * and never an agent's reads); Recently Modified, every file by its last
 * change; and Recently Created, the board's docs by when the board made each.
 *
 * Recently Created lists what the board made: a new board doc, or a new file
 * an agent wrote through the doc tools. A project file, opened or not, has
 * no created time (the server's `createdOnBoard`): its only clock is its
 * bytes' birth time, and a `git pull` that changes a file writes a new one,
 * so that clock cannot tell a new file from an edited one. It was the whole
 * reason the old Created tab read as Modified.
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

/** Which of the three lists the tab row shows. */
export type RecentTab = 'viewed' | 'modified' | 'created';

/** The tabs, in the row's order. */
export const RECENT_TABS: readonly RecentTab[] = ['viewed', 'modified', 'created'];

const isTab = (v: string | null | undefined): v is RecentTab =>
  v === 'viewed' || v === 'modified' || v === 'created';

/** Where this device keeps the tab last picked: a per-device choice. */
export const RECENT_TAB_KEY = 'cw-library-recent-tab';

export interface RecentTabStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The stored tab, or Recently Viewed when none is stored or storage is blocked. */
export function readRecentTab(storage: RecentTabStorage | undefined): RecentTab {
  try {
    const stored = storage?.getItem(RECENT_TAB_KEY);
    return isTab(stored) ? stored : 'viewed';
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
  modified: 'Recently Modified',
  created: 'Recently Created',
};

/**
 * The tabs, then the chosen list. The tabs keep their place and width
 * whichever is chosen: one weight for every label, the underline always
 * drawn and only coloured. The row holds the tabs and nothing else: three
 * labels fill it at 430, so Recently Viewed's "Show more" sits under its
 * table, where "See all files" sits under the other two.
 */
export function recentTabsHtml(
  tab: RecentTab,
  payload: LibraryPayload,
  opts: {
    viewedOpen: boolean;
    rowHtml: RowHtml;
    entryHtml: (entry: LibraryFileEntry, clock: LibrarySort) => string;
  },
): string {
  const tabs = RECENT_TABS.map(
    (t) =>
      `<button type="button" role="tab" class="board-detail-tab lf-recent-tab" id="lf-tab-${t}" data-lf-tab="${t}" aria-selected="${t === tab}" aria-controls="lf-panel-${t}" tabindex="${t === tab ? 0 : -1}">${TAB_LABEL[t]}</button>`,
  ).join('');
  const viewed = viewedRows(payload);
  const panel =
    tab === 'viewed'
      ? viewedPanelHtml(viewed, opts.viewedOpen, opts.rowHtml)
      : clockPanelHtml(payload, tab, opts.entryHtml);
  return `<div class="lf-section-head lf-recent-tabs"><div class="lf-tablist" role="tablist" aria-label="Recent files">${tabs}</div></div><div class="lf-recent-panel" role="tabpanel" id="lf-panel-${tab}" aria-labelledby="lf-tab-${tab}" data-lf-panel="${tab}">${panel}</div>`;
}

function viewedPanelHtml(rows: readonly LibraryRow[], open: boolean, rowHtml: RowHtml): string {
  const shown = rows.slice(0, open ? LIBRARY_VIEWED_MORE : LIBRARY_VIEWED);
  const inner = shown.map((r) => rowHtml(r, { clock: 'modified', showFolder: true })).join('');
  const toggle =
    rows.length > LIBRARY_VIEWED
      ? `<button type="button" class="lf-newfolder lf-viewmore" data-lf-viewmore aria-expanded="${open}">${open ? 'Show less' : 'Show more'}</button>`
      : '';
  return `${fixedTable('Viewed', inner, 'Nothing opened yet.')}${toggle}`;
}

/** The rows Recently Created lists: board docs with a record's birth. */
export function createdRows(payload: LibraryPayload): LibraryRow[] {
  return recentRows(payload, 'created').filter(
    (r) => r.docId !== undefined && r.created !== undefined,
  );
}

/**
 * Recently Modified or Recently Created, counted in ENTRIES: a burst is one
 * line of the ten, so a generator's run cannot push everything else off the
 * front page.
 */
function clockPanelHtml(
  payload: LibraryPayload,
  clock: LibrarySort,
  entryHtml: (entry: LibraryFileEntry, clock: LibrarySort) => string,
): string {
  const meetings = new Set(payload.meetings);
  const rows = clock === 'created' ? createdRows(payload) : recentRows(payload, 'modified');
  const entries = fileEntries(rows, clock, (r) => meetings.has(r));
  const more =
    entries.length > LIBRARY_RECENT.files
      ? `<button type="button" class="library-more" data-list="files" data-sort="${clock}">See all files</button>`
      : '';
  const shown = entries
    .slice(0, LIBRARY_RECENT.files)
    .map((e) => entryHtml(e, clock))
    .join('');
  const head = clock === 'created' ? 'Created' : 'Modified';
  const empty =
    clock === 'created'
      ? 'Nothing made on this board yet. Files already in the project are under Recently Modified.'
      : 'No files yet.';
  return `${fixedTable(head, shown, empty)}${more}`;
}

/**
 * A tap on a tab picks it; on a focused tab, Left/Right pick its neighbour
 * and Home/End the first or last (the ARIA tabs pattern, where only the
 * chosen tab is a Tab stop).
 * Focus follows the pick onto the re-rendered tab.
 */
export function wireRecentTabs(root: HTMLElement, pick: (tab: RecentTab) => void): void {
  const choose = (tab: RecentTab) => {
    pick(tab);
    root.querySelector<HTMLElement>(`[data-lf-tab=${tab}]`)?.focus();
  };
  root.addEventListener('click', (e) => {
    const hit = (e.target as Element).closest<HTMLElement>('[data-lf-tab]');
    const tab = hit?.dataset.lfTab;
    if (isTab(tab)) choose(tab);
  });
  root.addEventListener('keydown', (e) => {
    const on = (e.target as Element).closest<HTMLElement>('[data-lf-tab]');
    if (!on) return;
    const at = RECENT_TABS.indexOf(isTab(on.dataset.lfTab) ? on.dataset.lfTab : 'viewed');
    const last = RECENT_TABS.length - 1;
    const step: Record<string, number> = {
      ArrowLeft: Math.max(0, at - 1),
      ArrowRight: Math.min(last, at + 1),
      Home: 0,
      End: last,
    };
    const tab = RECENT_TABS[step[e.key] ?? -1];
    if (!tab) return;
    e.preventDefault();
    choose(tab);
  });
}
