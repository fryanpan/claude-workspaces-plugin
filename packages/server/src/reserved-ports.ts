/**
 * Ports this machine's other fleet services already own.
 *
 * A dev or staging server binding one of these does not fail loudly — there
 * is no cross-process lock on a TCP port, so the bind just succeeds. The
 * failure shows up later and sideways: on 2026-09-0x a staging server bound
 * the IPv6 wildcard on 8791 while the fleet's Notion webhook receiver held
 * `127.0.0.1:8791`. The moment the receiver restarted, the staging build
 * inherited every Notion webhook and answered them `unknown_host` — and its
 * OWN health check stayed green throughout, because the port was still
 * answering, just to the wrong process.
 *
 * Kept in one place so `scripts/staging.ts` and `bin.ts` check the same list
 * and agree on why each entry is there, instead of one of them drifting.
 */
export interface ReservedPort {
  port: number;
  /** Who owns it, for the refusal message — not a hostname or PID, just
   *  enough for a person to know what NOT to kill. */
  owner: string;
}

export const RESERVED_PORTS: readonly ReservedPort[] = [
  { port: 8787, owner: 'prod (the claude-workspaces server)' },
  { port: 8791, owner: "the fleet's Notion webhook receiver" },
  { port: 7900, owner: 'claude-hive' },
  { port: 7902, owner: 'the GitHub broker' },
];

/** The owner of `port`, or `null` when it is not reserved. Pure — no sockets,
 *  so it can be asserted against without booting anything. */
export function reservedPortOwner(port: number): string | null {
  return RESERVED_PORTS.find((p) => p.port === port)?.owner ?? null;
}

/** A ready-to-print refusal, or `null` when `port` is free to use. Shared so
 *  the two callers give the same guidance, not two differently-worded ones. */
export function reservedPortError(port: number): string | null {
  const owner = reservedPortOwner(port);
  if (!owner) return null;
  return (
    `port ${port} is reserved for ${owner}. ` +
    'Pick a port 8800 or above (or 0 to let the OS choose one).'
  );
}

/**
 * Every port a board server may listen on: prod's, then staging's. A
 * sandboxed lead's profile denies each of them at every address
 * (`scripts/lead-sandbox-wall.ts`), and `scripts/staging.ts` refuses any
 * other, so a staging server cannot sit where the wall does not look.
 */
export const BOARD_SERVER_PORTS: readonly number[] = [8787, 8788, 8789, 8790];

/** The ports staging may take: the board-server ports bar prod's. */
export const STAGING_PORTS: readonly number[] = BOARD_SERVER_PORTS.slice(1);

/** A ready-to-print refusal for a staging port, or `null` when it may be used. */
export function stagingPortError(port: number): string | null {
  if (STAGING_PORTS.includes(port)) return null;
  const owner = reservedPortOwner(port);
  const why = owner
    ? `is reserved for ${owner}`
    : "is not a board-server port, so a sandboxed lead's wall would not cover it";
  return `port ${port} ${why}. Pick one of ${STAGING_PORTS.join(', ')}.`;
}
