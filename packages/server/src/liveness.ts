/**
 * Is THIS server reachable right now — as opposed to: did the last deploy
 * come up?
 *
 * Those are two different claims and `GET /api/deploy` used to carry only the
 * second. Its `verification` field describes the boot that followed the last
 * `POST /api/deploy`: it reads `healthy` for as long as nothing deploys
 * again, including through an outage. On 16 September prod was unreachable
 * for seven minutes with that field reading `healthy` the whole time, and
 * peers took it for liveness twice.
 *
 * So the route carries a `liveness` field beside it, and this module is what
 * fills it. It changes nothing about the watchdog — the supervisor already
 * knows whether the port is bound, because it is the thing probing it. This
 * is for the READER: an agent or a person who has one endpoint and needs to
 * know which question they just asked.
 *
 * Two facts make it up, and both are about now rather than about a deploy:
 *
 *   the bound port      — this process is listening, which is implicit in
 *                         being able to answer at all, and explicit here so
 *                         the reply names the port it came from
 *   the discovery slot  — `~/.claude/claude-workspaces/server.json`, the
 *                         machine-wide file every MCP client resolves the
 *                         server through. A server that is bound but does not
 *                         own it is running and undiscoverable, which is
 *                         exactly staging's normal state and exactly what a
 *                         confused peer needs told.
 *
 * `ok` is the conjunction, so it is the field the done-when asked for: true
 * only when the child has bound its port AND written the discovery file.
 */

/** Who owns the machine-wide discovery slot, as this process sees it. */
export type DiscoveryOwnership =
  | 'ours'
  /** A live entry naming a different port or pid — staging's normal state. */
  | 'another-server'
  /** No entry at all: nothing published, or it was released. */
  | 'missing';

/** The entry as `readDiscovery` returns it — only the two fields we judge. */
export interface DiscoveryClaim {
  port: number;
  pid: number;
}

export interface LivenessInput {
  /** The port this process actually bound, or null before it has. */
  boundPort: number | null;
  /** When it bound, or null before it has. */
  boundAt: number | null;
  /** This process's pid — the one the supervisor publishes. */
  pid: number;
  /** The current discovery entry, or null when there is none. */
  discovery: DiscoveryClaim | null;
}

export interface ServerLiveness {
  /** True only when this process has bound its port AND owns the discovery
   *  slot peers resolve the server through. Not a deploy verdict. */
  ok: boolean;
  /** The port this process is listening on. */
  port: number | null;
  /** When it started listening. */
  boundAt: number | null;
  discovery: DiscoveryOwnership;
  /** One line naming what `ok` is and is not, so a reader who found this
   *  field while looking for `verification` cannot conflate them. */
  detail: string;
}

/**
 * Whose the slot is. The supervisor publishes the CHILD's pid and the port it
 * asked for, so an entry naming both is ours.
 *
 * Judged on both, not on the pid alone: a pid matching while the port does
 * not means the entry is stale from an earlier bind of this same process,
 * which is a slot no peer can reach us through — the same practical state as
 * another server owning it.
 */
export function discoveryOwnership(input: LivenessInput): DiscoveryOwnership {
  const { discovery, boundPort, pid } = input;
  if (!discovery) return 'missing';
  return discovery.pid === pid && discovery.port === boundPort ? 'ours' : 'another-server';
}

/** The `liveness` field of `GET /api/deploy`. Pure: the caller does the I/O. */
export function describeLiveness(input: LivenessInput): ServerLiveness {
  const ownership = discoveryOwnership(input);
  const bound = input.boundPort !== null;
  const ok = bound && ownership === 'ours';
  const detail = !bound
    ? 'this process has not bound a port yet'
    : ownership === 'ours'
      ? `listening on :${input.boundPort} and owns the discovery slot — this is liveness now, ` +
        'not the last deploy (read `deploy.verification` for that)'
      : ownership === 'another-server'
        ? `listening on :${input.boundPort}, but another server owns the discovery slot, so ` +
          'local agents resolve that one and not this'
        : `listening on :${input.boundPort}, but nothing owns the discovery slot, so local ` +
          'agents have no entry to resolve';
  return { ok, port: input.boundPort, boundAt: input.boundAt, discovery: ownership, detail };
}

/**
 * How long a discovery reading is reused before the file is read again.
 *
 * The supervisor probes this route every 30s and it is the route it probes,
 * so a file read here is on the path that decides whether prod gets
 * restarted. Bounded to one read per window regardless of how many callers
 * ask — and short enough that a slot changing hands is visible within a
 * tick. `readDiscovery` is synchronous, and a synchronous open is the shape
 * that parked prod's main thread for twenty minutes on 2026-09-04, so the
 * number of them this route can perform is worth being a constant rather
 * than a consequence of traffic.
 */
export const DISCOVERY_READ_TTL_MS = 15_000;

/** Wrap a discovery read so at most one happens per `DISCOVERY_READ_TTL_MS`. */
export function cacheDiscoveryReads(
  read: () => DiscoveryClaim | null,
  opts: { now?: () => number; ttlMs?: number } = {},
): () => DiscoveryClaim | null {
  const now = opts.now ?? Date.now;
  const ttlMs = opts.ttlMs ?? DISCOVERY_READ_TTL_MS;
  let readAt = Number.NEGATIVE_INFINITY;
  let last: DiscoveryClaim | null = null;
  return () => {
    const at = now();
    if (at - readAt < ttlMs) return last;
    readAt = at;
    last = read();
    return last;
  };
}
