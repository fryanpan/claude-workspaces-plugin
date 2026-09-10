import { COMBINED_SOURCE, untagAudioFrame } from '@claude-workspaces/core';
import { describe, expect, it, vi } from 'vitest';
import type { MeetingCaptureStart } from '../src/meeting-audio.ts';
import { combinedMicRoom, openCaptureSet, partialCaptureNote } from '../src/meeting-capture-set.ts';

/**
 * Two doors, either of which can be shut. These drive `openCaptureSet` with a
 * stubbed single-stream opener, because everything this module decides is
 * about the SET — which doors are knocked on and in what order, what the
 * meeting reports running on when one of them is shut, and whether the frames
 * that leave carry a stream byte.
 */

type Started = Parameters<Parameters<typeof openCaptureSet>[0]['startCapture'] & object>[0];

function fakeCapture() {
  return {
    stop: vi.fn(),
    setEchoCancellation: vi.fn(() => Promise.resolve()),
    reopen: vi.fn(() => Promise.resolve({ ok: true as const })),
  };
}

/** An opener that grants everything except the streams named. */
function opener(refuse: string[] = []) {
  const calls: Started[] = [];
  const frames: Array<(pcm: Int16Array) => void> = [];
  const captures: Array<ReturnType<typeof fakeCapture>> = [];
  const startCapture = (o: Started): Promise<MeetingCaptureStart> => {
    calls.push(o);
    if (refuse.includes(o.source ?? 'mic')) {
      return Promise.resolve({
        ok: false as const,
        kind: 'denied' as const,
        message: `no ${o.source}.`,
      });
    }
    frames.push(o.onFrame);
    const capture = fakeCapture();
    captures.push(capture);
    return Promise.resolve({ ok: true as const, capture });
  };
  return { calls, frames, captures, startCapture };
}

const sink = () => {
  const seen: Array<Uint8Array | Int16Array> = [];
  return { seen, onFrame: (pcm: Uint8Array | Int16Array) => seen.push(pcm) };
};

describe('opening both streams', () => {
  it('asks for the microphone before the share picker', async () => {
    const o = opener();
    await openCaptureSet({
      source: COMBINED_SOURCE,
      mode: 'conversation',
      onFrame: () => {},
      startCapture: o.startCapture,
    });
    expect(o.calls.map((c) => c.source)).toEqual(['mic', 'system']);
  });

  it('opens one stream, and asks the picker for nothing, on a microphone meeting', async () => {
    const o = opener();
    const set = await openCaptureSet({
      source: 'mic',
      mode: 'conversation',
      onFrame: () => {},
      startCapture: o.startCapture,
    });
    expect(o.calls.map((c) => c.source)).toEqual(['mic']);
    expect(set.ok && set.source).toBe('mic');
    expect(set.ok && set.tagged).toBe(false);
  });

  it('reports the combined source when both streams opened', async () => {
    const o = opener();
    const set = await openCaptureSet({
      source: COMBINED_SOURCE,
      mode: 'conversation',
      onFrame: () => {},
      startCapture: o.startCapture,
    });
    expect(set.ok && set.source).toBe(COMBINED_SOURCE);
    expect(set.ok && set.refusals).toHaveLength(0);
  });
});

describe('echo cancellation on the microphone', () => {
  it('forces it on for a combined capture', async () => {
    const o = opener();
    await openCaptureSet({
      source: COMBINED_SOURCE,
      mode: 'conversation',
      onFrame: () => {},
      startCapture: o.startCapture,
    });
    expect(o.calls[0]?.room?.echoCancellation).toBe(true);
  });

  it('overrules an address that asked for it off, because this room has a far end in it', async () => {
    const o = opener();
    await openCaptureSet({
      source: COMBINED_SOURCE,
      mode: 'conversation',
      room: { echoCancellation: false, noiseSuppression: false, autoGainControl: true },
      onFrame: () => {},
      startCapture: o.startCapture,
    });
    expect(o.calls[0]?.room?.echoCancellation).toBe(true);
    expect(o.calls[0]?.room?.noiseSuppression).toBe(true);
    // Gain control is not this rule's business and keeps what was asked for.
    expect(o.calls[0]?.room?.autoGainControl).toBe(true);
  });

  it('leaves a microphone-only capture’s room settings exactly as asked', async () => {
    const o = opener();
    const room = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
    await openCaptureSet({
      source: 'mic',
      mode: 'conversation',
      room,
      onFrame: () => {},
      startCapture: o.startCapture,
    });
    expect(o.calls[0]?.room).toEqual(room);
  });

  it('does not force the Mac’s own audio through the microphone’s processors', async () => {
    const o = opener();
    await openCaptureSet({
      source: COMBINED_SOURCE,
      mode: 'conversation',
      onFrame: () => {},
      startCapture: o.startCapture,
    });
    // The share picker's track is a clean copy of what the Mac is playing;
    // cancelling an echo in it would be cancelling the remote side itself.
    expect(o.calls[1]?.room?.echoCancellation).toBeUndefined();
  });

  it('keeps gain control where the room put it', () => {
    expect(
      combinedMicRoom({ echoCancellation: false, noiseSuppression: false, autoGainControl: true }),
    ).toEqual({ echoCancellation: true, noiseSuppression: true, autoGainControl: true });
  });
});

