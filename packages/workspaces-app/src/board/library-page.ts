/**
 * The Library tab: a board's recent files — meetings among them — each one
 * tap from the doc it names, then the board's folder tree (layout A of the
 * folders mock, `library-tree.ts`), and — folded shut at the end — where each
 * kind of doc really lives (mock v2).
 *
 * Four states, one at a time: the front page (Starred, the Recently Viewed /
 * Recently Created tabs, the folders, then the fold), the full list with a way back, the docs in
 * one location with a way back, and search results while the box holds a
 * term. A row is its title and one time — the page exists so that finding a
 * doc never needs a repo path, so no row carries one.
 *
 * Opening reuses the review-doc page and builds nothing new there: a row the
 * board already holds is a plain link to it, and a project file nobody has
 * bound yet is bound by `POST …/library/open`, whose answer is that same page.
 *
 * Owns its own state and its own container. `bootBoard` shows it on the
 * Library nav and hides it on every other; nothing else on the board reads
 * what is in here.
 */
import { escapeHtml } from '@claude-workspaces/core';
import type { BootHistory } from '../boot-env.ts';
import { recentRows } from './library-folders-model.ts';
import {
  LIBRARY_KIND_NAMES,
  type LibraryFileEntry,
  type LibraryHit,
  type LibraryList,
  type LibraryPayload,
  type LibraryRow,
  type LibrarySort,
  burstLabel,
  libraryWhenColumn,
  placeRows,
  searchLibrary,
  sortRows,
} from './library-model.ts';
import {
  type RecentTab,
  type RecentTabStorage,
  readRecentTab,
  recentTabsHtml,
  wireRecentTabs,
  writeRecentTab,
} from './library-recent.ts';
import { type StarViewer, createLibraryStars, starredSectionHtml } from './library-starred.ts';
import { createLibraryTree } from './library-tree.ts';
import { whereHtml } from './library-where.ts';

export interface LibraryPageDeps {
  /** `#board-library`. */
  root: HTMLElement;
  workspaceId: string;
  /** The board's name, for the header when no project repo backs the board. */
  boardName: () => string;
  fetchJson: <T>(path: string) => Promise<T | null>;
  send: (
    path: string,
    method: string,
    body: unknown,
  ) => Promise<{ ok: boolean; status: number; data: Record<string, unknown> | null }>;
  /** Go to a page — `location.assign` in the browser. */
  navigate: (href: string) => void;
  history: Pick<BootHistory, 'pushState' | 'replaceState' | 'back' | 'state'>;
  /** The page's own address at an inner page: a full list, or one location. */
  here: (list: string | null, place: string | null) => string;
  /** The inner page the address names when the page arrives. */
  requestedPlace?: () => { list: string | null; place: string | null };
  /**
   * A file the address asks to open (`?open=<path>`, how a run-output item on
   * Home links a file), taken off the address so Back does not open it again.
   */
  takeRequestedOpen?: () => string | null;
  now?: () => number;
  /** Who is reading, so the server answers their own Recently Viewed and
   *  Starred, and who stars. A signed-in session outranks it. */
  viewer?: () => StarViewer | null;
  /** The board's one-line report, with an optional Undo (`showToast`). */
  toast?: (msg: string, action?: { label: string; run: () => void; ms?: number }) => void;
  /** This device's stored choices: which recent-files tab was last picked. */
  storage?: RecentTabStorage;
}

export interface LibraryPage {
  /** Arrive at the Library: its front page, with the lists re-read. */
  open(): Promise<void>;
  /** Re-read the lists where the reader is: same list, place and search. */
  refresh(): Promise<void>;
}

/** The first column's header; the second is the sort (`sortHeader`). */
const FIRST_COLUMN: Record<'meetings' | 'files', string> = { meetings: 'Title', files: 'Name' };

