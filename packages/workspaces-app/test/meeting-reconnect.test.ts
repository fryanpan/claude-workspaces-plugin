import { MEETING_AUDIO_ENCODING, parseMeetingClientMessage } from '@claude-workspaces/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MeetingCaptureStart } from '../src/meeting-audio.ts';
import {
  RECONNECTING_NOTE,
  RECONNECT_DELAYS_MS,
  RESUME_FAILED_NOTE,
  createReconnectPlan,
} from '../src/meeting-reconnect.ts';
import {
  type MeetingSocket,
  type MeetingStripHandle,
  mountMeetingStrip,
} from '../src/meeting-strip.ts';

/**
 * A meeting whose socket dropped is not a meeting that ended.
 *
 * Two halves, tested apart because they fail apart: the policy — how long to
 * wait and when to stop waiting — and the strip's use of it, where the thing
 * that matters is that the MICROPHONE stays open and the same meeting id goes
 * back up the new socket. The state a bug here leaves behind is a recording
 * light over a dead connection, so every assertion below is about what the
 * person can see or what the server is actually sent.
 */

describe('the reconnect policy', () => {
  it('backs off, then holds at the cap', () => {
    const plan = createReconnectPlan({ now: () => 0 });
    const waits = [1, 2, 3, 4, 5, 6, 7].map(() => {
      const step = plan.dropped();
      return step.kind === 'retry' ? step.delayMs : -1;
    });
    // Doubling, then the last gap repeats: a server that is down is not
    // hammered, and one that comes back is found within a cap rather than a
    // minute later.
    expect(waits).toEqual([1_000, 2_000, 4_000, 8_000, 15_000, 15_000, 15_000]);
    expect(RECONNECT_DELAYS_MS[RECONNECT_DELAYS_MS.length - 1]).toBe(15_000);
  });

  it('counts the window from the FIRST drop, not the last attempt', () => {
    const clock = { at: 0 };
    const plan = createReconnectPlan({ now: () => clock.at, windowMs: 10_000 });
    expect(plan.dropped().kind).toBe('retry');
    clock.at = 9_999;
    expect(plan.dropped().kind).toBe('retry');
    clock.at = 10_000;
    // A window that restarted with every failure would never end.
    expect(plan.dropped().kind).toBe('give-up');
  });

  it('gives the whole window back once a connection lands', () => {
    const clock = { at: 0 };
    const plan = createReconnectPlan({ now: () => clock.at, windowMs: 10_000 });
    plan.dropped();
    plan.dropped();
    expect(plan.attempts()).toBe(2);
    plan.succeeded();
    expect(plan.attempts()).toBe(0);
    clock.at = 60_000;
    const step = plan.dropped();
    // A meeting that survived one outage is not partway through a deadline
    // set by the last one.
    expect(step).toEqual({ kind: 'retry', delayMs: 1_000, attempt: 1 });
  });
});

// ---------------------------------------------------------------------------

class FakeSocket implements MeetingSocket {
  sent: Array<string | ArrayBufferView> = [];
  closed = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send(data: string | ArrayBufferView): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed += 1;
  }
  serve(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  /** The connection going away on its own — a restart, a network drop. */
  drop(): void {
    this.onclose?.();
  }
  /** The `start` frame this socket carried, parsed as the server parses it. */
  startFrame(): Record<string, unknown> | null {
    for (const raw of this.sent) {
      if (typeof raw !== 'string') continue;
      const msg = parseMeetingClientMessage(raw);
      if (msg?.type === 'start') return msg as unknown as Record<string, unknown>;
    }
    return null;
  }
}

interface Pending {
  fn: () => void;
  ms: number;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const f of cleanups.splice(0)) f();
  document.body.replaceChildren();
});

