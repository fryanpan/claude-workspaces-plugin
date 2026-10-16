/**
 * The home feed: the fixed schema one board server hands Bryan's Home on
 * another machine, and the check that Home runs on every row it receives.
 *
 * Bryan's Home on the Mac lists review items from boards held by project
 * servers in the cloud (`home-remotes.ts` pulls them). A project server is
 * the less trusted side of that pull: if one is compromised, what it answers
 * is the one way it can put anything in front of Bryan on the Mac's origin.
 * So the Mac reads its answer as data in this schema and nothing more:
 *
 *  - **Field by field.** Each row is rebuilt from the fields named here, each
 *    checked for type and length. A field not named here is dropped. A row
 *    missing or failing a required field is dropped whole and counted.
 *  - **Text only.** Nothing here is markup. The renderer
 *    (`landing-remote.ts`) escapes every field and never parses one as
 *    markdown or HTML.
 *  - **Links only to that server's boards.** A row's `href` survives only as
 *    a same-origin path under `/workspaces/<board>/`, for a board the routing
 *    table says that server holds. Any other link is dropped from the row and
 *    counted; the row stays, as text.
 *
 * The remote side builds the same shape from its own queue (`homeFeedOf`),
 * so both ends spell the schema from one file.
 */
import { pageThreadHref } from '@claude-workspaces/core/page-thread-link';
import { boardIdOfPath } from '../../../infra/board-router-worker/worker.js';
import type { CrossReviewItem } from './cross-review-queue.ts';
import { taskDeepLink } from './home-brief.ts';

export const HOME_FEED_VERSION = 1;

/** The most rows one board's feed may carry; the rest are dropped and counted. */
export const MAX_FEED_ROWS = 200;

const ROW_KINDS = ['task-review', 'task-thread', 'goal-thread', 'doc-thread'] as const;
export type HomeFeedRowKind = (typeof ROW_KINDS)[number];

/** One review item, as Home on another machine may show it. */
export interface HomeFeedRow {
  key: string;
  kind: HomeFeedRowKind;
  /** What the item is about: a task title or a doc's label. */
  title: string;
  /** The question itself, as the remote clipped it. */
  ask: string;
  askedBy: string;
  /** When the wait began, epoch ms. */
  since: number;
  /** Where the item opens on its own board, when the link passed the check. */
  href?: string;
}

export interface HomeFeed {
  v: typeof HOME_FEED_VERSION;
  boardId: string;
  boardName: string;
  rows: HomeFeedRow[];
}

/** The longest text each field keeps. Longer is refused, not clipped, so a
 *  row is never shown as something the remote did not send. */
const LIMITS = { key: 512, title: 500, ask: 4000, askedBy: 200, boardName: 200, href: 2048 };

/** C0 and C1 controls other than tab, newline and carriage return, and the
 *  bidi overrides that make text read differently from the characters it
 *  holds. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the class is the point
const UNSAFE_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f‪-‮⁦-⁩]/;

function text(value: unknown, max: number, minLength = 1): string | null {
  if (typeof value !== 'string' || value.length < minLength || value.length > max) return null;
  return UNSAFE_TEXT.test(value) ? null : value;
}

/** The remote clips to the same limits, so its own long rows still arrive. */
const clip = (value: string, max: number): string =>
  value.length > max ? `${value.slice(0, max - 1)}…` : value;

/** Any epoch-ms time from 2000 to 2100. */
function time(value: unknown): number | null {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 946_684_800_000 &&
    value < 4_102_444_800_000
    ? value
    : null;
}

const LINK_BASE = 'https://home-feed.invalid';

/**
 * The link, when it is a same-origin path to one of `boards` and nothing
 * else; undefined otherwise. The string must survive URL parsing unchanged,
 * so a backslash, a dot segment, a scheme, a host or an encoded trick that
 * the parser would rewrite is refused rather than normalized.
 */
