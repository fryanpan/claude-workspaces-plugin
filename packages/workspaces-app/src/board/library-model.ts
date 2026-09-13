/**
 * The Library page's model: the shape `GET /workspaces/<id>/library/items`
 * answers, and the decisions the page makes over it — when a row happened,
 * which order the lists are in, which rows the front page shows, where each
 * kind of doc lives, and what a search finds.
 *
 * Pure, so the page's rules are testable without a DOM; `library-page.ts`
 * paints what this returns.
 */

/** One row, as the server sends it (`packages/server/src/library.ts`). */
export interface LibraryRow {
  name: string;
  /**
   * "Last Modified": a file's last change ON DISK, or a meeting's notes'.
   * Absent for a file this server could not stat — the column says so rather
   * than borrowing a different clock for that one row.
   */
  at?: number;
  /** "Created": a file's birth on disk, or when a meeting started. */
  created?: number;
  /** The key of the place this board doc lives in (`LibraryPayload.where`). */
  place?: string;
  /** Opens as a plain link. */
  href?: string;
  /** A project file with no doc yet — opened by `POST …/library/open`. */
  open?: string;
  /**
   * The folder a project file sits in, from the repo root: `''` at the root.
   * Absent for a meeting and for a file the listing does not name by its
   * path. Never painted on a row — it names a burst (`fileEntries`).
   */
  folder?: string;
}

export interface LibraryPayload {
  project: { name: string; path: string } | null;
  meetings: LibraryRow[];
  files: LibraryRow[];
  /** Where each kind really lives (`packages/server/src/library-location.ts`). */
  where?: LibraryWhere[];
}

/** The three kinds of thing a board files. */
export type LibraryKind = 'meetings' | 'documents' | 'mockups';

/** One location of one kind. Its label is never a host path. */
export interface LibraryPlace {
  key: string;
  /** A folder from the repo root, a project's name, or a fixed phrase. */
  label: string;
  /** The label is a folder path. */
  folder: boolean;
  note?: string;
  /** The note flags docs outside their kind's configured folders. */
  stray: boolean;
}

export interface LibraryWhere {
  kind: LibraryKind;
  places: LibraryPlace[];
  /** The project names no folder for this kind. */
  unset: boolean;
}

export const LIBRARY_KIND_NAMES: Record<LibraryKind, string> = {
  meetings: 'Meetings',
  documents: 'Documents',
  mockups: 'Mockups',
};

/** What a kind the project names no folder for says, rather than nothing. */
export const LIBRARY_NO_FOLDER = 'no folder named';

/** The board docs living in one place, from the list that kind is in. */
export function placeRows(payload: LibraryPayload, key: string): LibraryRow[] {
  const kind = payload.where?.find((w) => w.places.some((p) => p.key === key))?.kind;
  if (!kind) return [];
  return payload[kind === 'meetings' ? 'meetings' : 'files'].filter((r) => r.place === key);
}

/** Which clock a list is ordered and labelled by. */
export type LibrarySort = 'modified' | 'created';

/** The row's reading of the clock a list is sorted by. */
export const rowClock = (row: LibraryRow, sort: LibrarySort): number | undefined =>
  sort === 'created' ? row.created : row.at;

/**
 * A list in the order its sort names: newest first by that clock, a row with
 * no reading after every row that has one (unknown is not "oldest"), and ties
 * in the order the server sent them.
 */
export function sortRows(rows: readonly LibraryRow[], sort: LibrarySort): LibraryRow[] {
  return rows
    .map((row, i) => ({ row, i, t: rowClock(row, sort) }))
    .sort((a, b) => {
      if (a.t === undefined || b.t === undefined) {
        return a.t === b.t ? a.i - b.i : a.t === undefined ? 1 : -1;
      }
      return b.t - a.t || a.i - b.i;
    })
    .map((x) => x.row);
}

/** Which of the page's three states is showing. */
export type LibraryList = 'main' | 'meetings' | 'files';

/**
 * How many of each list the front page shows before "See all". Files show
 * ten (Bryan, 2026-09-12: "Increase recent files list default from 5 to 10
 * items"); meetings keep five, because the ask named files.
 */
export const LIBRARY_RECENT: Record<'meetings' | 'files', number> = { meetings: 5, files: 10 };

/** One line of the front page's Recent files: a file, or a burst of them. */
export type LibraryFileEntry =
  | { kind: 'file'; row: LibraryRow }
  | {
      kind: 'burst';
      /** Newest first, as the list has them. */
      rows: LibraryRow[];
      /** The last segment of the folder every member shares, or `''`. */
      folder: string;
    };

