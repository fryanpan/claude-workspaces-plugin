/**
 * A voice feedback session driven directly: a fake socket that records what
 * it is sent, the mock transcription engine (one word per audio chunk; a turn
 * settles on the chunk after its last word, and on close), and a fake tidier
 * that records its prompts and answers from a queue.
 *
 * Nothing here reaches the network. All fixtures are synthetic — the
 * Riverbend register. The repo is public.
 */
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { VoiceTarget } from '@claude-workspaces/core';
import { type MockScriptTurn, createMockTranscriptionEngine } from '../src/transcribe.ts';
import { VoiceFeedbackRelay, type VoiceWs } from '../src/voice-feedback-relay.ts';
import { voiceAudioDir, voiceLogPath } from '../src/voice-feedback-store.ts';
import type { TidyComplete } from '../src/voice-feedback-tidy.ts';
import { waitFor } from './wait-for.ts';

setDefaultTimeout(15_000);

const DOC = 'riverbend-mock';
const WS_ID = 'riverbend';
/** One 20ms frame of PCM16 at 16kHz. */
const CHUNK = 640;

const TARGETS: VoiceTarget[] = [
  { i: 0, tag: 'header', text: 'Riverbend' },
  { i: 1, tag: 'button', text: 'Save', parent: 0 },
  { i: 2, tag: 'span', text: 'done', parent: 0 },
  { i: 3, tag: 'footer', text: 'Harborlight' },
];

const SCRIPT: MockScriptTurn[] = [
  { words: ['the', 'header', 'is', 'too', 'tall'] },
  { words: ['make', 'it', 'shorter'] },
  { words: ['the', 'save', 'button', 'hides'] },
  { words: ['footer', 'text', 'is', 'faint'] },
];

interface Frame {
  type: string;
  [k: string]: unknown;
}

class FakeWs implements VoiceWs {
  readonly frames: Frame[] = [];
  closedWith: number | null = null;
  constructor(readonly data: VoiceWs['data']) {}
  send(payload: string): void {
    this.frames.push(JSON.parse(payload) as Frame);
  }
  close(code?: number): void {
    this.closedWith = code ?? 1000;
  }
  of(type: string): Frame[] {
    return this.frames.filter((f) => f.type === type);
  }
  comments(key?: string): Frame[] {
    return this.of('comment').filter((f) => key === undefined || f.key === key);
  }
}

/** A tidier answering from a queue; an Error in the queue is thrown. */
function fakeTidy(): {
  tidy: TidyComplete;
  prompts: string[];
  replies: Array<string | Error>;
  /** When set, the next answer waits for it. */
  hold: { gate: Promise<void> | null };
} {
  const prompts: string[] = [];
  const replies: Array<string | Error> = [];
  const hold: { gate: Promise<void> | null } = { gate: null };
  const tidy: TidyComplete = async ({ user }) => {
    prompts.push(user);
    const gate = hold.gate;
    hold.gate = null;
    if (gate) await gate;
    const next = replies.shift();
    if (next instanceof Error) throw next;
    return { text: next ?? '{"comments":[]}' };
  };
  return { tidy, prompts, replies, hold };
}

const reply = (...comments: Array<{ continues?: boolean; text: string; element?: string }>) =>
  JSON.stringify({ comments });

