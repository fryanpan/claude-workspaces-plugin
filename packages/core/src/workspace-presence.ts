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

/** Which kind of page a spot is on. A mock is a doc that opens on its own
 *  host page (`/workspaces/<ws>/mockups/<id>`), not the doc page, and so
 *  does an app, whose spot also carries the page of it as `path`. */
export type SpotSurface = 'board' | 'doc' | 'whiteboard' | 'mock';

/**
 * One place in the workspace. `docId` names the page (absent on the board);
 * at most one of the rest names the place on it: a block of a doc (the
 * planning voice's `agentFocus` shape — `blockId` and the words), a thread,
 * a point on a whiteboard's canvas, or a phrase alone (`quote`, found by
 * its words).
 *
 * Two more ride beside any of those. `path` is the page's own address, path
 * and query, for a page `docId` cannot name: a board tab, a task or goal
 * panel, a review item, a page of an app. `scroll` is how far down the page the
 * view is, from 0 (top) to 1 (bottom), for a page with no block to name.
 */
export interface PresenceSpot {
  surface: SpotSurface;
  docId?: string;
  blockId?: string;
  quote?: string;
  threadId?: string;
  x?: number;
  y?: number;
  path?: string;
  scroll?: number;
}

/** An agent's spot: where it pointed, and a counter that grows per point. */
export interface AgentSpot extends PresenceSpot {
  name: string;
  seq: number;
}

const SURFACES = new Set<SpotSurface>(['board', 'doc', 'whiteboard', 'mock']);
/** A path on this origin, with its query: no scheme, no `//` host, no `..`,
 *  no backslash. Which paths a follower may open is `spotHref`'s decision. */
const PATH = /^\/(?![/\\])[A-Za-z0-9/_.~:?=&%+-]{0,400}$/;
const QUOTE_MAX = 500;
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
    if (typeof r.quote === 'string') out.quote = r.quote.slice(0, QUOTE_MAX);
  } else if (typeof r.threadId === 'string' && ID.test(r.threadId)) {
    out.threadId = r.threadId;
  } else if (finite(r.x) && finite(r.y)) {
    out.x = r.x;
    out.y = r.y;
  } else if (typeof r.quote === 'string' && r.quote.trim()) {
    out.quote = r.quote.slice(0, QUOTE_MAX);
  }
  if (typeof r.path === 'string' && PATH.test(r.path) && !r.path.includes('..')) {
    out.path = r.path;
  }
  if (typeof r.scroll === 'number' && r.scroll >= 0 && r.scroll <= 1) out.scroll = r.scroll;
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

/**
 * Whether a page is the one its person is attending to: the tab is visible
 * and holds the window's focus. Every page announces it beside its spot, so
 * the server can tell a person's foreground tab from the ones left open in
 * the background or on another device (`person-presence.ts`).
 */
export const ATTENDING_FIELD = 'attending';

/**
 * The server's instruction to ONE page, by its awareness client id: go to
 * this spot. An agent asks for it (`show_person`, MCP) and the server
 * addresses it to the page its person is attending to on that board, so a
 * tab in the background or on another device stays where it is. `seq` grows
 * per instruction, across restarts, so a page acts on each one once.
 */
export const DIRECTIVE_FIELD = 'personDirective';

export interface PersonDirective {
  to: number;
  seq: number;
  /** Who asked: the agent, by id and the name its chip carries. */
  by: { id: string; name: string };
  spot: PresenceSpot;
}

/** A directive read off presence, or null. The server's own state, but read
 *  by every page, so it is checked like any other presence field. */
export function parseDirective(raw: unknown): PersonDirective | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const by = r.by as Record<string, unknown> | undefined;
  const whole = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
  if (!whole(r.to) || !whole(r.seq) || !by || typeof by !== 'object') return null;
  if (typeof by.id !== 'string' || !ID.test(by.id) || typeof by.name !== 'string') return null;
  const spot = parseSpot(r.spot);
  if (!spot) return null;
  return { to: r.to, seq: r.seq, by: { id: by.id, name: by.name.slice(0, 80) }, spot };
}