export function createLibraryPage(deps: LibraryPageDeps): LibraryPage {
  const { root, workspaceId } = deps;
  const now = deps.now ?? Date.now;
  const base = `/workspaces/${encodeURIComponent(workspaceId)}/library`;
  let payload: LibraryPayload | null = null;
  let failed = false;
  let list: LibraryList = 'main';
  let term = '';
  let opening = false;
  /** Each list's clock, chosen from its header. Survives a re-render. */
  const sort: Record<'meetings' | 'files', LibrarySort> = {
    meetings: 'modified',
    files: 'modified',
  };
  /** The location whose docs are showing, or null. */
  let place: string | null = null;
  /** Whether "Where files live" is open, carried across re-renders. */
  let whereOpen = false;
  /** The bursts a reader has opened, by `burstKey`. Survives a re-render. */
  const expanded = new Set<string>();
  /** Whether Recently Viewed is showing its longer list. */
  let viewedOpen = false;
  /** The recent-files tab showing, as this device last left it. */
  let tab: RecentTab = readRecentTab(deps.storage);

  root.innerHTML = `<div class="library-page">
    <header class="library-top">
      <div class="library-top-row">
        <h1 class="library-proj"></h1>
        <span class="library-repo"></span>
        <button type="button" class="library-new-whiteboard">New whiteboard</button>
      </div>
      <input class="library-search" type="search" autocomplete="off" spellcheck="false">
    </header>
    <div class="library-body"></div>
  </div>`;
  const proj = root.querySelector('.library-proj') as HTMLElement;
  const repo = root.querySelector('.library-repo') as HTMLElement;
  const search = root.querySelector('.library-search') as HTMLInputElement;
  const body = root.querySelector('.library-body') as HTMLElement;
  const stars = createLibraryStars({
    workspaceId,
    send: deps.send,
    viewer: () => deps.viewer?.() ?? null,
    rerender: () => render(),
    toast: deps.toast ?? (() => {}),
    now,
  });
  const tree = createLibraryTree({
    root,
    workspaceId,
    stars,
    send: deps.send,
    toast: deps.toast ?? (() => {}),
    refresh: () => refresh(),
    rerender: () => render(),
    now,
    bind: async (path) => {
      const res = await deps.send(`${base}/open`, 'POST', { path });
      const docId = res.data?.docId;
      return res.ok && typeof docId === 'string' ? docId : null;
    },
  });

  /**
   * One row: its name and its one clock reading, on the right (mock v2: no
   * second date, no duration).
   *
   * `hit` is a search result's highlighted name and list, which share the
   * middle slot, so the row stays one grid line at every width.
   */
  function rowHtml(
    row: LibraryRow,
    opts: { clock?: LibrarySort; hit?: { nameHtml: string; listHtml: string } } = {},
  ): string {
    const target = row.href
      ? `href="${escapeHtml(row.href)}"`
      : `href="#" data-open="${escapeHtml(row.open ?? '')}"`;
    const name = opts.hit?.nameHtml ?? escapeHtml(row.name);
    const label = opts.hit ? `<span class="library-hitpath">${opts.hit.listHtml}</span>` : '';
    const when = libraryWhenColumn(row, now(), opts.clock);
    return `<a class="library-row" ${target} title="${escapeHtml(row.name)}"><span class="library-main"><span class="library-name">${name}</span>${label}</span><span class="library-when">${escapeHtml(when)}</span></a>`;
  }

  /** A list, in its chosen order, one row each. */
  function tableHtml(which: 'meetings' | 'files', rows: readonly LibraryRow[]): string {
    const inner = sortRows(rows, sort[which])
      .map((r) => rowHtml(r, { clock: sort[which] }))
      .join('');
    return tableOf(which, inner);
  }

  /**
   * The time column's header IS its sort: "Last Modified", or "Created"
   * (Bryan, mock v2). A native select, so it is one tap and a keyboard stop
   * on every device, and it says which clock the column shows.
   */
  function sortHeader(which: 'meetings' | 'files'): string {
    const option = (value: LibrarySort, text: string) =>
      `<option value="${value}"${sort[which] === value ? ' selected' : ''}>${text}</option>`;
    return `<select class="library-sort" data-list="${which}" aria-label="Sort ${which} by">${option('modified', 'Last Modified')}${option('created', 'Created')}</select>`;
  }

  function tableOf(which: 'meetings' | 'files', inner: string): string {
    const list = inner || `<div class="library-empty">No ${which} yet.</div>`;
    return `<div class="library-tbl"><div class="library-cols"><span aria-hidden="true">${FIRST_COLUMN[which]}</span>${sortHeader(which)}</div><div class="library-list">${list}</div></div>`;
  }

  /** The docs living in one location, as a full list with a way back. */
  function placeListHtml(data: LibraryPayload, key: string): string {
    const where = data.where?.find((w) => w.places.some((p) => p.key === key));
    const at = where?.places.find((p) => p.key === key);
    if (!where || !at) return '<div class="library-empty">Nothing lives there now.</div>';
    const label = at.folder
      ? `<span class="library-path">${escapeHtml(at.label)}</span>`
      : escapeHtml(at.label);
    const which = where.kind === 'meetings' ? 'meetings' : 'files';
    return `<section class="library-all"><button type="button" class="library-back">← Library</button><h2>${LIBRARY_KIND_NAMES[where.kind]} · ${label}</h2>${tableHtml(which, placeRows(data, key))}</section>`;
  }

  /**
   * A burst is known by where its newest file opens — unique per row, where a
   * name is not — so a later load that adds files after it keeps it open.
   */
  const burstKey = (rows: readonly LibraryRow[]): string => rows[0]?.open ?? rows[0]?.href ?? '';

  /**
   * One line for a burst, which opens in place onto its files. The line reads
   * as the newest file's clock, because that is where the run sits in a list
   * ordered by it.
   */
  function entryHtml(entry: LibraryFileEntry, clock: LibrarySort = sort.files): string {
    if (entry.kind === 'file') return tree.rowHtml(entry.row, { clock, showFolder: true });
    const key = burstKey(entry.rows);
    const open = expanded.has(key);
    const newest = entry.rows[0] as LibraryRow;
    const members = open
      ? `<div class="library-burst-rows">${entry.rows.map((r) => tree.rowHtml(r, { clock, showFolder: true })).join('')}</div>`
      : '';
    return `<div class="library-burst"><button type="button" class="library-row library-burst-head" data-burst="${escapeHtml(key)}" aria-expanded="${open}"><span class="library-main"><span class="library-caret" aria-hidden="true"></span><span class="library-name">${escapeHtml(burstLabel(entry))}</span></span><span class="library-when">${escapeHtml(libraryWhenColumn(newest, now(), clock))}</span><span class="lf-more-gap" aria-hidden="true"></span></button>${members}</div>`;
  }

  function markHtml(name: string, needle: string): string {
    const i = name.toLowerCase().indexOf(needle);
    if (i < 0) return escapeHtml(name);
    return `${escapeHtml(name.slice(0, i))}<mark>${escapeHtml(name.slice(i, i + needle.length))}</mark>${escapeHtml(name.slice(i + needle.length))}`;
  }

  function hitsHtml(hits: LibraryHit[]): string {
    if (!hits.length) return '<div class="library-empty">No match in this project.</div>';
    const needle = term.trim().toLowerCase();
    return `<div class="library-results">${hits
      .map(({ row, list: from }) =>
        rowHtml(row, {
          hit: { nameHtml: markHtml(row.name, needle), listHtml: markHtml(from, needle) },
        }),
      )
      .join('')}</div>`;
  }

  function render(): void {
    const fold = body.querySelector<HTMLDetailsElement>('details.library-where-fold');
    if (fold) whereOpen = fold.open;
    const name = payload?.project?.name ?? deps.boardName();
    proj.textContent = name;
    repo.textContent = payload?.project?.path ?? '';
    repo.title = payload?.project?.path ?? '';
    search.placeholder = `Search ${name}`;
    if (!payload) {
      body.innerHTML = `<div class="library-empty">${failed ? 'The library could not load.' : 'Loading…'}</div>`;
      return;
    }
    tree.load(payload, sort.files);
    if (term.trim()) {
      body.innerHTML = hitsHtml(searchLibrary(payload, term));
      return;
    }
    if (place !== null) {
      body.innerHTML = placeListHtml(payload, place);
      return;
    }
    // Meetings are files here: they sit in both lists with everything else,
    // and in their own folder below (the separate list is gone).
    if (list !== 'main') {
      const all = recentRows(payload, sort.files).map((r) =>
        tree.rowHtml(r, { clock: sort.files, showFolder: true }),
      );
      body.innerHTML = `<section class="library-all"><button type="button" class="library-back">← Library</button><h2>All files</h2>${filesTable(all.join(''))}</section>`;
      tree.afterRender();
      return;
    }
    const recent = recentTabsHtml(tab, payload, {
      viewedOpen,
      rowHtml: tree.rowHtml,
      entryHtml: (e) => entryHtml(e, 'created'),
    });
    const rows = [...payload.meetings, ...payload.files];
    const starred = starredSectionHtml(stars.list(), rows, tree.rowHtml, tree.folderLinkHtml);
    // Starred first (it is short, and the reader chose it), then the recent
    // tabs; the tree below.
    body.innerHTML = `${starred}${recent}${tree.html()}${payload.where ? whereHtml(payload.where, whereOpen) : ''}`;
    tree.afterRender();
  }

  /** Recent or all files: rows with a ⋯ menu, so a third column for it. */
  function filesTable(inner: string): string {
    const list = inner || '<div class="library-empty">No files yet.</div>';
    return `<div class="library-tbl lf-tbl"><div class="library-cols"><span aria-hidden="true">${FIRST_COLUMN.files}</span>${sortHeader('files')}<span aria-hidden="true"></span></div><div class="library-list">${list}</div></div>`;
  }

  function showList(next: LibraryList, at: string | null = null): void {
    list = next;
    place = at;
    render();
    root.scrollTop = 0;
    root.closest('.board-col')?.scrollTo?.(0, 0);
  }

  async function openFile(path: string): Promise<void> {
    if (opening) return;
    opening = true;
    try {
      const res = await deps.send(`${base}/open`, 'POST', { path });
      const href = res.data?.href;
      if (res.ok && typeof href === 'string') deps.navigate(href);
      else
        body.insertAdjacentHTML(
          'afterbegin',
          '<div class="library-empty library-error">That file could not be opened.</div>',
        );
    } finally {
      opening = false;
    }
  }

  /** Make a whiteboard on this board and go to it. */
  async function newWhiteboard(): Promise<void> {
    if (opening) return;
    opening = true;
    try {
      const res = await deps.send(
        `/workspaces/${encodeURIComponent(workspaceId)}/whiteboards`,
        'POST',
        { title: 'Whiteboard' },
      );
      const url = res.data?.url;
      if (res.ok && typeof url === 'string') deps.navigate(url);
      else
        body.insertAdjacentHTML(
          'afterbegin',
          '<div class="library-empty library-error">The whiteboard could not be made.</div>',
        );
    } finally {
      opening = false;
    }
  }

  root.addEventListener('click', (e) => {
    const target = e.target as Element;
    if (target.closest('.library-new-whiteboard')) {
      void newWhiteboard();
      return;
    }
    if (target.closest('[data-lf-viewmore]')) {
      viewedOpen = !viewedOpen;
      render();
      root.querySelector<HTMLElement>('[data-lf-viewmore]')?.focus();
      return;
    }
    const burst = target.closest<HTMLElement>('.library-burst-head');
    if (burst) {
      const key = burst.dataset.burst ?? '';
      if (!expanded.delete(key)) expanded.add(key);
      render();
      // The render replaced the button; keep the reader's place on it.
      for (const head of root.querySelectorAll<HTMLElement>('.library-burst-head')) {
        if (head.dataset.burst === key) head.focus();
      }
      return;
    }
    const more = target.closest<HTMLElement>('.library-more');
    if (more) {
      // A history entry of its own: Back (or a phone's back swipe) lands on
      // the Library front page, and the address names the list, so a reload
      // or a shared link opens it.
      deps.history.pushState({ libraryList: 'files' }, '', deps.here('files', null));
      showList('files');
      return;
    }
    const at = target.closest<HTMLElement>('.library-place[data-place]');
    if (at) {
      const where = at.dataset.place ?? null;
      deps.history.pushState({ libraryPlace: where }, '', deps.here(null, where));
      showList('main', at.dataset.place ?? null);
      return;
    }
    if (target.closest('.library-back')) {
      const state = deps.history.state as { libraryList?: string; libraryPlace?: string } | null;
      if (state?.libraryList || state?.libraryPlace) {
        deps.history.back();
      } else {
        deps.history.replaceState(null, '', deps.here(null, null));
        showList('main');
      }
      return;
    }
    const row = target.closest<HTMLAnchorElement>('a[data-open]');
    if (row) {
      e.preventDefault();
      void openFile(row.dataset.open ?? '');
    }
  });
  wireRecentTabs(root, (next) => {
    tab = next;
    writeRecentTab(deps.storage, tab);
    render();
  });
  root.addEventListener('change', (e) => {
    const select = (e.target as Element).closest<HTMLSelectElement>('.library-sort');
    if (!select) return;
    const which = select.dataset.list === 'meetings' ? 'meetings' : 'files';
    sort[which] = select.value === 'created' ? 'created' : 'modified';
    render();
    // The render replaced the select; keep the reader's place on it.
    root.querySelector<HTMLElement>(`.library-sort[data-list=${which}]`)?.focus();
  });
  search.addEventListener('input', () => {
    term = search.value;
    render();
  });
  search.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    search.value = '';
    term = '';
    render();
  });

  /** The list, read as this reader, so it carries their own views. */
  function itemsUrl(): string {
    const viewer = deps.viewer?.()?.id ?? null;
    return viewer ? `${base}/items?viewer=${encodeURIComponent(viewer)}` : `${base}/items`;
  }

  async function refresh(): Promise<void> {
    const next = await deps.fetchJson<LibraryPayload>(itemsUrl());
    // A failed re-read keeps the list up: unlike an arrival, the reader is
    // looking at rows that were true a moment ago, and the next frame or
    // reconnect reads again.
    if (next === null) return;
    failed = false;
    payload = next;
    stars.load(next);
    render();
  }

  return {
    async open() {
      // Read before the first await: the board rewrites its address as it
      // boots, and the question would be gone by the time the list arrived.
      const wanted = deps.takeRequestedOpen?.() ?? null;
      // The inner page the address names, or the front page.
      const at = deps.requestedPlace?.() ?? { list: null, place: null };
      // An old "All meetings" address shows every file: meetings are files now.
      list = at.list === 'files' || at.list === 'meetings' ? 'files' : 'main';
      place = at.place;
      render();
      const next = await deps.fetchJson<LibraryPayload>(itemsUrl());
      failed = next === null;
      // The last list is DROPPED on a failure rather than left up. Rows here
      // are an invitation to tap, and a list the server can no longer vouch
      // for offers meetings and files that may not be there any more; saying
      // so is the honest page.
      payload = next;
      if (next) stars.load(next);
      render();
      // Opened after the list, so a refusal's message is not painted over.
      if (wanted) await openFile(wanted);
    },
    refresh,
  };
}
