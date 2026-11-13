import { type RelocateError, relocateDocFile } from '../doc-file-relocate.ts';
import { browserCannotBindBody, isBrowserRequest } from '../middleware/write-gate.ts';
import type { DocResourceRouteRequest, DocRoutesContext } from './docs-routes-context.ts';

/**
 * Move a bound doc's file, or repoint the doc at a file git already moved:
 *
 *   POST /workspaces/<ws>/docs/<docId>/move-file — `{ path, mode }` → the doc
 *
 * Trusted-local, and not on `shareScopeAllows`: it renames a file on this
 * machine. It refuses a share visitor and a browser itself, as every binding
 * route does (`browserCannotBindBody`). A walled lead reaches it on its own
 * board (`middleware/lead-scope.ts`) and is held to the folders registered
 * for that board. Everything else it refuses is decided in
 * `doc-file-relocate.ts`, which this file only maps onto status codes.
 */

const STATUS: Record<RelocateError, number> = {
  'bad-mode': 400,
  'bad-path': 400,
  'not-found': 404,
  'not-markdown': 400,
  'set-member': 409,
  'home-pinned': 409,
  'not-bound': 409,
  'no-root': 409,
  'same-path': 409,
  'outside-root': 400,
  'out-of-lead-scope': 403,
  'contained-move': 409,
  'target-exists': 409,
  'target-missing': 409,
  'source-missing': 409,
  'path-held': 409,
  busy: 409,
  unreadable: 409,
  'move-failed': 500,
};

/** Answers the move, or `undefined` when the path is not `docs/<id>/move-file`. */
export async function handleDocFileMoveRoute(
  ctx: DocRoutesContext,
  rq: DocResourceRouteRequest,
): Promise<Response | undefined> {
  const { req, visitor, rest, docId } = rq;
  const { j } = ctx;
  if (rest !== 'move-file') return undefined;
  if (visitor) return j(403, { error: 'moving a doc file is not available to share visitors' });
  if (req.method !== 'POST') return j(405, { error: 'method not allowed' });
  if (isBrowserRequest(req.headers)) return j(403, browserCannotBindBody());
  const body = await ctx.safeJson(req);
  const lead = rq.leadBoard;
  const res = await relocateDocFile(
    { docStore: ctx.docStore },
    {
      docId,
      path: body?.path,
      mode: body?.mode,
      ...(lead ? { leadWritable: (path: string) => ctx.leadWritable(lead, path) } : {}),
    },
  );
  return res.ok ? j(200, res) : j(STATUS[res.error], res);
}
