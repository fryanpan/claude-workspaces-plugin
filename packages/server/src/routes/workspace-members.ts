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
 *   POST   /workspaces/<id>/members/<email>/role owner, edit, comment or view (owner)
 *   DELETE /workspaces/<id>/members/<email>      end their access    (owner)
 *   POST   /workspaces/<id>/roles-mode           report-only or enforce (owner)
 *   POST   /workspaces/<id>/collab-core          the collab core on or off, for this
 *                                                board and server-wide (owner)
 *
 * A change that lets somebody do more needs the owner's own proof, because
 * `requireOwner` passes every agent on this machine: a promotion to Owner
 * files an access card, and view to comment, either to edit, enforce to report-only
 * and collab-core off to on are refused with `owner-proof-required`. A
 * narrowing applies at once.
 *
 * The READ is a member's, deliberately: everything in a workspace is available
 * to everyone in it (`.claude/rules/workspace-board.md`), and a Regular User
 * who cannot see who else is on the board cannot know who reads what they
 * write. It carries no link ids and no secrets — `/api/share` is where those
 * live, and that route refuses browsers outright.
 *
 * THE WRITES ARE THE OWNER'S ALONE (Bryan, 29 Oct: only he changes who is
 * in). Every share visitor is refused, an invited Owner included; the PATHS
 * are still admitted to members by `MEMBER_ADMIN_ROUTES` in the host guard,
 * so the refusal is a server-side 403 here rather than a control the page
 * happened not to draw. Off the share hostname the check is `requireOwner`,
 * and an add needs the owner's own proof besides (`share/owner-proof.ts`).
 *
 * WHOSE SEAT IS NOT HERE. The operator's. A board is created from the local
 * surface and its owner is whoever holds that machine — `boardRoleOf` answers
 * `owner` for a non-visitor and for an address in the operator's own
 * allowlist, with no record consulted. So this list is the people INVITED to
 * the board, demoting all of them still leaves the board an owner, and nothing
 * a promoted guest can do here locks the operator out of their own board.
 */
import { normalizeEmail } from '@claude-workspaces/core';
import { collabCoreView } from '../collab-core-switch.ts';
import { matchRest } from '../middleware/workspace-scope.ts';
import { proposalReply, proposingAgent } from '../share/access-proposals.ts';
import { accessPeople } from '../share/access-view.ts';
import {
  parseAccessRole,
  parseRolesMode,
  seatAndAccess,
  widensAccess,
} from '../share/board-access.ts';
import { hasOwnerProof } from '../share/owner-proof.ts';
import { parseShareAudience } from '../share/share-audience.ts';
import { shareMemberKey } from '../share/share-links.ts';
import { safeDecodeSegment } from '../workspace-path.ts';
import { sent } from './route-contract.ts';
import type { AudienceBody, MemberRoleBody } from './share-contract.ts';
import type { WorkspaceRouteRequest, WorkspaceRoutesContext } from './workspace-routes-context.ts';

