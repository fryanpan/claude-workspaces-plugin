/**
 * One hosted agent's pushes: numbered, held for a while, and written to one
 * stream at a time.
 *
 * WHY A HOLD AT ALL. A push can arrive while the agent has no stream open —
 * the moments after a server restart, before Claude Code's GET reconnects,
 * are exactly when the backlog of a restart lands. A push written to nothing
 * is a push lost, which is what the stdio connector measurably did across a
 * restart (a comment posted 0.1s after boot never arrived, 2 runs of 2). So
 * every push is appended here first and delivered from here.
 *
 * WHICH STREAM. Only one. Two connections with the same agent and working
 * directory are the same agent — a respawn overlapping its predecessor, or
 * Claude Code opening a second session while it re-initializes — and a push
 * written to both is a push the agent reads twice. The host names the target
 * (`targetOrder`): the session initialized most recently, even in the moment
 * between its initialize and its GET, when a push waits here for it rather
 * than going to the stream that is still open. Not the oldest: during a
 * respawn the old process is still connected for a moment and is about to be
 * gone, and a push handed to it then is lost with it. And not the stream that
 * connected most recently: an old session whose stream blips and reconnects
 * must not take pushes back from the session that replaced it.
 *
 * NOTHING DOUBLED, NOTHING DROPPED. Every frame carries `id: <epoch>-<seq>`.
 * A stream that attaches with a `Last-Event-ID` from this epoch gets what
 * followed it; one from another epoch — a client that was connected to the
 * previous server process — gets everything this process has held, because
 * none of it can have reached that client; one with no id gets what no stream
 * has been handed yet. A frame that aged out while a client was away is not
 * silently skipped: the stream gets a `replay.gap` line telling the agent to
 * refetch, the same line the event bus has always sent.
 */

/** A live GET stream, as the outbox sees it. */
export interface OutboxStream {
  /** When its session was initialized. Larger is newer. */
  readonly order: number;
  /** Queue one complete SSE frame. Throws once the stream is gone. */
  write(text: string): void;
}

export interface OutboxOptions {
  /** Distinguishes this server process's ids from the previous one's. */
  epoch: string;
  /** How long a frame waits for a stream. */
  maxAgeMs: number;
  /** How many frames wait at most. */
  maxFrames: number;
  /** The reconnect delay the client is told to use, in ms. */
  retryMs: number;
  now: () => number;
  /** The order of the session pushes belong to now, or null to hold them. */
  targetOrder: () => number | null;
  /** Builds the notice written when frames aged out before a stream came back. */
  gapNotice: () => unknown;
}

export interface Outbox {
  /** Number and hold one JSON-RPC message, and write it to the target stream
   *  if there is one. Returns the frame id. */
  push(message: unknown): string;
  /** Add a stream and bring it up to date. Returns the function that removes it. */
  attach(stream: OutboxStream, lastEventId: string | null): () => void;
  /** Write what is held and undelivered to the target, if it has a stream. */
  flush(): void;
  /** Frames held right now. */
  size(): number;
  /** Whether any stream is attached. */
  hasStream(): boolean;
}

interface Held {
  seq: number;
  at: number;
  text: string;
}

export function sseFrame(id: string | null, message: unknown): string {
  const idLine = id === null ? '' : `id: ${id}\n`;
  return `${idLine}event: message\ndata: ${JSON.stringify(message)}\n\n`;
}

export function createOutbox(opts: OutboxOptions): Outbox {
  const held: Held[] = [];
  const streams: OutboxStream[] = [];
  let seq = 0;
  /** The highest seq handed to any stream. */
  let delivered = 0;
  /** The highest seq ever pruned, so a stream asking from before it knows. */
  let pruned = 0;

  const idOf = (n: number) => `${opts.epoch}-${n}`;

  const prune = (): void => {
    const cutoff = opts.now() - opts.maxAgeMs;
    while (held.length > 0) {
      const first = held[0] as Held;
      if (held.length <= opts.maxFrames && first.at >= cutoff) break;
      pruned = first.seq;
      held.shift();
    }
  };

  /** The target session's live stream, or undefined while it has none. */
  const target = (): OutboxStream | undefined => {
    const order = opts.targetOrder();
    return order === null ? undefined : streams.find((s) => s.order === order);
  };

  /** Write to a stream, dropping it if it has gone. */
  const writeTo = (stream: OutboxStream, text: string): boolean => {
    try {
      stream.write(text);
      return true;
    } catch {
      const i = streams.indexOf(stream);
      if (i >= 0) streams.splice(i, 1);
      return false;
    }
  };

  /** Where a stream presenting `lastEventId` should resume from. */
  const resumeFrom = (lastEventId: string | null): number => {
    if (lastEventId === null || lastEventId === '') return delivered;
    const dash = lastEventId.lastIndexOf('-');
    const epoch = dash > 0 ? lastEventId.slice(0, dash) : '';
    const n = Number(lastEventId.slice(dash + 1));
    if (epoch !== opts.epoch || !Number.isInteger(n) || n < 0) return 0;
    return Math.min(n, seq);
  };

  const flush = (): void => {
    const t = target();
    if (!t) return;
    prune();
    if (delivered < pruned) {
      if (!writeTo(t, sseFrame(null, opts.gapNotice()))) return;
      delivered = pruned;
    }
    for (const h of held) {
      if (h.seq <= delivered) continue;
      if (!writeTo(t, h.text)) return;
      delivered = h.seq;
    }
  };

  return {
    push(message) {
      prune();
      seq += 1;
      held.push({ seq, at: opts.now(), text: sseFrame(idOf(seq), message) });
      flush();
      return idOf(seq);
    },

    attach(stream, lastEventId) {
      streams.push(stream);
      const detach = () => {
        const i = streams.indexOf(stream);
        if (i >= 0) streams.splice(i, 1);
      };
      // Only the target is brought up to date. An older session reconnecting
      // while a newer one is live gets nothing, so a push is never read twice
      // — only the reconnect delay, so it does not redial fast while it waits
      // to be retired.
      if (target() !== stream) {
        writeTo(stream, `retry: ${opts.retryMs}\n\n`);
        return detach;
      }
      prune();
      const from = resumeFrom(lastEventId);
      // The reconnect delay and a resumable id first, so a stream that dies
      // mid-replay still reconnects slowly enough to outlast a restart and
      // from a position that is true.
      if (!writeTo(stream, `retry: ${opts.retryMs}\nid: ${idOf(from)}\ndata: \n\n`)) return detach;
      if (from < pruned) {
        if (!writeTo(stream, sseFrame(null, opts.gapNotice()))) return detach;
      }
      for (const h of held) {
        if (h.seq <= from) continue;
        if (!writeTo(stream, h.text)) return detach;
      }
      delivered = seq;
      return detach;
    },

    flush,
    size: () => held.length,
    hasStream: () => streams.length > 0,
  };
}
