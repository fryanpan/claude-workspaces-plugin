/**
 * The Library tab: a board's recent meetings and recent files, each one tap
 * from the doc it names (approved mock, round 4).
 *
 * Three states, one at a time: the front page (five of each list, then "See
 * all"), one full list with a way back, and search results while the box
 * holds a term. A row is its title and how long ago — the page exists so that
 * finding a doc never needs a repo path, so no row carries one.
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
import {
  LIBRARY_RECENT,
  type LibraryHit,
  type LibraryList,
  type LibraryPayload,
  type LibraryRow,
  libraryWhenColumn,
  meetingSubtitle,
  searchLibrary,
} from './library-model.ts';

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
  history: Pick<BootHistory, 'pushState' | 'back' | 'state'>;
  /** The page's own address, for the history entry "See all" pushes. */
  here: () => string;
  now?: () => number;
}

export interface LibraryPage {
  /** Arrive at the Library: its front page, with the lists re-read. */
  open(): Promise<void>;
}

/**
 * The second column NAMES ITS CLOCK. "Modified" alone was read off two
 * different measurements — a bound doc's last activity and an unopened file's
 * mtime — and a reader comparing two rows of one list had no way to know.
 * One clock now, and the header says which one it is.
 */
const COLUMNS: Record<'meetings' | 'files', [string, string]> = {
  meetings: ['Title', 'Held'],
  files: ['Name', 'File modified'],
};
const HEADINGS: Record<'meetings' | 'files', { recent: string; all: string; more: string }> = {
  meetings: { recent: 'Recent meetings', all: 'All meetings', more: 'See all meetings' },
  files: { recent: 'Recent files', all: 'All files', more: 'See all files' },
};

export function createLibraryPage(deps: LibraryPageDeps): LibraryPage {
  const { root, workspaceId } = deps;
  const now = deps.now ?? Date.now;
  const base = `/workspaces/${encodeURIComponent(workspaceId)}/library`;
  let payload: LibraryPayload | null = null;
  let failed = false;
  let list: LibraryList = 'main';
  let term = '';
  let opening = false;

  root.innerHTML = `<div class="library-page">
    <header class="library-top">
      <div class="library-top-row">
        <h1 class="library-proj"></h1>
        <span class="library-repo"></span>
      </div>
      <input class="library-search" type="search" autocomplete="off" spellcheck="false">
    </header>
    <div class="library-body"></div>
  </div>`;
  const proj = root.querySelector('.library-proj') as HTMLElement;
  const repo = root.querySelector('.library-repo') as HTMLElement;
  const search = root.querySelector('.library-search') as HTMLInputElement;
  const body = root.querySelector('.library-body') as HTMLElement;

  /**
   * One row: its name, a secondary line where the name alone does not
   * identify it, and its one clock reading.
   *
   * `hit` is a search result's highlighted name and list. Both extras sit in
   * the same middle slot, so the row stays one grid line at every width.
   */
  function rowHtml(
    row: LibraryRow,
    opts: { sub?: string; hit?: { nameHtml: string; listHtml: string } } = {},
  ): string {
    const target = row.href
      ? `href="${escapeHtml(row.href)}"`
      : `href="#" data-open="${escapeHtml(row.open ?? '')}"`;
    const name = opts.hit?.nameHtml ?? escapeHtml(row.name);
    const sub = opts.sub ? `<span class="library-sub">${escapeHtml(opts.sub)}</span>` : '';
    const label = opts.hit ? `<span class="library-hitpath">${opts.hit.listHtml}</span>` : '';
    return `<a class="library-row" ${target} title="${escapeHtml(row.name)}"><span class="library-main"><span class="library-name">${name}</span>${sub}${label}</span><span class="library-when">${escapeHtml(libraryWhenColumn(row, now()))}</span></a>`;
  }

  /** A meeting's "Sep 11, 22:43 · 5 min"; a file's name is its own label. */
  function subFor(which: 'meetings' | 'files', row: LibraryRow): string | undefined {
    return which === 'meetings' ? meetingSubtitle(row) || undefined : undefined;
  }

  function tableHtml(which: 'meetings' | 'files', rows: LibraryRow[]): string {
    const [c1, c2] = COLUMNS[which];
    const inner = rows.length
      ? rows.map((r) => rowHtml(r, { sub: subFor(which, r) })).join('')
      : `<div class="library-empty">No ${which} yet.</div>`;
    return `<div class="library-tbl"><div class="library-cols" aria-hidden="true"><span>${c1}</span><span>${c2}</span></div><div class="library-list">${inner}</div></div>`;
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
          sub: subFor(from, row),
          hit: { nameHtml: markHtml(row.name, needle), listHtml: markHtml(from, needle) },
        }),
      )
      .join('')}</div>`;
  }

  function render(): void {
    const name = payload?.project?.name ?? deps.boardName();
    proj.textContent = name;
    repo.textContent = payload?.project?.path ?? '';
    repo.title = payload?.project?.path ?? '';
    search.placeholder = `Search ${name}`;
    if (!payload) {
      body.innerHTML = `<div class="library-empty">${failed ? 'The library could not load.' : 'Loading…'}</div>`;
      return;
    }
    if (term.trim()) {
      body.innerHTML = hitsHtml(searchLibrary(payload, term));
      return;
    }
    if (list !== 'main') {
      body.innerHTML = `<section class="library-all"><button type="button" class="library-back">← Library</button><h2>${HEADINGS[list].all}</h2>${tableHtml(list, payload[list])}</section>`;
      return;
    }
    body.innerHTML = (['meetings', 'files'] as const)
      .map((which) => {
        const rows = payload?.[which] ?? [];
        const more =
          rows.length > LIBRARY_RECENT
            ? `<button type="button" class="library-more" data-list="${which}">${HEADINGS[which].more}</button>`
            : '';
        return `<h2>${HEADINGS[which].recent}</h2>${tableHtml(which, rows.slice(0, LIBRARY_RECENT))}${more}`;
      })
      .join('');
  }

  function showList(next: LibraryList): void {
    list = next;
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

  root.addEventListener('click', (e) => {
    const target = e.target as Element;
    const more = target.closest<HTMLElement>('.library-more');
    if (more) {
      // A history entry of its own, on the same address: Back (or a phone's
      // back swipe) then lands on the Library front page, because arriving
      // at the Library always shows it.
      deps.history.pushState({ libraryList: more.dataset.list }, '', deps.here());
      showList(more.dataset.list === 'files' ? 'files' : 'meetings');
      return;
    }
    if (target.closest('.library-back')) {
      if ((deps.history.state as { libraryList?: string } | null)?.libraryList) deps.history.back();
      else showList('main');
      return;
    }
    const row = target.closest<HTMLAnchorElement>('.library-row[data-open]');
    if (row) {
      e.preventDefault();
      void openFile(row.dataset.open ?? '');
    }
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

  return {
    async open() {
      list = 'main';
      render();
      const next = await deps.fetchJson<LibraryPayload>(`${base}/items`);
      failed = next === null;
      // The last list is DROPPED on a failure rather than left up. Rows here
      // are an invitation to tap, and a list the server can no longer vouch
      // for offers meetings and files that may not be there any more; saying
      // so is the honest page.
      payload = next;
      render();
    },
  };
}
