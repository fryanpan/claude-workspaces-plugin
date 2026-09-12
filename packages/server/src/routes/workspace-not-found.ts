/**
 * The HTML answer for an address under a board that NOTHING serves.
 *
 * WHAT WAS WRONG. `/workspaces/<ws>/review/<id>` — the pre-cutover spelling
 * of a doc's page, which is still pasted into chats and still sits in old
 * comment threads — reached the tail of the router and got
 * `new Response('not found', { status: 404 })`. Nine bytes, no content type,
 * so Bun labelled them `application/octet-stream`. Chrome will not render a
 * 404 whose body it is told is a binary download: it paints
 * ERR_INVALID_RESPONSE, which is the same thing it paints when a server is
 * unreachable. So a link with a typo in it read as prod being down, and the
 * reader waited for a deploy instead of reporting the link. Same for any
 * other unknown remainder — `/workspaces/<ws>/whatever` did it too.
 *
 * WHAT THIS ANSWERS. One HTML page, the same one every other wrong address
 * under a board already got (`shells.ts`), which says the server is running,
 * says the link is wrong, and links back to the board the reader was already
 * on. Status stays 404; only the body and the content type change.
 *
 * WHERE IT SITS. The very tail of the router, below every real route and
 * below the stale-client 410 and the wrong-prefix hint, so it can shadow
 * nothing that exists and claims only paths every handler has already
 * declined. The share and sign-in gates in `request-admission.ts` ran long
 * before: a visitor who may not reach the board is refused there and never
 * reaches this page, so it widens no share scope.
 *
 * WHAT IT DELIBERATELY LEAVES ALONE. A request that is not a GET or a HEAD,
 * and one that asked for `?format=json`, keep the bare 404 — neither is a
 * browser navigating, and answering a tool with a page helps nobody. So does
 * every path outside `/workspaces/<id>/…`, `/api/…` included.
 *
 * AND THE BOARD IS KNOWN TO EXIST BY THE TIME IT RUNS, which is why this
 * module asks nothing about it. `middleware/workspace-scope.ts` resolves the
 * board far above here and refuses a path whose board is missing, rendering
 * the board's own not-found page for a browser; nothing with an unknown board
 * reaches the tail. A branch here for that case would be a second answer to a
 * question already settled, and one no request could reach.
 */
import { renderBoardMemberNotFound } from '../shells.ts';
import { matchWorkspaceRoute, wantsJson } from '../workspace-path.ts';

/** The tail not-found page for an address under a board, or `undefined` for
 *  every path this module does not claim. */
export function handleWorkspaceNotFound(rq: {
  pathname: string;
  method: string;
  url: URL;
}): Response | undefined {
  if (rq.method !== 'GET' && rq.method !== 'HEAD') return undefined;
  if (wantsJson(rq.url)) return undefined;
  const match = matchWorkspaceRoute(rq.pathname);
  if (!match) return undefined;
  return new Response(renderBoardMemberNotFound(match.workspaceId, match.rest), {
    status: 404,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}
