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
import { type TidyComplete, unusedWords } from '../src/voice-feedback-tidy.ts';
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
} {
  const prompts: string[] = [];
  const replies: Array<string | Error> = [];
  const tidy: TidyComplete = async ({ user }) => {
    prompts.push(user);
    const next = replies.shift();
    if (next instanceof Error) throw next;
    return { text: next ?? '{"comments":[]}' };
  };
  return { tidy, prompts, replies };
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

describe('unusedWords', () => {
  const w = (s: string) => s.split(' ');
  const n = (s: string) => w(s).map((x) => x.toLowerCase().replace(/[^\p{L}\p{N}']/gu, ''));

  it('returns the words past the used prefix, matched case- and punctuation-blind', () => {
    expect(unusedWords(w('The header, is too tall.'), n('the header is'))).toEqual([
      'too',
      'tall.',
    ]);
    expect(unusedWords(w('the header'), [])).toEqual(['the', 'header']);
    expect(unusedWords(w('the header'), n('the header'))).toEqual([]);
  });

  it('does not drop later words when the engine re-formats a used stretch', () => {
    // "sixty six" was handed to a tick; the settled turn says "66 dollars".
    const out = unusedWords(w('the price is 66 dollars'), n('the price is sixty six'));
    // Cutting by count would return nothing; one repeated token is the price.
    expect(out).toEqual(['66', 'dollars']);
    // A same-length correction ("sink" settling as "sync") resumes after it.
    expect(unusedWords(w('so the sync is the bottleneck'), n('so the sink is the'))).toEqual([
      'bottleneck',
    ]);
  });

  it('does not repeat a long matched tail after one early re-format', () => {
    const out = unusedWords(
      w('the 1st row and the second row look wrong'),
      n('the first row and the second row'),
    );
    expect(out).toEqual(['look', 'wrong']);
  });
});