export function boardHref(value: unknown, boards: ReadonlySet<string>): string | undefined {
  if (typeof value !== 'string' || value.length > LIMITS.href) return undefined;
  if (!value.startsWith('/workspaces/') || /[\s\\]/.test(value)) return undefined;
  let url: URL;
  try {
    url = new URL(value, LINK_BASE);
  } catch {
    return undefined;
  }
  if (url.origin !== LINK_BASE) return undefined;
  if (`${url.pathname}${url.search}${url.hash}` !== value) return undefined;
  const board = boardIdOfPath(url.pathname);
  return board !== null && boards.has(board) ? value : undefined;
}

export interface ReadFeed {
  boardName: string;
  rows: HomeFeedRow[];
  /** Rows refused whole: a required field missing or bad, or past the cap. */
  dropped: number;
  /** Rows kept with their link removed, because it pointed anywhere but
   *  this server's own boards. */
  linksRefused: number;
}

/**
 * Read one board's feed as the remote answered it. Null when the answer is
 * not a feed for `boardId` at all: not an object, another version, or
 * another board. `boards` is the set the routing table says this remote
 * holds, which is where a link may point.
 */
export function readHomeFeed(
  raw: unknown,
  boardId: string,
  boards: ReadonlySet<string>,
): ReadFeed | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const feed = raw as Record<string, unknown>;
  if (feed.v !== HOME_FEED_VERSION || feed.boardId !== boardId) return null;
  if (!Array.isArray(feed.rows)) return null;
  const boardName = text(feed.boardName, LIMITS.boardName) ?? boardId;
  const rows: HomeFeedRow[] = [];
  let dropped = 0;
  let linksRefused = 0;
  const seen = new Set<string>();
  for (const entry of feed.rows) {
    if (rows.length >= MAX_FEED_ROWS) {
      dropped += 1;
      continue;
    }
    const row = readRow(entry);
    if (!row || seen.has(row.key)) {
      dropped += 1;
      continue;
    }
    seen.add(row.key);
    const href = boardHref((entry as Record<string, unknown>).href, boards);
    if (href) row.href = href;
    else if ((entry as Record<string, unknown>).href !== undefined) linksRefused += 1;
    rows.push(row);
  }
  return { boardName, rows, dropped, linksRefused };
}

function readRow(entry: unknown): HomeFeedRow | null {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const r = entry as Record<string, unknown>;
  const key = text(r.key, LIMITS.key);
  const kind = ROW_KINDS.find((k) => k === r.kind);
  const title = text(r.title, LIMITS.title);
  const ask = text(r.ask, LIMITS.ask, 0);
  const askedBy = text(r.askedBy, LIMITS.askedBy, 0);
  const since = time(r.since);
  if (key === null || !kind || title === null || ask === null || askedBy === null) return null;
  if (since === null) return null;
  return { key, kind, title, ask, askedBy, since };
}

/** Where an item opens on its own board, as the board's own Home links it. */
export function itemHref(item: CrossReviewItem): string {
  const ws = item.workspaceId;
  if (item.kind === 'task-review' || item.kind === 'task-thread') {
    return taskDeepLink(ws, item.taskId ?? '');
  }
  const board = `/workspaces/${encodeURIComponent(ws)}`;
  if (item.kind === 'goal-thread') return `${board}?goal=${encodeURIComponent(item.taskId ?? '')}`;
  const doc = encodeURIComponent(item.docId);
  if (item.docType === 'app') return pageThreadHref(`${board}/apps/${doc}/`, item.threadId);
  const surface = item.docType === 'mockup' ? 'mockups' : 'docs';
  return pageThreadHref(`${board}/${surface}/${doc}`, item.threadId);
}

/** The remote side: one board's open items in the fixed schema, queue order. */
export function homeFeedOf(
  boardId: string,
  boardName: string,
  items: readonly CrossReviewItem[],
): HomeFeed {
  const rows: HomeFeedRow[] = [];
  for (const item of items) {
    if (item.workspaceId !== boardId) continue;
    if (rows.length >= MAX_FEED_ROWS) break;
    rows.push({
      key: item.key,
      kind: item.kind,
      title: clip(item.title || item.key, LIMITS.title),
      ask: clip(item.ask, LIMITS.ask),
      askedBy: clip(item.askedBy, LIMITS.askedBy),
      since: item.since,
      href: itemHref(item),
    });
  }
  return { v: HOME_FEED_VERSION, boardId, boardName: clip(boardName, LIMITS.boardName), rows };
}
