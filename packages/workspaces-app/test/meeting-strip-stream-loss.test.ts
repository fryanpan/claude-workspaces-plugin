/**
 * The whole path, at the strip: a capture dies mid-meeting, the person is told
 * within the same beat, the server is told so the record carries the hole, and
 * the stream is asked for again.
 *
 * WHAT THIS STANDS IN FOR. Acceptance asks for three real screen-share cycles
 * on a real meeting, one of them started mid-sentence. No test can drive
 * Chrome's share picker or speak into a microphone, so what is driven here is
 * the thing the share picker DOES to a meeting — it ends the capture's track —
 * three times over, including once with a turn still open. The real-meeting
 * confirmation is a person's step and is not claimed by this file.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MeetingCaptureStart } from '../src/meeting-audio.ts';
import { type MeetingSocket, mountMeetingStrip } from '../src/meeting-strip.ts';
import type { TrackLossReason } from '../src/meeting-track-watch.ts';

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
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const cleanups: Array<() => void> = [];
beforeEach(() => {
  for (const c of cleanups.splice(0)) c();
  document.body.replaceChildren();
});

/**
 * A strip over a mic + Mac-audio meeting whose captures a test can kill and
 * whose reopen it can refuse.
 */
function mount(
  opts: { reopen?: () => Promise<{ ok: true } | { ok: false; message: string }> } = {},
) {
  const root = document.createElement('div');
  document.body.append(root);
  const sockets: FakeSocket[] = [];
  const clock = { at: 1_000 };
  const scheduled: Array<{ fn: () => void; delayMs: number }> = [];
  /** The capture's own report channel, one per stream — the track watch's. */
  const lose = new Map<string, (reason: TrackLossReason) => void>();
  const reopens: string[] = [];
  const strip = mountMeetingStrip({
    docId: 'doc-1',
    root,
    now: () => clock.at,
    interval: () => () => {},
    schedule: (fn, delayMs) => {
      const entry = { fn, delayMs };
      scheduled.push(entry);
      return () => {
        const at = scheduled.indexOf(entry);
        if (at >= 0) scheduled.splice(at, 1);
      };
    },
    openSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    systemAudioOffered: () => true,
    listEngines: () => Promise.resolve(null),
    startCapture: (o) => {
      const stream = o.source ?? 'mic';
      if (o.onLost) lose.set(stream, o.onLost);
      return Promise.resolve({
        ok: true as const,
        capture: {
          stop: vi.fn(),
          setEchoCancellation: () => Promise.resolve(),
          reopen: () => {
            reopens.push(stream);
            return opts.reopen ? opts.reopen() : Promise.resolve({ ok: true as const });
          },
        },
      } satisfies MeetingCaptureStart);
    },
  });
  cleanups.push(() => strip.destroy());
  return {
    root,
    strip,
    sockets,
    clock,
    reopens,
    /** The browser ends one of the meeting's captures. */
    kill: (stream: 'mic' | 'system', reason: TrackLossReason = 'ended') => {
      const fn = lose.get(stream);
      if (!fn) throw new Error(`no capture is running for ${stream}`);
      fn(reason);
    },
    /** Run the reopen the backoff is waiting on. */
    fireScheduled: () => {
      const next = scheduled.shift();
      if (!next) throw new Error('nothing was scheduled');
      next.fn();
    },
    pending: () => scheduled.length,
    alarm: () => root.querySelector('.meeting-stream-alarm')?.textContent ?? '',
    action: () => root.querySelector<HTMLButtonElement>('.meeting-note-action'),
    note: () => root.querySelector('.meeting-note')?.textContent ?? '',
    /** Every stream_state frame this meeting put on the wire, in order. */
    streamFrames: () =>
      sockets
        .flatMap((s) => s.sent)
        .filter((d): d is string => typeof d === 'string')
        .map((d) => JSON.parse(d) as Record<string, unknown>)
        .filter((m) => m.type === 'stream_state'),
  };
}

/** Start a mic + Mac-audio meeting and get it to `recording`. */
async function record(h: ReturnType<typeof mount>): Promise<void> {
  (h.root.querySelector('.meeting-record') as HTMLButtonElement).click();
  const card = [...h.root.querySelectorAll('.meeting-choice')].find(
    (el) => el.querySelector('.meeting-choice-title')?.textContent === 'Mac Audio',
  );
  const input = card?.querySelector('input');
  if (!input) throw new Error('no Mac Audio card in the chooser');
  input.checked = true;
  input.dispatchEvent(new Event('change'));
  (h.root.querySelector('.meeting-start-cta') as HTMLButtonElement).click();
  await settle();
  h.sockets[0]?.onopen?.();
  h.sockets[0]?.serve({
    type: 'ready',
    meetingId: 'm-1',
    startedAt: 1_000,
    engine: 'test',
    mode: 'conversation',
  });
  await settle();
}

