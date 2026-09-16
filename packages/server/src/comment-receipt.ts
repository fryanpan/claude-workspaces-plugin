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

/** The frame a page needs to turn one tick into two without a reload. */
export interface DeliveredFrame {
  event: 'comment.delivered';
  docId: string;
  threadId: string;
  commentId: string;
  deliveredAt: number;
  [k: string]: unknown;
}

/** Where a delivery is written down, and who is told about it. */
export interface ReceiptSink {
  /** Write-once: `already` for a comment that has a stamp, `gone` for one
   *  whose doc or thread is no longer resident. */
  markDelivered(
    docId: string,
    threadId: string,
    commentId: string,
    at: number,
  ): 'stamped' | 'already' | 'gone';
  /** One channel's worth of "this landed", for pages only. */
  announce(channel: string, frame: DeliveredFrame): void;
}

/**
 * Stamp a comment delivered and tell every channel it travelled on.
 *
 * Two callers, and they are not variations on one path: a comment handed
 * straight to a session that was already listening, and one handed over on the
 * heartbeat that follows a session attaching LATE. The second is the common
 * case — a person comments on a board nobody is watching and an agent picks
 * the work up minutes later — so a receipt that only the first path could set
 * would leave the second tick permanently missing from ordinary use.
 *
 * ALL the channels are announced on, from the one stamp. The write is
 * write-once, so a per-channel stamp-then-announce tells only whichever
 * channel happened to be asked first and leaves every other open page on one
 * tick until it reloads.
 */
export function recordDelivery(
  args: {
    docId: string;
    threadId: string;
    commentId: string;
    channels: readonly string[];
    at: number;
  },
  sink: ReceiptSink,
): boolean {
  if (sink.markDelivered(args.docId, args.threadId, args.commentId, args.at) !== 'stamped') {
    return false;
  }
  const frame: DeliveredFrame = {
    event: 'comment.delivered',
    docId: args.docId,
    threadId: args.threadId,
    commentId: args.commentId,
    deliveredAt: args.at,
  };
  for (const channel of new Set(args.channels)) sink.announce(channel, frame);
  return true;
}

/**
 * The comment id inside a queue row's replayed payload.
 *
 * The row records the doc and the thread but not the comment — it is a
 * delivery record, and the words live in the ydoc. The payload it replays is
 * the original broadcast, so the comment is read back out of it with the same
 * rule the live path uses. `unknown` in, because a row read off disk is
 * whatever the file said.
 */
export function commentIdOfReplay(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const shaped = payload as { event?: unknown; comment?: unknown; thread?: unknown };
  if (typeof shaped.event !== 'string') return undefined;
  const comment = commentOfEvent<{ id?: unknown }>({
    event: shaped.event,
    ...(shaped.comment !== undefined ? { comment: shaped.comment as { id?: unknown } } : {}),
    ...(typeof shaped.thread === 'object' && shaped.thread !== null
      ? { thread: shaped.thread as { comments?: Array<{ id?: unknown }> } }
      : {}),
  });
  return typeof comment?.id === 'string' ? comment.id : undefined;
}