describe('VoiceFeedbackRelay', () => {
  let dataDir: string;
  let relay: VoiceFeedbackRelay;
  let t: ReturnType<typeof fakeTidy>;

  const make = (opts: { engines?: boolean; tidy?: boolean; script?: MockScriptTurn[] } = {}) => {
    t = fakeTidy();
    relay = new VoiceFeedbackRelay({
      engines: opts.engines === false ? [] : [createMockTranscriptionEngine(opts.script ?? SCRIPT)],
      tidy: opts.tidy === false ? null : t.tidy,
      dataDir,
      cadenceMs: 20,
      pauseMs: 5,
    });
  };

  const open = async (data: Partial<VoiceWs['data']> = {}): Promise<FakeWs> => {
    const ws = new FakeWs({ docId: DOC, workspaceId: WS_ID, ...data });
    relay.onText(ws, JSON.stringify({ type: 'start', sampleRate: 16_000, targets: TARGETS }));
    return ws;
  };

  const speak = (ws: FakeWs, chunks: number) => {
    for (let i = 0; i < chunks; i++) relay.onAudio(ws, new Uint8Array(CHUNK));
  };

  const until = <T>(probe: () => T, describe: string) => waitFor(probe, { describe });

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-voice-relay-'));
  });
  afterEach(async () => {
    await relay?.dispose();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('starts with ready, records the audio, and turns a settled turn into a comment', async () => {
    make();
    const ws = await open();
    await until(() => ws.of('ready')[0], 'ready');
    expect(ws.of('ready')[0]).toEqual({ type: 'ready', segment: 1 });

    t.replies.push(reply({ continues: false, text: 'The header is too tall.', element: 'e0' }));
    // Five words reveal the turn; the sixth chunk settles it.
    speak(ws, 6);
    const v1 = await until(() => ws.comments('v1')[0], 'comment v1');

    expect(ws.of('heard').length).toBeGreaterThan(0);
    expect(t.prompts[0]).toContain('<new_words>the header is too tall</new_words>');
    expect(t.prompts[0]).toContain('<open>none</open>');
    expect(v1).toMatchObject({
      key: 'v1',
      text: 'The header is too tall.',
      target: 0,
      raw: 'the header is too tall',
      final: false,
    });
    expect(String(v1.clip)).toMatch(
      /^\/workspaces\/riverbend\/docs\/riverbend-mock\/voice-feedback\/seg-1\.wav#t=\d+\.\d,\d+\.\d$/,
    );

    // The recording grew with every chunk, and its header says so.
    const wav = join(voiceAudioDir(dataDir, DOC), 'seg-1.wav');
    expect(statSync(wav).size).toBe(44 + 6 * CHUNK);
    const buf = readFileSync(wav);
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    expect(view.getUint32(40, true)).toBe(6 * CHUNK);
    expect(view.getUint32(4, true)).toBe(36 + 6 * CHUNK);
  });

  it('grows the open comment on continues, settles it and opens the next on a new topic', async () => {
    make();
    const ws = await open();
    await until(() => ws.of('ready')[0], 'ready');

    t.replies.push(reply({ text: 'The header is too tall.', element: 'e0' }));
    speak(ws, 6);
    await until(() => ws.comments('v1')[0], 'v1');

    t.replies.push(
      reply({ continues: true, text: 'The header is too tall; make it shorter.', element: 'e0' }),
    );
    speak(ws, 4);
    const grown = await until(() => ws.comments('v1')[1], 'v1 grown');
    expect(t.prompts[1]).toContain('<open element="e0">The header is too tall.</open>');
    expect(t.prompts[1]).toContain('<new_words>make it shorter</new_words>');
    expect(grown).toMatchObject({
      text: 'The header is too tall; make it shorter.',
      raw: 'the header is too tall make it shorter',
      final: false,
    });

    t.replies.push(reply({ continues: false, text: 'The Save button hides.', element: 'e1' }));
    speak(ws, 5);
    const v2 = await until(() => ws.comments('v2')[0], 'v2');
    const settled = ws.comments('v1').at(-1);
    expect(settled).toMatchObject({
      final: true,
      text: 'The header is too tall; make it shorter.',
    });
    // The settle frame goes out before the new comment's first frame.
    expect(ws.frames.indexOf(settled as Frame)).toBeLessThan(ws.frames.indexOf(v2));
    expect(v2).toMatchObject({ target: 1, raw: 'the save button hides', final: false });
  });

  it('two topics in one tick get their own words and clips that do not overlap', async () => {
    make();
    const ws = await open();
    await until(() => ws.of('ready')[0], 'ready');
    t.replies.push(reply({ text: 'The header is too tall.', element: 'e0' }));
    speak(ws, 6);
    await until(() => ws.comments('v1')[0], 'v1');

    // "make it shorter" and "the save button hides" both settle before the tick.
    t.replies.push(
      reply(
        { continues: true, text: 'The header is too tall; make it shorter.', element: 'e0' },
        { text: 'The Save button hides.', element: 'e1' },
      ),
    );
    speak(ws, 9);
    const v2 = await until(() => ws.comments('v2')[0], 'v2');
    const v1 = ws.comments('v1').at(-1) as Frame;
    expect(t.prompts[1]).toContain('<new_words>make it shorter the save button hides</new_words>');
    expect(v1).toMatchObject({ raw: 'the header is too tall make it shorter', final: true });
    expect(v2).toMatchObject({ raw: 'the save button hides', target: 1 });

    const range = (f: Frame) => String(f.clip).split('#t=')[1]?.split(',').map(Number) ?? [];
    const [s1, e1] = range(v1);
    const [s2, e2] = range(v2);
    expect(s1).toBe(0);
    expect(e1 as number).toBeGreaterThan(s1 as number);
    expect(s2 as number).toBeGreaterThanOrEqual(e1 as number);
    expect(e2 as number).toBeGreaterThan(s2 as number);
  });

  it("writes a comment's line after the words it was made of, before words said later", async () => {
    make();
    const ws = await open();
    await until(() => ws.of('ready')[0], 'ready');
    t.replies.push(reply({ text: 'The header is too tall.', element: 'e0' }));
    speak(ws, 6);
    await until(() => ws.comments('v1')[0], 'v1');
    t.replies.push(reply({ continues: true, text: 'Header too tall; shorter.', element: 'e0' }));
    speak(ws, 4);
    await until(() => ws.comments('v1')[1], 'v1 grown');
    // "footer text is faint" is heard while the Save tick is still thinking,
    // so v1 settles after words said later than it.
    let release = (): void => {};
    t.hold.gate = new Promise<void>((r) => {
      release = r;
    });
    t.replies.push(reply({ text: 'The Save button hides.', element: 'e1' }));
    speak(ws, 5);
    await until(() => t.prompts.length === 3, 'the Save tick is under way');
    speak(ws, 5);
    await until(() => ws.of('heard').some((f) => String(f.text).endsWith('is faint')), 'faint');
    t.replies.push(reply({ text: 'The footer text is faint.', element: 'e3' }));
    release();
    await until(() => ws.comments('v3')[0], 'v3');
    relay.onText(ws, JSON.stringify({ type: 'stop' }));
    await until(() => ws.of('stopped')[0], 'stopped');

    const lines = readFileSync(voiceLogPath(dataDir, DOC), 'utf8')
      .split('\n')
      .filter((l) => l.startsWith('- '));
    const at = (needle: string) => lines.findIndex((l) => l.includes(needle));
    expect(at('Comment v1')).toBeGreaterThan(at('make it shorter'));
    expect(at('Comment v1')).toBeLessThan(at('the save button hides'));
    expect(at('Comment v2')).toBeGreaterThan(at('the save button hides'));
    expect(at('Comment v2')).toBeLessThan(at('footer text is faint'));
    expect(at('Comment v3')).toBeGreaterThan(at('footer text is faint'));
    expect(lines.filter((l) => /^- \[/.test(l)).length).toBe(7);
  });

  it('a pin settles the open comment and fixes the next new comment to the tapped element', async () => {
    make();
    const ws = await open();
    await until(() => ws.of('ready')[0], 'ready');
    t.replies.push(reply({ text: 'The header is too tall.', element: 'e0' }));
    speak(ws, 6);
    await until(() => ws.comments('v1')[0], 'v1');

    relay.onText(ws, JSON.stringify({ type: 'pin', target: 2 }));
    expect(ws.comments('v1').at(-1)).toMatchObject({ final: true });

    // The model claims it continues and names another element; the pin wins.
    t.replies.push(reply({ continues: true, text: 'Make it shorter.', element: 'e3' }));
    speak(ws, 4);
    const v2 = await until(() => ws.comments('v2')[0], 'v2');
    expect(t.prompts[1]).toContain('<pinned>e2</pinned>');
    expect(v2).toMatchObject({ target: 2, text: 'Make it shorter.' });

    // A later continue may grow it but not re-point it: the person placed it.
    t.replies.push(reply({ continues: true, text: 'Make it shorter; save hides.', element: 'e1' }));
    speak(ws, 5);
    const grown = await until(() => ws.comments('v2')[1], 'v2 grown');
    expect(t.prompts[2]).toContain('<open element="e2" fixed>');
    expect(grown).toMatchObject({ target: 2, text: 'Make it shorter; save hides.' });
  });

  it('a move re-points a comment for good', async () => {
    make();
    const ws = await open();
    await until(() => ws.of('ready')[0], 'ready');
    t.replies.push(reply({ text: 'The header is too tall.', element: 'e0' }));
    speak(ws, 6);
    await until(() => ws.comments('v1')[0], 'v1');

    relay.onText(ws, JSON.stringify({ type: 'move', key: 'v1', target: 3 }));
    expect(ws.comments('v1').at(-1)).toMatchObject({ target: 3, final: false });

    t.replies.push(reply({ continues: true, text: 'Header tall; shorter.', element: 'e0' }));
    speak(ws, 4);
    const grown = await until(() => ws.comments('v1')[2], 'v1 grown after move');
    expect(grown).toMatchObject({ target: 3, text: 'Header tall; shorter.' });
  });

  it('lands the raw words when the tidier throws, answers junk, or is absent', async () => {
    make();
    const ws = await open();
    await until(() => ws.of('ready')[0], 'ready');

    t.replies.push(new Error('overloaded'));
    speak(ws, 6);
    const v1 = await until(() => ws.comments('v1')[0], 'v1 from a failed tidy');
    expect(v1).toMatchObject({
      text: 'the header is too tall',
      raw: 'the header is too tall',
      target: null,
    });

    t.replies.push('Sorry, I cannot help with that.');
    speak(ws, 4);
    const grown = await until(() => ws.comments('v1')[1], 'v1 grown from junk');
    // With a comment open and nothing pinned, the fallback continues it.
    expect(grown).toMatchObject({
      text: 'make it shorter',
      raw: 'the header is too tall make it shorter',
    });

    // No tidier at all: the words still arrive.
    await relay.dispose();
    make({ tidy: false });
    const bare = await open({ docId: 'harborlight-mock' });
    await until(() => bare.of('ready')[0], 'ready without a tidier');
    speak(bare, 6);
    const plain = await until(() => bare.comments('v1')[0], 'v1 without a tidier');
    expect(plain).toMatchObject({ text: 'the header is too tall' });
  });

  it('refuses to start without an engine, or for a socket that could not sign in', async () => {
    make({ engines: false });
    const none = await open();
    expect(none.of('unavailable')).toEqual([{ type: 'unavailable', reason: 'not_configured' }]);
    speak(none, 3);
    expect(existsSync(voiceAudioDir(dataDir, DOC))).toBe(false);

    make();
    const readOnly = await open({ readOnly: true });
    expect(readOnly.of('unavailable')).toEqual([
      { type: 'unavailable', reason: 'sign_in_required' },
    ]);
    expect(readOnly.of('ready')).toEqual([]);
  });

  it('answers an unreadable frame with an error and keeps the session', async () => {
    make();
    const ws = await open();
    await until(() => ws.of('ready')[0], 'ready');
    relay.onText(ws, '{"type":"pin","target":"e2"}');
    expect(ws.of('error')).toEqual([{ type: 'error', message: 'unreadable frame' }]);
  });

  it('stop flushes the sentence in progress into a final comment, then says stopped', async () => {
    make();
    const ws = await open();
    await until(() => ws.of('ready')[0], 'ready');
    // Three of five words: the turn is still open when stop arrives.
    speak(ws, 3);
    t.replies.push(reply({ text: 'The header is…', element: 'e0' }));
    relay.onText(ws, JSON.stringify({ type: 'stop' }));

    await until(() => ws.of('stopped')[0], 'stopped');
    const last = ws.comments('v1').at(-1);
    expect(last).toMatchObject({ text: 'The header is…', raw: 'the header is', final: true });
    expect(ws.frames.indexOf(last as Frame)).toBeLessThan(
      ws.frames.indexOf(ws.of('stopped')[0] as Frame),
    );
    expect(ws.closedWith).toBe(1000);
    // A socket closing after stop does not end it twice.
    relay.onClose(ws);
    expect(ws.of('stopped')).toHaveLength(1);
  });

  it('keeps a log of what was heard and what was posted, and numbers the next session', async () => {
    make();
    const ws = await open();
    await until(() => ws.of('ready')[0], 'ready');
    t.replies.push(reply({ text: 'The header is too tall.', element: 'e0' }));
    speak(ws, 6);
    await until(() => ws.comments('v1')[0], 'v1');
    relay.onText(ws, JSON.stringify({ type: 'posted', key: 'v1', threadId: 'th-riverbend-1' }));
    relay.onText(ws, JSON.stringify({ type: 'stop' }));
    await until(() => ws.of('stopped')[0], 'stopped');

    const log = readFileSync(voiceLogPath(dataDir, DOC), 'utf8');
    expect(log).toContain('## Recording 1');
    expect(log).toMatch(/^- \[\d\d:\d\d\] the header is too tall$/m);
    // The thread rides on the comment's own line, not a line nested under
    // whatever was heard just before it was posted.
    expect(log).toMatch(
      /^- \[\d\d:\d\d\]–\[\d\d:\d\d\] Comment v1 \(thread th-riverbend-1\) on header “Riverbend”: The header is too tall\.$/m,
    );
    expect(log).not.toContain('posted as thread');
    expect(log).toMatch(/_Recording 1 ended at \[\d\d:\d\d\]; 1 tidy calls/);

    const second = await open();
    await until(() => second.of('ready')[0], 'second ready');
    expect(second.of('ready')[0]).toEqual({ type: 'ready', segment: 2 });
    await until(
      () => readFileSync(voiceLogPath(dataDir, DOC), 'utf8').includes('## Recording 2'),
      'heading 2',
    );
    expect(existsSync(join(voiceAudioDir(dataDir, DOC), 'seg-2.wav'))).toBe(true);
  });

  it('a Stop and a close that race end the recording once', async () => {
    make();
    const ws = await open();
    await until(() => ws.of('ready')[0], 'ready');
    speak(ws, 3);
    let release = (): void => {};
    t.hold.gate = new Promise<void>((r) => {
      release = r;
    });
    t.replies.push(reply({ text: 'The header is…', element: 'e0' }));
    relay.onText(ws, JSON.stringify({ type: 'stop' }));
    await until(() => t.prompts.length === 1, 'the final tidy call is under way');
    relay.onClose(ws);
    release();
    await until(() => ws.of('stopped')[0], 'stopped');
    const log = readFileSync(voiceLogPath(dataDir, DOC), 'utf8');
    expect(log.match(/_Recording 1 ended/g)).toHaveLength(1);
    expect(ws.comments('v1').at(-1)).toMatchObject({ final: true });
  });

  it('a close during a tidy call still settles and logs the comment it makes', async () => {
    make();
    const ws = await open();
    await until(() => ws.of('ready')[0], 'ready');
    let release = (): void => {};
    t.hold.gate = new Promise<void>((r) => {
      release = r;
    });
    t.replies.push(reply({ text: 'The header is too tall.', element: 'e0' }));
    speak(ws, 6);
    await until(() => t.prompts.length === 1, 'a tidy call is under way');
    relay.onClose(ws);
    release();
    await until(() => ws.comments('v1').at(-1)?.final === true, 'v1 settled');
    await relay.dispose();
    const log = readFileSync(voiceLogPath(dataDir, DOC), 'utf8');
    expect(log).toMatch(/Comment v1 on header “Riverbend”: The header is too tall\./);
    expect(log.indexOf('Comment v1')).toBeLessThan(log.indexOf('_Recording 1 ended'));
  });

  it('a socket that goes away settles the open comment without a stopped frame', async () => {
    make();
    const ws = await open();
    await until(() => ws.of('ready')[0], 'ready');
    t.replies.push(reply({ text: 'The header is too tall.', element: 'e0' }));
    speak(ws, 6);
    await until(() => ws.comments('v1')[0], 'v1');
    relay.onClose(ws);
    await until(() => ws.comments('v1').at(-1)?.final === true, 'v1 settled on close');
    expect(ws.of('stopped')).toEqual([]);
    // Audio after close is not recorded.
    speak(ws, 2);
    expect(statSync(join(voiceAudioDir(dataDir, DOC), 'seg-1.wav')).size).toBe(44 + 6 * CHUNK);
  });
});
