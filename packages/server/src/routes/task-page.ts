/**
 * ── The task address a person pastes, answered with the page that shows it ──
 *
 * `/workspaces/<ws>/tasks/<taskId>` is the API PREFIX: everything the server
 * answers there carries a verb after the id (`/detail`, `/notes`,
 * `/transition`, …), and the bare path is nobody's route. The page that shows
 * one task is `/workspaces/<ws>?task=<taskId>` — the board with that task
 * open.
 *
 * Agents write the path form, because a path is what a resource address looks
 * like everywhere else in this server, and a person then opens it in a
 * browser. Before this module that was a bare 404 with an
 * `application/octet-stream` body, which Chrome renders as
 * `ERR_INVALID_RESPONSE` — an address the product itself handed out, failing
 * in a way that reads as the server being down.
 *
 * So the bare path REDIRECTS to the page, and a query string rides along: a
 * link carrying `?from=…` keeps it, and `task` is set on top rather than
 * appended to whatever was there.
 *
 * ── Where it sits, and why that is safe ──
 *
 * The tail of the router, below `serveShellRoutes` and above the stale-client
 * and wrong-prefix answers. Nothing above it claims the bare path (no task
 * route matches a remainder with no verb), so it shadows nothing; and sitting
 * below the whole chain means an address that IS a route is still answered by
 * its route.
 *
 * It asks no access question and holds no store. Both halves were already
 * answered before it runs: `shareScopeAllows` refuses a share visitor the
 * bare path (`tasks/<id>` is deliberately not in its table), and
 * `middleware/workspace-scope.ts` has confirmed the board exists and that the
 * task is filed on it — see `isBoardPageRequest` in `workspace-path.ts`, which
 * is the one list that says this address is a browser's rather than an API's.
 * A task that is not on the board never reaches here; it is refused up there,
 * as a page, because that is what the caller was asking for.
 *
 * ── The unknown verb ──
 *
 * `/workspaces/<ws>/tasks/<taskId>/<something>` that no route claims lands
 * here too, and gets the same readable page rather than the bare 404.
 *
 * ── The JSON caller ──
 *
 * `?format=json` declines the whole module, the bare address included. It is
 * the server's one spelling for "data, not a page", and an API client that
 * followed the redirect would be handed the BOARD where it asked for a task —
 * a wrong answer carrying a 200, which is worse than the 404 it had.
 */
import { renderBoardMemberNotFound } from '../shells.ts';
import { safeDecodeSegment, wantsJson } from '../workspace-path.ts';

/** `/workspaces/<ws>/tasks/<taskId>`, with whatever follows the id. */
const TASK_ADDRESS = /^\/workspaces\/([^/]+)\/tasks\/([^/]+)(\/.*)?$/;

/** What this module needs of a request. */
export interface TaskPageRequest {
  method: string;
  pathname: string;
  url: URL;
}

/**
 * The board page for a bare task address, a readable page for an unknown verb
 * under one, or `undefined` when the path is not a task address at all.
 */
export function handleTaskPageRoutes(rq: TaskPageRequest): Response | undefined {
  if (rq.method !== 'GET') return undefined;
  const match = TASK_ADDRESS.exec(rq.pathname);
  if (!match) return undefined;
  const workspaceId = safeDecodeSegment(match[1] ?? '');
  const taskId = safeDecodeSegment(match[2] ?? '');
  if (workspaceId === '' || taskId === '') return undefined;
  const verb = match[3] ?? '';

  // `?format=json` is an API client, and this module answers a person. It
  // keeps the bare 404 it has always had, for the bare address as much as for
  // an unknown verb: a redirect it followed would hand it the whole BOARD
  // where it asked for one task, which is worse than the 404 — a wrong answer
  // with a 200 on it rather than a missing one.
  if (wantsJson(rq.url)) return undefined;

  if (verb === '') return redirectToBoard(workspaceId, taskId, rq.url);

  // An unknown verb, asked for by a browser: a page naming the board it can
  // go back to.
  return notFoundPage(workspaceId, `tasks/${taskId}${verb}`);
}

/**
 * The board with this task open.
 *
 * Built from the request's own URL so every other query parameter survives,
 * and answered as a path rather than an absolute URL: the host a caller
 * reached this server on is the host they should stay on, and spelling it
 * back at them is how a redirect starts leaking the box's own name.
 */
function redirectToBoard(workspaceId: string, taskId: string, url: URL): Response {
  const target = new URL(url);
  target.pathname = `/workspaces/${encodeURIComponent(workspaceId)}`;
  target.searchParams.set('task', taskId);
  return new Response(null, {
    status: 302,
    headers: { location: `${target.pathname}${target.search}` },
  });
}

/** The readable 404 — HTML, never the bare body a browser cannot render. */
function notFoundPage(workspaceId: string, rest: string): Response {
  return new Response(renderBoardMemberNotFound(workspaceId, rest), {
    status: 404,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}
