/**
 * The Library page's model: the shape `GET /workspaces/<id>/library/items`
 * answers, and the three decisions the page makes over it — how long ago a
 * row happened, which rows the front page shows, and what a search finds.
 *
 * Pure, so the page's rules are testable without a DOM; `library-page.ts`
 * paints what this returns.
 */

/** One row, as the server sends it (`packages/server/src/library.ts`). */
export interface LibraryRow {
  name: string;
  /**
   * A meeting's start, or a file's last change ON DISK. Absent for a file
   * this server could not stat — the column says so rather than borrowing a
   * different clock for that one row.
   */
  at?: number;
  /** Opens as a plain link. */
  href?: string;
  /** A project file with no doc yet — opened by `POST …/library/open`. */
  open?: string;
}

export interface LibraryPayload {
  project: { name: string; path: string } | null;
  meetings: LibraryRow[];
  files: LibraryRow[];
}

/** Which of the page's three states is showing. */
export type LibraryList = 'main' | 'meetings' | 'files';

/** The front page shows this many of each list, then "See all". */
export const LIBRARY_RECENT = 5;

/**
 * "12m ago", "2h ago", "3d ago", "2w ago", "1mo ago", "2y ago" — the mock's
 * spelling, which runs past the board's `timeAgo` (days only) because a
 * library reaches back months. Floors rather than rounds, so a file changed
 * 13 days ago never reads "2w ago" before it is two weeks old.
 */
export function libraryAgo(at: number, now: number): string {
  const s = Math.max(0, Math.floor((now - at) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 14) return `${d}d ago`;
  if (d < 30) return `${Math.floor(d / 7)}w ago`;
  if (d < 365) return `${Math.floor(d / 30)}mo ago`;
  return `${Math.floor(d / 365)}y ago`;
}

/**
 * What a row's time column reads when the server could not stat its file.
 * An em dash, not a guess: the doc is still openable, and the one thing the
 * page must not do is print a clock it did not measure.
 */
export const LIBRARY_NO_TIME = '—';

/** The row's age, or the em dash when there is no clock reading for it. */
export function libraryWhenColumn(row: LibraryRow, now: number): string {
  return row.at === undefined ? LIBRARY_NO_TIME : libraryAgo(row.at, now);
}

/** One search hit, and which list it came from. */
export interface LibraryHit {
  row: LibraryRow;
  list: 'meetings' | 'files';
}

/** How many hits a search shows. A search is for finding one thing. */
export const LIBRARY_MAX_HITS = 40;

/**
 * Rows whose name — or list, so "meetings" finds every meeting — holds the
 * term, meetings first, each list newest first: the order both lists already
 * have. A blank term finds nothing: the page shows its front page instead.
 */
export function searchLibrary(payload: LibraryPayload, term: string): LibraryHit[] {
  const needle = term.trim().toLowerCase();
  if (!needle) return [];
  const hits: LibraryHit[] = [];
  for (const list of ['meetings', 'files'] as const) {
    for (const row of payload[list]) {
      if (`${row.name} ${list}`.toLowerCase().includes(needle)) hits.push({ row, list });
    }
  }
  return hits.slice(0, LIBRARY_MAX_HITS);
}
