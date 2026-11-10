/**
 * ── Board links in the wrong form, answered with the page they meant ──
 *
 * Three addresses a person is handed and nothing served, each now a redirect
 * to the page it names — or a not-found page that names the address:
 *
 *  - `/workspaces/<ws>/review/<id>` (and `reviews/<id>`): the old spelling of
 *    a doc's page, and the form an agent guesses for a review item. The id is
 *    tried as a review item, then a task, a doc and an attachment set ON THIS
 *    BOARD, in that order; the first that answers wins.
 *  - `/workspaces/<ws>/home%3Fitem%3D…`: a link whose `?` was escaped on the
 *    way, so the query became part of the path. Redirected to the same
 *    address with the escape undone.
 *  - `/workspaces/<ws>/open?path=<relative path>[&from=<docId>]`: where the
 *    comment renderer sends a relative link (`[note](../dir/plan.md)`). The
 *    doc on this board whose file the path names (`resolveRelativeLink`).
 *
 * ── Where it sits, and why that is safe ──
 *
 * The tail of the router, directly below `routes/task-page.ts` and for its
 * reasons: nothing above claims these paths, so it shadows nothing. Share
 * visitors never reach it — `shareScopeAllows` lists none of these paths,
 * and the rows in `route-table-rows.ts` say `trusted-local`, which
 * `route-table.test.ts` checks against the guard. The board is known to
 * exist: `middleware/workspace-scope.ts` refused an unknown one above.
 *
 * Every target is a path on this board, built here from ids the stores
 * answered for; nothing a caller sent is echoed into a `Location` except the
 * un-escaped remainder of its own board path, which still starts with
 * `/workspaces/<ws>/`, so no redirect can leave the board or the host. The
 * `open` path is compared with the paths of docs already on the board and
 * never touches the filesystem.
 *
 * `?format=json` and every method but GET decline, as `task-page.ts` does:
 * an API client that followed the redirect would get a page where it asked
 * for data.
 */
import {
  type LinkCandidate,
  RELATIVE_LINK_MAX,
  resolveRelativeLink,
  reviewItemPath,
  taskReviewItemKey,
  threadReviewItemKey,
} from '../board-links.ts';
import { LEGACY_REVIEW_ITEM_ID } from '../review-items/derive.ts';
import { askedAddress, renderBoardMemberNotFound } from '../shells.ts';
import { matchWorkspaceRoute, safeDecodeSegment, wantsJson } from '../workspace-path.ts';

export interface BoardLinkRoutesContext {
  /** Which boards hold this member, through this collection — the scope
   *  middleware's one lookup (`workspacesOfMember` in `server.ts`). */
  workspacesOfMember: (collection: string, memberId: string) => readonly string[];
  /** The ticket a minted review item is filed on. */
  findReviewItem: (reviewItemId: string) => { taskId: string; workspaceId: string } | undefined;
  /** A derived doc-thread item id, decoded — or undefined for any other id. */
  parseThreadReviewItemId: (
    reviewItemId: string,
  ) => { docId: string; threadId: string; commentId: string } | undefined;
  /** A doc's page under this board, as a path; undefined when it has none. */
  docPagePath: (docId: string, workspaceId: string) => string | undefined;
  /** Every doc on the board, with the paths its file is known by. */
  linkCandidates: (workspaceId: string) => LinkCandidate[];
}

export interface BoardLinkRequest {
  method: string;
  pathname: string;
  url: URL;
}

const LEGACY_REVIEW = /^reviews?\/([^/]+)$/;

export function handleBoardLinkRoutes(
  ctx: BoardLinkRoutesContext,
  rq: BoardLinkRequest,
): Response | undefined {
  if (rq.method !== 'GET' || wantsJson(rq.url)) return undefined;
  const match = matchWorkspaceRoute(rq.pathname);
  if (!match) return undefined;
  const { workspaceId, rest } = match;
  const board = `/workspaces/${encodeURIComponent(workspaceId)}`;

  if (/%3f/i.test(rest)) {
    const unescaped = safeDecodeSegment(rest);
    // A control character cannot go in a header, and is in no board address;
    // a `..` segment or a leading slash would step off this board.
    const path = unescaped.split('?', 1)[0] ?? '';
    const staysOnBoard = !path.startsWith('/') && !path.split('/').includes('..');
    if (unescaped.includes('?') && staysOnBoard && !hasControl(unescaped)) {
      return redirect(`${board}/${unescaped}${rq.url.search ? `&${rq.url.search.slice(1)}` : ''}`);
    }
    return undefined;
  }

  const legacy = LEGACY_REVIEW.exec(rest);
  if (legacy) {
    const id = safeDecodeSegment(legacy[1] ?? '');
    const target = legacyTarget(ctx, workspaceId, id);
    return target ? redirect(target) : notFound(workspaceId, rq.url);
  }

  if (rest === 'open') {
    const path = rq.url.searchParams.get('path') ?? '';
    if (path === '' || path.length > RELATIVE_LINK_MAX) return notFound(workspaceId, rq.url);
    const from = rq.url.searchParams.get('from');
    const candidates = ctx.linkCandidates(workspaceId);
    // `from` counts only when it is a doc on this board: its paths come off
    // the candidate list, never from the caller.
    const fromPaths = from ? (candidates.find((c) => c.docId === from)?.paths ?? []) : [];
    const found = resolveRelativeLink(path, candidates, fromPaths);
    if (found.kind === 'one') {
      const page = ctx.docPagePath(found.docId, workspaceId);
      if (page) return redirect(page);
    }
    return notFound(workspaceId, rq.url);
  }
  return undefined;
}

/** Where `review/<id>` should have gone, or undefined when nothing on this
 *  board answers to the id. */
function legacyTarget(
  ctx: BoardLinkRoutesContext,
  workspaceId: string,
  id: string,
): string | undefined {
  if (id === '') return undefined;
  // `r-legacy` is derived on every legacy-decision ticket at once, so alone
  // it names no item (`workspace-home.ts` refuses it the same way).
  if (
    id !== LEGACY_REVIEW_ITEM_ID &&
    ctx.workspacesOfMember('review-items', id).includes(workspaceId)
  ) {
    const thread = ctx.parseThreadReviewItemId(id);
    if (thread)
      return reviewItemPath(workspaceId, threadReviewItemKey(thread.docId, thread.threadId));
    const item = ctx.findReviewItem(id);
    if (item) return reviewItemPath(workspaceId, taskReviewItemKey(item.taskId, id));
  }
  if (ctx.workspacesOfMember('tasks', id).includes(workspaceId)) {
    return `/workspaces/${encodeURIComponent(workspaceId)}?task=${encodeURIComponent(id)}`;
  }
  if (ctx.workspacesOfMember('docs', id).includes(workspaceId)) {
    return ctx.docPagePath(id, workspaceId);
  }
  if (ctx.workspacesOfMember('attachments', id).includes(workspaceId)) {
    return `/workspaces/${encodeURIComponent(workspaceId)}/attachments/${encodeURIComponent(id)}`;
  }
  return undefined;
}

function hasControl(s: string): boolean {
  for (const ch of s) if (ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f) return true;
  return false;
}

/** A path on this host: the host a caller reached the server on is the one
 *  they should stay on (the reason `task-page.ts` gives). */
function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}

function notFound(workspaceId: string, url: URL): Response {
  return new Response(renderBoardMemberNotFound(workspaceId, askedAddress(url)), {
    status: 404,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}
