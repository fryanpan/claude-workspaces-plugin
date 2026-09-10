import { describe, expect, it, vi } from 'vitest';
import { type AudioPump, startMeetingCapture } from '../src/meeting-audio.ts';
import { openCaptureSet } from '../src/meeting-capture-set.ts';
import type { TrackLossReason } from '../src/meeting-track-watch.ts';
import type { OriginFacts } from '../src/voice-capture.ts';

/**
 * What the recorder does when a capture dies under it, end to end through the
 * real capture and the real set — the bug being fixed, and the recovery.
 *
 * The measured behaviour before this existed: the track ended, `readyState`
 * went to `ended`, the pump kept delivering, frames kept leaving the device,
 * and nothing anywhere was told. Every case here drives that same sequence.
 */

const SECURE: OriginFacts = {
  isSecureContext: true,
  protocol: 'https:',
  hostname: 'example.test',
  port: '',
  pathname: '/review/d1',
  search: '',
};

function fakeTrack() {
  const listeners = new Map<string, Array<() => void>>();
  const self = {
    kind: 'audio' as const,
    readyState: 'live' as MediaStreamTrackState,
    muted: false,
    stop: vi.fn(() => {
      self.readyState = 'ended';
    }),
    applyConstraints: vi.fn(() => Promise.resolve()),
    addEventListener: (t: string, fn: () => void) =>
      listeners.set(t, [...(listeners.get(t) ?? []), fn]),
    removeEventListener: (t: string, fn: () => void) =>
      listeners.set(
        t,
        (listeners.get(t) ?? []).filter((l) => l !== fn),
      ),
    /** What macOS taking the capture away looks like to the page. */
    endFromOutside() {
      self.readyState = 'ended';
      for (const fn of listeners.get('ended') ?? []) fn();
    },
  };
  return self;
}

function streamOf(t: ReturnType<typeof fakeTrack>): MediaStream {
  return {
    getTracks: () => [t],
    getAudioTracks: () => [t],
    getVideoTracks: () => [],
    removeTrack: () => {},
  } as unknown as MediaStream;
}

/** A capture whose device and graph a test can reach and replace. */
function rig() {
  const tracks: Array<ReturnType<typeof fakeTrack>> = [];
  const pumps: AudioPump[] = [];
  const frames: number[] = [];
  const losses: TrackLossReason[] = [];
  const opens: number[] = [];
  let refuseNext: string | null = null;
  const deps = {
    readOrigin: () => SECURE,
    getMedia: () => {
      opens.push(Date.now());
      if (refuseNext) {
        const err = Object.assign(new Error(refuseNext), { name: 'NotAllowedError' });
        refuseNext = null;
        return Promise.reject(err);
      }
      const t = fakeTrack();
      tracks.push(t);
      return Promise.resolve(streamOf(t));
    },
    createPump: async (): Promise<AudioPump> => {
      const pump: AudioPump = { sampleRate: 16_000, onBlock: null, stop: vi.fn() };
      pumps.push(pump);
      return pump;
    },
  };
  return {
    tracks,
    pumps,
    frames,
    losses,
    deps,
    opens,
    refuse: (message: string) => {
      refuseNext = message;
    },
    /** One block of real audio through whichever graph is current. */
    speak: () => (pumps[pumps.length - 1] as AudioPump).onBlock?.(new Float32Array(1600).fill(0.5)),
  };
}

describe('a capture whose track dies mid-meeting', () => {
  it('reports the loss instead of streaming silence in silence', async () => {
    const r = rig();
    const started = await startMeetingCapture({
      onFrame: (pcm) => r.frames.push(pcm.length),
      onLost: (reason) => r.losses.push(reason),
      deps: r.deps,
    });
    if (!started.ok) throw new Error(started.message);

    r.speak();
    expect(r.frames.length).toBeGreaterThan(0);
    expect(r.losses).toEqual([]);

    // The failure the ticket describes: the browser ends the track and the
    // graph carries on delivering.
    (r.tracks[0] as ReturnType<typeof fakeTrack>).endFromOutside();
    expect(r.losses).toEqual(['ended']);
  });

  it('finds an end that fired no event on the next block of audio', async () => {
    const r = rig();
    const started = await startMeetingCapture({
      onFrame: () => {},
      onLost: (reason) => r.losses.push(reason),
      deps: r.deps,
    });
    if (!started.ok) throw new Error(started.message);
    // No event — just a track that is no longer live.
    (r.tracks[0] as ReturnType<typeof fakeTrack>).readyState = 'ended';
    expect(r.losses).toEqual([]);
    r.speak();
    expect(r.losses).toEqual(['ended']);
  });
});

