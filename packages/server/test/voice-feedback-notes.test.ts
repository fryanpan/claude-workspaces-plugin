/**
 * When talk becomes a finished note, on a clock the test turns by hand.
 *
 * The owner's words for the flow (the approved mock): raw words show while
 * they talk; after a 1.4s pause they become a finished note on that item; more
 * talk on the same item rewrites the note; tapping another place starts a new
 * note, and tapping an old note adds to it.
 *
 * The mock engine reveals one word per audio chunk and settles a turn on the
 * chunk after its last word. All fixtures are synthetic — the Riverbend
 * register. The repo is public.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { VoiceTarget } from '@claude-workspaces/core';
import {
  type MockScriptTurn,
  type TranscriptionEngine,
  type TranscriptionOpenOpts,
  createMockTranscriptionEngine,
} from '../src/transcribe.ts';
import {
  VOICE_CADENCE_MS,
  VOICE_PAUSE_MS,
  VoiceFeedbackRelay,
  type VoiceWs,
} from '../src/voice-feedback-relay.ts';
import type { TidyComplete } from '../src/voice-feedback-tidy.ts';
import { waitFor } from './wait-for.ts';

const TARGETS: VoiceTarget[] = [
  { i: 0, tag: 'header', text: 'Riverbend' },
  { i: 1, tag: 'button', text: 'Save', parent: 0 },
  { i: 3, tag: 'footer', text: 'Harborlight' },
];

const SCRIPT: MockScriptTurn[] = [
  { words: ['the', 'header', 'is', 'too', 'tall'] },
  { words: ['make', 'it', 'shorter'] },
  { words: ['footer', 'text', 'is', 'faint'] },
  { words: ['and', 'the', 'logo', 'is', 'blurry'] },
];

interface Frame {
  type: string;
  [k: string]: unknown;
}

/** Timers that fire only when the test moves the clock past them. */
function manualClock() {
  let now = 0;
  const pending = new Set<{ fn: () => void; at: number }>();
  return {
    now: () => now,
    timers: {
      set: (fn: () => void, ms: number) => {
        const t = { fn, at: now + ms };
        pending.add(t);
        return t;
      },
      clear: (h: unknown) => {
        pending.delete(h as { fn: () => void; at: number });
      },
    },
    advance(ms: number): void {
      now += ms;
      for (const t of [...pending].sort((a, b) => a.at - b.at)) {
        if (t.at > now || !pending.has(t)) continue;
        pending.delete(t);
        t.fn();
      }
    },
  };
}

const reply = (...comments: Array<{ continues?: boolean; text: string; element?: string }>) =>
  JSON.stringify({ comments });

