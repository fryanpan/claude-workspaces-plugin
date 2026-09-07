import { describe, expect, it, vi } from 'vitest';
import { startMeetingCapture } from '../src/meeting-audio.ts';
import {
  type MediaDeviceSeam,
  SYSTEM_AUDIO_NOT_SHARED,
  SYSTEM_AUDIO_REQUEST,
  SYSTEM_AUDIO_UNSUPPORTED,
  openMeetingSource,
  systemAudioOffered,
} from '../src/meeting-source.ts';
import type { OriginFacts } from '../src/voice-capture.ts';

/**
 * "This Mac's audio" is Chrome's share picker with the audio box ticked. The
 * picker cannot be driven here, so what is asserted is everything around it:
 * that the option is offered only where a picker exists, that the screen the
 * picker insists on is dropped at once, that a picker closed without audio
 * says so in the strip's words, and that the microphone path is untouched.
 */

const SECURE: OriginFacts = {
  isSecureContext: true,
  protocol: 'https:',
  hostname: 'example.test',
  port: '',
  pathname: '/review/d1',
  search: '',
};

function track(kind: 'audio' | 'video') {
  return { kind, stop: vi.fn(), applyConstraints: vi.fn(() => Promise.resolve()) };
}

function shared(kinds: Array<'audio' | 'video'>): MediaStream {
  const tracks = kinds.map(track);
  return {
    getTracks: () => tracks,
    getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'),
    getVideoTracks: () => tracks.filter((t) => t.kind === 'video'),
    removeTrack: (t: unknown) => {
      const i = tracks.indexOf(t as ReturnType<typeof track>);
      if (i >= 0) tracks.splice(i, 1);
    },
  } as unknown as MediaStream;
}

describe('whether the chooser offers the Mac’s audio', () => {
  it('only where the browser has a share picker', () => {
    expect(systemAudioOffered({ getDisplayMedia: () => Promise.reject() })).toBe(true);
    expect(systemAudioOffered({ getUserMedia: () => Promise.reject() })).toBe(false);
    expect(systemAudioOffered(undefined)).toBe(false);
  });
});

describe('opening the Mac’s audio', () => {
  it('asks the picker for system audio, keeps the sound and drops the screen', async () => {
    const stream = shared(['video', 'audio']);
    const video = stream.getVideoTracks()[0] as unknown as ReturnType<typeof track>;
    const getDisplayMedia = vi.fn(() => Promise.resolve(stream));
    const getUserMedia = vi.fn();
    const out = await openMeetingSource(
      'system',
      { audio: true },
      { getDisplayMedia, getUserMedia },
    );
    expect(getDisplayMedia).toHaveBeenCalledWith(SYSTEM_AUDIO_REQUEST);
    expect(SYSTEM_AUDIO_REQUEST).toMatchObject({ systemAudio: 'include', video: true });
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(video.stop).toHaveBeenCalled();
    expect(out.getVideoTracks()).toHaveLength(0);
    expect(out.getAudioTracks()).toHaveLength(1);
  });

  it('says so, in the strip’s words, when the picker closed without audio', async () => {
    const stream = shared(['video']);
    const video = stream.getVideoTracks()[0] as unknown as ReturnType<typeof track>;
    await expect(
      openMeetingSource(
        'system',
        { audio: true },
        { getDisplayMedia: () => Promise.resolve(stream) },
      ),
    ).rejects.toThrow(SYSTEM_AUDIO_NOT_SHARED);
    // The screen it did share is not kept as a consolation.
    expect(video.stop).toHaveBeenCalled();
  });

  it('says so when the browser has no picker, without touching the microphone', async () => {
    const getUserMedia = vi.fn();
    await expect(openMeetingSource('system', { audio: true }, { getUserMedia })).rejects.toThrow(
      SYSTEM_AUDIO_UNSUPPORTED,
    );
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it('is the microphone, exactly as before, for the mic source', async () => {
    const stream = shared(['audio']);
    const getUserMedia = vi.fn(() => Promise.resolve(stream));
    const getDisplayMedia = vi.fn();
    const constraints = { audio: { channelCount: 1 } };
    const out = await openMeetingSource('mic', constraints, { getUserMedia, getDisplayMedia });
    expect(out).toBe(stream);
    expect(getUserMedia).toHaveBeenCalledWith(constraints);
    expect(getDisplayMedia).not.toHaveBeenCalled();
  });
});

describe('a capture from the Mac’s audio', () => {
  const pump = () => Promise.resolve({ sampleRate: 48_000, onBlock: null, stop: vi.fn() });

  it('streams frames the same way the microphone does', async () => {
    const devices: MediaDeviceSeam = {
      getDisplayMedia: () => Promise.resolve(shared(['video', 'audio'])),
      getUserMedia: vi.fn(),
    };
    const started = await startMeetingCapture({
      onFrame: () => {},
      source: 'system',
      deps: { readOrigin: () => SECURE, devices, createPump: pump },
    });
    expect(started.ok).toBe(true);
    expect(devices.getUserMedia).not.toHaveBeenCalled();
  });

  it('reports the refusal in its own words rather than as a microphone error', async () => {
    const started = await startMeetingCapture({
      onFrame: () => {},
      source: 'system',
      deps: { readOrigin: () => SECURE, devices: {}, createPump: pump },
    });
    expect(started).toEqual({ ok: false, kind: 'denied', message: SYSTEM_AUDIO_UNSUPPORTED });
  });

  it('leaves a microphone capture on the getMedia seam every existing caller uses', async () => {
    const getMedia = vi.fn(() => Promise.resolve(shared(['audio'])));
    const started = await startMeetingCapture({
      onFrame: () => {},
      deps: { readOrigin: () => SECURE, getMedia, devices: {}, createPump: pump },
    });
    expect(started.ok).toBe(true);
    expect(getMedia).toHaveBeenCalledTimes(1);
  });
});
