/**
 * Where the board's owner is attending, and the one tab an agent may move.
 *
 * Every page of a board announces its person's spot in the board's presence
 * room (`@claude-workspaces/core/workspace-presence`), and now also whether
 * it is the tab that person is attending to (`ATTENDING_FIELD`: visible and
 * focused). This module reads that room on the server and answers two
 * questions for agents attached to the board:
 *
 *  - **Where is the owner?** An agent that watches gets a `person.landed`
 *    frame when the owner's attended tab lands on a page — a doc, a task, a
 *    mock, a diff — naming the board, the resource and the place in view.
 *    Only a change of page is news; a scroll within it is not, or a reader
 *    would wake the agent on every paragraph. The frame waits `settleMs` so
 *    the page has said which part of itself is in view.
 *  - **Take the owner there.** `show` addresses a `PersonDirective` to the
 *    awareness client id of that one tab, so a tab in the background or on
 *    another device stays where it is.
 *
 * Which tabs are the owner's. A page's announced user id is whatever the
 * page set, so it is not trusted alone: a socket whose upgrade proved a
 * person (`personProof`) counts only if that proof named the owner, a share
 * visitor's socket never counts, and a socket that proved nobody counts by
 * its announced id only where the deployment let it write (a read-only
 * socket is one the sign-in gate refused). That id is the one the server
 * stamped on the socket (`presence-identity.ts`), never the page's own.
 *
 * The wall between boards is the room itself: a board's room holds only the
 * pages open on that board, so an agent on one board can neither hear nor
 * move a tab that is on another.
 */
import {
  ATTENDING_FIELD,
  DIRECTIVE_FIELD,
  PERSON_SPOT_FIELD,
  type PersonDirective,
  type PresenceSpot,
  parseSpot,
} from '@claude-workspaces/core/workspace-presence';
import type * as awarenessProtocol from 'y-protocols/awareness';

/** What a landing names besides the spot: the kind of page and its id. */
export interface LandedResource {
  kind: 'doc' | 'diff' | 'mockup' | 'app' | 'whiteboard' | 'task' | 'goal' | 'page';
  id?: string;
  title?: string;
}

export interface Landing {
  workspaceId: string;
  person: { id: string; name: string };
  resource: LandedResource;
  spot: PresenceSpot;
  /** The agent whose `show` sent the owner here, when one did: the MCP
   *  child drops a landing its own session caused (`self-authored.ts`). */
  actor?: { id: string; name: string };
}

/** The slice of a socket's stamp this reads: the `origin` of a remote update. */
interface SocketStamp {
  data?: {
    shareId?: unknown;
    shareMember?: unknown;
    readOnly?: unknown;
    personProof?: unknown;
    presenceUser?: { id?: unknown; kind?: unknown; verified?: unknown };
  };
}

