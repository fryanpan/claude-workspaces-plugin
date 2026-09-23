/**
 * What a call to the sharing switch asked for, and the log line that says who
 * asked.
 *
 * On 23 September at 00:09Z a session meaning to close one board threw the
 * master switch, and every outside hostname, the owner's own among them,
 * answered `sharing_disabled` for two minutes. Nothing said who had done it:
 * the route wrote no line and the timing log skips fast requests. So every
 * flip now writes one line naming the actor, the peer address, the time and
 * the reason given.
 *
 * The line is TIMESTAMPED, which `log-stamp.ts` warns against on a
 * `console.error` line because the squelch cannot collapse distinct strings.
 * That warning is about lines that can fire in a loop. A flip is an operator
 * action on a trusted-local route that writes a file per call, and a squelch
 * that folded two flips into one summary would lose exactly the who and when
 * this line exists for.
 *
 * The body is parsed strictly. A key this route does not read is refused and
 * named, because an `ok: true` over a dropped argument is how the 23 September
 * call went wrong: it named a board, the tool ignored the name, and the answer
 * said nothing about it.
 */
import { stamped } from '../log-stamp.ts';

/** How long a reason may be. A sentence, not a document. */
export const FLIP_REASON_MAX = 500;
/** How long a self-reported actor field may be. */
const ACTOR_FIELD_MAX = 200;

/** The body keys this route reads. Anything else is refused. */
const KNOWN_KEYS = new Set(['enabled', 'workspaceId', 'reason', 'actor']);

export interface FlipRequest {
  enabled: boolean;
  /** Present: close or open this one board. Absent: the master switch. */
  workspaceId?: string;
  reason?: string;
  /** Who the caller says it is. The MCP tool sends its session's agent. */
  actor?: { id?: string; name?: string };
}

export type FlipParse = { ok: true; value: FlipRequest } | { ok: false; error: string };

/** Read a switch request body, refusing anything it would otherwise drop. */
export function parseFlipRequest(body: Record<string, unknown> | null): FlipParse {
  if (!body) return { ok: false, error: 'body must be a JSON object' };
  const unknown = Object.keys(body).filter((k) => !KNOWN_KEYS.has(k));
  if (unknown.length > 0) {
    return { ok: false, error: `unknown field(s): ${unknown.sort().join(', ')}` };
  }
  const { enabled, workspaceId, reason, actor } = body;
  if (typeof enabled !== 'boolean') return { ok: false, error: 'enabled must be a boolean' };
  const value: FlipRequest = { enabled };
  if (workspaceId !== undefined) {
    if (typeof workspaceId !== 'string' || workspaceId.trim() === '') {
      return { ok: false, error: 'workspaceId must be a non-empty string' };
    }
    value.workspaceId = workspaceId.trim();
  }
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

/** One flip, as the log line and the owner notice describe it. */
export interface SharingFlip {
  /** Absent for the master switch. */
  workspaceId?: string;
  enabled: boolean;
  /** Who, as the request attributes it: an agent, a signed-in person, or
   *  `unattributed`. */
  actor: string;
  /** The socket's peer address, or `unknown`. */
  peer: string;
  reason: string | null;
  at: number;
}

/**
 * Who flipped it. The caller's own claim first, because the agent's MCP calls
 * arrive over loopback and prove no identity; then the identity the request
 * proved; then an explicit `unattributed` rather than a blank.
 */
export function flipActor(
  claimed: FlipRequest['actor'],
  proven: { email?: string; displayName?: string } | null,
): string {
  if (claimed?.name || claimed?.id) {
    const name = claimed.name ?? claimed.id ?? '';
    const id = claimed.id && claimed.id !== name ? ` (${claimed.id})` : '';
    return `agent ${name}${id}`;
  }
  if (proven?.email) return `person ${proven.email}`;
  if (proven?.displayName) return `person ${proven.displayName}`;
  return 'unattributed';
}

/**
 * The line. Free text goes through JSON quoting so a reason or a name cannot
 * start a second line in the log.
 */
export function sharingFlipLine(f: SharingFlip): string {
  const what = f.workspaceId
    ? `board ${JSON.stringify(f.workspaceId)} ${f.enabled ? 'opened to' : 'closed to'} outside visitors`
    : `master switch ${f.enabled ? 'ON' : 'OFF'}`;
  const reason = f.reason === null ? 'none given' : JSON.stringify(f.reason);
  return stamped(
    `[sharing] ${what} by ${JSON.stringify(f.actor)} from ${f.peer} reason=${reason}`,
    f.at,
  );
}
