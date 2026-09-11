/**
 * Frames onto live response streams, handed to the sockets ONE STREAM PER
 * EVENT-LOOP TURN.
 *
 * WHY. Under Bun 1.3.10 on macOS, only the first socket written in a turn of
 * the event loop is sent promptly. A chunk enqueued onto any other stream in
 * that same turn sits for about 100ms — and while such writes keep coming,
 * longer: steady writes every 30ms were measured arriving in batches of
 * eight, the first held 230ms. Two ordinary shapes hit it every time:
 *
 *  - a write made inside a request handler, because the handler's own
 *    response is the turn's first socket. A comment POST broadcasting to its
 *    subscribers is exactly this, so every one of them waited.
 *  - one broadcast reaching two streams, even from a timer: the first stream
 *    got the frame in under a millisecond and the second 105ms later.
 *
 * The same writes spread across successive `setImmediate` turns, one stream
 * each, all arrived in under a millisecond. A Python loopback pair on the same
 * machine delivers in 0.2ms, so the hold is in the server, not in TCP. Linux
 * does not hold, which is why CI never saw it and this machine — where prod
 * runs — always did.
 *
 * So a write here only queues, and a pump hands one stream's queued text to
 * its socket per turn, as a single chunk. Order within a stream is untouched:
 * its queue is FIFO and every write to it goes through the queue, so a
 * replayed tail and the live feed still meet exactly where they met before.
 * Only the moment the bytes leave moves — by one turn per stream ahead of it.
 */

export interface SseStreamWriter {
  /** Queue one complete frame (or comment line). Throws once the writer is
   *  closed — the same answer a closed controller's `enqueue` gave, which is
   *  what lets the bus count a write to a dead stream as not delivered. */
  write(text: string): void;
  /** Hand over what is queued, then close the stream. Frames written before
   *  the close are delivered, exactly as they were when writes were
   *  synchronous. */
  close(): void;
  /** The reader went away: drop what is queued and refuse further writes. */
  cancel(): void;
}

/** A stream with text waiting, and how to hand it over. */
interface Waiting {
  /** Whether a socket write happened — a stream closed or cancelled since it
   *  queued hands nothing over, and must not spend the turn. */
  flush(): boolean;
}

/** Streams with text waiting, oldest first. Each appears at most once. */
const waiting: Waiting[] = [];
let pumping = false;

/** One stream per turn, then yield: the next turn's write is the first again. */
function pump(): void {
  for (let w = waiting.shift(); w; w = waiting.shift()) {
    if (w.flush()) break;
  }
  if (waiting.length > 0) setImmediate(pump);
  else pumping = false;
}

function schedule(w: Waiting): void {
  waiting.push(w);
  if (pumping) return;
  pumping = true;
  setImmediate(pump);
}

export function createSseStreamWriter(
  controller: ReadableStreamDefaultController<Uint8Array>,
): SseStreamWriter {
  const encoder = new TextEncoder();
  let pending: string[] = [];
  let queued = false;
  let closed = false;

  const self: Waiting = {
    flush() {
      queued = false;
      if (pending.length === 0) return false;
      const text = pending.join('');
      pending = [];
      try {
        controller.enqueue(encoder.encode(text));
        return true;
      } catch {
        // The stream ended between the write and this turn. Nothing to hand
        // over to; the bus removes the sink on the same cancel.
        closed = true;
        return false;
      }
    },
  };

  return {
    write(text) {
      if (closed) throw new TypeError('SSE stream is closed');
      pending.push(text);
      if (queued) return;
      queued = true;
      schedule(self);
    },
    close() {
      if (closed) return;
      // Still in `waiting` if it was queued; the pump finds nothing to send.
      self.flush();
      closed = true;
      try {
        controller.close();
      } catch {
        // Already closed or errored — the caller's bookkeeping runs either way.
      }
    },
    cancel() {
      closed = true;
      pending = [];
    },
  };
}
