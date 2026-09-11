/**
 * Is an attached agent actually LISTENING — the second half of "present".
 *
 * Attachment and listening are different facts and the board used to show only
 * the first. An `AgentAttachment` record is written when a session calls
 * `attach_agent` and it outlives the session: the row, its heartbeat and its
 * last tool call all persist across a `/clear`, a crash, a token switch and a
 * plain exit. So "attached" answers *did a session ever sit down here*, and a
 * reader who wants to know whether anybody is there gets a yes from a session
 * that left hours ago.
 *
 * What makes an agent reachable is a socket, not a record. The agent's MCP
 * child opens one SSE stream on `ws~<workspaceId>` for the life of the session
 * and puts its own `agentId` on it (`SseBus.add`); every frame the server can
 * push to that session — a doc-comment event a `watch_doc` subscription
 * forwards, a queued comment, a ready-work nudge, a stall wake, an addressed
 * `sendToAgent` — rides it. Lose the stream and every one of those lands
 * nowhere, whatever the watch store still remembers. That is why the stream,
 * and not the watch set, is what "listening" resolves to here: a registered
 * watch with no stream delivers nothing, and a stream with no watches still
 * takes board events and wakes.
 *
 * A browser tab sets no `agentId` on its stream, so a tab can never make an
 * absent agent look present — the same property that lets `agentsOn` widen a
 * delivery decision where a bare subscriber count may only narrow one
 * (`task-agents.ts`, `AgentStreamProbe`).
 *
 * This module is deliberately pure: it takes the set of listening ids as data
 * rather than reaching for an `SseBus`, so the stamping and the frame can be
 * driven directly by a unit test and so no route has to know how the bus
 * spells a channel.
 */

/** The frame pushed when an agent's stream opens or closes. Transient — the
 *  answer is a fact about right now, so a page that reconnects asks again
 *  rather than being told what was true before it left. */
export const AGENT_LISTENING_EVENT = 'agent.listening';

/** What the roster adds to every attachment row. Always explicit, never
 *  omitted-when-false: silence is what an older server sends, and a reader
 *  that cannot tell silence from "no" would draw a circle for an absent
 *  session — the one thing this field exists to prevent. */
export interface ListeningFlag {
  /** The agent's own event stream is open on this board right now. */
  listening: boolean;
}

/**
 * Stamp each attachment row with whether that agent is holding a stream.
 *
 * Generic over the row so the two roster projections — the owner's
 * `DescribedAttachment` and a share visitor's redacted `PublicAttachment` —
 * both pass through without either being widened. Nothing is dropped here:
 * the roster is the full list of sessions that have sat at this board, and
 * which of them to DRAW is the surface's decision, not the wire's.
 */
export function stampListening<T extends { agentId: string }>(
  rows: readonly T[],
  listening: ReadonlySet<string>,
): Array<T & ListeningFlag> {
  return rows.map((row) => ({ ...row, listening: listening.has(row.agentId) }));
}

export interface AgentListeningFrame extends ListeningFlag {
  event: typeof AGENT_LISTENING_EVENT;
  workspaceId: string;
  agentId: string;
}

/**
 * The push that makes a presence circle disappear without a reload.
 *
 * An agent's stream opening or closing is the one liveness change that emits
 * no store event — nothing is written, so no `agent.*` frame goes out and the
 * board's roster read is never triggered. Without this frame the strip would
 * keep drawing a departed session until the next unrelated refresh.
 *
 * It carries the answer rather than only the news, so a reader that only
 * wants the one agent's state need not re-fetch; the board re-reads the
 * roster anyway, because a departure usually arrives alongside other changes.
 */
export function agentListeningFrame(
  workspaceId: string,
  agentId: string,
  listening: boolean,
): AgentListeningFrame {
  return { event: AGENT_LISTENING_EVENT, workspaceId, agentId, listening };
}
