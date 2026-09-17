/**
 * What the fleet-wide unfiled-wait escalation remembers between ticks, and
 * how it survives a restart.
 *
 * Split out of `waiting-unfiled-escalation.ts` so the file it came from could
 * hold the aging decision alone, and so this half can be driven directly: the
 * escalation's own suite never touched the disk, which left "an old sidecar
 * still escalates, and a restart does not re-gift a row its spent wakes" as a
 * claim in a comment rather than a case.
 *
 * Two properties this file exists to hold, both of which fail OPEN — towards
 * more wakes, never fewer, because a finding nobody hears is the failure the
 * whole subsystem is against:
 *
 *  - A file written before a field existed is read as that field's zero, not
 *    as a row already silenced.
 *  - A file that cannot be parsed is discarded whole. One duplicate item, or
 *    one repeated wake, is the price; a crash inside a timer tick is not.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** `<dataDir>/waiting-unfiled-waits.json`. Exported so a test asserts the file
 *  the server actually writes rather than a copy of its name. */
export const WAITING_UNFILED_FILENAME = 'waiting-unfiled-waits.json';

/** One row the escalation is aging, keyed `<workspaceId>|<taskId>`. */
export interface Seen {
  workspaceId: string;
  taskId: string;
  firstSeen: number;
  /** Fleet wakes this row has already been carried in. Absent on a file
   *  written before the cap existed, which reads as none spent — the row gets
   *  its wakes rather than being silenced by a field nobody wrote. */
  tells?: number;
}

export interface Sidecar {
  seen: Record<string, Seen>;
  /** The one fleet item, while one stands. */
  filed?: { workspaceId: string; taskId: string; itemId: string; keys: string[] };
  /** When Team Lead was last told, this stretch. */
  teamLeadToldAt?: number;
  /** Keys the owner has already been shown on an item they answered or
   *  withdrew. Not asked about again; a task they were not shown is. */
  seenByOwner?: string[];
}

export const emptySidecar = (): Sidecar => ({ seen: {} });

export const sidecarPath = (dataDir: string): string => join(dataDir, WAITING_UNFILED_FILENAME);

/** Keys sorted, so an unchanged sidecar serializes byte-identically and costs
 *  no write on a loop that runs once a minute forever. */
export function serializeSidecar(sidecar: Sidecar): string {
  const seen: Record<string, Seen> = {};
  for (const k of Object.keys(sidecar.seen).sort()) {
    const row = sidecar.seen[k];
    if (row) seen[k] = row;
  }
  return `${JSON.stringify({ ...sidecar, seen }, null, 2)}\n`;
}

/**
 * Read one back, field by field rather than by trusting the parse. Anything
 * missing or the wrong shape is left at its default, which for every field
 * here means "not yet known" and never "already handled".
 *
 * `persisted` is what the caller should treat as already on disk, so that an
 * unchanged tick costs no write. Empty when nothing was read — a file that
 * was absent or unreadable is one the next save must write over.
 */
export function loadSidecar(path: string | null): { sidecar: Sidecar; persisted: string } {
  const nothing = { sidecar: emptySidecar(), persisted: '' };
  if (!path || !existsSync(path)) return nothing;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<Sidecar>;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.seen !== 'object') return nothing;
    const sidecar: Sidecar = { seen: parsed.seen ?? {} };
    if (parsed.filed) sidecar.filed = parsed.filed;
    if (typeof parsed.teamLeadToldAt === 'number') sidecar.teamLeadToldAt = parsed.teamLeadToldAt;
    if (Array.isArray(parsed.seenByOwner)) sidecar.seenByOwner = parsed.seenByOwner;
    return { sidecar, persisted: serializeSidecar(sidecar) };
  } catch {
    return nothing;
  }
}

/**
 * Write it back when it has actually moved, and answer what is now on disk so
 * the caller can skip the next unchanged write. Never throws: this runs
 * inside a timer tick, and a full disk must not stop the loop.
 */
export function saveSidecar(path: string | null, sidecar: Sidecar, lastPersisted: string): string {
  if (!path) return lastPersisted;
  const next = serializeSidecar(sidecar);
  if (next === lastPersisted) return lastPersisted;
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, next);
    renameSync(tmp, path);
    return next;
  } catch (err) {
    console.error('[stall] could not persist waiting-unfiled escalations:', err);
    return lastPersisted;
  }
}