describe('getting a dead capture back', () => {
  it('opens the source again and streams from the new graph', async () => {
    const r = rig();
    const started = await startMeetingCapture({
      onFrame: (pcm) => r.frames.push(pcm.length),
      onLost: (reason) => r.losses.push(reason),
      deps: r.deps,
    });
    if (!started.ok) throw new Error(started.message);
    (r.tracks[0] as ReturnType<typeof fakeTrack>).endFromOutside();
    r.frames.length = 0;

    const again = await started.capture.reopen();
    expect(again.ok).toBe(true);
    expect(r.tracks).toHaveLength(2);
    // The OLD graph is down and the old device released, so nothing is left
    // holding the recording indicator for a track nobody reads.
    expect(r.pumps[0]?.stop).toHaveBeenCalled();
    expect((r.tracks[0] as ReturnType<typeof fakeTrack>).stop).toHaveBeenCalled();

    r.speak();
    expect(r.frames.length).toBeGreaterThan(0);
  });

  it('reports a loss again when the replacement dies too', async () => {
    const r = rig();
    const started = await startMeetingCapture({
      onFrame: () => {},
      onLost: (reason) => r.losses.push(reason),
      deps: r.deps,
    });
    if (!started.ok) throw new Error(started.message);
    (r.tracks[0] as ReturnType<typeof fakeTrack>).endFromOutside();
    await started.capture.reopen();
    (r.tracks[1] as ReturnType<typeof fakeTrack>).endFromOutside();
    expect(r.losses).toEqual(['ended', 'ended']);
  });

  it('keeps the capture it has when the reopen is refused', async () => {
    const r = rig();
    const started = await startMeetingCapture({
      onFrame: (pcm) => r.frames.push(pcm.length),
      onLost: () => {},
      deps: r.deps,
    });
    if (!started.ok) throw new Error(started.message);
    r.refuse('no');
    const again = await started.capture.reopen();
    expect(again.ok).toBe(false);
    // The graph that was running is still running: a refused replacement must
    // never cost the audio that was still arriving.
    expect(r.pumps).toHaveLength(1);
    expect(r.pumps[0]?.stop).not.toHaveBeenCalled();
    r.frames.length = 0;
    r.speak();
    expect(r.frames.length).toBeGreaterThan(0);
  });

  it('refuses to reopen a capture the meeting already stopped', async () => {
    const r = rig();
    const started = await startMeetingCapture({ onFrame: () => {}, deps: r.deps });
    if (!started.ok) throw new Error(started.message);
    started.capture.stop();
    const again = await started.capture.reopen();
    expect(again.ok).toBe(false);
    expect(r.tracks).toHaveLength(1);
  });
});

describe('a two-stream meeting losing one of its captures', () => {
  it('names which stream died and leaves the other one running', async () => {
    const seen: Array<{ stream: string; reason: string }> = [];
    const lostHandlers = new Map<string, (r: TrackLossReason) => void>();
    const stopped: string[] = [];
    const reopened: string[] = [];
    const set = await openCaptureSet({
      source: 'mic+system',
      mode: 'conversation',
      onFrame: () => {},
      onStreamLost: (stream, reason) => seen.push({ stream, reason }),
      startCapture: (o) => {
        if (o.onLost && o.source) lostHandlers.set(o.source, o.onLost);
        return Promise.resolve({
          ok: true as const,
          capture: {
            stop: () => stopped.push(o.source ?? '?'),
            setEchoCancellation: () => Promise.resolve(),
            reopen: () => {
              reopened.push(o.source ?? '?');
              return Promise.resolve({ ok: true as const });
            },
          },
        });
      },
    });
    if (!set.ok) throw new Error('the set did not open');

    // The share dies; the microphone does not.
    lostHandlers.get('system')?.('ended');
    expect(seen).toEqual([{ stream: 'system', reason: 'ended' }]);
    expect(stopped).toEqual([]);

    await set.reopen('system');
    expect(reopened).toEqual(['system']);
  });

  it('refuses to reopen a stream this recording never opened', async () => {
    const set = await openCaptureSet({
      source: 'mic',
      mode: 'solo',
      onFrame: () => {},
      startCapture: () =>
        Promise.resolve({
          ok: true as const,
          capture: {
            stop: () => {},
            setEchoCancellation: () => Promise.resolve(),
            reopen: () => Promise.resolve({ ok: true as const }),
          },
        }),
    });
    if (!set.ok) throw new Error('the set did not open');
    const answer = await set.reopen('system');
    expect(answer.ok).toBe(false);
  });
});