/** A strip mid-meeting: mic open, `ready` answered, one socket in hand. */
async function recording(): Promise<{
  strip: MeetingStripHandle;
  root: HTMLElement;
  sockets: FakeSocket[];
  timers: Pending[];
  clock: { at: number };
  stopMic: ReturnType<typeof vi.fn>;
  /** Run the timer that is waiting, as its delay elapsing would. */
  fire(): void;
  note(): string;
  live(): FakeSocket;
}> {
  const root = document.createElement('div');
  document.body.append(root);
  const sockets: FakeSocket[] = [];
  const timers: Pending[] = [];
  const clock = { at: 1_000 };
  const stopMic = vi.fn();
  const strip = mountMeetingStrip({
    docId: 'doc-1',
    root,
    now: () => clock.at,
    interval: () => () => {},
    schedule: (fn, ms) => {
      const entry = { fn, ms };
      timers.push(entry);
      return () => {
        const at = timers.indexOf(entry);
        if (at >= 0) timers.splice(at, 1);
      };
    },
    openSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    alone: () => true,
    // No engine list to fetch: the chooser is never opened here, and a real
    // fetch in this environment is a connection refused per mount.
    listEngines: () => Promise.resolve(null),
    startCapture: () =>
      Promise.resolve({
        ok: true,
        capture: {
          stop: stopMic,
          setEchoCancellation: () => Promise.resolve(),
          reopen: () => Promise.resolve({ ok: true as const }),
        },
      } as MeetingCaptureStart),
  });
  cleanups.push(() => strip.destroy());
  (root.querySelector('.meeting-record') as HTMLButtonElement).click();
  await new Promise<void>((r) => setTimeout(r, 0));
  const first = sockets[0] as FakeSocket;
  first.onopen?.();
  first.serve({
    type: 'ready',
    meetingId: 'm-doc-1-1000',
    startedAt: 1_000,
    engine: 'mock',
    mode: 'solo',
  });
  return {
    strip,
    root,
    sockets,
    timers,
    clock,
    stopMic,
    fire: () => {
      const next = timers.shift();
      if (!next) throw new Error('no retry was scheduled');
      next.fn();
    },
    note: () => root.querySelector('.meeting-note')?.textContent ?? '',
    live: () => sockets[sockets.length - 1] as FakeSocket,
  };
}

