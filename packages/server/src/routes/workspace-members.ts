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
import { proposalReply, proposingAgent } from '../share/access-proposals.ts';
import { accessPeople } from '../share/access-view.ts';
import { normalizeBoardRole } from '../share/board-role.ts';
import { hasOwnerProof } from '../share/owner-proof.ts';
import { parseShareAudience } from '../share/share-audience.ts';
import { shareMemberKey } from '../share/share-links.ts';
import { safeDecodeSegment } from '../workspace-path.ts';
import type { WorkspaceRouteRequest, WorkspaceRoutesContext } from './workspace-routes-context.ts';

/** Answers the routes below, or `undefined` when the path is none of them. */
export async function handleWorkspaceMembers(
  ctx: WorkspaceRoutesContext,
  rq: WorkspaceRouteRequest,
): Promise<Response | undefined> {
  const { shareLinks, accessProposals, docStore, sse, j, safeJson } = ctx;
  const { req, scope, accessEmail, roleFor, requireOwner, visitor } = rq;
  if (!scope) return undefined;
  const { workspaceId } = scope;
  // Only the owner changes who is in (Bryan, 29 Oct). Their own browser
  // applies a change at once; an agent's call that lets somebody new in files
  // a proposal; one that narrows applies at once, because taking access away
  // never waits on a person. A share visitor changes nothing here — an
  // invited Owner is an ordinary member for this purpose.
  const proven = (): boolean => hasOwnerProof(req, rq.provenIdentityFor, rq.requestOriginFor);
  const refuseVisitor = (): Response | null =>
    visitor
      ? j(403, {
          error: 'owner-only',
          message: "Only the board's owner changes who is in this board.",
        })
      : requireOwner(workspaceId);
  /** Hang up what these members still have open on this board. */
  const hangUp = (emails: readonly string[]): { closedSockets: number; closedStreams: number } => {
    const keys = new Set(emails.map((e) => shareMemberKey(workspaceId, e)));
    return {
      closedSockets: docStore.closeSocketsForShareMembers((k) => keys.has(k)),
      closedStreams: sse.closeForShareMembers((k) => keys.has(k)),
    };
  };

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
      // Role spelled out on the wire even when the row omits it, and each
      // person filed under the entry that admits them (`share/access-view.ts`).
      members: accessPeople(shareLinks, workspaceId),
      // Who may sign in at all, and the changes waiting on the owner.
      audience: shareLinks.audienceOf(workspaceId)?.entries ?? [],
      openProposals: accessProposals.rows([workspaceId]).filter((r) => !r.answer).length,
    });
  }

  // ── Promote or demote ─────────────────────────────────────────────────
  const roleMatch = matchRest(scope, /^members\/([^/]+)\/role$/);
  if (roleMatch && req.method === 'POST') {
    const denied = refuseVisitor();
    if (denied) return denied;
    // `safeDecodeSegment`, not the bare decoder: one stray `%` in the segment
    // throws a `URIError`, and an address this server has never heard of would
    // come back as a 500 rather than as the 404 it is.
    const email = safeDecodeSegment(roleMatch[1] ?? '');
    const body = await safeJson(req);
    // Undefined rather than a fallback: `normalizeBoardRole` refuses anything
    // that is not one of the two words, so a typo'd "Owner" is a 400 and never
    // a silent demotion.
    const role = normalizeBoardRole(body?.role);
    if (!role) return j(400, { error: "role must be 'owner' or 'member'" });
    const before = shareLinks.roleOf(workspaceId, email);
    if (before === null) return j(404, { error: 'not a member', workspaceId });
    // A promotion by anything but the owner's own browser is a proposal.
    if (role === 'owner' && before !== 'owner' && !proven()) {
      const change = {
        op: 'set-role' as const,
        workspaceId,
        email: normalizeEmail(email),
        role,
        before,
      };
      const actor = rq.authorFor(body?.author) ?? proposingAgent(body?.createdBy);
      return proposalReply(
        j,
        accessProposals.propose({ change, taskId: body?.taskId, why: body?.why, actor }),
      );
    }
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
    const denied = refuseVisitor();
    if (denied) return denied;
    const email = safeDecodeSegment(removeMatch[1] ?? '');
    if (!shareLinks.removeMember(workspaceId, email)) {
      return j(404, { error: 'not a member', workspaceId });
    }
    // Exactly this membership: someone ejected from one board may still hold
    // another, and their connections to that one must survive.
    return j(200, { ok: true, workspaceId, email: normalizeEmail(email), ...hangUp([email]) });
  }

  // ── Who may sign in at all ────────────────────────────────────────────
  //
  // `POST /workspaces/<id>/audience` with `{ add?: [...], remove?: [...] }`,
  // addresses and `@domain`s. A removal applies at once and hangs up whoever
  // it ended; an add that names somebody new applies only from the owner's
  // own browser, and from anything else files a proposal (`taskId`, `why`).
  if (scope.rest === 'audience' && req.method === 'POST') {
    const denied = refuseVisitor();
    if (denied) return denied;
    const body = await safeJson(req);
    const parse = (raw: unknown): string[] | null => {
      if (raw === undefined) return [];
      const parsed = parseShareAudience(raw);
      return parsed.ok ? parsed.audience : null;
    };
    const add = parse(body?.add);
    const remove = parse(body?.remove);
    if (add === null || remove === null || add.length + remove.length === 0) {
      return j(400, {
        error: 'bad_audience',
        hint: 'add and remove are lists of addresses ("someone@partner.example") or domains ("@partner.example"); name at least one',
      });
    }
    // Their member rows stay — the record of how they got in — and simply
    // stop being admitted, so the next request refuses them.
    const lost = remove.flatMap((m) => shareLinks.removeFromAudience(workspaceId, m));
    const closed = hangUp(lost);
    const widening = accessProposals.widening(workspaceId, add);
    if (widening.length > 0 && !proven()) {
      const change = { op: 'add-audience' as const, workspaceId, entries: widening };
      const actor = rq.authorFor(body?.author) ?? proposingAgent(body?.createdBy);
      const res = accessProposals.propose({ change, taskId: body?.taskId, why: body?.why, actor });
      if (remove.length === 0) return proposalReply(j, res);
      // The removals above already landed; say so beside the proposal.
      const reply = await proposalReply(j, res).json();
      return j(res.ok ? 202 : res.status, { ...reply, removed: remove, ...closed });
    }
    if (widening.length > 0) {
      shareLinks.addToAudience(
        workspaceId,
        widening,
        rq.provenIdentityFor?.()?.displayName ?? 'owner',
      );
    }
    return j(200, {
      ok: true,
      workspaceId,
      added: widening,
      removed: remove,
      audience: shareLinks.audienceOf(workspaceId)?.entries ?? [],
      ...closed,
    });
  }

  return undefined;
}
