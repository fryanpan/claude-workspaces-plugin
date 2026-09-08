/**
 * The answer for an address that a PRE-CUTOVER client is still calling, so a
 * version skew stops reading as data loss.
 *
 * PR 723 moved every board resource out of `/api/…` and under the board that
 * owns it — `/api/workspaces/<id>/tasks` became `/workspaces/<id>/tasks`, and
 * `/api/goals/<id>` gained the board it never named. The previous addresses
 * were deleted outright; there is no compatibility shim, by decision. A
 * session whose plugin cache is a release or two behind therefore calls
 * addresses that no longer exist, and every one of its board tools fails with
 * the router tail's bare `not found`.
 *
 * That string is the bug. `404: not found` on `get_workspace` is exactly what
 * a DELETED board answers, so the reading an agent takes from it is "my
 * workspace is gone" — and the next step after that reading is a hunt for
 * lost data. It cost a peer several steps on 2026-09-06, on 0.1.168 against a
 * fleet on 0.1.169. Nothing about the request said "your client is behind",
 * because nothing in it could: the MCP client sends no version header on an
 * ordinary call, so the only evidence available is the SHAPE of the path.
 *
 * That evidence is enough, and it is exact. Each family named below was a
 * real address before the cutover and is not one now — verified by driving
 * the current server over all of them — so a request for one is a request
 * from something built against the old inventory. Nothing else emits these:
 * the board client, the skills, the scripts and the current MCP tools all
 * moved in the same commit.
 *
 * WHY 410 AND NOT 404. The whole failure is that one 404 cannot be told from
 * another. 410 Gone is the code for an address that existed and was
 * deliberately removed with no forwarding, which is precisely what happened,
 * and it separates the two cases before a body is even read: a genuinely
 * missing board on a CURRENT-shape route still answers 404, and only a dead
 * shape answers 410. 426 Upgrade Required was the other candidate and is
 * wrong — it is about switching protocol on the same address and wants an
 * `Upgrade` header naming what to switch to.
 *
 * WHERE IT SITS. The tail of the router, above `wrong-prefix.ts` and below
 * every real route, so it can shadow nothing that exists and answers only
 * paths every handler already declined. The share and sign-in gates in
 * `request-admission.ts` have run long before: a visitor who may not reach
 * the real address is refused there and never sees this body, exactly as they
 * are refused for the wrong-prefix hint. The verdict is derived from the
 * pathname and the server's own manifest, so it discloses nothing a caller
 * could not read from the plugin's own repository.
 *
 * THE ADDRESS IT NAMES. Only when it is mechanically derivable, which is
 * `wrongPrefixOf`'s existing job — it can name the families whose board
 * address is the old one with the board put back in front. The rest moved and
 * were also RENAMED (`/api/agent-notes` is now a route under the agent
 * roster, `/api/diffs` is an attach verb on docs), so no path is offered for
 * them rather than a confidently wrong one. The staleness verdict is the news
 * either way; the address is a bonus when it is certain.
 */

import { readReleasedPluginVersion } from '../plugin-release.ts';
import { wrongPrefixOf } from './wrong-prefix.ts';

/**
 * The `/api/<family>` words that were board addresses before the cutover and
 * are dead now.
 *
 * `workspaces` covers the bare collection AND everything under it — the old
 * client's whole board surface hung off `/api/workspaces/<id>/…`. The others
 * are top-level families the old client addressed by their own id, with the
 * board resolved behind the route.
 *
 * A word NOT in this set stays a bare 404, or the wrong-prefix hint where
 * that module can name an address: `/api/fortnightly` is a route that never
 * existed, and `/api/threads` never was one either — a thread has always been
 * addressed under its doc — so telling either caller their client is behind
 * would be a second wrong answer on top of the first. Live `/api/*` routes —
 * deploy, auth, share, agents, plugin — never reach this module at all,
 * because it runs only after they have had their turn.
 */
const PRE_CUTOVER_FAMILIES = new Set([
  'workspaces',
  'docs',
  'tasks',
  'goals',
  'refs',
  'reviews',
  'review-items',
  'dispatches',
  'diffs',
  'agent-notes',
  'chat-audit',
]);

/** What the server says about a request built against the old inventory. */
export interface StaleClientVerdict {
  /** The machine-readable discriminator. A caller branching on this never has
   *  to parse prose, and it is the one field that must not be reworded. */
  reason: 'stale-client';
  /** The current address, when it is the old one with the board put back in
   *  front. Absent for a family that was renamed as well as moved. */
  path?: string;
  /** The plugin version this server's deploy source would install, or absent
   *  when the manifest could not be read — `null` there means "we do not know
   *  what current is", and an unknown version must not be asserted. */
  serverVersion?: string;
  /** The whole news in one paragraph: what happened, that the board is not
   *  missing, and the two steps that fix it. Written to be readable verbatim
   *  in a tool error, because that is where it is read. */
  message: string;
}

/** The pre-cutover family a path names, or `undefined` for every other path. */
function preCutoverFamilyOf(pathname: string): string | undefined {
  const m = /^\/api\/([^/?]+)(?:[/?].*)?$/.exec(pathname);
  const family = m?.[1];
  if (!family || !PRE_CUTOVER_FAMILIES.has(family)) return undefined;
  return family;
}

/**
 * The verdict for a dead pre-cutover address, or `undefined` when the path is
 * not one.
 *
 * `serverVersion` is passed in rather than read here so the sentence a caller
 * reads can be asserted without a manifest on disk.
 */
export function staleClientOf(
  pathname: string,
  serverVersion: string | null,
): StaleClientVerdict | undefined {
  if (!preCutoverFamilyOf(pathname)) return undefined;
  const path = wrongPrefixOf(pathname)?.path;
  const message = [
    'this address was removed when every board resource moved under',
    '/workspaces/<workspaceId>/ — the client that sent it is running an older',
    'claude-workspaces bundle. The board is not missing.',
    'Update the plugin with `command claude plugin update',
    'claude-workspaces@claude-workspaces`, then restart the session; the order',
    'is update THEN restart.',
    ...(serverVersion ? [`This server ships plugin ${serverVersion}.`] : []),
    ...(path ? [`The current address is ${path}.`] : []),
  ].join(' ');
  return {
    reason: 'stale-client',
    ...(path ? { path } : {}),
    ...(serverVersion ? { serverVersion } : {}),
    message,
  };
}

/**
 * The tail 410 for a dead pre-cutover address, or `undefined` for every other
 * path.
 *
 * `readVersion` is injected for the test that proves the sentence survives an
 * unreadable manifest; production passes nothing.
 */
export function handleStaleClient(
  pathname: string,
  readVersion: () => string | null = readReleasedPluginVersion,
): Response | undefined {
  const verdict = staleClientOf(pathname, readVersion());
  if (!verdict) return undefined;
  return new Response(JSON.stringify({ error: 'gone', ...verdict }), {
    status: 410,
    headers: {
      'content-type': 'application/json',
      // A 410 is cacheable by default where a 404 is not, and this verdict is
      // about the CALLER's build rather than about the resource — it stops
      // being true the moment they update.
      'cache-control': 'no-store',
    },
  });
}
