/**
 * The app voice socket's limits, on one session driven with a scripted clock
 * and scripted engines: it closes after ten minutes with nothing to do and
 * after two hours whatever it does, and once the server's daily listen or
 * speak budget is spent it refuses both without calling either engine. The
 * positive control is a socket under every limit that keeps working.
 *
 * Nothing here sleeps: the clock is a number the test moves, and the
 * session's checks run when the test fires the tick it was handed.
 */
import { describe, expect, it } from 'bun:test';
import {
  APP_VOICE_CLOSE_IDLE,
  APP_VOICE_CLOSE_LIFETIME,
  type AppVoiceServerMessage,
} from '@claude-workspaces/core/app-voice';
import {
  APP_VOICE_LIMITS,
  APP_VOICE_LIMIT_CHECK_MS,
  AppVoiceBudget,
  appVoiceLimitsFromEnv,
} from '../src/app-voice/limits.ts';
import { AppVoiceSession } from '../src/app-voice/session.ts';
import type { SpokenVoice } from '../src/spoken-reply/tts.ts';
import type { TranscriptionEngine } from '../src/transcribe.ts';
import { waitFor } from './wait-for.ts';

const MIN = 60_000;
/** One second of PCM16 mono at the socket's input rate. */
const SECOND_OF_AUDIO = new Uint8Array(16_000 * 2);

function harness(opts: { budget?: AppVoiceBudget } = {}) {
  let now = Date.UTC(2026, 9, 21, 9, 0, 0);
  const frames: AppVoiceServerMessage[] = [];
  const hangUps: { code: number; reason: string }[] = [];
  const checks: (() => void)[] = [];
  const spoken: string[] = [];
  let listenOpens = 0;
  let framesHeard = 0;
  const voice: SpokenVoice = {
    name: 'scripted',
    async speak(text) {
      spoken.push(text);
    },
  };
  const listener: TranscriptionEngine = {
    name: 'scripted',
    async open() {
      listenOpens++;
      return { send: () => void framesHeard++, close: async () => {} };
    },
  };
  const s = new AppVoiceSession({
    voice,
    listener,
    say: async () => 204,
    sendJson: (m) => frames.push(m),
    sendAudio: () => {},
    freshToken: () => ({ token: 't', expiresAt: 0 }),
    every: (fn, ms) => {
      if (ms === APP_VOICE_LIMIT_CHECK_MS) checks.push(fn);
      return () => {};
    },
    now: () => now,
    hangUp: (code, reason) => hangUps.push({ code, reason }),
    budget:
      opts.budget ??
      new AppVoiceBudget(
        APP_VOICE_LIMITS,
        () => now,
        () => {},
      ),
  });
  s.open();
  return {
    s,
    frames,
    hangUps,
    spoken,
    get listenOpens() {
      return listenOpens;
    },
    get framesHeard() {
      return framesHeard;
    },
    /** Move the clock on and run the session's check, as its interval would. */
    advance(ms: number) {
      now += ms;
      for (const c of checks) c();
    },
    setNow(t: number) {
      now = t;
    },
    errors: () => frames.filter((f) => f.type === 'error').map((f) => (f as { code: string }).code),
  };
}

describe('an app voice socket with nothing to do', () => {
  it('closes ten minutes after its last speak, say or heard audio', async () => {
    const h = harness();
    h.advance(9 * MIN);
    h.s.onText(JSON.stringify({ type: 'speak', text: 'Welcome to Riverbend.' }));
    h.advance(9 * MIN);
    expect(h.hangUps).toEqual([]);
    h.advance(1 * MIN);
    expect(h.hangUps.map((x) => x.code)).toEqual([APP_VOICE_CLOSE_IDLE]);
  });

  it('counts audio heard while listening as activity, and listening alone as none', async () => {
    const h = harness();
    h.s.onText(JSON.stringify({ type: 'listen' }));
    await waitFor(() => h.listenOpens === 1, { describe: 'listener open' });
    h.advance(9 * MIN);
    h.s.onAudio(SECOND_OF_AUDIO);
    h.advance(9 * MIN);
    expect(h.hangUps).toEqual([]);
    h.advance(1 * MIN);
    expect(h.hangUps.map((x) => x.code)).toEqual([APP_VOICE_CLOSE_IDLE]);
  });
});

