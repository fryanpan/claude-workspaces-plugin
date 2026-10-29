/**
 * The planning voice inside a planning meeting, through the REAL server: a
 * plan-kind huddle records on its audio socket, and a spoken-reply socket on
 * the same doc hears that meeting (`ears: 'meeting'`) with nobody tapping
 * Talk. At the pause after the speaker talks, the plan is read and its one
 * open question is asked aloud; the answer is written into the plan and kept
 * out of the meeting notes; "any questions?" is answered; a discussion
 * meeting never asks.
 *
 * The plan has a written section under every heading and nothing marked TBD
 * or "?", so the gap list finds nothing: the question can only come from
 * reading it. Mock transcription, fake voice, a scripted model; nothing
 * reaches a vendor. Fixture names are the house ones.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MEETING_AUDIO_ENCODING,
  MEETING_SAMPLE_RATE,
  meetingSocketPath,
  prose,
} from '@claude-workspaces/core';
import { AGENT_FOCUS_FIELD } from '@claude-workspaces/core/spoken-reply';
import type { NotesComposeInput, NotesComposer, TickScheduler } from '../src/meeting-notes.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { READER_SYSTEM } from '../src/spoken-reply/interview-reader.ts';
import type { SpokenVoice } from '../src/spoken-reply/tts.ts';
import { type MockScriptTurn, createMockTranscriptionEngine } from '../src/transcribe.ts';
import { waitFor } from './wait-for.ts';

setDefaultTimeout(30_000);

const BERTH_PLAN = `## Goal

Open the second Harborlight berth to Riverbend ferries by spring.

### Work

- Dredge the Saltmarsh channel to four metres before March.
- Move the ticket office to the new pier.
- Train the Riverbend crews on the new mooring lines.
`;

const TALK = 'The berth opens in spring and the Riverbend crews move over in March.';
const ANSWER = 'The Saltmarsh harbour office signs off the berth design.';
const INVITE = 'Do you have any questions?';

const script = (text: string): MockScriptTurn => ({ words: text.split(' '), settled: text });
/** Each turn takes one audio frame per word, and one more to settle. */
const SCRIPT: readonly MockScriptTurn[] = [script(TALK), script(ANSWER), script(INVITE)];
const framesFor = (text: string) => text.split(' ').length + 1;

/** Ticks only when told; the meeting's end flushes what is left. */
const NEVER: TickScheduler = { set: () => 0, clear: () => {} };

interface Frame {
  type: string;
  [k: string]: unknown;
}

