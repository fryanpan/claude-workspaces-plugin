/**
 * Who is where in the workspace's presence room, and where following one of
 * them leads — the pure half, read by the board, a doc page and a whiteboard.
 *
 * The rule is `@claude-workspaces/core/workspace-presence`'s: a person is ONE
 * spot (the most recently active of their tabs), an agent is the spot it
 * last pointed at. A chip's key names the participant — `p-<identity>` or
 * `a-<agentId>` — exactly as the board's strip always has, so a follow armed
 * on any page means the same participant on every other.
 */
import { agentIdForName } from '@claude-workspaces/core/identity';
import {
  AGENT_SPOTS_FIELD,
  type AgentSpot,
  PERSON_SPOT_FIELD,
  type PresenceSpot,
  parseAgentSpots,
  parseSpot,
} from '@claude-workspaces/core/workspace-presence';
import {
  type PresenceChip,
  type PresencePerson,
  presenceIdentity,
} from '../board/board-presence-model.ts';

/** A person's row as the room carries it, with the spot their page set. */
export interface RoomPerson extends PresencePerson {
  spot: PresenceSpot;
}

/** Awareness states, as `Awareness.getStates()` hands them over. */
export type RoomStates = Map<number, unknown>;

/**
 * Every person in the room, one row per TAB (the strip folds tabs itself).
 * A board tab announces only `surface: 'board'`, and a page older than the
 * spot field only `surface` + `docId`, so a missing spot is rebuilt from
 * those rather than read as nowhere.
 */
export function peopleFromStates(states: RoomStates, selfClientId: number): RoomPerson[] {
  const people: RoomPerson[] = [];
  states.forEach((raw, clientId) => {
    const s = raw as
      | {
          user?: { id?: string; name?: string };
          surface?: string;
          docId?: string;
          lastActive?: number;
          [PERSON_SPOT_FIELD]?: unknown;
        }
      | undefined;
    if (!s?.user?.name) return;
    const surface = s.surface ?? 'board';
    const spot = parseSpot(s[PERSON_SPOT_FIELD]) ??
      parseSpot(surface === 'board' ? { surface } : { surface, docId: s.docId }) ?? {
        surface: 'board',
      };
    people.push({
      clientId,
      userId: s.user.id,
      name: s.user.name,
      surface,
      ...(s.docId ? { docId: s.docId } : {}),
      lastActive: s.lastActive ?? Date.now(),
      self: clientId === selfClientId,
      spot,
    });
  });
  return people;
}

/** Every agent spot the server announced, newest point per agent. */
export function agentSpotsFromStates(states: RoomStates): Map<string, AgentSpot> {
  const out = new Map<string, AgentSpot>();
  states.forEach((raw) => {
    const s = raw as Record<string, unknown> | undefined;
    if (!s || s.user !== undefined) return;
    for (const [id, spot] of parseAgentSpots(s[AGENT_SPOTS_FIELD])) {
      const prev = out.get(id);
      if (!prev || spot.seq > prev.seq) out.set(id, spot);
    }
  });
  return out;
}

/**
 * The spot following `key` leads to, or null when they are not in the room.
 * An agent chip on the board is keyed by the roster's id, which may be the
 * agent's name rather than its author id, so both spellings are tried.
 */
export function spotOfParticipant(
  states: RoomStates,
  key: string,
  selfClientId: number,
): PresenceSpot | null {
  if (key.startsWith('p-')) {
    const identity = key.slice(2);
    const [latest] = peopleFromStates(states, selfClientId)
      .filter((p) => !p.self && presenceIdentity(p) === identity)
      .sort((a, b) => b.lastActive - a.lastActive);
    return latest?.spot ?? null;
  }
  if (key.startsWith('a-')) {
    const id = key.slice(2);
    const spots = agentSpotsFromStates(states);
    return spots.get(id) ?? spots.get(agentIdForName(id)) ?? null;
  }
  return null;
}

/** The address a spot's page opens at. */
export function spotHref(workspaceId: string, spot: PresenceSpot): string {
  const board = `/workspaces/${encodeURIComponent(workspaceId)}`;
  if (spot.surface === 'board' || !spot.docId) return board;
  const id = encodeURIComponent(spot.docId);
  if (spot.surface === 'whiteboard') return `${board}/whiteboards/${id}`;
  const thread = spot.threadId ? `?thread=${encodeURIComponent(spot.threadId)}` : '';
  return `${board}/docs/${id}${thread}`;
}

/** One spot as a string, so the same spot is applied once, not per repaint. */
export function spotKey(spot: PresenceSpot): string {
  return JSON.stringify([
    spot.surface,
    spot.docId ?? '',
    spot.blockId ?? '',
    spot.threadId ?? '',
    spot.x ?? '',
    spot.y ?? '',
    (spot as Partial<AgentSpot>).seq ?? '',
  ]);
}

/**
 * The chips a doc or whiteboard page draws: everybody else in the room, and
 * every agent that has pointed somewhere. The board draws its own (agents
 * from its roster), through the same island and the same keys.
 */
export function roomChips(states: RoomStates, selfClientId: number): PresenceChip[] {
  const byPerson = new Map<string, RoomPerson>();
  for (const p of peopleFromStates(states, selfClientId)) {
    if (p.self) continue;
    const id = presenceIdentity(p);
    const prev = byPerson.get(id);
    if (!prev || p.lastActive >= prev.lastActive) byPerson.set(id, p);
  }
  const chips: PresenceChip[] = [...byPerson.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((p) => {
      const where = p.spot.surface === 'board' ? 'board' : (p.spot.docId ?? p.spot.surface);
      return {
        key: `p-${presenceIdentity(p)}`,
        label: p.name,
        kind: 'person',
        where,
        title: `${p.name} · in ${where}`,
        ...(p.docId ? { docId: p.docId } : {}),
        clientId: p.clientId,
      };
    });
  const agents = [...agentSpotsFromStates(states)].sort(([a], [b]) => a.localeCompare(b));
  for (const [id, spot] of agents) {
    const where = spot.docId ?? spot.surface;
    chips.push({
      key: `a-${id}`,
      label: spot.name,
      kind: 'agent',
      where,
      title: `${spot.name} · pointing in ${where}`,
    });
  }
  return chips;
}
