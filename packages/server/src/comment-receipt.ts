/**
 * Was this comment handed to a session that could act on it?
 *
 * The server half of the receipt the reader sees as a second tick. One
 * question, asked in one place, because the two surfaces that could answer it
 * disagree in exactly the way that matters: `agent-watches.json` says who has
 * SUBSCRIBED, which survives the session being gone, and a live SSE stream
 * says who is holding the wire open right now. Only the second is delivery.
 * The durable watch set is what the comment QUEUE is for — an unstamped
 * comment is re-offered on the next attach, and that redelivery stamps the
 * mark the same way a live one does.
 *
 * Kept out of `stall-wiring.ts` (which is already an exception row) because
 * it is a judgement with no wiring in it: everything it needs arrives as an
 * argument, so it can be driven directly by a test rather than through a
 * booted server and a real socket.
 */

/** What the decision needs to know about the live world. */
export interface DeliveryProbe {
  /** The agents holding a live stream on this channel right now. */
  agentsOn(channel: string): Iterable<string>;
  /**
   * Is this agent the one who wrote the comment? An agent is not owed a
   * receipt for its own words, and a session that watches the board it also
   * comments on would otherwise stamp every one of its own comments
   * delivered the instant it wrote them.
   */
  isAuthor(agentId: string): boolean;
}

/**
 * True when at least one agent other than the author is live on at least one
 * of the channels the comment went out on.
 *
 * Channels rather than one channel because a comment on a review doc is
 * broadcast on the doc's own stream AND on every board that holds it, and an
 * agent may be attached to either. Asking them all is the difference between
 * "a session has it" and "a session attached the way I happened to check".
 */
export function handedToAgent(channels: readonly string[], probe: DeliveryProbe): boolean {
  for (const channel of channels) {
    for (const agentId of probe.agentsOn(channel)) {
      if (!probe.isAuthor(agentId)) return true;
    }
  }
  return false;
}

/**
 * The comment a thread event is ABOUT, or undefined when it is not about one.
 *
 * Only `thread.created` and `thread.replied` carry a comment. A resolve, a
 * reopen or a suggestion verdict is a state change — nobody is waiting on a
 * receipt for it, and treating one as a comment would queue a row with no
 * words in it.
 *
 * `thread.replied` puts the comment on the payload; `thread.created` fires
 * with `comment: undefined` and the opening comment inside the thread (see
 * the `fireEvent` call sites in `doc-store.ts`), so the newest comment on the
 * thread is the fallback. Both readers of this rule — the delivery queue and
 * the receipt stamp — go through here so they cannot come to disagree about
 * which comment an event names.
 *
 * Generic in the comment so the caller keeps whatever shape its payload
 * declares: the server hands it a `WebhookPayload` and gets a `Comment`
 * back, with no widening and no cast at the call site.
 */
export function commentOfEvent<C>(payload: {
  event: string;
  comment?: C;
  thread?: { comments?: C[] };
}): C | undefined {
  if (payload.event !== 'thread.created' && payload.event !== 'thread.replied') return undefined;
  if (payload.comment !== undefined) return payload.comment;
  if (payload.event !== 'thread.created') return undefined;
  const comments = payload.thread?.comments;
  return comments?.[comments.length - 1];
}
