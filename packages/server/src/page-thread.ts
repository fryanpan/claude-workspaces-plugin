/**
 * An agent's thread on a page it cannot see: an attached app or a served
 * mock, anchored by the words the page shows.
 *
 * `create_thread`'s `find` searches a doc's own text, and these docs hold
 * none: the page lives in a dev server or an HTML file the widget runs on.
 * So the thread is anchored the way the widget anchors a person's comment,
 * an element anchor with the page as its context, except that its
 * fingerprint is the words alone (`createWordsAnchor`) and the page finds
 * the element that says them.
 *
 * The context is the address the widget INSIDE the frame reads, because
 * `contextMatches` compares it exactly: the app's prefix on the board, the
 * page's own query with the frame flag after it (`frameSrcFor`), then the
 * hash. A mock is one page, so its threads carry no context and show on it
 * whatever version is open.
 *
 * An agent's `path` is the page as the agent spelled it, so two things are
 * done to it first (`servedPath`). The board's own query (`cw-frame`,
 * `thread`) comes off, because an agent copies addresses from links that
 * carry it. And the dev server is asked for the page: a site that answers
 * `/bike` with a redirect to `/bike/` puts the frame, and every person's
 * thread on it, at `/bike/`.
 *
 * The link handed back (`pageThreadLink`) is the page a person opens, with
 * `?thread=` for the frame to open the thread by (`mock-bridge.ts`).
 */
import type { Anchor, DocType, ElementAnchor, PageSuggestion } from '@claude-workspaces/core';
import { createWordsAnchor } from '@claude-workspaces/core/anchor/element';
import { MAX_PAGE_FIND, readPageSuggestion } from '@claude-workspaces/core/page-edits';
import {
  MOCK_FRAME_PARAM,
  pageThreadHref,
  pageUrlOf,
  withoutBoardParams,
} from '@claude-workspaces/core/page-thread-link';
import { appPrefix, upstreamUrl } from './app-proxy.ts';
import { loopbackFetch } from './outbound-fetch.ts';

/** Redirects followed to find the page, and how long each answer may take. */
const MAX_HOPS = 5;
const PROBE_MS = 3000;

export type PageThreadPlan =
  | { ok: true; anchor: ElementAnchor; suggestion?: PageSuggestion }
  | { ok: false; error: string };

/** The doc kinds whose words are a page the widget runs on. */
export function isPageDoc(type: DocType): type is 'app' | 'mockup' {
  return type === 'app' || type === 'mockup';
}

export interface PageThreadArgs {
  type: 'app' | 'mockup';
  /** The board the app is served under; null when the doc is on none. */
  workspaceId: string | null;
  docId: string;
  find: string;
  path?: unknown;
  suggest?: unknown;
  /** Present when the caller sent any of the markdown-only narrowing fields. */
  narrowed: boolean;
}

/** The address the widget in the frame reads for the app page at `path`, or
 *  null when `path` does not name a page inside the app. */
export function appFrameUrl(workspaceId: string, docId: string, path: string): string | null {
  const prefix = appPrefix(workspaceId, docId);
  let u: URL;
  try {
    u = new URL(path.replace(/^\/+/, ''), `http://page${prefix}`);
  } catch {
    return null;
  }
  if (!u.pathname.startsWith(prefix)) return null;
  // `frameSrcFor`'s shape, with `thread` dropped as well as the frame flag.
  const rest = withoutBoardParams(u.search);
  return `${u.pathname}${rest ? `${rest}&` : '?'}${MOCK_FRAME_PARAM}=1${u.hash}`;
}

/**
 * The address inside the app that the dev server answers `path` at: the
 * board's query dropped, and redirects on the app's own origin followed.
 * `path` unchanged past the first step when the app is down or the path is
 * not one the proxy would fetch; `appFrameUrl` decides what to refuse.
 */
