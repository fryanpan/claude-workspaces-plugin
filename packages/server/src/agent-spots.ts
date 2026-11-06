/**
 * Where each agent is pointing, in the workspace's presence room.
 *
 * An agent's presence is only where it directs its followers, never where it
 * is working (Bryan, 2026-11-04; `@claude-workspaces/core/workspace-presence`).
 * An agent can be busy in many places at once, so its comments and edits move
 * nobody. Three verbs point:
 *
 *  - `point_at` (`routes/workspace-point.ts`): any page of one board, a
 *    thread, or a place in a doc or mock, with nothing written.
 *  - a whiteboard `point` (`routes/whiteboard-routes.ts`), which also moves
 *    the canvas's own pointer.
 *  - the planning voice's cursor (`agentFocus`, `spoken-reply/interview-docs.ts`),
 *    the words it is asking about.
 *
 * Every other verb — a comment, find-and-replace, block edits, a drawing
 * without `point` — goes through none of this.
 *
 * The record is kept here, per board, and published as the server's own
 * awareness state on the board doc (`ws:<id>`) under `AGENT_SPOTS_FIELD`,
 * one entry per agent, so every page holding the room hears a move at once.
 * A point is never a reason to load a board: one that is not resident is
 * published to when its room next opens (`restore`), so a follower who
 * arrives after the agent pointed still finds it.
 */
import {
  AGENT_SPOTS_FIELD,
  type AgentSpot,
  type PresenceSpot,
} from '@claude-workspaces/core/workspace-presence';
import type * as awarenessProtocol from 'y-protocols/awareness';

export interface AgentSpotsDeps {
  /** The boards a doc is filed on. */
  boardsForDoc: (docId: string) => Iterable<string>;
  /** The board doc's awareness, if the board doc is resident; never hydrates. */
  boardAwareness: (workspaceId: string) => awarenessProtocol.Awareness | null;
  /** Whether the agent holds its event stream on the board right now. */
  listening: (workspaceId: string, agentId: string) => boolean;
}

export interface AgentSpots {
  /**
   * Point `agentId` at a spot on `docId`, on every board that holds it.
   * `held`: the pointer is the server's own (the planning voice), present
   * while its spot is set rather than while an event stream is open.
   */
  point(
    docId: string,
    agentId: string,
    spot: (PresenceSpot & { name: string }) | null,
    opts?: { held?: boolean },
  ): void;
  /** Point `agentId` at a spot on one board: a board page, or a doc filed
   *  on it. */
  pointOn(workspaceId: string, agentId: string, spot: PresenceSpot & { name: string }): void;
  /** A board's room opened: publish what its agents last pointed at. */
  restore(workspaceId: string, awareness: awarenessProtocol.Awareness): void;
  /** An agent's stream opened or closed on a board: its spot shows or goes. */
  streamsChanged(workspaceId: string): void;
}

export function createAgentSpots(deps: AgentSpotsDeps): AgentSpots {
  // One entry per agent per board. Bounded by the agents that have pointed
  // on a board since boot, which is the roster, not the traffic.
  const latest = new Map<string, Map<string, AgentSpot>>();
  // Pointers the server holds itself, per board; cleared with their spot.
  const held = new Set<string>();
  const heldKey = (workspaceId: string, agentId: string) => `${workspaceId}\n${agentId}`;
  // Only an agent holding its stream is drawn, the board strip's own rule:
  // a spot left by a session that exited is a mark for somebody absent.
  const publish = (workspaceId: string, awareness: awarenessProtocol.Awareness): void => {
    const spots = latest.get(workspaceId);
    if (!spots) return;
    const present = [...spots].filter(
      ([agentId]) =>
        held.has(heldKey(workspaceId, agentId)) || deps.listening(workspaceId, agentId),
    );
    awareness.setLocalStateField(AGENT_SPOTS_FIELD, Object.fromEntries(present));
  };
  const pointOn = (
    workspaceId: string,
    agentId: string,
    spot: (PresenceSpot & { name: string }) | null,
    opts?: { held?: boolean },
  ): void => {
    const spots = latest.get(workspaceId) ?? new Map<string, AgentSpot>();
    const prev = spots.get(agentId)?.seq ?? 0;
    if (spot) spots.set(agentId, { ...spot, seq: prev + 1 });
    else spots.delete(agentId);
    if (opts?.held && spot) held.add(heldKey(workspaceId, agentId));
    else if (opts?.held) held.delete(heldKey(workspaceId, agentId));
    latest.set(workspaceId, spots);
    const awareness = deps.boardAwareness(workspaceId);
    if (awareness) publish(workspaceId, awareness);
  };
  const point: AgentSpots['point'] = (docId, agentId, spot, opts) => {
    for (const workspaceId of deps.boardsForDoc(docId)) pointOn(workspaceId, agentId, spot, opts);
  };
  return {
    point,
    pointOn: (workspaceId, agentId, spot) => pointOn(workspaceId, agentId, spot),
    streamsChanged(workspaceId) {
      const awareness = latest.has(workspaceId) ? deps.boardAwareness(workspaceId) : null;
      if (awareness) publish(workspaceId, awareness);
    },
    restore(workspaceId, awareness) {
      // A room already carrying the field was published to as it moved.
      if (awareness.getLocalState()?.[AGENT_SPOTS_FIELD] === undefined) {
        publish(workspaceId, awareness);
      }
    },
  };
}