describe('the planning voice in a planning meeting', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let wsBase: string;
  let boardId = '';
  const said: string[] = [];
  const reads: Array<{ system: string; user: string }> = [];
  /** The model's next replies to a reading, in order. */
  const readings: string[] = [];
  const composed: string[] = [];
  const lines: string[] = [];
  const realLog = console.log;

  const voice: SpokenVoice = {
    name: 'fake',
    async speak(text, onAudio) {
      said.push(text);
      onAudio(new Uint8Array(480));
    },
  };
  const composer: NotesComposer = {
    name: 'spy',
    compose(input: NotesComposeInput) {
      for (const t of input.tick.turns) composed.push(t.text);
      return Promise.resolve([]);
    },
  };

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    dataDir = mkdtempSync(join(tmpdir(), 'cw-plan-meeting-'));
    handle = createServer({
      port: 0,
      dataDir,
      transcription: createMockTranscriptionEngine(SCRIPT),
      meetingNotes: { composer, quietMs: 60_000, schedule: NEVER },
      // The first pause may ask; the quiet first minute is meeting-warmup.test.ts's.
      planWarmupMs: 0,
      spokenReply: {
        // Never opened: the meeting is the ears.
        listener: { name: 'unused', open: () => Promise.reject(new Error('not this one')) },
        voices: { 1: voice, 2: null },
        gemini: null,
      },
      voiceComplete: async (args) => {
        if (!args.system.startsWith(READER_SYSTEM)) return '';
        reads.push(args);
        return readings.shift() ?? '{"ask": null, "why": ""}';
      },
    });
    base = `http://127.0.0.1:${handle.port}`;
    wsBase = `ws://127.0.0.1:${handle.port}`;
    const ws = await post('/workspaces', { name: 'Harborlight' });
    boardId = ((await ws.json()) as { workspace: { id: string } }).workspace.id;
  });

  afterAll(async () => {
    console.log = realLog;
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function huddle(kind: 'plan' | 'discussion'): Promise<string> {
    const r = await post(`/workspaces/${boardId}/huddles`, { kind });
    const docId = ((await r.json()) as { docId: string }).docId;
    handle.docStore.applyBlockEdits(docId, [{ op: 'insert_at_end', markdown: BERTH_PLAN }], {
      author: 'fixture',
    });
    return docId;
  }

  async function socket(url: string) {
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    const frames: Frame[] = [];
    ws.addEventListener('message', (ev) => {
      if (typeof ev.data === 'string') frames.push(JSON.parse(ev.data) as Frame);
    });
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error(`refused: ${url}`)));
    });
    return { ws, frames };
  }

  /** A meeting recording on `docId`, and a planning voice hearing it. */
  async function meeting(docId: string) {
    const audio = await socket(`${wsBase}${meetingSocketPath(boardId, docId)}`);
    audio.ws.send(
      JSON.stringify({
        type: 'start',
        sampleRate: MEETING_SAMPLE_RATE,
        encoding: MEETING_AUDIO_ENCODING,
      }),
    );
    await waitFor(() => audio.frames.some((f) => f.type === 'ready'), { describe: 'ready' });
    const voiceWs = await socket(`${wsBase}/workspaces/${boardId}/voice/converse`);
    await waitFor(() => voiceWs.frames.some((f) => f.type === 'ready'), {
      describe: 'voice ready',
    });
    // `start` goes on the voice socket and the words on the audio socket, and
    // nothing orders two sockets: words read before the `start` are the
    // previous turn's cut-in, which withdraws the question they answer. So
    // `listen` resolves only once the server has handled the `start`. A
    // second `start` for setup 2, which this server does not have, is
    // refused with an error frame and changes nothing; one socket is handled
    // in order, so that error means the first `start` is in.
    const listen = async () => {
      const refusals = () => voiceWs.frames.filter((f) => f.type === 'error').length;
      const before = refusals();
      const start = {
        type: 'start',
        mode: 'tap',
        ears: 'meeting',
        context: { surface: 'doc', docId },
      };
      voiceWs.ws.send(JSON.stringify({ ...start, setup: 1 }));
      voiceWs.ws.send(JSON.stringify({ ...start, setup: 2 }));
      await waitFor(() => refusals() > before, { describe: 'the start handled' });
    };
    const speak = (text: string) => {
      for (let i = 0; i < framesFor(text); i++) audio.ws.send(new Uint8Array(640));
    };
    const replies = () => voiceWs.frames.filter((f) => f.type === 'reply');
    const stop = async () => {
      audio.ws.send(JSON.stringify({ type: 'stop' }));
      await waitFor(() => audio.frames.some((f) => f.type === 'stopped'), { describe: 'stopped' });
      audio.ws.close();
      voiceWs.ws.close();
    };
    return { audio, voice: voiceWs, listen, speak, replies, stop };
  }

  const markdown = (docId: string): string => {
    const doc = handle.docStore.get(docId);
    if (!doc) throw new Error(`no doc ${docId}`);
    return prose.serializeFragmentToMarkdown(prose.getProseFragment(doc.ydoc));
  };

  it('asks the plan’s open question at the pause, writes the answer in, and answers “any questions?”', async () => {
    const docId = await huddle('plan');
    const m = await meeting(docId);
    readings.push(
      JSON.stringify({
        ask: 'Who signs off the berth design?',
        heading: 'Work',
        quote: 'new pier',
      }),
    );
    await m.listen();
    m.speak(TALK);
    // Asked at the pause, with nobody tapping Talk.
    await waitFor(() => m.replies().length === 1, { describe: 'the question' });
    expect(m.replies()[0]).toMatchObject({
      spoken: 'Who signs off the berth design?',
      asking: true,
      route: 'interview',
    });
    expect(said).toContain('Who signs off the berth design?');
    expect(reads).toHaveLength(1);
    expect(reads[0]?.user).toContain('Train the Riverbend crews');
    expect(reads[0]?.user).toContain(TALK);
    // The cursor is on the plan's words, in every open view.
    const focus = handle.docStore.get(docId)?.awareness.getLocalState()?.[AGENT_FOCUS_FIELD] as
      | { quote?: string }
      | undefined;
    expect(focus?.quote).toBe('new pier');

    // The answer: written under the heading the question is about.
    await waitFor(() => m.voice.frames.some((f) => f.type === 'audio-end'), {
      describe: 'question said',
    });
    await m.listen();
    m.speak(ANSWER);
    await waitFor(() => m.replies().length === 2, { describe: 'after the answer' });
    expect(m.replies()[1]).toMatchObject({ spoken: 'Written under Work.', asking: true });
    const md = markdown(docId);
    expect(md.indexOf(ANSWER)).toBeGreaterThan(md.indexOf('### Work'));
    expect(lines.some((l) => l.includes('after-answer=edit'))).toBe(true);
    // One reading per pause: the question, then the look for a next one.
    expect(reads).toHaveLength(2);

    // "Any questions?" with nothing worth asking: "No.", and why written.
    readings.push(JSON.stringify({ ask: null, why: 'The plan names an owner for every step.' }));
    await m.listen();
    m.speak(INVITE);
    await waitFor(() => m.replies().length === 3, { describe: 'the invitation answered' });
    expect(m.replies()[2]?.spoken).toBe('No.');
    expect(m.replies()[2]?.detail).toEqual(['The plan names an owner for every step.']);
    expect(reads.at(-1)?.system).toContain('asked whether you have any questions');

    await m.stop();
    // The notes got the talk and the invitation, never the answer the plan has.
    await waitFor(() => composed.some((t) => t === TALK), { describe: 'notes composed' });
    expect(composed).toContain(INVITE);
    expect(composed).not.toContain(ANSWER);
  });

  it('never asks in a meeting that is not a plan', async () => {
    const docId = await huddle('discussion');
    const m = await meeting(docId);
    const before = reads.length;
    await m.listen();
    await waitFor(() => m.voice.frames.some((f) => f.type === 'error'), {
      describe: 'the refusal',
    });
    expect(m.voice.frames.find((f) => f.type === 'error')?.message).toBe(
      'No planning meeting is recording here.',
    );
    m.speak(TALK);
    await waitFor(() => m.audio.frames.some((f) => f.type === 'transcript' && f.final === true), {
      describe: 'the meeting heard it',
    });
    await m.stop();
    expect(m.replies()).toEqual([]);
    expect(reads.length).toBe(before);
  });
});
