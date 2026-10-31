/**
 * Where each agent is pointing, in the workspace's presence room.
 *
 * An agent's presence is the spot it chose to point at by a verb, never its
 * last edit (Bryan, 15 Oct; `@claude-workspaces/core/workspace-presence`).
 * Two verbs point today:
 *
 *  - a comment — `create_thread` / `post_reply`, any door that ends in a
 *    `thread.created` or `thread.replied` an agent wrote. A comment is how an
 *    agent says "this", so it is where the agent is.
 *  - a whiteboard `point` (`routes/whiteboard-routes.ts`), which also moves
 *    the canvas's own pointer.
 *  - the planning voice's cursor (`agentFocus`, `spoken-reply/interview-docs.ts`),
 *    the words it is asking about.
 *
 * Every edit verb — find-and-replace, block edits, a drawing without `point`
 * — goes through none of this, which is what "its edits elsewhere draw
 * nothing" means in code.
 *
 * The record is kept here, per board, and published as the server's own
 * awareness state on the board doc (`ws:<id>`) under `AGENT_SPOTS_FIELD`,
 * one entry per agent, so every page holding the room hears a move at once.
 * A point is never a reason to load a board: one that is not resident is
 * published to when its room next opens (`restore`), so a follower who
 * arrives after the agent pointed still finds it.
 */
import type { WebhookPayload } from '@claude-workspaces/core';
import {
  AGENT_SPOTS_FIELD,
  type AgentSpot,
  type PresenceSpot,
} from '@claude-workspaces/core/workspace-presence';
import type * as awarenessProtocol from 'y-protocols/awareness';

/** What an agent is, for this module: the one shape that fails closed. */
export function isAgentAuthorId(id: unknown): id is string {
  return typeof id === 'string' && (id.startsWith('agent-') || id === 'known-agent');
}

/** The spot a thread event points at, when an agent wrote its comment. */
export function spotFromThreadEvent(
  payload: WebhookPayload,
  surfaceOf: (docId: string) => PresenceSpot['surface'],
): { agentId: string; spot: PresenceSpot & { name: string } } | null {
  const p = payload as {
    event?: string;
    docId?: string;
    threadId?: string;
    comment?: { author?: { id?: unknown; name?: unknown } };
    thread?: { comments?: Array<{ author?: { id?: unknown; name?: unknown } }> };
  };
  if (p.event !== 'thread.created' && p.event !== 'thread.replied') return null;
  // A created frame carries no `comment`: the opener is the thread's first.
  const author = p.comment?.author ?? p.thread?.comments?.[0]?.author;
  if (!p.docId || !p.threadId || !isAgentAuthorId(author?.id)) return null;
  const name = typeof author?.name === 'string' && author.name ? author.name : author.id;
  return {
    agentId: author.id,
    spot: { surface: surfaceOf(p.docId), docId: p.docId, threadId: p.threadId, name },
  };
}

export interface AgentSpotsDeps {
  /** The boards a doc is filed on. */
  boardsForDoc: (docId: string) => Iterable<string>;
  /** The board doc's awareness, if the board doc is resident; never hydrates. */
  boardAwareness: (workspaceId: string) => awarenessProtocol.Awareness | null;
  /** What kind of page a doc opens as. */
  surfaceOf: (docId: string) => PresenceSpot['surface'];
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
  /** The doc-event hook: an agent's comment is a point. */
  onDocEvent(docId: string, payload: WebhookPayload): void;
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
  const point: AgentSpots['point'] = (docId, agentId, spot, opts) => {
    for (const workspaceId of deps.boardsForDoc(docId)) {
      const spots = latest.get(workspaceId) ?? new Map<string, AgentSpot>();
      const prev = spots.get(agentId)?.seq ?? 0;
      if (spot) spots.set(agentId, { ...spot, seq: prev + 1 });
      else spots.delete(agentId);
      if (opts?.held && spot) held.add(heldKey(workspaceId, agentId));
      else if (opts?.held) held.delete(heldKey(workspaceId, agentId));
      latest.set(workspaceId, spots);
      const awareness = deps.boardAwareness(workspaceId);
      if (awareness) publish(workspaceId, awareness);
    }
  };
  return {
    point,
    onDocEvent(docId, payload) {
      const hit = spotFromThreadEvent(payload, deps.surfaceOf);
      if (hit) point(docId, hit.agentId, hit.spot);
    },
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