describe('talk becomes a finished note', () => {
  let dataDir: string;
  let relay: VoiceFeedbackRelay;
  let clock: ReturnType<typeof manualClock>;
  let prompts: string[];
  let replies: string[];
  let frames: Frame[];
  let ws: VoiceWs;
  /** While set, a tidy call waits for it: a slow model. */
  let slow: Promise<void> | null;

  const of = (type: string) => frames.filter((f) => f.type === type);
  const notes = (key: string) => of('comment').filter((f) => f.key === key);
  const speak = (chunks: number) => {
    for (let i = 0; i < chunks; i++) relay.onAudio(ws, new Uint8Array(640));
  };
  const send = (msg: unknown) => relay.onText(ws, JSON.stringify(msg));
  const until = <T>(probe: () => T, describe: string) => waitFor(probe, { describe });
  const pendingNow = () => of('heard').at(-1)?.pending;

  const start = async (
    script: MockScriptTurn[] = SCRIPT,
    engine: TranscriptionEngine = createMockTranscriptionEngine(script),
  ) => {
    const tidy: TidyComplete = async ({ user }) => {
      prompts.push(user);
      if (slow) await slow;
      return { text: replies.shift() ?? '{"comments":[]}' };
    };
    relay = new VoiceFeedbackRelay({
      engines: [engine],
      tidy,
      dataDir,
      timers: clock.timers,
      now: clock.now,
    });
    ws = {
      data: { docId: 'riverbend-mock', workspaceId: 'riverbend' },
      send: (p) => frames.push(JSON.parse(p) as Frame),
      close: () => {},
    };
    send({ type: 'start', sampleRate: 16_000, targets: TARGETS });
    await until(() => of('ready')[0], 'ready');
  };

  /** Say turn one and pause: v1, on the header. */
  const firstNote = async () => {
    replies.push(reply({ text: 'The header is too tall.', element: 'e0' }));
    speak(6);
    clock.advance(VOICE_PAUSE_MS);
    return until(() => notes('v1')[0], 'v1');
  };

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-voice-notes-'));
    clock = manualClock();
    prompts = [];
    replies = [];
    frames = [];
    slow = null;
  });
  afterEach(async () => {
    await relay?.dispose();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('shows the raw words while they talk, and makes a note only at a pause', async () => {
    await start();
    speak(6); // "the header is too tall", settled
    clock.advance(VOICE_PAUSE_MS - 400);
    expect(prompts, 'no note before the pause is over').toEqual([]);
    expect(pendingNow()).toBe('the header is too tall');

    speak(1); // the talk goes on: "make"
    clock.advance(VOICE_PAUSE_MS - 400);
    expect(prompts, 'a word inside the pause starts it again: no mid-thought note').toEqual([]);
    expect(pendingNow()).toBe('the header is too tall make');

    replies.push(reply({ text: 'The header is too tall; make it shorter.', element: 'e0' }));
    speak(3); // "it shorter", settled
    clock.advance(VOICE_PAUSE_MS);
    const v1 = await until(() => notes('v1')[0], 'v1 after the pause');
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('<new_words>the header is too tall make it shorter</new_words>');
    expect(v1).toMatchObject({
      text: 'The header is too tall; make it shorter.',
      raw: 'the header is too tall make it shorter',
      target: 0,
    });
    await until(() => pendingNow() === '', 'the raw words are in the note now');
  });

  it('more talk on the same item writes the note again from all of its words', async () => {
    await start();
    await firstNote();
    replies.push(
      reply({
        continues: true,
        text: 'The header is too tall; make it shorter.',
        element: 'e0',
      }),
    );
    speak(4);
    clock.advance(VOICE_PAUSE_MS);
    const grown = await until(() => notes('v1')[1], 'v1 rewritten');
    expect(prompts[1]).toContain('<open element="e0"><said>the header is too tall</said></open>');
    expect(prompts[1]).toContain('<new_words>make it shorter</new_words>');
    expect(grown).toMatchObject({
      text: 'The header is too tall; make it shorter.',
      raw: 'the header is too tall make it shorter',
      final: false,
    });
    expect(
      of('comment').filter((f) => f.key !== 'v1'),
      'still one note',
    ).toEqual([]);
  });

  it('a tap on another place puts the words already said in their note first', async () => {
    await start();
    await firstNote();
    // "make it shorter" is said and settled, and the footer is tapped before a pause.
    replies.push(
      reply({ continues: true, text: 'The header is too tall; make it shorter.', element: 'e0' }),
    );
    speak(4);
    send({ type: 'pin', target: 3 });
    await until(() => notes('v1').at(-1)?.final === true, 'v1 settled');
    expect(prompts[1], 'the words went to the header, not the footer').not.toContain('<pinned>');
    expect(notes('v1').at(-1)).toMatchObject({ raw: 'the header is too tall make it shorter' });

    replies.push(reply({ text: 'The footer text is faint.', element: 'e0' }));
    speak(5);
    clock.advance(VOICE_PAUSE_MS);
    const v2 = await until(() => notes('v2')[0], 'v2');
    expect(prompts[2]).toContain('<pinned>e3</pinned>');
    expect(v2).toMatchObject({ target: 3, raw: 'footer text is faint', final: false });
  });

  it('words said after a tap go to its note, however long the tidy call already out takes', async () => {
    await start();
    let answer = () => {};
    slow = new Promise<void>((r) => {
      answer = r;
    });
    replies.push(reply({ text: 'The header is too tall.', element: 'e0' }));
    speak(6);
    clock.advance(VOICE_PAUSE_MS);
    await until(() => prompts.length === 1, 'the header tick is out');
    send({ type: 'pin', target: 3 });
    speak(4); // "make it shorter", after the tap, while the model is still thinking
    slow = null;
    answer();
    await until(() => notes('v1').at(-1)?.final === true, 'v1 settled by the pin');
    expect(prompts, 'the words after the tap did not ride the old note').toHaveLength(1);

    replies.push(reply({ text: 'Make it shorter.', element: 'e0' }));
    clock.advance(VOICE_PAUSE_MS);
    const v2 = await until(() => notes('v2')[0], 'v2');
    expect(prompts[1]).toContain('<pinned>e3</pinned>');
    expect(prompts[1]).toContain('<new_words>make it shorter</new_words>');
    expect(v2).toMatchObject({ target: 3, raw: 'make it shorter' });
  });

  it('a tap on an earlier note opens it again, and the next words add to it', async () => {
    await start();
    await firstNote();
    send({ type: 'pin', target: 3 });
    await until(() => notes('v1').at(-1)?.final === true, 'v1 settled by the pin');
    replies.push(reply({ text: 'Make it shorter.', element: 'e3' }));
    speak(4);
    clock.advance(VOICE_PAUSE_MS);
    await until(() => notes('v2')[0], 'v2 on the footer');

    send({ type: 'reopen', key: 'v1' });
    await until(() => notes('v1').at(-1)?.final === false && notes('v1').length > 1, 'v1 reopened');
    expect(notes('v2').at(-1), 'the note being talked about is done').toMatchObject({
      final: true,
    });

    replies.push(
      reply({
        continues: true,
        text: 'The header is too tall, and its text is faint.',
        element: 'e1',
      }),
    );
    speak(5);
    clock.advance(VOICE_PAUSE_MS);
    await until(() => prompts.length === 3, 'the reopened note is tidied');
    expect(prompts[2]).toContain(
      '<open element="e0" fixed chosen><said>the header is too tall</said></open>',
    );
    const grown = await until(
      () => notes('v1').find((f) => String(f.text).includes('faint')),
      'v1 grown',
    );
    expect(grown).toMatchObject({
      target: 0,
      raw: 'the header is too tall footer text is faint',
      final: false,
    });
    expect(notes('v3'), 'no new note').toEqual([]);

    // Chosen once: the tick after that reads it as an ordinary open note.
    speak(6);
    clock.advance(VOICE_PAUSE_MS);
    await until(() => prompts.length === 4, 'the next tick');
    expect(prompts[3]).toContain('<open element="e0" fixed><said>');
  });

  it('a frame the engine repeats with no new word does not hold the note back', async () => {
    let onTurn: TranscriptionOpenOpts['onTurn'] = () => {};
    const engine: TranscriptionEngine = {
      name: 'repeats',
      open: async (opts) => {
        onTurn = opts.onTurn;
        return { send: () => {}, close: async () => {} };
      },
    };
    await start(SCRIPT, engine);
    const frame = { turn: 0, text: 'the header is too tall', final: false };
    onTurn({ ...frame, settledText: 'the header is' });
    clock.advance(500);
    for (let k = 0; k < 4; k++) {
      onTurn({ ...frame, settledText: 'the header is too tall' });
      clock.advance(300);
    }
    expect(prompts, 'at the pause after the last new word').toHaveLength(1);
    expect(prompts[0]).toContain('<new_words>the header is too tall</new_words>');
  });

  it('talk that never pauses still lands at the ceiling', async () => {
    // An engine that marks words final as they come (as AssemblyAI does)
    // inside one turn that never ends.
    let onTurn: TranscriptionOpenOpts['onTurn'] = () => {};
    const engine: TranscriptionEngine = {
      name: 'steady',
      open: async (opts) => {
        onTurn = opts.onTurn;
        return { send: () => {}, close: async () => {} };
      },
    };
    await start(SCRIPT, engine);
    const said: string[] = [];
    let second = 0;
    const talk = (seconds: number) => {
      for (let k = 0; k < seconds; k++) {
        said.push(`word${second++}`);
        onTurn({
          turn: 0,
          text: `${said.join(' ')} still`,
          settledText: said.join(' '),
          final: false,
        });
        clock.advance(1000);
      }
    };
    talk(VOICE_CADENCE_MS / 1000 - 2);
    expect(prompts, 'a word a second is never a pause').toEqual([]);
    talk(2);
    expect(prompts, 'the ceiling fired').toHaveLength(1);
  });
});
