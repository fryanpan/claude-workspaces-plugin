/**
 * `POST /api/share/enabled`: the external-access master switch, and the
 * narrower switch for one board.
 *
 * Trusted-local like the rest of `/api/share*` (routes/route-table-rows.ts).
 * Called from `routes/auth-share.ts` at the position this block held there,
 * after the share list and before the retired per-doc share route.
 *
 * Two shapes, told apart by `workspaceId`:
 *
 *  - **No `workspaceId`: the master switch.** Off refuses every share,
 *    share-link, collab AND proxied-local request, the owner's own hostname
 *    among them. That breadth is the point of it, and it is why a caller who
 *    meant one board must never land here.
 *  - **With `workspaceId`: that board only.** Its share, share-link and
 *    collab visitors are refused and its link can admit nobody new; the
 *    master switch, the owner's hostname and every other board are untouched.
 *    The answer echoes the id back, so a caller can see which one it closed.
 *
 * Every flip of either kind writes one `[sharing]` line to the error log
 * (share/sharing-flip.ts), and a master switch turned OFF is also handed to
 * `onSharingFlip`, which tells the owner on their board.
 *
 * Turning either OFF also hangs up what is already connected: a websocket and
 * an SSE stream are authorized ONCE at open, so a visitor mid-review would
 * otherwise keep syncing and keep receiving comments on a doc that is no
 * longer reachable. Same lesson as share revocation.
 */
import type { DocStore } from '../doc-store.ts';
import type { IdentityRecord } from '../identities.ts';
import { memberKeyOnBoard } from '../share/collab-member-key.ts';
import type { Shares } from '../share/shares.ts';
import {
  type SharingFlip,
  flipActor,
  parseFlipRequest,
  sharingFlipLine,
} from '../share/sharing-flip.ts';
import type { SharingGate } from '../share/sharing-gate.ts';
import type { SseBus } from '../sse.ts';
import type { TaskStore } from '../tasks.ts';

export interface ShareSwitchContext {
  docStore: DocStore;
  sse: SseBus;
  taskStore: TaskStore;
  shares: Shares | null;
  sharingGate: SharingGate;
  j: (status: number, body: unknown) => Response;
  safeJson: (req: Request) => Promise<Record<string, unknown> | null>;
  /** The socket's peer address, as `Bun.serve` reports it. */
  requestAddress: (req: Request) => string | undefined;
  /** Told of every flip after it is written. The server uses it to tell the
   *  owner when the master switch goes off. */
  onSharingFlip: (flip: SharingFlip) => void;
  /** The clock, for the log line. */
  now?: () => number;
}

export interface ShareSwitchRequest {
  req: Request;
  /** The identity this request proved, or null. */
  provenIdentityFor: () => IdentityRecord | null;
}

/** Answer `POST /api/share/enabled`. The caller has already matched the path. */
export async function handleShareSwitch(
  ctx: ShareSwitchContext,
  rq: ShareSwitchRequest,
): Promise<Response> {
  const { docStore, sse, taskStore, shares, sharingGate, j } = ctx;
  const parsed = parseFlipRequest(await ctx.safeJson(rq.req));
  if (!parsed.ok) return j(400, { error: parsed.error });
  const { enabled, workspaceId, reason, actor } = parsed.value;

  const flip: SharingFlip = {
    ...(workspaceId ? { workspaceId } : {}),
    enabled,
    actor: flipActor(actor, rq.provenIdentityFor()),
    peer: ctx.requestAddress(rq.req) ?? 'unknown',
    reason: reason ?? null,
    at: (ctx.now ?? Date.now)(),
  };

  let closedSockets = 0;
  let closedStreams = 0;

  if (workspaceId) {
    // A board that does not exist closes nothing, and an `ok` over it would
    // read as a precaution taken.
    if (!taskStore.getWorkspace(workspaceId)) {
      return j(404, { error: 'unknown_workspace', workspaceId });
    }
    const res = sharingGate.setBoardEnabled(workspaceId, enabled);
    if (!res.ok) return j(409, { error: res.error, hint: ENV_LOCKED_HINT });
    console.error(sharingFlipLine(flip));
    if (!enabled) {
      for (const share of shares?.list() ?? []) {
        if (share.workspaceId !== workspaceId) continue;
        closedSockets += docStore.closeSocketsForShare(share.shareId);
        closedStreams += sse.closeForShare(share.shareId);
      }
      const onBoard = memberKeyOnBoard(workspaceId);
      closedSockets += docStore.closeSocketsForShareMembers(onBoard);
      closedStreams += sse.closeForShareMembers(onBoard);
    }
    ctx.onSharingFlip(flip);
    return j(200, {
      ok: true,
      workspaceId,
      board: { workspaceId, enabled },
      sharing: sharingGate.status(),
      ...(closedSockets ? { closedSockets } : {}),
      ...(closedStreams ? { closedStreams } : {}),
    });
  }

  const applied = applyMasterFlip(ctx, flip);
  if (!applied.ok) return j(409, { error: applied.error, hint: ENV_LOCKED_HINT });
  return j(200, {
    ok: true,
    sharing: sharingGate.status(),
    ...(applied.closedSockets ? { closedSockets: applied.closedSockets } : {}),
    ...(applied.closedStreams ? { closedStreams: applied.closedStreams } : {}),
  });
}

/**
 * Flip the master switch and do everything a flip does: the log line, the
 * hang-ups on off, and the `onSharingFlip` hand-off. The route calls it, and
 * so does the owner's "Turn back on" answer, so the two cannot drift.
 */
export function applyMasterFlip(
  ctx: Pick<ShareSwitchContext, 'docStore' | 'sse' | 'shares' | 'sharingGate' | 'onSharingFlip'>,
  flip: SharingFlip,
): { ok: true; closedSockets: number; closedStreams: number } | { ok: false; error: string } {
  const { docStore, sse, shares, sharingGate } = ctx;
  const res = sharingGate.setEnabled(flip.enabled);
  if (!res.ok) return { ok: false, error: res.error };
  console.error(sharingFlipLine(flip));
  let closedSockets = 0;
  let closedStreams = 0;
  if (!flip.enabled) {
    for (const share of shares?.list() ?? []) {
      closedSockets += docStore.closeSocketsForShare(share.shareId);
      closedStreams += sse.closeForShare(share.shareId);
    }
    // And every share-link and collaboration-hostname visitor, neither of
    // whom carries a Cloudflare shareId for the sweep above to match. Both
    // carry a membership key, and this matches every one. Without it the
    // switch closed the door to new requests while an already-open
    // `/y/<doc>` kept reading AND writing, and an `/events/` stream kept
    // delivering.
    closedSockets += docStore.closeSocketsForShareMembers(() => true);
    closedStreams += sse.closeForShareMembers(() => true);
  }
  ctx.onSharingFlip(flip);
  return { ok: true, closedSockets, closedStreams };
}

export const ENV_LOCKED_HINT =
  'CW_SHARING_DISABLED is set in the environment. Remove it from the service definition and restart to allow runtime control.';
