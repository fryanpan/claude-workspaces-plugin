/**
 * The whiteboard REST family: create one on a board, read its scene, draw on
 * it.
 *
 *  - `POST /workspaces/<ws>/whiteboards {title}` mints a whiteboard and files
 *    it on the board. The server picks the id, so a caller cannot address a
 *    doc it did not create. Called from the board's "New whiteboard" button
 *    and from `create_whiteboard`; no host path is involved, so a page may
 *    call it as an agent may.
 *  - `GET  /workspaces/<ws>/docs/<id>/whiteboard` reads the scene in the
 *    agent's form (`get_whiteboard`).
 *  - `POST /workspaces/<ws>/docs/<id>/whiteboard {shapes, mode, point}` draws
 *    (`draw_on_whiteboard`).
 *
 * The two `docs/<id>/…` routes sit in the doc resource chain, so they inherit
 * its membership check, and a share visitor reaches neither: neither name is
 * in the share allowlist. People draw over the doc socket, not through here.
 */
import { newDocId } from '../doc-ids.ts';
import { restIs } from '../middleware/workspace-scope.ts';
import { parseShapes } from '../whiteboard/elements.ts';
import { drawShapes, readScene, setAgentPointer } from '../whiteboard/scene.ts';
import type {
  DocResourceRouteRequest,
  DocRouteRequest,
  DocRoutesContext,
} from './docs-routes-context.ts';

const MAX_TITLE = 200;

/** The page a whiteboard opens at. */
export const whiteboardHref = (workspaceId: string, docId: string): string =>
  `/workspaces/${encodeURIComponent(workspaceId)}/whiteboards/${encodeURIComponent(docId)}`;

/** `POST /workspaces/<ws>/whiteboards`. `undefined` when the path is not it. */
export async function handleWhiteboardCreateRoute(
  ctx: DocRoutesContext,
  rq: DocRouteRequest,
): Promise<Response | undefined> {
  const { scope, req } = rq;
  if (!restIs(scope, 'whiteboards') || req.method !== 'POST') return undefined;
  const { docStore, j, safeJson, withReviewUrl, fileUnderBoardWorkspace } = ctx;
  const body = await safeJson(req);
  const raw = body?.title;
  if (raw !== undefined && typeof raw !== 'string')
    return j(400, { error: 'title must be a string' });
  const title = (raw ?? '').trim().slice(0, MAX_TITLE) || 'Whiteboard';
  const docId = newDocId();
  const doc = docStore.getOrCreate(docId, { type: 'whiteboard', title, titleSource: 'given' });
  fileUnderBoardWorkspace(doc.docId, scope.workspaceId);
  return j(200, {
    docId: doc.docId,
    url: whiteboardHref(scope.workspaceId, doc.docId),
    meta: withReviewUrl(doc.meta, scope.workspaceId),
  });
}

/** `GET|POST /workspaces/<ws>/docs/<id>/whiteboard`. */
export async function handleWhiteboardRoutes(
  ctx: DocRoutesContext,
  rq: DocResourceRouteRequest,
): Promise<Response | undefined> {
  const { req, rest, doc, docId, authorFor } = rq;
  if (rest !== 'whiteboard') return undefined;
  const { j, safeJson } = ctx;
  if (doc.meta.type !== 'whiteboard') {
    return j(409, { error: 'not_a_whiteboard', hint: `${docId} is a ${doc.meta.type} doc.` });
  }
  if (req.method === 'GET') {
    return j(200, { docId, ...readScene(doc.ydoc) });
  }
  if (req.method !== 'POST') return undefined;
  const body = await safeJson(req);
  const parsed = parseShapes(body?.shapes ?? []);
  if (!parsed.ok) return j(400, { error: 'bad_shapes', hint: parsed.error });
  const mode = body?.mode ?? 'add';
  if (mode !== 'add' && mode !== 'replace') {
    return j(400, { error: 'bad_mode', hint: 'mode is "add" or "replace".' });
  }
  const point = body?.point;
  let pointer: { x: number; y: number } | null | undefined;
  if (point === null) pointer = null;
  else if (point !== undefined) {
    const p = point as { x?: unknown; y?: unknown };
    const ok = (v: unknown): v is number =>
      typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1_000_000;
    if (typeof point !== 'object' || !ok(p.x) || !ok(p.y)) {
      return j(400, { error: 'bad_point', hint: 'point is {x, y} in canvas units, or null.' });
    }
    pointer = { x: p.x, y: p.y };
  }
  const author = authorFor(body?.author);
  const actor = {
    id: author?.id ?? 'agent',
    name: author?.name ?? 'Agent',
    kind: 'agent' as const,
  };
  const written = drawShapes(doc.ydoc, parsed.shapes, mode, actor);
  if (pointer !== undefined) {
    setAgentPointer(doc.awareness, actor.id, pointer ? { ...pointer, label: actor.name } : null);
    // The same point, in the workspace's presence room, so a follower on
    // another page comes here. A drawing without `point` moves neither.
    ctx.agentSpots.point(
      docId,
      actor.id,
      pointer ? { surface: 'whiteboard', docId, ...pointer, name: actor.name } : null,
    );
  }
  const { count } = readScene(doc.ydoc);
  return j(200, { docId, written, count });
}