/**
 * How close together, in file-modified time, two neighbouring files must be
 * to belong to one burst. Measured on generator output: inside a run the
 * widest gap between consecutive files was 48s; the narrowest gap between a
 * run and the file before or after it was 112s (and a summary written 4m16s
 * after the seven files it summarised). A minute sits between the two.
 */
export const BURST_GAP_MS = 60_000;

/**
 * The fewest files that make a burst. Three, not seven: a rule tuned to one
 * digest's size misses the generator that writes three. Two stay apart —
 * collapsing a pair frees one line and hides two files a person may have
 * saved side by side.
 */
export const BURST_MIN = 3;

/**
 * The files list, as the front page shows it: a run of files each changed
 * within `BURST_GAP_MS` of the one before becomes ONE entry, so a generator
 * that writes seven files in half a minute takes one line of Recent files,
 * not seven, and everything a person touched before it stays in view.
 *
 * Grouped by time alone. Folder cannot decide it: one measured run wrote to
 * four sibling folders, and edits to one folder hours apart are not a burst.
 * A file with no clock reading is never in a burst — nothing measured puts it
 * beside anything.
 */
export function fileEntries(
  files: readonly LibraryRow[],
  sort: LibrarySort = 'modified',
): LibraryFileEntry[] {
  const out: LibraryFileEntry[] = [];
  let run: LibraryRow[] = [];
  const flush = (): void => {
    if (run.length >= BURST_MIN) out.push({ kind: 'burst', rows: run, folder: sharedFolder(run) });
    else for (const row of run) out.push({ kind: 'file', row });
    run = [];
  };
  for (const row of files) {
    const prev = run.at(-1);
    const t = rowClock(row, sort);
    if (t === undefined) {
      flush();
      out.push({ kind: 'file', row });
      continue;
    }
    const before = prev && rowClock(prev, sort);
    if (before !== undefined && before - t > BURST_GAP_MS) flush();
    run.push(row);
  }
  flush();
  return out;
}

/** The last segment of the deepest folder every row sits in, or `''` when
 *  they share none or any row does not say where it is. */
function sharedFolder(rows: readonly LibraryRow[]): string {
  let common: string[] | null = null;
  for (const row of rows) {
    if (row.folder === undefined) return '';
    const segs = row.folder.split('/').filter(Boolean);
    if (common === null) common = segs;
    else {
      let i = 0;
      while (i < common.length && common[i] === segs[i]) i += 1;
      common = common.slice(0, i);
    }
  }
  return common?.at(-1) ?? '';
}

/** "7 files in clippings", or "7 files" when they share no folder. */
export function burstLabel(entry: { rows: readonly LibraryRow[]; folder: string }): string {
  const n = `${entry.rows.length} files`;
  return entry.folder ? `${n} in ${entry.folder}` : n;
}

/**
 * When a row happened, as its time column reads (Bryan, mock v2): under a week
 * it is how long ago — "just now", "12m ago", "3h ago", "4d ago" — and from
 * seven days on it is the date, "Sep 4", with the year only when it is not
 * this one. Floors rather than rounds, so a file changed 6 days 23 hours ago
 * still reads "6d ago".
 */
export function libraryWhen(at: number, now: number, fmt: LibraryFormat = {}): string {
  const s = Math.max(0, Math.floor((now - at) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  const zone = fmt.timeZone === undefined ? {} : { timeZone: fmt.timeZone };
  const year = (t: number) =>
    new Intl.DateTimeFormat('en-US', { year: 'numeric', ...zone }).format(new Date(t));
  return new Intl.DateTimeFormat(fmt.locale, {
    month: 'short',
    day: 'numeric',
    ...(year(at) === year(now) ? {} : { year: 'numeric' }),
    ...zone,
  }).format(new Date(at));
}

/** How the reader's own locale writes a date. Overridable for tests. */
export interface LibraryFormat {
  locale?: string;
  timeZone?: string;
}

/**
 * What a row's time column reads when there is no reading of its clock.
 * An em dash, not a guess: the doc is still openable, and the one thing the
 * page must not do is print a clock it did not measure.
 */
export const LIBRARY_NO_TIME = '—';

/** The row's reading of the list's clock, or the em dash when there is none. */
export function libraryWhenColumn(
  row: LibraryRow,
  now: number,
  sort: LibrarySort = 'modified',
  fmt: LibraryFormat = {},
): string {
  const t = rowClock(row, sort);
  return t === undefined ? LIBRARY_NO_TIME : libraryWhen(t, now, fmt);
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
