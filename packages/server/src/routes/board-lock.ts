/**
 * `POST /api/share/lock`: lock one board never-shareable, or unlock it.
 *
 * Called from `routes/auth-share.ts` beside the sharing switch, below the
 * `/api/share*` browser refusal, so a page never reaches it. It is narrower
 * than the switch in one way that matters: the switch is `trusted-local`,
 * which admits the owner's own hostname through the tunnel, and this is
 * **loopback-only**. A lock is the owner saying a board's files must never
 * leave the machine, and a call that itself arrived from outside the machine
 * is the wrong place to take that back — so a `cf-ray` or a non-loopback peer
 * is refused before the body is read, in either direction.
 *
 * Locking also hangs up what is already connected, because a locked board is
 * closed to visitors and a socket is authorized once at open (the same sweep
 * `routes/share-switch.ts` runs when a board is closed).
 */
import { isOnBox } from '../attachment-privacy.ts';
import { boardLockLine, parseLockRequest } from '../share/board-lock.ts';
import { memberKeyOnBoard } from '../share/collab-member-key.ts';
import { flipActor } from '../share/sharing-flip.ts';
import {
  ENV_LOCKED_HINT,
  type ShareSwitchContext,
  type ShareSwitchRequest,
} from './share-switch.ts';

export const BOARD_LOCK_PATH = '/api/share/lock';

/** Answer `POST /api/share/lock`. The caller has already matched the path. */
export async function handleBoardLock(
  ctx: ShareSwitchContext,
  rq: ShareSwitchRequest,
): Promise<Response> {
  const { docStore, sse, taskStore, shares, sharingGate, j } = ctx;
  const peer = ctx.requestAddress(rq.req);
  if (!isOnBox(rq.req.headers, peer)) {
    // Two codes for the two ways off the box, so a log reader can tell the
    // owner's own tunnel from a network peer.
    return j(403, {
      error: rq.req.headers.has('cf-ray') ? 'lock_through_the_edge' : 'lock_from_the_box',
      hint: 'A board’s sharing lock is set and cleared only by a caller on the owner’s machine, never through the tunnel or the network.',
    });
  }
  const parsed = parseLockRequest(await ctx.safeJson(rq.req));
  if (!parsed.ok) return j(400, { error: parsed.error });
  const { workspaceId, locked, reason, actor } = parsed.value;
  // A board that does not exist locks nothing, and an `ok` over it would read
  // as a precaution taken.
  if (!taskStore.getWorkspace(workspaceId)) {
    return j(404, { error: 'unknown_workspace', workspaceId });
  }
  const res = sharingGate.setBoardLocked(workspaceId, locked);
  if (!res.ok) return j(409, { error: res.error, hint: ENV_LOCKED_HINT });
  console.error(
    boardLockLine({
      workspaceId,
      locked,
      actor: flipActor(actor, rq.provenIdentityFor()),
      peer: peer ?? 'unknown',
      reason: reason ?? null,
      at: (ctx.now ?? Date.now)(),
    }),
  );
  let closedSockets = 0;
  let closedStreams = 0;
  if (locked) {
    for (const share of shares?.list() ?? []) {
      if (share.workspaceId !== workspaceId) continue;
      closedSockets += docStore.closeSocketsForShare(share.shareId);
      closedStreams += sse.closeForShare(share.shareId);
    }
    const onBoard = memberKeyOnBoard(workspaceId);
    closedSockets += docStore.closeSocketsForShareMembers(onBoard);
    closedStreams += sse.closeForShareMembers(onBoard);
  }
  return j(200, {
    ok: true,
    workspaceId,
    board: { workspaceId, locked, open: sharingGate.isBoardOpen(workspaceId) },
    sharing: sharingGate.status(),
    ...(closedSockets ? { closedSockets } : {}),
    ...(closedStreams ? { closedStreams } : {}),
  });
}
