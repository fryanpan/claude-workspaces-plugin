import { describe, expect, it, vi } from 'vitest';
import {
  MUTE_LOST_MS,
  type TrackLossReason,
  type WatchableTrack,
  watchTracks,
} from '../src/meeting-track-watch.ts';

/**
 * The detector that was missing entirely. Every case here is driven through a
 * track the way a browser drives one — an event, or a state that changed with
 * no event at all — and asserts what the capture is told.
 */

/** A track whose state and events a test can move, as a browser would. */
function track(): WatchableTrack & {
  end(fire?: boolean): void;
  setMuted(muted: boolean, fire?: boolean): void;
  listeners(): number;
} {
  const listeners = new Map<string, Array<() => void>>();
  const self = {
    readyState: 'live' as MediaStreamTrackState,
    muted: false,
    addEventListener(type: string, fn: () => void) {
      listeners.set(type, [...(listeners.get(type) ?? []), fn]);
    },
    removeEventListener(type: string, fn: () => void) {
      listeners.set(
        type,
        (listeners.get(type) ?? []).filter((l) => l !== fn),
      );
    },
    /** `fire: false` is the end that dispatches nothing — `track.stop()`. */
    end(fire = true) {
      self.readyState = 'ended';
      if (fire) for (const fn of listeners.get('ended') ?? []) fn();
    },
    setMuted(muted: boolean, fire = true) {
      self.muted = muted;
      if (fire) for (const fn of listeners.get(muted ? 'mute' : 'unmute') ?? []) fn();
    },
    listeners: () => [...listeners.values()].reduce((n, l) => n + l.length, 0),
  };
  return self;
}

function watch(tracks: WatchableTrack[], clock = { ms: 0 }) {
  const losses: TrackLossReason[] = [];
  const w = watchTracks({ tracks, onLost: (r) => losses.push(r), now: () => clock.ms });
  return { w, losses, clock };
}

describe('a track that ends under a running capture', () => {
  it('reports the loss the moment the browser fires ended', () => {
    const t = track();
    const { losses } = watch([t]);
    expect(losses).toEqual([]);
    t.end();
    expect(losses).toEqual(['ended']);
  });

  it('reports an end that fired no event, off the audio graph’s own clock', () => {
    // `track.stop()` ends a track SILENTLY per spec, and a browser can drop
    // the event for its own reasons. The pump is still delivering silence, so
    // the block handler is the second way to find out.
    const t = track();
    const { w, losses } = watch([t]);
    t.end(false);
    expect(losses).toEqual([]);
    w.tick();
    expect(losses).toEqual(['ended']);
  });

  it('reports a track that was already dead when the watch went on', () => {
    const t = track();
    t.end(false);
    const { losses } = watch([t]);
    expect(losses).toEqual(['ended']);
  });

  it('reports once, however many times it is told', () => {
    const t = track();
    const { w, losses } = watch([t]);
    t.end();
    t.end();
    w.tick();
    w.tick();
    expect(losses).toEqual(['ended']);
    expect(w.lost()).toBe(true);
  });

  it('is silent for a capture whose tracks are all alive', () => {
    const { w, losses } = watch([track(), track()]);
    for (let i = 0; i < 50; i++) w.tick();
    expect(losses).toEqual([]);
    expect(w.lost()).toBe(false);
  });

  it('reports when ANY of a capture’s tracks dies', () => {
    const alive = track();
    const dying = track();
    const { losses } = watch([alive, dying]);
    dying.end();
    expect(losses).toEqual(['ended']);
  });
});

describe('a track that goes quiet without ending', () => {
  it('is not reported until the mute has outlived the window', () => {
    const t = track();
    const clock = { ms: 1_000 };
    const { w, losses } = watch([t], clock);
    t.setMuted(true);
    expect(losses).toEqual([]);
    clock.ms += MUTE_LOST_MS - 1;
    w.tick();
    expect(losses).toEqual([]);
    clock.ms += 1;
    w.tick();
    expect(losses).toEqual(['muted']);
  });

  it('says nothing at all about a mute that ended inside the window', () => {
    const t = track();
    const clock = { ms: 0 };
    const { w, losses } = watch([t], clock);
    t.setMuted(true);
    clock.ms += MUTE_LOST_MS - 1;
    w.tick();
    t.setMuted(false);
    // And the NEXT mute gets the whole window again rather than inheriting
    // the first one's head start.
    clock.ms += MUTE_LOST_MS;
    w.tick();
    expect(losses).toEqual([]);
    t.setMuted(true);
    clock.ms += MUTE_LOST_MS - 1;
    w.tick();
    expect(losses).toEqual([]);
  });

  it('prefers ended over muted when a track manages both', () => {
    const t = track();
    const clock = { ms: 0 };
    const { w, losses } = watch([t], clock);
    t.setMuted(true, false);
    t.end(false);
    clock.ms += MUTE_LOST_MS;
    w.tick();
    expect(losses).toEqual(['ended']);
  });
});

describe('taking the watch off', () => {
  it('removes every listener it installed and reports nothing after', () => {
    const t = track();
    const { w, losses } = watch([t]);
    expect(t.listeners()).toBeGreaterThan(0);
    w.stop();
    expect(t.listeners()).toBe(0);
    t.end(false);
    w.tick();
    expect(losses).toEqual([]);
  });

  it('never calls back after stop even if an event is already in flight', () => {
    const t = track();
    const onLost = vi.fn();
    const w = watchTracks({ tracks: [t], onLost });
    w.stop();
    t.end();
    expect(onLost).not.toHaveBeenCalled();
  });
});