describe('a share that kills the Mac-audio capture mid-meeting', () => {
  it('tells the person within the same beat, naming what stopped and what did not', async () => {
    const h = mount();
    await record(h);
    expect(h.alarm()).toBe('');

    h.kill('system');

    expect(h.alarm()).toContain("This Mac's audio stopped");
    expect(h.alarm()).toContain("voices on the call aren't being recorded");
    // And the half that stops somebody killing a recording that still works.
    expect(h.alarm()).toContain('Still recording the microphone');
    expect(h.strip.state().kind).toBe('recording');
  });

  it('opens a gap in the record by telling the server, and closes it on the way back', async () => {
    const h = mount();
    await record(h);
    h.kill('system');
    expect(h.streamFrames()).toEqual([
      { type: 'stream_state', stream: 'system', state: 'lost', reason: 'ended' },
    ]);

    h.action()?.click();
    await settle();
    expect(h.streamFrames().at(-1)).toEqual({
      type: 'stream_state',
      stream: 'system',
      state: 'restored',
    });
  });

  it('offers a press rather than promising a recovery it cannot make', async () => {
    // getDisplayMedia needs a gesture, so nothing auto-retries it; the line
    // must not say it is trying.
    const h = mount();
    await record(h);
    h.kill('system');
    expect(h.alarm()).not.toContain('Trying to get it back');
    expect(h.action()?.textContent).toBe("Share this Mac's audio again");
    expect(h.pending()).toBe(0);
  });

  it('says it is recording again once the share comes back', async () => {
    const h = mount();
    await record(h);
    h.kill('system');
    h.action()?.click();
    await settle();
    expect(h.alarm()).toBe('');
    expect(h.note()).toContain("This Mac's audio is recording again");
  });

  it('keeps the alarm up when the person’s press is refused', async () => {
    const h = mount({ reopen: () => Promise.resolve({ ok: false, message: 'no' }) });
    await record(h);
    h.kill('system');
    h.action()?.click();
    await settle();
    expect(h.alarm()).toContain("This Mac's audio stopped");
  });
});

describe('three share cycles in one meeting', () => {
  it('reports and recovers every one of them, and never doubles a gap', async () => {
    const h = mount();
    await record(h);
    for (let cycle = 0; cycle < 3; cycle++) {
      h.kill('system');
      expect(h.alarm()).toContain("This Mac's audio stopped");
      h.action()?.click();
      await settle();
      expect(h.alarm()).toBe('');
    }
    const frames = h.streamFrames();
    expect(frames.filter((f) => f.state === 'lost')).toHaveLength(3);
    expect(frames.filter((f) => f.state === 'restored')).toHaveLength(3);
    // Strictly alternating: a second `lost` before a `restored` would be a
    // second hole in a record that cannot be edited afterwards.
    expect(frames.map((f) => f.state)).toEqual([
      'lost',
      'restored',
      'lost',
      'restored',
      'lost',
      'restored',
    ]);
    expect(h.reopens).toEqual(['system', 'system', 'system']);
  });

  it('reports one loss however many times the track says so', async () => {
    const h = mount();
    await record(h);
    h.kill('system');
    h.kill('system');
    h.kill('system');
    expect(h.streamFrames().filter((f) => f.state === 'lost')).toHaveLength(1);
  });
});

describe('a capture that dies while somebody is mid-sentence', () => {
  it('leaves the words already on the strip alone and adds the alarm over them', async () => {
    const h = mount();
    await record(h);
    // A turn is open — the engine has not settled it — when the share starts.
    h.sockets[0]?.serve({
      type: 'transcript',
      turn: 0,
      text: 'so the thing I wanted to',
      final: false,
    });
    await settle();

    h.kill('system');

    expect(h.alarm()).toContain("This Mac's audio stopped");
    // The half-spoken turn is still there: the loss is about a capture, not
    // about the words already carried.
    expect(h.root.textContent).toContain('so the thing I wanted to');

    // And the turn still settles afterwards, through the stream that lived.
    h.sockets[0]?.serve({
      type: 'transcript',
      turn: 0,
      text: 'So the thing I wanted to say.',
      final: true,
    });
    await settle();
    expect(h.root.textContent).toContain('So the thing I wanted to say.');
  });
});

describe('the microphone, which can come back on its own', () => {
  it('retries without a press and says so while it is trying', async () => {
    const h = mount({ reopen: () => Promise.resolve({ ok: false, message: 'not yet' }) });
    await record(h);
    h.kill('mic');
    await settle();
    // The first attempt is immediate — a device the OS took for a moment is
    // usually back at once, and a second of waiting is a second of meeting.
    expect(h.reopens).toEqual(['mic']);
    expect(h.alarm()).toContain('Trying to get it back');
    expect(h.pending()).toBeGreaterThan(0);
  });

  it('stops promising a recovery once the retries run out', async () => {
    const h = mount({ reopen: () => Promise.resolve({ ok: false, message: 'gone' }) });
    await record(h);
    h.kill('mic');
    await settle();
    // Past the whole window: the plan gives up rather than holding a
    // microphone open against a device that is never coming back.
    h.clock.at += 200_000;
    h.fireScheduled();
    await settle();
    while (h.pending() > 0) {
      h.fireScheduled();
      await settle();
    }
    expect(h.alarm()).not.toContain('Trying to get it back');
    expect(h.action()?.textContent).toBe('Start the microphone again');
  });
});

describe('a meeting that loses everything', () => {
  it('says nothing is being recorded rather than naming a survivor', async () => {
    const h = mount({ reopen: () => Promise.resolve({ ok: false, message: 'no' }) });
    await record(h);
    h.kill('system');
    h.kill('mic');
    await settle();
    expect(h.alarm()).toContain('nothing is being recorded');
    expect(h.alarm()).not.toContain('Still recording');
  });
});

describe('what the meeting ending does to all of it', () => {
  it('drops the alarm and every pending retry with the meeting', async () => {
    const h = mount({ reopen: () => Promise.resolve({ ok: false, message: 'no' }) });
    await record(h);
    h.kill('mic');
    await settle();
    expect(h.pending()).toBeGreaterThan(0);

    (h.root.querySelector('.meeting-record') as HTMLButtonElement).click();
    (h.root.querySelector('.meeting-stop-cta') as HTMLButtonElement).click();
    await settle();

    expect(h.alarm()).toBe('');
    // Nothing is left trying to reopen a microphone for a meeting that is
    // over — that would light the recording indicator with nothing recording.
    expect(h.pending()).toBe(0);
  });
});