/** Answers the routes below, or `undefined` when the path is none of them. */
export async function handleWorkspaceMembers(
  ctx: WorkspaceRoutesContext,
  rq: WorkspaceRouteRequest,
): Promise<Response | undefined> {
  const { shareLinks, accessProposals, docStore, sse, collabRooms, collabCoreSwitch, j, safeJson } =
    ctx;
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
  /**
   * A widening the owner did not make from the board's own page. Only the
   * Owner promotion files a card; these three are switches the owner flips
   * in Settings, so an agent's call is refused and changes nothing.
   */
  const refuseUnproven = (what: string): Response | null =>
    proven()
      ? null
      : j(403, {
          error: 'owner-proof-required',
          message: `Only the board's owner ${what}, from the board's own page.`,
        });
  /** Hang up what these members still have open on this board. */
  const hangUp = (emails: readonly string[]): { closedSockets: number; closedStreams: number } => {
    const keys = new Set(emails.map((e) => shareMemberKey(workspaceId, e)));
    // And the core's room hosts, whose connections carry no member key.
    collabRooms.recheck();
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
        // The four-word role (`share/board-access.ts`), read the way a
        // socket's is (`board-membership.ts` `boardAccessOf`).
        accessRole:
          roleFor(workspaceId) === 'owner'
            ? 'owner'
            : (shareLinks.accessRoleOf(workspaceId, accessEmail) ?? 'edit'),
      },
      // Whether comment and view are enforced on this board yet.
      rolesMode: shareLinks.rolesModeOf(workspaceId),
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
    const body = sent<MemberRoleBody>(await safeJson(req));
    // Undefined rather than a fallback: anything that is not one of the four
    // words (or `member`, the old spelling of edit) is a 400 and never a
    // silent demotion.
    const accessRole = parseAccessRole(body?.role);
    if (!accessRole) {
      return j(400, { error: "role must be 'owner', 'edit', 'comment' or 'view'" });
    }
    const { seat: role, access } = seatAndAccess(accessRole);
    const before = shareLinks.roleOf(workspaceId, email);
    const accessBefore = shareLinks.accessRoleOf(workspaceId, email);
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
      const actor = proposingAgent(body?.author ?? body?.createdBy);
      return proposalReply(
        j,
        accessProposals.propose({ change, taskId: body?.taskId, why: body?.why, actor }),
      );
    }
    // View to comment, or either to edit, lets them do more: the owner's own.
    if (accessBefore !== null && widensAccess(accessBefore, accessRole)) {
      const unproven = refuseUnproven('widens what a member may do');
      if (unproven) return unproven;
    }
    if (!shareLinks.setMemberRole(workspaceId, email, role, access)) {
      return j(404, { error: 'not a member', workspaceId });
    }
    // A socket's role is read once, at its upgrade, so a change hangs up what
    // they have open and they reconnect under the new one.
    const closed = accessBefore === accessRole ? {} : hangUp([email]);
    return j(200, {
      ok: true,
      workspaceId,
      email: normalizeEmail(email),
      role,
      accessRole,
      ...closed,
    });
  }

  // ── Turn comment and view enforcement on or off ───────────────────────
  //
  // Every board enforces: a comment or view socket's edit is dropped
  // (`socket-write-gate.ts`). `report-only`, an opt-out the owner sets per
  // board, applies it and logs it. The mode is read per frame, so open
  // sockets follow it without a reconnect.
  if (scope.rest === 'roles-mode' && req.method === 'POST') {
    const denied = refuseVisitor();
    if (denied) return denied;
    const body = await safeJson(req);
    const mode = parseRolesMode(body?.mode);
    if (!mode) return j(400, { error: "mode must be 'report-only' or 'enforce'" });
    // Back to report-only applies comment and view members' edits again.
    if (mode === 'report-only' && shareLinks.rolesModeOf(workspaceId) === 'enforce') {
      const unproven = refuseUnproven('stops enforcing comment and view');
      if (unproven) return unproven;
    }
    shareLinks.setRolesMode(workspaceId, mode);
    console.error(`[roles] board ${workspaceId} roles mode set to ${mode}`);
    return j(200, { ok: true, workspaceId, rolesMode: mode });
  }

  // ── Serve this board's sockets with the collab core, or not ───────────
  //
  // Two settings (`collab-core-switch.ts`): the board's own (`on`) and the
  // server-wide one (`serverWide`), and a board takes the core only while
  // both are on. Both start off. The board page's switch sends both in one
  // request, so moving a board is one tap. Read at connect, so a page takes
  // the new path at its next reconnect. A server-wide setting the
  // environment fixed (`CW_COLLAB_CORE`) is refused with 409.
  if (scope.rest === 'collab-core' && req.method === 'POST') {
    const denied = refuseVisitor();
    if (denied) return denied;
    const body = await safeJson(req);
    const on = typeof body?.on === 'boolean' ? body.on : undefined;
    const serverWide = typeof body?.serverWide === 'boolean' ? body.serverWide : undefined;
    const bad = (k: string) => body?.[k] !== undefined && typeof body[k] !== 'boolean';
    if ((on === undefined && serverWide === undefined) || bad('on') || bad('serverWide')) {
      return j(400, { error: 'on must be true or false' });
    }
    const fixed = collabCoreSwitch.fixed;
    if (serverWide !== undefined && fixed !== undefined && serverWide !== fixed) {
      return j(409, {
        error: 'fixed-by-environment',
        message: `CW_COLLAB_CORE fixes the collab core ${fixed ? 'on' : 'off'} on this server.`,
      });
    }
    // On hands writes to different code to judge: the owner's own call.
    const widens =
      (on === true && !collabCoreSwitch.boardOn(workspaceId)) ||
      (serverWide === true && !collabCoreSwitch.serverWide);
    if (widens) {
      const unproven = refuseUnproven('turns the collab core on');
      if (unproven) return unproven;
    }
    try {
      if (serverWide !== undefined) collabCoreSwitch.setServerWide(serverWide);
      if (on !== undefined) collabCoreSwitch.set(workspaceId, on);
    } catch (err) {
      console.error(`[collab-core] could not switch board ${workspaceId}:`, err);
      return j(500, { error: 'could not save the setting' });
    }
    const said = [
      on === undefined ? null : `board ${workspaceId} ${on ? 'on' : 'off'}`,
      serverWide === undefined ? null : `server-wide ${serverWide ? 'on' : 'off'}`,
    ].filter(Boolean);
    console.error(`[collab-core] switched ${said.join(', ')}`);
    // The switch tells the board's open pages itself (`server.ts`).
    return j(200, { ok: true, workspaceId, ...collabCoreView(collabCoreSwitch, workspaceId) });
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
    const body = sent<AudienceBody>(await safeJson(req));
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
      const actor = proposingAgent(body?.author ?? body?.createdBy);
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
