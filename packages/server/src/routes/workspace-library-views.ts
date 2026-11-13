import { liveFolders } from '../library-folders.ts';
import { isStarKind, starsFor } from '../library-stars.ts';
import { personKeyOf } from '../library-views.ts';
import { restIs } from '../middleware/workspace-scope.ts';
import { isBrowserRequest } from '../middleware/write-gate.ts';
import {
  type LibraryRouteRequest,
  type LibraryRoutesContext,
  viewerOf,
} from './workspace-library.ts';

/**
 * A person opened an item on this board — the record behind the Library's
 * Recently Viewed list.
 *
 *   POST /workspaces/<id>/library/views   { docId, author? }  → { recorded }
 *
 * The doc, mock, diff and whiteboard pages call it once each time a person
 * arrives on one. Two checks keep agents out, so an agent reading a doc never
 * lands on anybody's list:
 *  - the request must come from a browser (`isBrowserRequest`: `Origin` and
 *    the `Sec-Fetch-*` headers, which a browser sets itself and no MCP or
 *    REST client in this repo sends);
 *  - its author must read as a person (`personKeyOf`). A signed-in session
 *    outranks the author the page names, so nobody records a view as
 *    someone else.
 * A request failing either answers `{ recorded: false }` with a 200: the
 * page sends it in the background and has nothing to show for a refusal.
 *
 * Trusted-local like the folder verbs, and share visitors are refused: their
 * reading is not this board's to list.
 *
 * Stars ride the same two checks, for the same reason — a star is one
 * person's own choice:
 *
 *   GET  /workspaces/<id>/library/stars?viewer=<id>         → { starred }
 *   POST /workspaces/<id>/library/stars { kind, id, starred, author? } → { recorded }
 *
 * `kind` is `doc` (any board item: a doc, mock, whiteboard, meeting or diff review) or
 * `folder`; the id must name one still on the board.
 */
export async function handleLibraryViewRoutes(
  ctx: LibraryRoutesContext,
  rq: LibraryRouteRequest,
): Promise<Response | undefined> {
  const { scope, req, visitor } = rq;
  if (scope?.rest === 'library/stars') return handleStars(ctx, rq);
  if (!scope || !restIs(scope, 'library/views')) return undefined;
  const { j } = ctx;
  if (req.method !== 'POST') return j(405, { error: 'method not allowed' });
  if (visitor) return j(403, { error: 'views are not recorded for share visitors' });
  const body = await ctx.safeJson(req);
  const raw = typeof body?.docId === 'string' ? body.docId : '';
  if (raw === '' || raw.length > 200) return j(400, { error: 'docId is required' });
  const docId = ctx.docStore.resolveDocId(raw);
  if (!scope.board.docIds.includes(docId)) {
    return j(404, { error: 'not-found', message: 'That item is not on this board.' });
  }
  const person = isBrowserRequest(req.headers) ? personKeyOf(rq.authorFor?.(body?.author)) : null;
  if (!person) return j(200, { recorded: false });
  ctx.taskStore.recordLibraryView(scope.workspaceId, person, docId, Date.now());
  return j(200, { recorded: true });
}

async function handleStars(ctx: LibraryRoutesContext, rq: LibraryRouteRequest): Promise<Response> {
  const { scope, req, visitor } = rq;
  const { j } = ctx;
  if (!scope) return j(404, { error: 'not-found' });
  if (visitor) return j(403, { error: 'stars are not kept for share visitors' });
  const folders = new Set(liveFolders(scope.board).map((f) => f.id));
  const docs = new Set(scope.board.docIds);
  if (req.method === 'GET') {
    const starred = starsFor(scope.board, viewerOf(rq), (s) =>
      s.kind === 'doc' ? docs.has(s.id) : folders.has(s.id),
    );
    return j(200, { starred });
  }
  if (req.method !== 'POST') return j(405, { error: 'method not allowed' });
  const body = await ctx.safeJson(req);
  const kind = body?.kind;
  const raw = typeof body?.id === 'string' ? body.id : '';
  if (!isStarKind(kind) || raw === '' || raw.length > 200 || typeof body?.starred !== 'boolean') {
    return j(400, { error: 'kind (doc or folder), id and starred are required' });
  }
  const id = kind === 'doc' ? ctx.docStore.resolveDocId(raw) : raw;
  if (!(kind === 'doc' ? docs.has(id) : folders.has(id))) {
    return j(404, { error: 'not-found', message: 'That item is not on this board.' });
  }
  const person = isBrowserRequest(req.headers) ? personKeyOf(rq.authorFor?.(body?.author)) : null;
  if (!person) return j(200, { recorded: false });
  ctx.taskStore.setLibraryStar(scope.workspaceId, person, { kind, id }, body.starred, Date.now());
  return j(200, { recorded: true, starred: body.starred });
}
