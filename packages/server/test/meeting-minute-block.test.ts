/**
 * A minute is a block of its own in the meeting's notes: never merged into
 * the block that holds the request, the reply or the transcript (Bryan,
 * 3 Oct). Through the REAL server: a mic meeting on a board with a live lead,
 * the owner asks "Claude, can you create tasks…", the router hands it to the
 * lead, the lead answers with a minute, and the doc's blocks are read back.
 *
 * Mock transcription, a recorded voice, the server's emailed-code sign-in.
 * Fixture names are the house ones.
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
import { resetOwnerIdentities } from '../src/actor-identity.ts';
import { SESSION_COOKIE } from '../src/auth/session.ts';
import type { NotesComposer, TickScheduler } from '../src/meeting-notes.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { LEAD_ANSWER_ROUTE } from '../src/spoken-reply/lead-answer.ts';
import type { SpokenVoice } from '../src/spoken-reply/tts.ts';
import { type MockScriptTurn, createMockTranscriptionEngine } from '../src/transcribe.ts';
import { ANSWER_VOICE_SINCE } from '../src/voice-quick.ts';
import { type AgentStream, openWorkspaceStream } from './agent-stream.ts';
import { waitFor } from './wait-for.ts';

setDefaultTimeout(30_000);
process.env.CW_LOG_LOGIN_CODES = '1';

const OWNER = ['owner', 'harborlight.test'].join('@');
const TALK = 'We open the Saltmarsh berth in spring.';
const ASK = 'Claude, can you create tasks for the berth work?';
const MINUTE = 'Tasks created: Dredge the Saltmarsh channel, Move the ticket office';
const script = (text: string): MockScriptTurn => ({ words: text.split(' '), settled: text });
const framesFor = (text: string) => text.split(' ').length + 1;
const NEVER: TickScheduler = { set: () => 0, clear: () => {} };

interface Frame {
  type: string;
  [k: string]: unknown;
}

describe('a minute in a mic meeting’s notes', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let wsBase: string;
  let boardId = '';
  let leadStream: AgentStream | null = null;
  const codes: string[] = [];
  const realLog = console.log;

  const voice: SpokenVoice = {
    name: 'recorded',
    async speak(_text, onAudio) {
      onAudio(new Uint8Array(480));
    },
  };
  // The note-taker writes the discussion as a paragraph, so the minute has a
  // transcript block to be merged into if anything merged it.
  const composer: NotesComposer = {
    name: 'one-topic',
    compose: () => Promise.resolve([{ op: 'insert_at_end', markdown: `## Berth\n\n${TALK}` }]),
  };

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  async function signIn(email: string): Promise<string> {
    const before = codes.length;
    expect((await post('/api/auth/start', { email })).status).toBe(200);
    expect(codes.length).toBe(before + 1);
    const res = await post('/api/auth/verify', { email, code: codes.at(-1) });
    expect(res.status).toBe(200);
    const pair = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    expect(pair.startsWith(`${SESSION_COOKIE}=`)).toBe(true);
    return pair;
  }

  beforeAll(async () => {
    console.log = (...args: unknown[]) => {
      const m = args
        .map(String)
        .join(' ')
        .match(/login code for \S+: (\d{6})/);
      if (m?.[1]) codes.push(m[1]);
    };
    dataDir = mkdtempSync(join(tmpdir(), 'cw-minute-block-'));
    handle = createServer({
      port: 0,
      dataDir,
      emailCodeSignIn: true,
      ownerEmail: OWNER,
      transcription: createMockTranscriptionEngine([script(TALK), script(ASK)]),
      meetingNotes: { composer, quietMs: 60_000, schedule: NEVER },
      spokenReply: {
        listener: { name: 'unused', open: () => Promise.reject(new Error('not this one')) },
        voices: { 1: voice, 2: null },
        gemini: null,
      },
    });
    base = `http://127.0.0.1:${handle.port}`;
    wsBase = `ws://127.0.0.1:${handle.port}`;
    const ws = await post('/workspaces', { name: 'Harborlight' });
    boardId = ((await ws.json()) as { workspace: { id: string } }).workspace.id;
    handle.tasks.attachAgent(boardId, {
      agentId: 'lead',
      runtime: 'claude-code-local',
      pluginVersion: ANSWER_VOICE_SINCE,
    });
    leadStream = await openWorkspaceStream(base, boardId, {}, 'lead');
  });

  afterAll(async () => {
    console.log = realLog;
    resetOwnerIdentities();
    await leadStream?.close();
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function socket(url: string, cookie?: string) {
    const ws = new WebSocket(url, (cookie ? { headers: { cookie } } : undefined) as never);
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

  it('is one block holding the minute alone', async () => {
    const cookie = await signIn(OWNER);
    const r = await post(`/workspaces/${boardId}/huddles`, {});
    const docId = ((await r.json()) as { docId: string }).docId;
    const audio = await socket(`${wsBase}${meetingSocketPath(boardId, docId)}`);
    audio.ws.send(
      JSON.stringify({
        type: 'start',
        sampleRate: MEETING_SAMPLE_RATE,
        encoding: MEETING_AUDIO_ENCODING,
      }),
    );
    await waitFor(() => audio.frames.some((f) => f.type === 'ready'), { describe: 'ready' });
    const page = await socket(`${wsBase}/workspaces/${boardId}/voice/converse`, cookie);
    await waitFor(() => page.frames.some((f) => f.type === 'ready'), { describe: 'voice ready' });
    const listen = () =>
      page.ws.send(
        JSON.stringify({
          type: 'start',
          setup: 1,
          mode: 'tap',
          ears: 'meeting',
          context: { surface: 'doc', docId },
        }),
      );
    const speak = (text: string) => {
      for (let i = 0; i < framesFor(text); i++) audio.ws.send(new Uint8Array(640));
    };
    const replies = () => page.frames.filter((f) => f.type === 'reply');

    listen();
    speak(TALK);
    // Talk nobody addressed is heard and answered with silence.
    await waitFor(() => replies().length === 1, { describe: 'the talk heard' });
    expect(replies()[0]?.spoken).toBe('');
    listen();
    speak(ASK);
    await waitFor(() => replies().length === 2, { describe: 'the lead takes it' });
    // The lead took it: nothing is said until it answers.
    expect(replies()[1]?.spoken).toBe('');
    const queueId = handle.tasks.listQueuedVoice(boardId).at(-1)?.id ?? '';
    expect(queueId).not.toBe('');

    listen();
    const answered = await post(`/workspaces/${boardId}/voice-queue/${queueId}/answer`, {
      agentId: 'lead',
      text: 'Two tasks made.',
      minute: MINUTE,
    });
    expect(await answered.json()).toEqual({ ok: true, delivered: true });
    await waitFor(() => replies().some((f) => f.route === LEAD_ANSWER_ROUTE), {
      describe: 'the lead’s answer said',
    });

    audio.ws.send(JSON.stringify({ type: 'stop' }));
    await waitFor(() => audio.frames.some((f) => f.type === 'stopped'), { describe: 'stopped' });
    audio.ws.close();
    page.ws.close();

    const blocks = () => {
      const doc = handle.docStore.get(docId);
      if (!doc) throw new Error(`no doc ${docId}`);
      return prose.readOutline(doc.ydoc).filter((b) => b.kind !== 'heading');
    };
    await waitFor(() => blocks().some((b) => b.text.includes('Tasks created')), {
      describe: 'the minute written',
    });
    const holding = blocks().filter((b) => b.text.includes('Tasks created'));
    expect(holding.map((b) => b.text)).toEqual([`Claude: ${MINUTE}`]);
    const talk = blocks().filter((b) => b.text.includes('Saltmarsh berth in spring'));
    expect(talk).toHaveLength(1);
    expect(talk[0]?.id).not.toBe(holding[0]?.id);
    // Neither the request nor the reply is in the notes, in any block.
    for (const b of blocks()) {
      expect(b.text).not.toContain('create tasks for the berth');
      expect(b.text).not.toContain('Two tasks made');
    }
  });
});
