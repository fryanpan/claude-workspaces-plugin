import { type SseStreamWriter, createSseStreamWriter } from '../sse-writer.ts';
/**
 * The coach's own event stream, `GET /coach/stream`: the moment, to every
 * page the owner has open, and its clearing once he answers it in any of them.
 *
 * Its own stream rather than a board channel because a board channel
 * reaches every member of that board, and a moment is his alone. It carries
 * nothing else, so a page holding it learns only what the coach says.
 *
 * A page that connects while a moment is open gets it at once. Writes go
 * through `createSseStreamWriter`, like every other stream here, for the
 * macOS hold that file explains.
 */
import { SSE_KEEPALIVE_MS } from '../sse.ts';
import type { CoachFrame } from './moment.ts';

/** One person's tabs; past this the oldest is closed. */
export const MAX_COACH_STREAMS = 24;

const frameText = (f: CoachFrame) => `event: coach\ndata: ${JSON.stringify(f)}\n\n`;

export class CoachHub {
  private readonly sinks = new Set<SseStreamWriter>();

  constructor(private readonly keepaliveMs: number = SSE_KEEPALIVE_MS) {}

  get size(): number {
    return this.sinks.size;
  }

  open(initial: CoachFrame | null): Response {
    let writer: SseStreamWriter | null = null;
    let keepalive: ReturnType<typeof setInterval> | null = null;
    const sinks = this.sinks;
    const drop = () => {
      if (keepalive) clearInterval(keepalive);
      if (writer) sinks.delete(writer);
    };
    const stream = new ReadableStream<Uint8Array>({
      start: (c) => {
        const w = createSseStreamWriter(c);
        writer = w;
        if (sinks.size >= MAX_COACH_STREAMS) {
          const oldest = sinks.values().next().value;
          if (oldest) {
            sinks.delete(oldest);
            oldest.close();
          }
        }
        sinks.add(w);
        w.write(':ok\n\n');
        if (initial) w.write(frameText(initial));
        keepalive = setInterval(() => {
          try {
            w.write(':ka\n\n');
          } catch {
            drop();
          }
        }, this.keepaliveMs);
        keepalive.unref?.();
      },
      cancel: () => {
        writer?.cancel();
        drop();
      },
    });
    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      },
    });
  }

  publish(frame: CoachFrame): void {
    const text = frameText(frame);
    for (const w of [...this.sinks]) {
      try {
        w.write(text);
      } catch {
        this.sinks.delete(w);
      }
    }
  }

  close(): void {
    for (const w of this.sinks) w.close();
    this.sinks.clear();
  }
}
