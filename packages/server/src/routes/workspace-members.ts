/**
 * Who has access to this board, and at what level.
 *
 * THE POINT OF THE FAMILY. A share link used to be a grant of everything the
 * operator can do: whoever redeemed one was a member, and every member could
 * do everything any other member could. Bryan's 2026-09-11 ask names the
 * missing half — "someone who can read and comment but cannot act as him" —
 * so a board now has two roles, `owner` and `member` (shown as "Owner" and
 * "Regular User"), and these three routes are where the second one is read and
 * the first one is handed out.
 *
 * THREE ROUTES, one of them everybody's:
 *
 *   GET    /workspaces/<id>/members              the list, plus YOUR own role
 *   POST   /workspaces/<id>/members/<email>/role promote or demote  (owner)
 *   DELETE /workspaces/<id>/members/<email>      end their access    (owner)
 *
 * The READ is a member's, deliberately: everything in a workspace is available
 * to everyone in it (`.claude/rules/workspace-board.md`), and a Regular User
 * who cannot see who else is on the board cannot know who reads what they
 * write. It carries no link ids and no secrets — `/api/share` is where those
 * live, and that route refuses browsers outright.
 *
 * THE TWO WRITES ARE THE OWNER'S, and the check is `requireOwner` off the
 * admission gate rather than anything local: one reading of "is this the
 * owner" for every owner-only act on this server (see `boardRoleOf` in
 * `board-membership.ts`). The PATHS are admitted to members by
 * `MEMBER_ADMIN_ROUTES` in the host guard, which is what lets a PROMOTED owner
 * reaching the board through the share hostname manage it at all; the refusal
 * is the role check here, so a member's attempt is a server-side 403 and not a
 * control the page happened not to draw.
 *
 * WHOSE SEAT IS NOT HERE. The operator's. A board is created from the local
 * surface and its owner is whoever holds that machine — `boardRoleOf` answers
 * `owner` for a non-visitor and for an address in the operator's own
 * allowlist, with no record consulted. So this list is the people INVITED to
 * the board, demoting all of them still leaves the board an owner, and nothing
 * a promoted guest can do here locks the operator out of their own board.
 */
import { normalizeEmail } from '@claude-workspaces/core';
import { matchRest } from '../middleware/workspace-scope.ts';
import { normalizeBoardRole } from '../share/board-role.ts';
import { shareMemberKey } from '../share/share-links.ts';
import type { WorkspaceRouteRequest, WorkspaceRoutesContext } from './workspace-routes-context.ts';

/** Answers the routes below, or `undefined` when the path is none of them. */
export async function handleWorkspaceMembers(
  ctx: WorkspaceRoutesContext,
  rq: WorkspaceRouteRequest,
): Promise<Response | undefined> {
  const { shareLinks, docStore, sse, j, safeJson } = ctx;
  const { req, scope, accessEmail, roleFor, requireOwner } = rq;
  if (!scope) return undefined;
  const { workspaceId } = scope;

  // ── The list, and your own place in it ────────────────────────────────
  //
  // `you` rides along rather than being a second call: the panel has to know
  // whether to draw the controls, and a client that asked twice could paint a
  // list from one answer and an authority from the other. One request, one
  // consistent answer.
  //
  // `email: null` is the operator on their own machine — an owner with no
  // address, because no address was ever proven and none is needed. The panel
  // reads the role, never the address.
  if (scope.rest === 'members' && req.method === 'GET') {
    return j(200, {
      workspaceId,
      you: {
        email: accessEmail ? normalizeEmail(accessEmail) : null,
        role: roleFor(workspaceId),
      },
      members: shareLinks.membersOf(workspaceId).map((m) => ({
        email: m.email,
        // Spelled out on the wire even when the row omits it. The absent-means
        // -member rule is this server's; a client that had to know it would be
        // a second place the default is written down.
        role: m.role ?? 'member',
        addedAt: m.addedAt,
      })),
    });
  }

  // ── Promote or demote ─────────────────────────────────────────────────
  const roleMatch = matchRest(scope, /^members\/([^/]+)\/role$/);
  if (roleMatch && req.method === 'POST') {
    const denied = requireOwner(workspaceId);
    if (denied) return denied;
    const email = decodeURIComponent(roleMatch[1] ?? '');
    const body = await safeJson(req);
    // Undefined rather than a fallback: `normalizeBoardRole` refuses anything
    // that is not one of the two words, so a typo'd "Owner" is a 400 and never
    // a silent demotion.
    const role = normalizeBoardRole(body?.role);
    if (!role) return j(400, { error: "role must be 'owner' or 'member'" });
    if (!shareLinks.setMemberRole(workspaceId, email, role)) {
      return j(404, { error: 'not a member', workspaceId });
    }
    return j(200, { ok: true, workspaceId, email: normalizeEmail(email), role });
  }

  // ── End one person's access ───────────────────────────────────────────
  //
  // The same act as `POST /api/share/member/remove`, addressed under the board
  // it is about so that the board's own owner can perform it from the board's
  // own settings. Both hang up what the membership already has open, for the
  // reason that route records: a websocket and an SSE stream are authorized
  // once, at their upgrade, so a removed member with the board open would
  // otherwise keep reading AND writing until the connection happened to drop.
  const removeMatch = matchRest(scope, /^members\/([^/]+)$/);
  if (removeMatch && req.method === 'DELETE') {
    const denied = requireOwner(workspaceId);
    if (denied) return denied;
    const email = decodeURIComponent(removeMatch[1] ?? '');
    if (!shareLinks.removeMember(workspaceId, email)) {
      return j(404, { error: 'not a member', workspaceId });
    }
    // Exactly this membership: someone ejected from one board may still hold
    // another, and their connections to that one must survive.
    const key = shareMemberKey(workspaceId, email);
    const closedSockets = docStore.closeSocketsForShareMembers((k) => k === key);
    const closedStreams = sse.closeForShareMembers((k) => k === key);
    return j(200, {
      ok: true,
      workspaceId,
      email: normalizeEmail(email),
      closedSockets,
      closedStreams,
    });
  }

  return undefined;
}