describe('a stream that was refused', () => {
  it('runs on the microphone when the picker was closed, and says so', async () => {
    const o = opener(['system']);
    const set = await openCaptureSet({
      source: COMBINED_SOURCE,
      mode: 'conversation',
      onFrame: () => {},
      startCapture: o.startCapture,
    });
    expect(set.ok).toBe(true);
    // The record must name what is RUNNING, not what was asked for.
    expect(set.ok && set.source).toBe('mic');
    expect(set.ok && set.refusals.map((r) => r.stream)).toEqual(['system']);
  });

  it('runs on the Mac’s audio when the microphone was refused', async () => {
    const o = opener(['mic']);
    const set = await openCaptureSet({
      source: COMBINED_SOURCE,
      mode: 'conversation',
      onFrame: () => {},
      startCapture: o.startCapture,
    });
    expect(set.ok && set.source).toBe('system');
  });

  it('is a refusal only when nothing at all opened, and carries both reasons', async () => {
    const o = opener(['mic', 'system']);
    const set = await openCaptureSet({
      source: COMBINED_SOURCE,
      mode: 'conversation',
      onFrame: () => {},
      startCapture: o.startCapture,
    });
    expect(set.ok).toBe(false);
    expect(set.ok === false && set.message).toContain('no mic.');
    expect(set.ok === false && set.message).toContain('no system.');
  });

  it('names what is missing AND what is still running', () => {
    const note = partialCaptureNote(
      [{ stream: 'system', kind: 'denied', message: 'Chrome shared no sound.' }],
      ['mic'],
    );
    expect(note).toContain("this Mac's audio");
    expect(note).toContain('Chrome shared no sound.');
    expect(note).toContain('the microphone');
  });

  it('says nothing when everything asked for opened', () => {
    expect(partialCaptureNote([], ['mic', 'system'])).toBe('');
  });
});

describe('what leaves on the wire', () => {
  it('tags each frame with the stream it came from when two are running', async () => {
    const o = opener();
    const out = sink();
    await openCaptureSet({
      source: COMBINED_SOURCE,
      mode: 'conversation',
      onFrame: out.onFrame,
      startCapture: o.startCapture,
    });
    o.frames[0]?.(new Int16Array([1, 2]));
    o.frames[1]?.(new Int16Array([3, 4]));
    const split = out.seen.map((f) =>
      untagAudioFrame(new Uint8Array(f.buffer, f.byteOffset, f.byteLength)),
    );
    expect(split.map((s) => s?.stream)).toEqual(['mic', 'system']);
  });

  it('sends raw PCM with no tag when only one stream is running', async () => {
    const o = opener();
    const out = sink();
    await openCaptureSet({
      source: 'mic',
      mode: 'conversation',
      onFrame: out.onFrame,
      startCapture: o.startCapture,
    });
    const frame = new Int16Array([1, 2]);
    o.frames[0]?.(frame);
    // Byte-for-byte what a microphone meeting has always put on the socket,
    // which is what an older server reads.
    expect(out.seen[0]).toBe(frame);
  });

  it('stops every stream it opened', async () => {
    const o = opener();
    const set = await openCaptureSet({
      source: COMBINED_SOURCE,
      mode: 'conversation',
      onFrame: () => {},
      startCapture: o.startCapture,
    });
    if (!set.ok) throw new Error('expected the set to open');
    set.stopAll();
    expect(o.captures.map((c) => c.stop.mock.calls.length)).toEqual([1, 1]);
  });
});
