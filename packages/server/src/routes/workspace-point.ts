/**
 * `POST /workspaces/<ws>/point`: an agent points its followers at a place on
 * the board, and writes nothing (`point_at`, MCP).
 *
 * A comment already points (`agent-spots.ts`), but a comment is a write: the
 * owner gets a thread to read. This is the pointer alone. The place is one
 * of these:
 *
 *  - a page of the board, by `path` relative to it — `home`, `library`,
 *    `home?item=<key>`, `?task=<id>&tab=activity` — or the review queue or
 *    the workspaces list (`/review`, `/`);
 *  - a task or goal panel (`taskId` / `goalId`), at a thread on it
 *    (`threadId`);
 *  - a doc, mock, app, diff or folder file on the board (`docId`), at a
 *    thread, a block, a phrase (`quote`), a scroll fraction, or a
 *    whiteboard's `x`/`y`.
 *
 * `POST /workspaces/<ws>/person/watch` and `/person/show` are the same
 * family for the owner rather than for followers (`person-presence.ts`):
 * hear where the owner's attended tab lands, and send that one tab to a
 * place named exactly as `point` names one. Both hold to the agent token.
 *
 * Gated as the voice answer route is: the caller proves it speaks for
 * `agentId` (on this machine, with its token) and that agent is attached to
 * this board. Share visitors are refused. Every id is checked to be on this
 * board, and the path is checked by the same rule a page applies before it
 * opens one (`parseSpot`).
 */
import { type PresenceSpot, parseSpot } from '@claude-workspaces/core/workspace-presence';
import { isValidAgentId } from '../agent-watches.ts';
import type { WorkspaceRouteRequest, WorkspaceRoutesContext } from './workspace-routes-context.ts';

const ID = /^[A-Za-z0-9:_.~-]{1,200}$/;
/** Board-relative page names: a tab or a page under the board, with a query. */
const RELATIVE = /^(?:[A-Za-z0-9_.~:-]+(?:\/[A-Za-z0-9_.~:-]*)*)?(?:\?[A-Za-z0-9_.~:=&%+-]*)?$/;
const ABSOLUTE = /^\/(?:review(?:[/?].*)?)?$/;

type Built = { ok: true; spot: PresenceSpot } | { ok: false; status: number; error: string };

const bad = (error: string, status = 400): Built => ({ ok: false, status, error });
const optId = (v: unknown): string | null | undefined =>
  v === undefined ? undefined : typeof v === 'string' && ID.test(v) ? v : null;

/** The board-relative `path` as the page's own address, or null. */
function absolutePath(workspaceId: string, path: string): string | null {
  if (path.includes('..')) return null;
  // The workspaces list is the root; `/workspaces` itself answers JSON.
  if (path === '/workspaces') return '/';
  if (path.startsWith('/')) return ABSOLUTE.test(path) ? path : null;
  if (!RELATIVE.test(path)) return null;
  const board = `/workspaces/${encodeURIComponent(workspaceId)}`;
  const [page = '', query] = path.split(/\?(.*)/s);
  // `tasks` is the board itself, as the nav writes it.
  const head = page === '' || page === 'tasks' ? board : `${board}/${page}`;
  // Re-encoded, so the address is the one a page's own URL would carry.
  const q = query ? new URLSearchParams(query).toString() : '';
  return q ? `${head}?${q}` : head;
}

