/**
 * The lead chat's voice on a phone: what iOS Safari needs from the tap.
 *
 * Safari runs an AudioContext only when `resume()` is called inside a user
 * gesture (`makeGestureContext` in `meeting-audio.ts`; the meeting's iPad
 * "Tap to keep recording" in docs/architecture/meeting-assistant.md). A
 * context that is only constructed in the tap, and resumed after an await,
 * can stay suspended: the mic is open, no frame is ever produced, and the
 * chat says "Listening…" forever. These cases pin the tap's synchronous
 * part, and the notice and report when the mic still sends no sound.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type LeadVoice, NO_SOUND, createLeadVoice } from '../src/lead-chat/lead-chat-voice.ts';
import { fakeVoice, settle } from './lead-chat-voice-fakes.ts';

const ME = { id: 'known-bryan', name: 'Bryan', kind: 'known' };

/** Whether the code under test is running inside the tap's own task. */
let inTap = false;

class FakeContext {
  static made: FakeContext[] = [];
  state = 'suspended';
  resumedInTap = false;
  resumedLater = false;
  closed = false;
  readonly madeInTap = inTap;
  constructor() {
    FakeContext.made.push(this);
  }
  resume(): Promise<void> {
    if (inTap) {
      this.resumedInTap = true;
      this.state = 'running';
    } else this.resumedLater = true;
    return Promise.resolve();
  }
  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

let voice: LeadVoice | null = null;
let savedCtor: unknown;
beforeEach(() => {
  FakeContext.made = [];
  savedCtor = (window as unknown as { AudioContext?: unknown }).AudioContext;
  (window as unknown as { AudioContext: unknown }).AudioContext = FakeContext;
});
afterEach(() => {
  voice?.destroy();
  voice = null;
  (window as unknown as { AudioContext: unknown }).AudioContext = savedCtor;
  vi.useRealTimers();
});

function make(extra: Partial<Parameters<typeof createLeadVoice>[0]> = {}) {
  const fake = fakeVoice();
  const captureCtx: Array<AudioContext | undefined> = [];
  let startsInTap = 0;
  const startCapture = fake.seams.startCapture;
  voice = createLeadVoice({
    ...fake.seams,
    startCapture: (c) => {
      if (inTap) startsInTap++;
      captureCtx.push(c.context);
      return startCapture ? startCapture(c) : Promise.reject(new Error('no capture'));
    },
    workspaceId: 'w-harbor',
    author: ME,
    getContext: () => ({ surface: 'board' }),
    agent: () => 'harborlight-lead',
    onChange: () => {},
    ...extra,
  });
  const tap = (): void => {
    inTap = true;
    try {
      voice?.start();
    } finally {
      inTap = false;
    }
  };
  return { ...fake, voice, tap, captureCtx, startsInTap: () => startsInTap };
}

describe('the lead chat voice, inside the tap', () => {
  it('starts the capture context running inside the tap, and hands that context to the mic', async () => {
    const { tap, captureCtx } = make();
    tap();
    await settle();
    // Two contexts: the player's (woken in the tap) and the mic's.
    const mic = captureCtx[0] as unknown as FakeContext | undefined;
    expect(mic, 'the mic was given a context').toBeInstanceOf(FakeContext);
    expect(mic?.madeInTap).toBe(true);
    expect(mic?.resumedInTap).toBe(true);
  });

  it('asks for the microphone inside the tap, before the setups are fetched', async () => {
    const { tap, startsInTap, mic } = make();
    tap();
    expect(startsInTap()).toBe(1);
    await settle();
    expect(mic.starts).toBe(1);
  });

  it('closes the mic again when the server has no voice set up', async () => {
    const fake = make({ fetchSetups: async () => [] });
    fake.tap();
    await settle();
    await settle();
    expect(fake.voice.state()).toMatchObject({ phase: 'off' });
    expect(fake.mic.stops).toBe(1);
  });
});

describe('the lead chat voice, when the mic sends nothing', () => {
  it('stops with a one-line notice and reports it, once the mic has sent no sound for a while', async () => {
    vi.useFakeTimers();
    const reports: Error[] = [];
    const { tap, voice } = make({ report: (e) => reports.push(e) });
    tap();
    await vi.advanceTimersByTimeAsync(0);
    expect(voice.state().phase).toBe('listening');
    await vi.advanceTimersByTimeAsync(6_000);
    expect(voice.state()).toMatchObject({ phase: 'off', notice: NO_SOUND });
    expect(reports).toHaveLength(1);
    expect(reports[0]?.message).toContain(NO_SOUND);
  });

  it('keeps listening when the mic sends frames', async () => {
    vi.useFakeTimers();
    const reports: Error[] = [];
    const { tap, voice, speak } = make({ report: (e) => reports.push(e) });
    tap();
    await vi.advanceTimersByTimeAsync(0);
    speak();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(voice.state().phase).toBe('listening');
    expect(reports).toHaveLength(0);
  });

  it('reports a microphone that would not open, beside the notice it already shows', async () => {
    const reports: Error[] = [];
    const { tap, voice } = make({
      report: (e) => reports.push(e),
      startCapture: async () => ({ ok: false, message: 'No microphone was found.' }),
    });
    tap();
    await settle();
    await settle();
    expect(voice.state()).toMatchObject({ phase: 'off', notice: 'No microphone was found.' });
    expect(reports.map((e) => e.message)).toEqual([
      expect.stringContaining('No microphone was found.'),
    ]);
  });
});
