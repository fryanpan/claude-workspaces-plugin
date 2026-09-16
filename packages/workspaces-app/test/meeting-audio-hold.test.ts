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
import { AUDIO_HOLD_FRAMES, AUDIO_HOLD_MS, createAudioHold } from '../src/meeting-reconnect.ts';

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
    const read = hold.peek(1_150);
    expect(bytes(read.frames)).toEqual([1, 2, 3]);
    // From the oldest frame still held to the moment it is read: the stretch
    // of the outage the server must NOT record as lost.
    expect(read.heldMs).toBe(150);
  });

  it('drops the excess of an outage longer than the cap', () => {
    const hold = createAudioHold();
    // One frame right at the start of a long outage, then one inside the cap.
    hold.push(frame(1), 0);
    hold.push(frame(2), AUDIO_HOLD_MS + 500);
    hold.push(frame(3), AUDIO_HOLD_MS + 1_000);
    const read = hold.peek(AUDIO_HOLD_MS + 1_000);
    expect(bytes(read.frames)).toEqual([2, 3]);
    expect(read.heldMs).toBe(500);
  });

  it('still holds what it handed back, so a failed handshake can say it again', () => {
    // READING IS NOT TAKING, and that is the point. The replay goes out on
    // the new socket's `open`, which can still die before the server answers
    // — a refused resume retried, or another drop. The retry after that has
    // to be able to replay the same frames, so only a confirmed `ready`
    // (`clear`) empties the hold.
    const hold = createAudioHold();
    hold.push(frame(1), 0);
    expect(bytes(hold.peek(10).frames)).toEqual([1]);
    expect(bytes(hold.peek(20).frames)).toEqual([1]);
  });

  it('holds nothing at all once cleared', () => {
    const hold = createAudioHold();
    hold.push(frame(1), 0);
    hold.clear();
    expect(hold.peek(10)).toEqual({ frames: [], heldMs: 0 });
  });

  it('carries no more frames than the far end can buffer, whatever filled it', () => {
    // THE CAP IS SHARED, and a two-stream meeting is what proves it has to
    // be. `meeting-capture-set.ts` forwards the microphone and the Mac's own
    // audio through the same `onFrame`, so a mic+system meeting banks TWO
    // frames every 50 ms and eight seconds of it is ~320 — past the 256 the
    // server's pre-handshake buffer holds. What that buffer drops when it
    // overflows is the NEWEST frames, which is the seam this hold exists to
    // keep, and the start frame would still have claimed the whole span, so
    // the server would have shortened the gap over audio nobody received.
    const hold = createAudioHold();
    let n = 0;
    for (let at = 0; at < AUDIO_HOLD_MS; at += 50) {
      hold.push(frame(n++), at); // the microphone
      hold.push(frame(n++), at); // the Mac's own audio
    }
    const read = hold.peek(AUDIO_HOLD_MS);
    expect(read.frames.length).toBe(AUDIO_HOLD_FRAMES);
    // The newest survive: what a room wants back is the sentence it was in
    // the middle of, so the oldest go and the seam stays.
    expect(bytes(read.frames).at(-1)).toBe(n - 1);
    expect(bytes(read.frames)[0]).toBe(n - AUDIO_HOLD_FRAMES);
    // And `heldMs` describes what is still HELD rather than the cap or the
    // outage, so the gap the server writes is shortened by exactly the audio
    // it is about to receive — honest by construction, on either bound.
    expect(read.heldMs).toBe((AUDIO_HOLD_FRAMES / 2) * 50);
  });

  it('caps what it can ever carry, however long the outage runs', () => {
    // The memory bound, which is the other half of "bounded": a two-minute
    // reconnect window must not grow this without limit.
    const hold = createAudioHold();
    for (let at = 0; at <= 120_000; at += 50) hold.push(frame(at % 30_000), at);
    const read = hold.peek(120_000);
    expect(read.heldMs).toBeLessThanOrEqual(AUDIO_HOLD_MS);
    expect(read.frames.length).toBeLessThanOrEqual(AUDIO_HOLD_MS / 50 + 1);
  });
});
