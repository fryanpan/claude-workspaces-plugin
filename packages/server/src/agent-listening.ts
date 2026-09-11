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
 * WHEN THE ANSWER IS ANNOUNCED is here, and it is not "whenever a socket
 * moved". The first version broadcast on every stream open and every stream
 * close with no memory of what it had already said, and a transient on a
 * board channel wakes every agent session attached to it. A dropped
 * connection that recovers is two socket events and no news, so a peer
 * working two boards was paying a wake per board per blip for a roster that
 * never changed. `ListeningAnnouncer` below is what makes a non-event quiet.
 *
 * WHO THE ANSWER IS ANNOUNCED TO is the board's pages, and never an agent.
 * Quieting the non-events still left every real arrival and departure — and
 * a whole fleet reconnecting after a deploy — waking every other session on
 * the board for a circle it cannot act on. So the frame goes out with
 * `skipAgentStreams` (`SseBus.broadcastTransient`), which the `agentId` on
 * an agent's stream makes exact on both the per-key and the multiplexed
 * route (`sse-mux.ts` registers it on board channels).
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

/**
 * How long a departure is held before it is announced.
 *
 * A close followed by an open is a reconnect, not somebody leaving, and the
 * board should never learn about it. The MCP client's first retry is drawn
 * with full jitter from `[0, RECONNECT_BASE_MS)` — a 1.5s window — so a
 * window shorter than that would announce departures the client is already
 * on its way back from. This is twice the base, which covers the first
 * attempt whole and most of the second, and still puts a real departure on
 * the board inside the "few seconds" the strip promises.
 *
 * It is deliberately NOT the backoff cap. A session that has been gone for
 * thirty seconds HAS left, and the strip drawing it for half a minute would
 * be the very staleness the presence work was done to remove.
 */
export const LISTENING_DEPARTURE_GRACE_MS = 3_000;

/** The timer pair, injectable so a test drives the clock instead of waiting. */
export interface AnnouncerTimers {
  schedule(run: () => void, ms: number): unknown;
  cancel(handle: unknown): void;
}

/**
 * Announces a listening change once, and only when it is a change.
 *
 * Two rules, and the second is the one that matters:
 *
 *  - **Nothing is said twice.** An arrival for an agent already announced as
 *    listening emits nothing, so a duplicate socket event costs no wake.
 *  - **A departure waits.** It is held for `graceMs`, and the same agent
 *    coming back inside that window cancels it — so a reconnect emits
 *    NOTHING AT ALL, rather than a departure followed by an arrival. Holding
 *    the departure is what a plain state-comparison cannot do: false then
 *    true is two honest transitions, and announcing both is exactly the pair
 *    that was waking people.
 *
 * State is per process. A restart starts empty, so every agent's first event
 * after it is announced — which is right: a new process genuinely does not
 * know who is there, and neither does a board that reconnected to it.
 */
export class ListeningAnnouncer {
  private readonly announced = new Map<string, boolean>();
  private readonly pending = new Map<string, unknown>();

  constructor(
    private readonly emit: (frame: AgentListeningFrame) => void,
    private readonly graceMs: number = LISTENING_DEPARTURE_GRACE_MS,
    private readonly timers: AnnouncerTimers = {
      schedule: (run, ms) => setTimeout(run, ms),
      cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
  ) {}

  /** A stream for `agentId` opened or closed. Emits only if that is news. */
  observe(workspaceId: string, agentId: string, listening: boolean): void {
    const key = `${workspaceId}\u0000${agentId}`;
    this.clearPending(key);
    if (listening) {
      // A reconnect lands here with `announced` still true: the departure it
      // would have retracted was cancelled above, so there is nothing to say.
      if (this.announced.get(key) === true) return;
      this.announced.set(key, true);
      this.emit(agentListeningFrame(workspaceId, agentId, true));
      return;
    }
    // Never announce a departure for somebody the board was never told
    // about — and a key that is absent is exactly that somebody.
    if (this.announced.get(key) !== true) return;
    this.pending.set(
      key,
      this.timers.schedule(() => {
        this.pending.delete(key);
        // Deleted, not set to false: absence already MEANS not announced, so
        // a `false` entry is a second spelling of the same fact that nothing
        // ever removes. Keeping them would grow the map by one entry for
        // every agent-board pairing the process ever saw.
        this.announced.delete(key);
        this.emit(agentListeningFrame(workspaceId, agentId, false));
      }, this.graceMs),
    );
  }

  /** How many agent-board pairings this holds state for — so a test can
   *  assert the map is bounded by who is here rather than by who ever was. */
  trackedCount(): number {
    return this.announced.size + this.pending.size;
  }

  /** Drop every held departure — for shutdown, so no timer outlives the bus. */
  stop(): void {
    for (const key of [...this.pending.keys()]) this.clearPending(key);
  }

  private clearPending(key: string): void {
    const handle = this.pending.get(key);
    if (handle === undefined) return;
    this.timers.cancel(handle);
    this.pending.delete(key);
  }
}
