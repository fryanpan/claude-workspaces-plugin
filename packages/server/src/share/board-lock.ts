/**
 * What a call to lock a board against sharing asked for, the log line that
 * says who asked, and the refusal a mint on a locked board gets.
 *
 * A locked board is one no share may be minted for (`share/sharing-gate.ts`).
 * It exists because closing a board refuses its VISITORS but leaves minting
 * open, so a board holding files that must never leave the machine stayed
 * one `share_workspace` call away from a link. The lock refuses the call.
 *
 * Parsed strictly, as the sharing switch is (`sharing-flip.ts`): a key this
 * route does not read is refused and named, because an `ok` over a dropped
 * argument is how the 23 September switch call went wrong.
 */
import { stamped } from '../log-stamp.ts';
import { FLIP_REASON_MAX, type FlipRequest } from './sharing-flip.ts';

const KNOWN_KEYS = new Set(['workspaceId', 'locked', 'reason', 'actor']);
const ACTOR_FIELD_MAX = 200;

export interface LockRequest {
  workspaceId: string;
  locked: boolean;
  reason?: string;
  actor?: FlipRequest['actor'];
}

export type LockParse = { ok: true; value: LockRequest } | { ok: false; error: string };

/** Read a lock request body, refusing anything it would otherwise drop. */
export function parseLockRequest(body: Record<string, unknown> | null): LockParse {
  if (!body) return { ok: false, error: 'body must be a JSON object' };
  const unknown = Object.keys(body).filter((k) => !KNOWN_KEYS.has(k));
  if (unknown.length > 0) {
    return { ok: false, error: `unknown field(s): ${unknown.sort().join(', ')}` };
  }
  const { workspaceId, locked, reason, actor } = body;
  if (typeof workspaceId !== 'string' || workspaceId.trim() === '') {
    return { ok: false, error: 'workspaceId must be a non-empty string' };
  }
  if (typeof locked !== 'boolean') return { ok: false, error: 'locked must be a boolean' };
  const value: LockRequest = { workspaceId: workspaceId.trim(), locked };
  if (reason !== undefined) {
    if (typeof reason !== 'string') return { ok: false, error: 'reason must be a string' };
    if (reason.length > FLIP_REASON_MAX) {
      return { ok: false, error: `reason is longer than ${FLIP_REASON_MAX} characters` };
    }
    if (reason.trim() !== '') value.reason = reason.trim();
  }
  if (actor !== undefined) {
    if (typeof actor !== 'object' || actor === null || Array.isArray(actor)) {
      return { ok: false, error: 'actor must be an object' };
    }
    const a = actor as Record<string, unknown>;
    const out: { id?: string; name?: string } = {};
    for (const k of ['id', 'name'] as const) {
      const v = a[k];
      if (v === undefined) continue;
      if (typeof v !== 'string' || v.length > ACTOR_FIELD_MAX) {
        return { ok: false, error: `actor.${k} must be a string of at most ${ACTOR_FIELD_MAX}` };
      }
      out[k] = v;
    }
    value.actor = out;
  }
  return { ok: true, value };
}

/** The log line. Free text is JSON-quoted so it cannot start a second line. */
export function boardLockLine(f: {
  workspaceId: string;
  locked: boolean;
  actor: string;
  peer: string;
  reason: string | null;
  at: number;
}): string {
  const what = `board ${JSON.stringify(f.workspaceId)} ${f.locked ? 'locked never-shareable' : 'unlocked for sharing'}`;
  const reason = f.reason === null ? 'none given' : JSON.stringify(f.reason);
  return stamped(
    `[sharing] ${what} by ${JSON.stringify(f.actor)} from ${f.peer} reason=${reason}`,
    f.at,
  );
}

/** What `share_workspace`, `share_link` and `share_doc` answer on a locked board. */
export function boardLockedRefusal(workspaceId: string): {
  error: 'board_never_shareable';
  workspaceId: string;
  hint: string;
} {
  return {
    error: 'board_never_shareable',
    workspaceId,
    hint: 'This board is locked never-shareable, so no share link can be minted for it. Only a call from the owner’s machine can unlock it: set_board_sharing_lock with locked:false.',
  };
}

/**
 * The locked board a retired `share_doc` payload names, if any: its
 * `workspaceId` directly, or a board holding its `docId` or the doc's set.
 * First match wins, because one locked board is enough to refuse.
 */
export function lockedBoardNamedBy(
  body: Record<string, unknown> | null,
  deps: { isBoardLocked: (id: string) => boolean; boardsHolding: (id: string) => string[] },
): string | null {
  const named: string[] = [];
  if (typeof body?.workspaceId === 'string') named.push(body.workspaceId);
  if (typeof body?.docId === 'string') named.push(...deps.boardsHolding(body.docId));
  return named.find((id) => deps.isBoardLocked(id)) ?? null;
}
