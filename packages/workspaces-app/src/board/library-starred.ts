/**
 * The reader's stars in the Library: which items and folders they starred,
 * the Star / Unstar item in each row's ⋯ menu, and the Starred list at the top of the
 * front page. One person's stars, kept by the server per person
 * (`packages/server/src/library-stars.ts`).
 *
 * The toggle is a fixed 44px square whose outline fills when pressed, so it
 * keeps its size and place as it flips. A reader with no name (anonymous)
 * cannot star, and their rows hold an empty square of the same size instead.
 */
import { escapeHtml } from '@claude-workspaces/core';
import type { LibraryPayload, LibraryRow } from './library-model.ts';

export type StarKind = 'doc' | 'folder';
export interface Star {
  kind: StarKind;
  id: string;
  at: number;
}
export interface StarViewer {
  id: string;
  name: string;
  kind: string;
}

export interface LibraryStarsDeps {
  workspaceId: string;
  send: (
    path: string,
    method: string,
    body: unknown,
  ) => Promise<{ ok: boolean; status: number; data: Record<string, unknown> | null }>;
  /** Who is starring; null for a reader who cannot (anonymous). */
  viewer: () => StarViewer | null;
  rerender: () => void;
  toast: (msg: string) => void;
  now: () => number;
}

export interface LibraryStars {
  /** Take the server's list from a fresh payload. */
  load(payload: LibraryPayload): void;
  has(kind: StarKind, id: string): boolean;
  /** The reader's stars, newest first. */
  list(): readonly Star[];
  /** The Star or Unstar item for one ⋯ menu, or nothing where none applies. */
  menuItemHtml(kind: StarKind, id: string | undefined): string;
  /** Flip one star: shown at once, then sent. */
  toggle(kind: StarKind, id: string): Promise<void>;
}

const STAR_PATH =
  '<path d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z"/>';
const STAR_SVG = `<svg viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true">${STAR_PATH}</svg>`;

export function createLibraryStars(deps: LibraryStarsDeps): LibraryStars {
  let stars: Star[] = [];
  const url = `/workspaces/${encodeURIComponent(deps.workspaceId)}/library/stars`;
  const same = (s: Star, kind: StarKind, id: string) => s.kind === kind && s.id === id;

  function has(kind: StarKind, id: string): boolean {
    return stars.some((s) => same(s, kind, id));
  }

  function set(kind: StarKind, id: string, on: boolean): void {
    stars = on
      ? [{ kind, id, at: deps.now() }, ...stars.filter((s) => !same(s, kind, id))]
      : stars.filter((s) => !same(s, kind, id));
  }

  return {
    load(payload) {
      stars = (payload.starred ?? []).map((s) => ({ ...s }));
    },
    has,
    list: () => stars,
    menuItemHtml(kind, id) {
      if (!id || !deps.viewer()) return '';
      const on = has(kind, id);
      return `<button type="button" class="lf-menu-item lf-star-item${on ? ' is-on' : ''}" data-lf-star="${kind}" data-lf-star-id="${escapeHtml(id)}" role="menuitem">${STAR_SVG}${on ? 'Unstar' : 'Star'}</button>`;
    },
    async toggle(kind, id) {
      const author = deps.viewer();
      if (!author) return;
      const on = !has(kind, id);
      set(kind, id, on);
      deps.rerender();
      const res = await deps.send(url, 'POST', { kind, id, starred: on, author });
      if (res.ok && res.data?.recorded !== false) return;
      set(kind, id, !on);
      deps.rerender();
      deps.toast(on ? 'Could not star that.' : 'Could not unstar that.');
    },
  };
}

const FOLDER_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2h8.5A1.5 1.5 0 0 1 21 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/></svg>';

/** A starred folder in the Starred list: tapping it opens the folder in the
 *  tree, and its ⋯ is the folder's own menu, where Unstar lives. */
export function folderLinkHtml(
  f: { id: string; name: string; path: string },
  count: number,
): string {
  return `<div class="library-row lf-row lf-folder lf-starred-folder"><button type="button" class="library-main" data-lf-reveal="${escapeHtml(f.id)}" title="${escapeHtml(f.path)}"><span class="lf-ico">${FOLDER_SVG}</span><span class="library-name">${escapeHtml(f.name)}</span><span class="lf-count">${count}</span></button><span class="library-when"></span><button type="button" class="lf-more" data-lf-foldermenu="${escapeHtml(f.id)}" aria-label="More for folder ${escapeHtml(f.name)}">⋯</button></div>`;
}

/**
 * The Starred list, newest star first: each starred item's own row and each
 * starred folder's link. Absent when the reader starred nothing, so it costs
 * no height until it holds something.
 */
export function starredSectionHtml(
  stars: readonly Star[],
  rows: readonly LibraryRow[],
  rowHtml: (row: LibraryRow, opts: { clock: 'modified'; showFolder: boolean }) => string,
  folderRow: (id: string) => string,
): string {
  const byDoc = new Map(rows.map((r) => [r.docId, r]));
  const docRow = (id: string) => {
    const row = byDoc.get(id);
    return row ? rowHtml(row, { clock: 'modified', showFolder: true }) : '';
  };
  const inner = stars.map((s) => (s.kind === 'doc' ? docRow(s.id) : folderRow(s.id))).join('');
  if (!inner) return '';
  return `<div class="lf-section-head lf-starred-head"><h2>Starred</h2></div><div class="library-tbl lf-tbl"><div class="library-list">${inner}</div></div>`;
}
