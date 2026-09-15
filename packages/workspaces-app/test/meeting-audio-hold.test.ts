/**
 * The bounded hold that carries a few seconds of speech across a reconnect.
 *
 * The drop it replaces is deliberate and stays: a minute of banked speech
 * pushed into a freshly opened engine session, billed by the second it is
 * open and arriving out of time with the words around it, is worse than a
 * hole. What was wrong was that the bound was ZERO, so a three-second blip
 * cost three seconds of conversation. This is the bound, and both sides of
 * it — inside the cap nothing is lost, past it the excess goes.
 */
import { describe, expect, it } from 'vitest';
import { AUDIO_HOLD_MS, createAudioHold } from '../src/meeting-reconnect.ts';

/** A frame, identified by its first byte so a test can name it. */
const frame = (n: number): Int16Array => Int16Array.of(n);
const bytes = (frames: readonly ArrayBufferView[]): number[] =>
  frames.map((f) => (f as Int16Array)[0] as number);

describe('the audio a reconnect carries across', () => {
  it('gives back everything banked inside the cap, oldest first', () => {
    const hold = createAudioHold();
    hold.push(frame(1), 1_000);
    hold.push(frame(2), 1_050);
    hold.push(frame(3), 1_100);
    const taken = hold.take(1_150);
    expect(bytes(taken.frames)).toEqual([1, 2, 3]);
    // From the oldest frame still held to the moment it is taken: the stretch
    // of the outage the server must NOT record as lost.
    expect(taken.heldMs).toBe(150);
  });

  it('drops the excess of an outage longer than the cap', () => {
    const hold = createAudioHold();
    // One frame right at the start of a long outage, then one inside the cap.
    hold.push(frame(1), 0);
    hold.push(frame(2), AUDIO_HOLD_MS + 500);
    hold.push(frame(3), AUDIO_HOLD_MS + 1_000);
    const taken = hold.take(AUDIO_HOLD_MS + 1_000);
    expect(bytes(taken.frames)).toEqual([2, 3]);
    expect(taken.heldMs).toBe(500);
  });

  it('is empty after it is taken, so one outage is replayed once', () => {
    const hold = createAudioHold();
    hold.push(frame(1), 0);
    expect(bytes(hold.take(10).frames)).toEqual([1]);
    expect(hold.take(20)).toEqual({ frames: [], heldMs: 0 });
  });

  it('holds nothing at all once cleared', () => {
    const hold = createAudioHold();
    hold.push(frame(1), 0);
    hold.clear();
    expect(hold.take(10)).toEqual({ frames: [], heldMs: 0 });
  });

  it('caps what it can ever carry, however long the outage runs', () => {
    // The memory bound, which is the other half of "bounded": a two-minute
    // reconnect window must not grow this without limit.
    const hold = createAudioHold();
    for (let at = 0; at <= 120_000; at += 50) hold.push(frame(at % 30_000), at);
    const taken = hold.take(120_000);
    expect(taken.heldMs).toBeLessThanOrEqual(AUDIO_HOLD_MS);
    expect(taken.frames.length).toBeLessThanOrEqual(AUDIO_HOLD_MS / 50 + 1);
  });
});