export interface PersonPresenceDeps {
  /** Whether a user id is the board owner's identity. */
  isOwner: (userId: string) => boolean;
  /** Name the page a spot is on. */
  describe: (workspaceId: string, spot: PresenceSpot) => LandedResource;
  /** Hand one agent a landing; transient, live streams only. */
  deliver: (workspaceId: string, agentId: string, landing: Landing) => void;
  now?: () => number;
  /** How long a page has to say what is in view before the landing goes. */
  settleMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export type ShowResult = { ok: true; to: number; seq: number } | { ok: false; reason: 'not-here' };

export interface PersonPresence {
  /** A board's room opened (or reopened with a new awareness). */
  attach(workspaceId: string, awareness: awarenessProtocol.Awareness): void;
  /** Start or stop an agent's watch on a board; returns where the owner is. */
  watch(workspaceId: string, agentId: string, on: boolean): Landing | null;
  /** Where the owner's attended tab on this board is, or null. */
  current(workspaceId: string): Landing | null;
  /** Send the owner's attended tab on this board to a spot. */
  show(workspaceId: string, by: { id: string; name: string }, spot: PresenceSpot): ShowResult;
}

interface Room {
  awareness: awarenessProtocol.Awareness;
  /** What the socket that carried each client id proved about its person. */
  trusted: Map<number, 'proven' | 'announced' | 'none'>;
  /** When the server saw each client become attended, by its own clock. */
  since: Map<number, number>;
  /** The page the last landing was about, or null. */
  lastPage: string | null;
  timer: unknown;
  /** The last `show`: who sent the owner, and to which page. */
  directed: { by: { id: string; name: string }; page: string } | null;
}

/** The trust a socket's stamp gives the states it carried, or null for none.
 *  `presenceUser` is the name the server put on the socket's presence: a
 *  guest never counts, and a proof naming somebody else never does. */
function trustOf(
  origin: unknown,
  isOwner: (id: string) => boolean,
): 'proven' | 'announced' | 'none' | null {
  const data = (origin as SocketStamp | null)?.data;
  if (!data || typeof data !== 'object') return null;
  if (data.shareId || data.shareMember) return 'none';
  if (data.personProof === 'owner') return 'proven';
  if (data.personProof === 'other' || data.readOnly) return 'none';
  const stamped = data.presenceUser;
  if (stamped?.kind === 'guest') return 'none';
  if (stamped?.verified === true && !(typeof stamped.id === 'string' && isOwner(stamped.id))) {
    return 'none';
  }
  return 'announced';
}

/** The page a spot is on, not the place on it. A doc is named by its id;
 *  a board page by its path, which `show` and the page write alike. */
const pageKey = (spot: PresenceSpot): string =>
  `${spot.surface}|${spot.docId ?? ''}|${spot.surface === 'board' ? (spot.path ?? '') : ''}`;
const pageOf = (clientId: number, spot: PresenceSpot): string => `${clientId}|${pageKey(spot)}`;

export function createPersonPresence(deps: PersonPresenceDeps): PersonPresence {
  const now = deps.now ?? Date.now;
  const settleMs = deps.settleMs ?? 300;
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer =
    deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout> | undefined));
  const rooms = new Map<string, Room>();
  // Per board, kept apart from the room: a watch outlives the room's doc
  // being evicted and rehydrated with a new awareness.
  const watchers = new Map<string, Set<string>>();
  let lastSeq = 0;

  const attended = (
    room: Room,
  ): { clientId: number; person: Landing['person']; spot: PresenceSpot } | null => {
    const states = room.awareness.getStates();
    let best: { clientId: number; at: number } | null = null;
    for (const [clientId, at] of room.since) {
      const trust = room.trusted.get(clientId);
      if (!trust || trust === 'none') continue;
      const user = (states.get(clientId) as { user?: { id?: unknown } } | undefined)?.user;
      // A proven owner socket is the owner whatever id the page announced.
      if (trust === 'announced' && !(typeof user?.id === 'string' && deps.isOwner(user.id))) {
        continue;
      }
      if (!best || at > best.at || (at === best.at && clientId > best.clientId)) {
        best = { clientId, at };
      }
    }
    if (!best) return null;
    const state = states.get(best.clientId) as Record<string, unknown> | undefined;
    const spot = parseSpot(state?.[PERSON_SPOT_FIELD]);
    if (!spot) return null;
    const user = state?.user as { id?: unknown; name?: unknown } | undefined;
    return {
      clientId: best.clientId,
      person: {
        id: typeof user?.id === 'string' ? user.id : '',
        name: typeof user?.name === 'string' ? user.name.slice(0, 80) : '',
      },
      spot,
    };
  };

  const landingOf = (workspaceId: string, room: Room | undefined): Landing | null => {
    const at = room ? attended(room) : null;
    if (!at) return null;
    return {
      workspaceId,
      person: at.person,
      resource: deps.describe(workspaceId, at.spot),
      spot: at.spot,
    };
  };

  const changed = (workspaceId: string, room: Room): void => {
    const at = attended(room);
    const page = at ? pageOf(at.clientId, at.spot) : null;
    if (page === room.lastPage) return;
    room.lastPage = page;
    if (room.timer !== undefined) clearTimer(room.timer);
    room.timer = undefined;
    if (!page) return;
    room.timer = setTimer(() => {
      room.timer = undefined;
      const landing = landingOf(workspaceId, room);
      const sent = room.directed;
      room.directed = null;
      const agents = watchers.get(workspaceId);
      if (!landing || !agents) return;
      if (sent && sent.page === pageKey(landing.spot)) landing.actor = sent.by;
      for (const agentId of agents) deps.deliver(workspaceId, agentId, landing);
    }, settleMs);
  };

  return {
    attach(workspaceId, awareness) {
      if (rooms.get(workspaceId)?.awareness === awareness) return;
      const room: Room = {
        awareness,
        trusted: new Map(),
        since: new Map(),
        lastPage: null,
        timer: undefined,
        directed: null,
      };
      rooms.set(workspaceId, room);
      awareness.on(
        'update',
        (
          { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
          origin: unknown,
        ) => {
          if (rooms.get(workspaceId) !== room) return;
          const trust = trustOf(origin, deps.isOwner);
          for (const id of [...added, ...updated]) {
            if (id === awareness.clientID) continue;
            // A socket's stamp is fixed at its upgrade; the first one wins.
            if (trust && !room.trusted.has(id)) room.trusted.set(id, trust);
            const on = (awareness.getStates().get(id) as Record<string, unknown> | undefined)?.[
              ATTENDING_FIELD
            ];
            if (on === true && !room.since.has(id)) room.since.set(id, now());
            else if (on !== true) room.since.delete(id);
          }
          for (const id of removed) {
            room.trusted.delete(id);
            room.since.delete(id);
          }
          changed(workspaceId, room);
        },
      );
    },
    watch(workspaceId, agentId, on) {
      const set = watchers.get(workspaceId) ?? new Set<string>();
      if (on) set.add(agentId);
      else set.delete(agentId);
      if (set.size > 0) watchers.set(workspaceId, set);
      else watchers.delete(workspaceId);
      return landingOf(workspaceId, rooms.get(workspaceId));
    },
    current: (workspaceId) => landingOf(workspaceId, rooms.get(workspaceId)),
    show(workspaceId, by, spot) {
      const room = rooms.get(workspaceId);
      const at = room ? attended(room) : null;
      if (!room || !at) return { ok: false, reason: 'not-here' };
      // Grows across restarts, so a page never mistakes a new one for seen.
      lastSeq = Math.max(lastSeq + 1, now());
      const directive: PersonDirective = { to: at.clientId, seq: lastSeq, by, spot };
      room.awareness.setLocalStateField(DIRECTIVE_FIELD, directive);
      room.directed = { by, page: pageKey(spot) };
      return { ok: true, to: at.clientId, seq: lastSeq };
    },
  };
}