describe('an app voice socket that stays busy', () => {
  it('closes two hours after it opened', () => {
    const h = harness();
    for (let i = 0; i < 23; i++) {
      h.advance(5 * MIN);
      h.s.onText(JSON.stringify({ type: 'say', text: 'Harborlight' }));
    }
    expect(h.hangUps).toEqual([]);
    h.advance(5 * MIN);
    expect(h.hangUps.map((x) => x.code)).toEqual([APP_VOICE_CLOSE_LIFETIME]);
  });

  it('keeps speaking, listening and writing while under every limit', async () => {
    const h = harness();
    h.s.onText(JSON.stringify({ type: 'listen' }));
    await waitFor(() => h.listenOpens === 1, { describe: 'listener open' });
    for (let i = 0; i < 6; i++) {
      h.advance(8 * MIN);
      h.s.onText(JSON.stringify({ type: 'speak', text: 'Saltmarsh is next.' }));
      h.s.onAudio(SECOND_OF_AUDIO);
    }
    await waitFor(() => h.spoken.length === 6, { describe: 'six lines spoken' });
    expect(h.framesHeard).toBe(6);
    expect(h.hangUps).toEqual([]);
    expect(h.errors()).toEqual([]);
  });
});

describe("the server's daily app voice budget", () => {
  it('refuses speak past the character cap without calling the voice', async () => {
    let now = Date.UTC(2026, 9, 21, 9);
    const warnings: string[] = [];
    const budget = new AppVoiceBudget(
      { dailyListenS: 60, dailySpeakChars: 30 },
      () => now,
      (m) => warnings.push(m),
    );
    const h = harness({ budget });
    h.setNow(now);
    h.s.onText(JSON.stringify({ type: 'speak', text: 'Welcome to Riverbend.', id: 'a' }));
    await waitFor(() => h.spoken.length === 1, { describe: 'first line spoken' });
    h.s.onText(JSON.stringify({ type: 'speak', text: 'Saltmarsh is next.', id: 'b' }));
    h.s.onText(JSON.stringify({ type: 'speak', text: 'And Harborlight.', id: 'c' }));
    await waitFor(() => h.errors().length === 2, { describe: 'two refusals' });
    expect(h.errors()).toEqual(['daily_cap', 'daily_cap']);
    expect(h.spoken).toEqual(['Welcome to Riverbend.']);
    // One warning for the day, however many lines it refused.
    expect(warnings.length).toBe(1);
    // A new UTC day has a fresh budget.
    now = Date.UTC(2026, 9, 22, 0, 0, 1);
    h.setNow(now);
    h.s.onText(JSON.stringify({ type: 'speak', text: 'Saltmarsh is next.', id: 'd' }));
    await waitFor(() => h.spoken.length === 2, { describe: 'spoken the next day' });
  });

  it('stops listening past the seconds cap and will not open the listener again', async () => {
    const now = Date.UTC(2026, 9, 21, 9);
    const budget = new AppVoiceBudget(
      { dailyListenS: 2, dailySpeakChars: 1000 },
      () => now,
      () => {},
    );
    const h = harness({ budget });
    h.setNow(now);
    h.s.onText(JSON.stringify({ type: 'listen' }));
    await waitFor(() => h.listenOpens === 1, { describe: 'listener open' });
    h.s.onAudio(SECOND_OF_AUDIO);
    h.s.onAudio(SECOND_OF_AUDIO);
    h.s.onAudio(SECOND_OF_AUDIO);
    h.s.onAudio(SECOND_OF_AUDIO);
    expect(h.framesHeard).toBe(2);
    expect(h.errors()).toEqual(['daily_cap']);
    h.s.onText(JSON.stringify({ type: 'listen' }));
    await waitFor(() => h.errors().length === 2, { describe: 'listen refused' });
    expect(h.errors()).toEqual(['daily_cap', 'daily_cap']);
    expect(h.listenOpens).toBe(1);
  });

  it('reads its caps from the environment, and keeps the defaults for a bad value', () => {
    expect(
      appVoiceLimitsFromEnv({
        CW_APP_VOICE_DAILY_LISTEN_S: '600',
        CW_APP_VOICE_DAILY_SPEAK_CHARS: '5000',
      }),
    ).toMatchObject({ dailyListenS: 600, dailySpeakChars: 5000 });
    expect(
      appVoiceLimitsFromEnv({
        CW_APP_VOICE_DAILY_LISTEN_S: 'lots',
        CW_APP_VOICE_DAILY_SPEAK_CHARS: '-1',
      }),
    ).toEqual(APP_VOICE_LIMITS);
    expect(appVoiceLimitsFromEnv({})).toEqual(APP_VOICE_LIMITS);
  });
});
