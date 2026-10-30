import type { AnchorContext, Thread } from '@claude-workspaces/core/types';

/**
 * What the comment view shows, decided without a page: which page each thread
 * is on, which threads are new to this reader, and the order of the groups.
 *
 * The owner, reviewing a mock with several pages: comments on other pages
 * were hard to find, and the popover showed little of each thread. The view
 * (`widget-page-list.ts`) puts the new threads under one "New" heading at the
 * top, then one group per page in the page's own order, and a page keeps its
 * place whichever page the reader is on.
 *
 * A page is the address's path plus its fragment: a one-file mock moves
 * between its pages by `#book`, `#pay`, and an app by its path. The query is
 * the state a page keeps its controls in (`samePage` in core), so two threads
 * made with different controls set are on one page. A `view` the app
 * declared is part of the page too, since it is how an app says which screen
 * it shows.
 */

/** The page an address is on: its path and fragment, without the query. */
export function pageKey(ctx: AnchorContext | undefined | null): string {
  const url = ctx?.url ?? '';
  const [beforeHash = '', hash] = url.split(/#(.*)/s);
  const path = beforeHash.split('?')[0] ?? '';
  return `${path}${hash ? `#${hash}` : ''}${ctx?.view ? ` ${ctx.view}` : ''}`;
}

/** A page's name: what a link to it on this page says, else its fragment,
 *  else the last part of its path. */
export function pageName(key: string, linkText?: string): string {
  const said = linkText?.replace(/\s+/g, ' ').trim();
  if (said) return said.length > 28 ? `${said.slice(0, 27)}…` : said;
  const [addr = '', view] = key.split(/ (.*)/s);
  if (view) return view;
  const hash = addr.split('#')[1];
  if (hash) return hash.replace(/^[/!]+/, '').replace(/[-_]/g, ' ') || 'Top';
  const seg = addr.replace(/\/+$/, '').split('/').pop();
  return seg ? decodeURIComponent(seg).replace(/[-_]/g, ' ') : 'Home';
}

/** The context a thread was made in, an orphan's from its original anchor. */
export function contextOf(t: Thread): AnchorContext | undefined {
  const a = t.anchor;
  if (a.kind === 'orphan') return (a.original as { context?: AnchorContext }).context;
  return 'context' in a ? a.context : undefined;
}

/** The record of what this reader has seen: thread id → the latest
 *  comment's time when they last opened it. */
export type SeenMap = Record<string, number>;

/**
 * Is anything on this thread new to the reader? Someone else's comment later
 * than the last time they opened it. The reader's own replies never make a
 * thread new. On the first visit nothing already there counts, since a page
 * of marks on arrival says nothing the reader can act on; a comment that
 * arrives while they look still does.
 */
export function isNewTo(
  t: Pick<Thread, 'id' | 'comments'>,
  me: string | undefined,
  seen: SeenMap,
  visit: { first: boolean; since: number },
): boolean {
  let last = 0;
  for (const c of t.comments) if (c.author.id !== me && c.ts > last) last = c.ts;
  if (!last) return false;
  const at = seen[t.id];
  if (at !== undefined) return last > at;
  return !visit.first || last > visit.since;
}

/** One thread as the view sorts it. */
export interface ViewRow {
  id: string;
  status: 'open' | 'resolved' | 'orphan';
  /** `pageKey` of where it was made; the reader's page for a subject thread. */
  key: string;
  /** Newest comment time, for the order within a group. */
  last: number;
  isNew: boolean;
}

export interface ViewGroup {
  key: string;
  here: boolean;
  rows: ViewRow[];
  /** How many of this page's threads sit under New instead. */
  underNew: number;
}

export interface ViewModel {
  fresh: ViewRow[];
  pages: ViewGroup[];
  /** Threads made on this page whose element is gone. */
  nospot: ViewRow[];
  resolved: ViewRow[];
  /** Open threads, and how many pages they are on. */
  open: number;
  pageCount: number;
}

/**
 * The view's groups. `order` is the pages in the order the page links to
 * them; any other page with a thread follows, by its newest thread. The page
 * the reader is on is always a group, so "this page" has somewhere to say
 * there is nothing open. `kept` is the thread the reader opened from New: it
 * stays there until they open another, so the card they tapped does not jump
 * away under their finger. `justResolved` stays in its group, with Reopen,
 * until the reader moves on.
 */
export function buildView(
  rows: ViewRow[],
  o: { here: string; order: string[]; kept: string | null; justResolved: string | null },
): ViewModel {
  const byNewest = [...rows].sort((a, b) => b.last - a.last);
  const live = (r: ViewRow) => r.status !== 'resolved';
  const inNew = (r: ViewRow) => live(r) && (r.isNew || r.id === o.kept);
  const fresh = byNewest.filter(inNew);
  const nospot = byNewest.filter((r) => r.status === 'orphan' && r.key === o.here && !inNew(r));
  const keys = [...o.order];
  const add = (k: string) => {
    if (!keys.includes(k)) keys.push(k);
  };
  add(o.here);
  for (const r of byNewest) if (live(r)) add(r.key);
  const pages = keys
    .map((key) => ({
      key,
      here: key === o.here,
      rows: byNewest.filter(
        (r) =>
          r.key === key &&
          !inNew(r) &&
          !(r.status === 'orphan' && r.key === o.here) &&
          (live(r) || r.id === o.justResolved),
      ),
      underNew: fresh.filter((r) => r.key === key).length,
    }))
    // A page only the links name, with nothing on it, is not worth a heading.
    .filter((g) => g.here || g.rows.length || g.underNew);
  const openRows = rows.filter(live);
  return {
    fresh,
    pages,
    nospot,
    resolved: byNewest.filter((r) => r.status === 'resolved' && r.id !== o.justResolved),
    open: openRows.length,
    pageCount: new Set(openRows.map((r) => r.key)).size,
  };
}

/** Open threads per page, for the badges on links to other pages. */
export function openCounts(rows: ViewRow[]): Map<string, number> {
  const n = new Map<string, number>();
  for (const r of rows) if (r.status !== 'resolved') n.set(r.key, (n.get(r.key) ?? 0) + 1);
  return n;
}