function buildSpot(
  ctx: WorkspaceRoutesContext,
  workspaceId: string,
  body: Record<string, unknown>,
): Built {
  const docId = optId(body.docId);
  const taskId = optId(body.taskId);
  const goalId = optId(body.goalId);
  const threadId = optId(body.threadId);
  const blockId = optId(body.blockId);
  if ([docId, taskId, goalId, threadId, blockId].includes(null)) return bad('bad id');
  const quote = body.quote;
  if (quote !== undefined && (typeof quote !== 'string' || !quote.trim() || quote.length > 500)) {
    return bad('quote is 1 to 500 characters');
  }
  const scroll = body.scroll;
  if (scroll !== undefined && (typeof scroll !== 'number' || !(scroll >= 0 && scroll <= 1))) {
    return bad('scroll is a number from 0 (top) to 1 (bottom)');
  }
  const xy = body.x !== undefined || body.y !== undefined;
  const near = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1e6;
  if (xy && !(near(body.x) && near(body.y))) return bad('x and y are canvas numbers');
  const rawPath = body.path;
  if (rawPath !== undefined && typeof rawPath !== 'string') return bad('path is a string');
  const where = [docId, taskId, goalId, rawPath].filter((v) => v !== undefined).length;
  if (where !== 1) return bad('name one place: path, docId, taskId or goalId');

  let raw: Record<string, unknown>;
  if (docId) {
    if (!ctx.boardsForDoc(docId).has(workspaceId)) return bad('doc not on this board', 404);
    const type = ctx.docStore.peekMeta(docId)?.type;
    const framed = type === 'mockup' || type === 'app';
    const surface = type === 'whiteboard' ? 'whiteboard' : framed ? 'mock' : 'doc';
    // An app opens at its door, not at a page of the doc.
    const door = `/workspaces/${encodeURIComponent(workspaceId)}/apps/${encodeURIComponent(docId)}/`;
    raw = {
      surface,
      docId,
      threadId,
      blockId,
      quote,
      x: body.x,
      y: body.y,
      scroll,
      ...(type === 'app' ? { path: door } : {}),
    };
  } else if (taskId || goalId) {
    if (blockId || quote !== undefined || xy) return bad('a panel takes threadId only');
    const found = taskId
      ? ctx.taskStore.listTasks(workspaceId).some((t) => t.id === taskId)
      : (ctx.taskStore.getWorkspace(workspaceId)?.goals ?? []).some((g) => g.id === goalId);
    if (!found) return bad(`${taskId ? 'task' : 'goal'} not on this board`, 404);
    const q = new URLSearchParams(taskId ? { task: taskId } : { goal: goalId ?? '' });
    if (threadId) q.set('thread', threadId);
    raw = { surface: 'board', path: `/workspaces/${encodeURIComponent(workspaceId)}?${q}` };
  } else {
    if (threadId || blockId || quote !== undefined || xy) {
      return bad('a page takes no thread or position; name a docId, taskId or goalId');
    }
    const path = absolutePath(workspaceId, rawPath as string);
    if (!path) return bad('path is a page of this board, /review or /');
    raw = { surface: 'board', path, scroll };
  }
  const spot = parseSpot(raw);
  // A path the route built and the page's own check refuses is refused here.
  if (!spot || (raw.path !== undefined && spot.path !== raw.path)) return bad('bad place');
  return { ok: true, spot };
}

export async function handleWorkspacePoint(
  ctx: WorkspaceRoutesContext,
  rq: WorkspaceRouteRequest,
): Promise<Response | undefined> {
  const { req, pathname, visitor } = rq;
  const m = /^\/workspaces\/([^/]+)\/(point|person\/watch|person\/show)$/.exec(pathname);
  if (!m || req.method !== 'POST') return undefined;
  const verb = m[2];
  if (visitor) return ctx.j(403, { error: 'not available to share visitors' });
  let workspaceId: string;
  try {
    workspaceId = decodeURIComponent(m[1] ?? '');
  } catch {
    return ctx.j(400, { error: 'bad board id' });
  }
  const body = (await ctx.safeJson(req)) ?? {};
  const agentId = typeof body.agentId === 'string' ? body.agentId : '';
  if (!isValidAgentId(agentId)) return ctx.j(400, { error: 'agentId required' });
  // Hearing where the owner is and moving the tab they are reading are new
  // routes no tokenless client ever called, so they hold to the token.
  const allowed = ctx.authorizeAgent(req, agentId, { requireToken: verb !== 'point' });
  if (!allowed.ok) return ctx.j(allowed.status, allowed.body);
  const attached = ctx.taskStore.listAttachments(workspaceId).find((a) => a.agentId === agentId);
  if (!attached) return ctx.j(403, { error: 'not attached to this board' });
  if (verb === 'person/watch') {
    if (body.on !== undefined && typeof body.on !== 'boolean') {
      return ctx.j(400, { error: 'on is true or false' });
    }
    const on = body.on !== false;
    const landing = ctx.personPresence.watch(workspaceId, agentId, on);
    return ctx.j(200, { ok: true, watching: on, landing });
  }
  const built = buildSpot(ctx, workspaceId, body);
  if (!built.ok) return ctx.j(built.status, { error: built.error });
  // The chip's label: the agent's own name for itself, as its comments carry.
  const named = typeof body.agentName === 'string' ? body.agentName.trim() : '';
  const name = (named || agentId).slice(0, 80);
  if (verb === 'person/show') {
    const shown = ctx.personPresence.show(workspaceId, { id: agentId, name }, built.spot);
    if (!shown.ok) {
      return ctx.j(409, {
        error: 'not-here',
        message: 'The owner has no tab in front of them on this board.',
      });
    }
    return ctx.j(200, { ok: true, spot: built.spot });
  }
  ctx.agentSpots.pointOn(workspaceId, agentId, { ...built.spot, name });
  return ctx.j(200, { ok: true, spot: built.spot });
}
