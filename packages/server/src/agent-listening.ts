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
 * WHERE THE ANSWER IS PUT ON A ROW is not here. The roster derives it inside
 * `listAttachments` / `listPublicAttachments` (`task-agents.ts`), so a share
 * visitor's copy still passes through the `PublicAttachment` allowlist, which
 * is only a gate while nothing is added to a row downstream of it. This
 * module owns the event and the frame: the push that tells an open board the
 * answer changed, which no store write would otherwise announce.
 */

/** The frame pushed when an agent's stream opens or closes. Transient — the
 *  answer is a fact about right now, so a page that reconnects asks again
 *  rather than being told what was true before it left. */
export const AGENT_LISTENING_EVENT = 'agent.listening';

export interface AgentListeningFrame {
  event: typeof AGENT_LISTENING_EVENT;
  workspaceId: string;
  agentId: string;
  /** Whether that agent's own event stream is open, as of this frame. */
  listening: boolean;
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