/** The two reads `describeLanding` makes; the stores satisfy them. */
export interface LandingSources {
  peekMeta(docId: string): { type?: string; title?: string } | undefined;
}
export interface LandingTasks {
  getTask(taskId: string): { workspaceId?: string; title?: string } | undefined;
  getGoalRow(goalId: string): { workspaceId?: string; title?: string } | undefined;
}

/**
 * Name the page a spot is on, in the words an agent acts on: a doc, a diff
 * file, a mock, an app, a whiteboard, or a task or goal panel on the board.
 * A task or goal that is not on this board is named as a page, never by id.
 */
export function describeLanding(
  docs: LandingSources,
  tasks: LandingTasks,
  workspaceId: string,
  spot: PresenceSpot,
): LandedResource {
  if (spot.docId) {
    const meta = docs.peekMeta(spot.docId);
    const t = meta?.type;
    const kind: LandedResource['kind'] =
      t === 'diff' || t === 'code'
        ? 'diff'
        : t === 'mockup'
          ? 'mockup'
          : t === 'app'
            ? 'app'
            : t === 'whiteboard'
              ? 'whiteboard'
              : 'doc';
    return { kind, id: spot.docId, ...(meta?.title ? { title: meta.title } : {}) };
  }
  const query = new URLSearchParams(spot.path?.split('?')[1] ?? '');
  const taskId = query.get('task');
  const goalId = query.get('goal');
  const row = taskId ? tasks.getTask(taskId) : goalId ? tasks.getGoalRow(goalId) : undefined;
  if (row && row.workspaceId === workspaceId) {
    return {
      kind: taskId ? 'task' : 'goal',
      id: (taskId ?? goalId) as string,
      ...(row.title ? { title: row.title } : {}),
    };
  }
  return { kind: 'page' };
}
