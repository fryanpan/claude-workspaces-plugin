/**
 * Where everybody in a workspace is, as one presence room holds it.
 *
 * The rule (Bryan, 15 Oct): a person attends to one place, so a person's
 * presence is a single spot on one page. An agent is not in one place at a
 * time — it can edit five places in a doc and draw in a mock at once — so an
 * agent's presence is the spot it CHOOSES to point at, by a verb, and its
 * edits elsewhere draw nothing. Following either leads anywhere in the
 * workspace.
 *
 * The room is the board's own awareness (`/workspaces/<ws>/y`). Every page of
 * the workspace joins it — the board with its full socket, a doc or a
 * whiteboard with a presence-only one that syncs no board content — and
 * announces `user` plus `PERSON_SPOT_FIELD`. The server announces no `user`;
 * its own state carries `AGENT_SPOTS_FIELD`, one entry per agent, the way a
 * whiteboard's `agentPointers` does for one canvas.
 *
 * Read by the server (which writes agent spots) and by every page (which
 * writes its person's spot and follows), so the two cannot disagree on the
 * shape.
 */

/** The page's own spot, beside `user` in its awareness state. */
export const PERSON_SPOT_FIELD = 'spot';

/** The server's record of where each agent pointed, keyed by agent id. */
export const AGENT_SPOTS_FIELD = 'agentSpots';

/** Which kind of page a spot is on. */
export type SpotSurface = 'board' | 'doc' | 'whiteboard';

/**
 * One place in the workspace. `docId` names the page (absent on the board);
 * at most one of the rest names the place on it: a block of a doc (the
 * planning voice's `agentFocus` shape — `blockId` and the words), a thread,
 * or a point on a whiteboard's canvas.
 */
export interface PresenceSpot {
  surface: SpotSurface;
  docId?: string;
  blockId?: string;
  quote?: string;
  threadId?: string;
  x?: number;
  y?: number;
}

/** An agent's spot: where it pointed, and a counter that grows per point. */
export interface AgentSpot extends PresenceSpot {
  name: string;
  seq: number;
}

const SURFACES = new Set<SpotSurface>(['board', 'doc', 'whiteboard']);
/** Ids here are doc, block and thread ids: short, no control characters. */
const ID = /^[A-Za-z0-9:_.~-]{1,200}$/;
const finite = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1_000_000;

/**
 * A spot read off presence, or null. Presence is whatever a page set, so
 * every field is checked before a page navigates or scrolls on it.
 */
export function parseSpot(raw: unknown): PresenceSpot | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.surface !== 'string' || !SURFACES.has(r.surface as SpotSurface)) return null;
  const surface = r.surface as SpotSurface;
  const out: PresenceSpot = { surface };
  if (surface !== 'board') {
    if (typeof r.docId !== 'string' || !ID.test(r.docId)) return null;
    out.docId = r.docId;
  }
  if (typeof r.blockId === 'string' && ID.test(r.blockId)) {
    out.blockId = r.blockId;
    if (typeof r.quote === 'string') out.quote = r.quote.slice(0, 500);
  } else if (typeof r.threadId === 'string' && ID.test(r.threadId)) {
    out.threadId = r.threadId;
  } else if (finite(r.x) && finite(r.y)) {
    out.x = r.x;
    out.y = r.y;
  }
  return out;
}

/** The server's agent spots, each checked; a bad entry is dropped alone. */
export function parseAgentSpots(raw: unknown): Map<string, AgentSpot> {
  const out = new Map<string, AgentSpot>();
  if (!raw || typeof raw !== 'object') return out;
  for (const [agentId, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!ID.test(agentId) || !v || typeof v !== 'object') continue;
    const e = v as Record<string, unknown>;
    const spot = parseSpot(e);
    if (!spot || typeof e.name !== 'string' || !finite(e.seq)) continue;
    out.set(agentId, { ...spot, name: e.name.slice(0, 80), seq: e.seq });
  }
  return out;
}

/** Whether two spots are on the same page, wherever on it they are. */
export function samePage(a: PresenceSpot, b: PresenceSpot): boolean {
  return a.surface === b.surface && (a.docId ?? '') === (b.docId ?? '');
}
