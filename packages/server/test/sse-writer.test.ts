/**
 * The writer's contract, against a stand-in controller: what reaches the
 * stream, in what order, and on which turn.
 *
 * The turn is the behaviour here, not an implementation detail. The hold this
 * module exists for (sse-writer.ts) is "a second socket written in the same
 * turn waits ~100ms", so the property that removes it is "no two streams are
 * handed over in the same turn" — and that is observable deterministically by
 * stepping the event loop one `setImmediate` at a time, with no clock.
 */
import { describe, expect, it } from 'bun:test';
import { createSseStreamWriter } from '../src/sse-writer.ts';

/** A controller that records what was handed to it. */
function fakeController(opts: { throwOnEnqueue?: boolean } = {}) {
  const chunks: string[] = [];
  let closed = false;
  const decoder = new TextDecoder();
  const controller = {
    enqueue(chunk: Uint8Array) {
      if (opts.throwOnEnqueue) throw new TypeError('stream is closed');
      chunks.push(decoder.decode(chunk));
    },
    close() {
      closed = true;
    },
  } as unknown as ReadableStreamDefaultController<Uint8Array>;
  return { controller, chunks, isClosed: () => closed };
}

/** Let exactly one more turn of the event loop run. A `setImmediate` queued
 *  from inside a `setImmediate` callback runs on the NEXT turn, so each await
 *  of this advances the writer's pump by one step. */
const nextTurn = () => new Promise<void>((r) => setImmediate(r));

describe('the SSE stream writer', () => {
  it('hands a turn’s writes to the stream later, as one chunk, in order', async () => {
    const a = fakeController();
    const w = createSseStreamWriter(a.controller);
    w.write('event: one\n\n');
    w.write('event: two\n\n');
    // Nothing in the writer's own turn: that turn may belong to another
    // request's handler, which is exactly where the hold happens.
    expect(a.chunks).toEqual([]);
    await nextTurn();
    expect(a.chunks).toEqual(['event: one\n\nevent: two\n\n']);
  });

  it('hands over one stream per turn, so no stream is the second socket of a turn', async () => {
    const a = fakeController();
    const b = fakeController();
    const c = fakeController();
    const wa = createSseStreamWriter(a.controller);
    const wb = createSseStreamWriter(b.controller);
    const wc = createSseStreamWriter(c.controller);
    // One broadcast, three subscribers — the shape that measured A prompt and
    // B and C at ~105ms when all three were enqueued in the same turn.
    wa.write('x');
    wb.write('x');
    wc.write('x');

    await nextTurn();
    expect([a.chunks.length, b.chunks.length, c.chunks.length]).toEqual([1, 0, 0]);
    await nextTurn();
    expect([a.chunks.length, b.chunks.length, c.chunks.length]).toEqual([1, 1, 0]);
    await nextTurn();
    expect([a.chunks.length, b.chunks.length, c.chunks.length]).toEqual([1, 1, 1]);
  });

  it('keeps a stream’s frames in the order they were written across turns', async () => {
    const a = fakeController();
    const b = fakeController();
    const wa = createSseStreamWriter(a.controller);
    const wb = createSseStreamWriter(b.controller);
    wa.write('1');
    wb.write('1');
    await nextTurn(); // a handed over; b still queued
    wa.write('2'); // a rejoins the queue BEHIND b
    await nextTurn();
    expect(b.chunks).toEqual(['1']);
    expect(a.chunks).toEqual(['1']);
    await nextTurn();
    expect(a.chunks).toEqual(['1', '2']);
  });

  it('delivers what was queued before a close, then closes', () => {
    const a = fakeController();
    const w = createSseStreamWriter(a.controller);
    w.write('last words');
    w.close();
    expect(a.chunks).toEqual(['last words']);
    expect(a.isClosed()).toBe(true);
    // A closed stream refuses, synchronously — the bus counts on the throw to
    // tell a dead subscriber from a delivered one.
    expect(() => w.write('too late')).toThrow();
  });

  it('drops what was queued when the reader goes away, and refuses more', async () => {
    const a = fakeController();
    const w = createSseStreamWriter(a.controller);
    w.write('never read');
    w.cancel();
    expect(() => w.write('after')).toThrow();
    await nextTurn();
    expect(a.chunks).toEqual([]);
  });

  it('keeps serving other streams when one has already ended underneath it', async () => {
    const dead = fakeController({ throwOnEnqueue: true });
    const live = fakeController();
    const wDead = createSseStreamWriter(dead.controller);
    const wLive = createSseStreamWriter(live.controller);
    wDead.write('x');
    wLive.write('y');
    await nextTurn();
    await nextTurn();
    expect(live.chunks).toEqual(['y']);
    // …and the dead one now says so to its next writer.
    expect(() => wDead.write('again')).toThrow();
  });
});
