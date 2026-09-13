import type { AudioPump } from '@claude-workspaces/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { frameLevel, micRefusal, startPcmCapture } from '../src/voice/voice-audio.ts';

/**
 * The microphone as frames. There is no audio hardware here, so the media
 * stream and the audio graph are stand-ins and a test pushes blocks of
 * samples through the pump by hand.
 */

function fakeStream() {
  const track = {
    stopped: 0,
    stop() {
      track.stopped += 1;
    },
  };
  return { stream: { getTracks: () => [track] } as unknown as MediaStream, track };
}

function fakePump(sampleRate = 16_000) {
  const pump: AudioPump & { stops: number } = {
    sampleRate,
    onBlock: null,
    stops: 0,
    stop() {
      pump.stops += 1;
    },
  };
  return pump;
}

const secure = (value: boolean) =>
  Object.defineProperty(window, 'isSecureContext', { value, configurable: true });

beforeEach(() => secure(true));
afterEach(() => secure(false));

describe('frameLevel', () => {
  it('reads silence as zero and a loud frame as full', () => {
    expect(frameLevel(new Int16Array(800))).toBe(0);
    expect(frameLevel(new Int16Array(800).fill(32767))).toBe(1);
    const quiet = frameLevel(new Int16Array(800).fill(1000));
    expect(quiet).toBeGreaterThan(0);
    expect(quiet).toBeLessThan(1);
  });
});

describe('micRefusal', () => {
  it('tells a blocked microphone from a missing one', () => {
    expect(micRefusal({ name: 'NotAllowedError' })).toMatch(/blocked/);
    expect(micRefusal({ name: 'SecurityError' })).toMatch(/blocked/);
    expect(micRefusal({ name: 'NotFoundError' })).toBe('No microphone was found.');
    expect(micRefusal(null)).toBe('The microphone could not be opened.');
  });
});

describe('startPcmCapture', () => {
  it('refuses outside a secure page', async () => {
    secure(false);
    expect(await startPcmCapture({ onFrame: () => {} })).toEqual({
      ok: false,
      message: 'Voice feedback needs https or localhost.',
    });
  });

  it('turns blocks from the pump into whole frames, each with its level', async () => {
    const { stream, track } = fakeStream();
    const pump = fakePump();
    const frames: Int16Array[] = [];
    const levels: number[] = [];
    const started = await startPcmCapture({
      onFrame: (f) => frames.push(f),
      onLevel: (l) => levels.push(l),
      getMedia: async () => stream,
      createPump: async () => pump,
    });
    expect(started.ok).toBe(true);
    // Half a frame, then the rest and a quarter more: one whole frame out.
    pump.onBlock?.(new Float32Array(400).fill(0.5));
    expect(frames).toHaveLength(0);
    pump.onBlock?.(new Float32Array(600).fill(0.5));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toHaveLength(800);
    expect(levels).toHaveLength(1);

    if (started.ok) started.capture.stop();
    expect(pump.stops).toBe(1);
    expect(pump.onBlock, 'no frames after Stop').toBeNull();
    expect(track.stopped, 'the recording light goes out').toBe(1);
  });

  it('says why the microphone was refused', async () => {
    const started = await startPcmCapture({
      onFrame: () => {},
      getMedia: async () => {
        throw Object.assign(new Error('no'), { name: 'NotFoundError' });
      },
    });
    expect(started).toEqual({ ok: false, message: 'No microphone was found.' });
  });

  it('lets go of the microphone when the audio graph cannot be built', async () => {
    const { stream, track } = fakeStream();
    const started = await startPcmCapture({
      onFrame: () => {},
      getMedia: async () => stream,
      createPump: async () => {
        throw new Error('no worklet');
      },
    });
    expect(started.ok).toBe(false);
    expect(track.stopped).toBe(1);
  });
});