describe('a meeting whose socket drops', () => {
  it('keeps the microphone and offers the same meeting back', async () => {
    const h = await recording();
    expect(h.strip.state().kind).toBe('recording');

    h.sockets[0]?.drop();

    // The microphone is the whole reason a resume is possible: releasing it
    // would put a permission prompt between the person and their sentence.
    expect(h.stopMic).not.toHaveBeenCalled();
    expect(h.strip.state().kind).toBe('recording');
    expect(h.note()).toBe(RECONNECTING_NOTE);
    // And the sentence says the words spoken meanwhile are gone, because they
    // are: nothing is buffered across the outage.
    expect(h.note()).toContain('not recorded');

    h.fire();
    expect(h.sockets).toHaveLength(2);
    h.live().onopen?.();
    const frame = h.live().startFrame();
    expect(frame?.resume).toBe('m-doc-1-1000');
    expect(frame?.encoding).toBe(MEETING_AUDIO_ENCODING);
  });

  it('says nothing at all once the resume is taken', async () => {
    const h = await recording();
    h.sockets[0]?.drop();
    h.fire();
    h.live().onopen?.();
    h.live().serve({
      type: 'ready',
      meetingId: 'm-doc-1-1000',
      startedAt: 1_000,
      engine: 'mock',
      mode: 'solo',
      resumed: true,
    });
    expect(h.note()).toBe('');
    expect(h.strip.state()).toEqual({ kind: 'recording', startedAt: 1_000 });
  });

  it('keeps the clock on the meeting rather than restarting it', async () => {
    const h = await recording();
    h.clock.at = 40_000;
    h.sockets[0]?.drop();
    h.fire();
    h.live().onopen?.();
    h.live().serve({
      type: 'ready',
      meetingId: 'm-doc-1-1000',
      startedAt: 1_000,
      engine: 'mock',
      mode: 'solo',
      resumed: true,
    });
    // Started at 1000 and still counting from it: the outage was part of the
    // meeting, not a second one.
    expect(h.strip.state()).toEqual({ kind: 'recording', startedAt: 1_000 });
  });

  it('restarts the clock when the fallback opens a new meeting', async () => {
    const h = await recording();
    h.clock.at = 40_000;
    h.sockets[0]?.drop();
    h.fire();
    h.live().onopen?.();
    h.clock.at = 41_000;
    h.live().serve({
      type: 'ready',
      meetingId: 'm-doc-1-41000',
      startedAt: 41_000,
      engine: 'mock',
      mode: 'solo',
    });
    // A new meeting with its own id, transcript and notes section: an elapsed
    // readout still counting from the old one would put a length on this
    // recording that no file of it holds.
    expect(h.strip.state()).toEqual({ kind: 'recording', startedAt: 41_000 });
    // …and the sentence saying what happened survives the restart, because
    // the recording did not end.
    expect(h.note()).toBe(RESUME_FAILED_NOTE);
  });

  it('says so in one plain sentence when the meeting could not be resumed', async () => {
    const h = await recording();
    h.sockets[0]?.drop();
    h.fire();
    h.live().onopen?.();
    // A server that opened a NEW meeting instead: no `resumed` on the answer.
    h.live().serve({
      type: 'ready',
      meetingId: 'm-doc-1-99999',
      startedAt: 99_999,
      engine: 'mock',
      mode: 'solo',
    });
    expect(h.note()).toBe(RESUME_FAILED_NOTE);
    // Recording carries on — the fallback is today's behaviour, not a stop.
    expect(h.strip.state().kind).toBe('recording');
    expect(h.stopMic).not.toHaveBeenCalled();
    // One sentence, not a banner: the strip's own line, nothing added around
    // it.
    expect(h.root.querySelectorAll('.meeting-note')).toHaveLength(1);
  });

  it('waits out a doc the old socket has not let go of yet', async () => {
    const h = await recording();
    h.sockets[0]?.drop();
    h.fire();
    h.live().onopen?.();
    h.live().serve({
      type: 'unavailable',
      reason: 'already_recording',
      message: 'This doc is already being recorded by another connection.',
    });
    // The server is still tearing the dropped socket's meeting down. That is
    // a reason to ask again, not a reason to end the recording.
    expect(h.strip.state().kind).toBe('recording');
    expect(h.stopMic).not.toHaveBeenCalled();
    expect(h.note()).toBe(RECONNECTING_NOTE);
    h.fire();
    expect(h.sockets).toHaveLength(3);
  });

  it('still reports a refusal that is about this meeting rather than the drop', async () => {
    const h = await recording();
    h.sockets[0]?.serve({
      type: 'unavailable',
      reason: 'not_configured',
      message: 'no engine here',
    });
    expect(h.strip.state()).toEqual({
      kind: 'unavailable',
      reason: 'not_configured',
      message: 'no engine here',
    });
    expect(h.stopMic).toHaveBeenCalled();
  });

  it('gives up when the window is spent, and lets the microphone go', async () => {
    const h = await recording();
    h.sockets[0]?.drop();
    // Every retry fails the moment it is made, with the clock running past the
    // two-minute window between attempts.
    for (let i = 0; i < 40 && h.strip.state().kind === 'recording'; i++) {
      h.fire();
      h.clock.at += 10_000;
      h.live().drop();
    }
    expect(h.strip.state()).toEqual({
      kind: 'error',
      message: 'The connection to the meeting was lost.',
    });
    expect(h.stopMic).toHaveBeenCalled();
    expect(h.timers).toHaveLength(0);
  });

  it('does not chase a meeting the person stopped', async () => {
    const h = await recording();
    // Stop through the menu's verb: the socket is closed deliberately, so its
    // handlers are gone and nothing here should be waiting on a timer.
    (h.root.querySelector('.meeting-record') as HTMLButtonElement).click();
    (h.root.querySelector('.meeting-stop-cta') as HTMLButtonElement).click();
    expect(h.strip.state().kind).toBe('idle');
    expect(h.timers).toHaveLength(0);
    expect(h.sockets).toHaveLength(1);
  });
});
