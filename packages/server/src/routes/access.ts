import { SHARING_OFF_PAGE_PATH } from '../sharing-off-door.ts';
import { type SharingOffView, renderSharingOffPage } from './sharing-off-page.ts';

/**
 * ── The access page: who can reach every board, and what is waiting ──
 *
 *   GET /access[/<section>]          the page (the settings shell)
 *   GET /api/access                  boards, entries, people, proposals
 *   GET /api/access/events:stream    `access.changed`, nameless (page-nudges.ts)
 *   GET /sharing-off                 the sharing notice, for the owner away from
 *                                    this machine while sharing is off
 *                                    (routes/sharing-off-page.ts)
 *
 * Top-level for the review queue's reason: it is about every board. It
 * writes nothing itself. Approve and Reject go to each card's own door
 * (`routes/task-access.ts`), and Add and Remove to each board's audience
 * route (`routes/workspace-members.ts`), so every write keeps the gate it
 * already has.
 *
 * The owner's alone, behind the coach's gate: a share or collab visitor is
 * refused, and the list and stream need a person proof naming the owner,
 * read from this server's own page. An agent reads the same facts through
 * `list_shares`; this page lists every board's addresses at once, which is
 * more than any one board's member may read.
 */

export interface AccessRoutesContext {
  view: () => unknown;
  renderPage: () => string;
  pageHeaders: Record<string, string>;
  stream: () => Response;
  /** The master switch and the notice's open card. */
  sharingOff: () => SharingOffView;
  j: (status: number, body: unknown) => Response;
}

export interface AccessRouteRequest {
  req: Request;
  pathname: string;
  /** Truthy for a share or collaboration visitor. */
  visitor: unknown;
  ownerProven: () => boolean;
  /** A person proof exists, whoever it names. */
  anyoneProven: () => boolean;
}

/** `/access`, `/access/waiting`, `/access/<boardId>`. */
const PAGE = /^\/access(?:\/[A-Za-z0-9_-]{1,64})?\/?$/;
const LIST = '/api/access';
const STREAM = '/api/access/events:stream';

/** Null when the caller is the owner, on this server's own page. */
export function refuseNonOwnerRead(
  ctx: Pick<AccessRoutesContext, 'j'>,
  rq: AccessRouteRequest,
): Response | null {
  if (rq.visitor) return ctx.j(403, { error: 'not available to share visitors' });
  if (!rq.ownerProven()) {
    return ctx.j(403, {
      error: 'owner-proof-required',
      message: 'Only the owner, signed in, can see who has access to every board.',
    });
  }
  if (rq.req.headers.get('sec-fetch-site') !== 'same-origin') {
    return ctx.j(403, { error: 'same-origin-only', message: 'Use this server’s own pages.' });
  }
  return null;
}

export function handleAccessRoutes(
  ctx: AccessRoutesContext,
  rq: AccessRouteRequest,
): Response | null {
  const { pathname } = rq;
  if (pathname === SHARING_OFF_PAGE_PATH) {
    if (rq.req.method !== 'GET') return ctx.j(405, { error: 'method not allowed' });
    if (rq.visitor) return ctx.j(403, { error: 'not available to share visitors' });
    if (rq.anyoneProven() && !rq.ownerProven()) {
      return ctx.j(403, { error: 'owner-only', message: 'Only the owner can see this page.' });
    }
    const page = renderSharingOffPage(ctx.sharingOff());
    return new Response(page.html, { headers: page.headers });
  }
  if (pathname !== LIST && pathname !== STREAM && !PAGE.test(pathname)) return null;
  if (rq.req.method !== 'GET') return ctx.j(405, { error: 'method not allowed' });
  if (pathname === STREAM) return refuseNonOwnerRead(ctx, rq) ?? ctx.stream();
  if (pathname === LIST) return refuseNonOwnerRead(ctx, rq) ?? ctx.j(200, ctx.view());
  // The shell is markup only. A browser that has not signed in yet gets it
  // and is told by the list's 403; a visitor and a proven non-owner do not.
  if (rq.visitor) return ctx.j(403, { error: 'not available to share visitors' });
  if (rq.anyoneProven() && !rq.ownerProven()) {
    return ctx.j(403, { error: 'owner-only', message: 'Only the owner can see this page.' });
  }
  return new Response(ctx.renderPage(), { headers: ctx.pageHeaders });
}