export async function servedPath(
  origin: string,
  prefix: string,
  path: string,
  get: typeof fetch = loopbackFetch('attached-app'),
): Promise<string> {
  const hashAt = path.indexOf('#');
  const hash = hashAt < 0 ? '' : path.slice(hashAt);
  const bare = hashAt < 0 ? path : path.slice(0, hashAt);
  const queryAt = bare.indexOf('?');
  const tail = queryAt < 0 ? bare : bare.slice(0, queryAt);
  const search = withoutBoardParams(queryAt < 0 ? '' : bare.slice(queryAt));
  let u = upstreamUrl(origin, tail, search);
  if (!u) return tail + search + hash;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    let res: Response;
    try {
      res = await get(u, { redirect: 'manual', signal: AbortSignal.timeout(PROBE_MS) });
    } catch {
      break;
    }
    void res.body?.cancel().catch(() => {});
    const to = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    let next: URL | null = null;
    try {
      next = to ? new URL(to, u) : null;
    } catch {}
    if (!next || next.origin !== u.origin) break;
    // A site built under the board's prefix redirects to it; the app's own
    // address is what follows the prefix.
    if (next.pathname.startsWith(prefix)) next.pathname = `/${next.pathname.slice(prefix.length)}`;
    u = next;
  }
  return u.pathname + withoutBoardParams(u.search) + hash;
}

/**
 * The link a person opens for a page thread: the page, with `thread` added
 * to its own query. `docUrl` is the doc's address on the board; the page is
 * the anchor's context, which a mock's thread has none of: a mock is one page.
 */
export function pageThreadLink(docUrl: string, thread: { id: string; anchor: Anchor }): string {
  return pageThreadHref(docUrl, thread.id, pageUrlOf(thread.anchor));
}

/** What to store for an agent's `find` on a page, or why it is refused. */
export function pageThreadPlan(a: PageThreadArgs): PageThreadPlan {
  if (a.find.trim() === '') return { ok: false, error: 'find must name words the page shows' };
  if (a.find.length > MAX_PAGE_FIND) {
    return { ok: false, error: `find is at most ${MAX_PAGE_FIND} characters on a page` };
  }
  if (a.narrowed) {
    return {
      ok: false,
      error:
        'on a page, find is the words alone: contextBefore, contextAfter and occurrence are for ' +
        'markdown. Pass more of the words to tell two places apart.',
    };
  }
  let suggestion: PageSuggestion | undefined;
  if (a.suggest !== undefined) {
    const replacement = (a.suggest as { replacement?: unknown } | null)?.replacement;
    suggestion = readPageSuggestion({ find: a.find, replacement });
    if (!suggestion) {
      return {
        ok: false,
        error: 'suggest is { replacement }: at most 4000 characters, different from find',
      };
    }
  }
  const extra = suggestion ? { suggestion } : {};
  if (a.type === 'mockup') {
    if (a.path !== undefined) return { ok: false, error: 'a mock is one page: omit path' };
    return { ok: true, anchor: createWordsAnchor(a.find), ...extra };
  }
  if (typeof a.path !== 'string' || !a.path.startsWith('/')) {
    return {
      ok: false,
      error:
        "an app has many pages: pass path, the page's address inside the app, e.g. /calendar " +
        'or /calendar?month=june',
    };
  }
  const url = a.workspaceId ? appFrameUrl(a.workspaceId, a.docId, a.path) : null;
  if (!url) return { ok: false, error: `path ${a.path} is not a page inside this app` };
  return { ok: true, anchor: createWordsAnchor(a.find, { url }), ...extra };
}

/** `pageThreadPlan`, after asking the dev server at `origin` which address
 *  an app's `path` is (`servedPath`). */
export async function planPageThread(
  a: PageThreadArgs & { origin?: string },
  get: typeof fetch = loopbackFetch('attached-app'),
): Promise<PageThreadPlan> {
  const { origin, ...args } = a;
  if (a.type !== 'app' || !origin || !a.workspaceId) return pageThreadPlan(args);
  if (typeof a.path !== 'string' || !a.path.startsWith('/')) return pageThreadPlan(args);
  const prefix = appPrefix(a.workspaceId, a.docId);
  return pageThreadPlan({ ...args, path: await servedPath(origin, prefix, a.path, get) });
}
