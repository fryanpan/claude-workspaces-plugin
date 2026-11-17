import { type SseStreamWriter, createSseStreamWriter } from '../sse-writer.ts';
/**
 * The coach's own event stream, `GET /coach/stream`: the moment, to every
 * page the owner has open, and its clearing once he answers it in any of them.
 *
 * Its own stream rather than a board channel because a board channel
 * reaches every member of that board, and a moment is his alone. It carries
 * nothing else, so a page holding it learns only what the coach says.
 *
 * A page that connects while a moment is open gets it at once, wherever it
 * is, and one that connects with none open is told so, so a card it drew
 * before he answered elsewhere goes. A moment follows him to every page until
 * he answers it in any one. Each page says where it is when it connects
 * (`?workspaceId=&docId=`; the review walk names nowhere), and the moment a
 * page on a board the coach is excluded from is sent says `off`, so the card
 * there says the coach is not listening rather than offering to stop it.
 * Showing the card there sends nothing about the board to the session. When a
 * board becomes off or on again, `reshow` tells each page anew.
 *
 * Writes go through `createSseStreamWriter`, like every other stream here,
 * for the macOS hold that file explains.
 */
import { SSE_KEEPALIVE_MS } from '../sse.ts';
import type { CoachFrame } from './moment.ts';

/** One person's tabs; past this the oldest is closed. */
export const MAX_COACH_STREAMS = 24;

const frameText = (f: CoachFrame) => `event: coach\ndata: ${JSON.stringify(f)}\n\n`;

/** Where a page is: a board, a doc on one, or null for the review walk. */
export type CoachPagePlace = { workspaceId: string; docId?: string } | null;

export interface CoachHubOptions {
  keepaliveMs?: number;
  /** True when the coach is excluded from this place (`coach/exclusion.ts`):
   *  a page there shows the moment marked `off`. */
  offAt?: (place: { workspaceId: string; docId?: string }) => boolean;
}

export class CoachHub {
  /** Each open page, and where it is. */
  private readonly sinks = new Map<SseStreamWriter, CoachPagePlace>();
  private readonly keepaliveMs: number;
  private readonly offAt: (place: { workspaceId: string; docId?: string }) => boolean;

  constructor(opts: CoachHubOptions = {}) {
    this.keepaliveMs = opts.keepaliveMs ?? SSE_KEEPALIVE_MS;
    this.offAt = opts.offAt ?? (() => false);
  }

  /** What a page at `place` is sent for `frame`: a moment says `off` where
   *  the coach is excluded. A check that throws counts as excluded. */
  private frameAt(frame: CoachFrame, place: CoachPagePlace): CoachFrame {
    if (frame.type !== 'moment' || place === null) return frame;
    let off: boolean;
    try {
      off = this.offAt(place);
    } catch {
      off = true;
    }
    return off ? { ...frame, off: true } : frame;
  }

  get size(): number {
    return this.sinks.size;
  }

  open(initial: CoachFrame | null, place: CoachPagePlace = null): Response {
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
          const oldest = sinks.keys().next().value;
          if (oldest) {
            sinks.delete(oldest);
            oldest.close();
          }
        }
        sinks.set(w, place);
        w.write(':ok\n\n');
        w.write(frameText(initial ? this.frameAt(initial, place) : { type: 'idle' }));
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

  /** A new moment, or its clearing, to every open page. */
  publish(frame: CoachFrame): void {
    this.send((place) => this.frameAt(frame, place));
  }

  /** The open moment, told to every page again, each with whether the coach
   *  hears from it now. */
  reshow(frame: CoachFrame | null): void {
    if (frame) this.send((place) => this.frameAt(frame, place));
  }

  private send(frameFor: (place: CoachPagePlace) => CoachFrame): void {
    for (const [w, place] of [...this.sinks]) {
      const f = frameFor(place);
      try {
        w.write(frameText(f));
      } catch {
        this.sinks.delete(w);
      }
    }
  }

  close(): void {
    for (const w of this.sinks.keys()) w.close();
    this.sinks.clear();
  }
}
