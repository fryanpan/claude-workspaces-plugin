/**
 * In a planning meeting, Claude's minute goes under the plan section it is
 * about, as a block of its own (Bryan, 3 Oct: "Next to the topic"). A plan
 * has no notes section, so a minute sent there was held for one that never
 * came. Through the REAL server: a planning meeting on a board with a live
 * lead, the owner asks "Claude, …", the lead answers with a minute, and the
 * doc's blocks are read back.
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
const PLAN = [
  '# Harborlight launch',
  '',
  '## Goals',
  '',
  'Open the Saltmarsh berth in spring.',
  '',
  '## Risks',
  '',
  'The Riverbend channel silts up.',
  '',
  '## Open questions',
  '',
  'Who runs the ticket office?',
  '',
].join('\n');
const ASK_RISKS = 'Claude, create tasks for the Riverbend risks.';
const ASK_FERRY = 'Claude, can you book the ferry for Friday?';
const ASK_SIGNS = 'Claude, can you order the dock signs?';
const SIGNS_MINUTE = 'Decided: the dock signs come from Saltmarsh Print';
const RISKS_MINUTE = 'Tasks created: Dredge the Riverbend channel';
const FERRY_MINUTE = 'Decided: the ferry is booked for Friday';
const script = (text: string): MockScriptTurn => ({ words: text.split(' '), settled: text });
const framesFor = (text: string) => text.split(' ').length + 1;
const NEVER: TickScheduler = { set: () => 0, clear: () => {} };

interface Frame {
  type: string;
  [k: string]: unknown;
}

describe('a minute in a planning meeting', () => {
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
  // A planning meeting's note-taker edits the plan, so it opens no notes
  // section of its own.
  const composer: NotesComposer = { name: 'plan-edits', compose: () => Promise.resolve([]) };

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
    dataDir = mkdtempSync(join(tmpdir(), 'cw-plan-minute-'));
    handle = createServer({
      port: 0,
      dataDir,
      emailCodeSignIn: true,
      ownerEmail: OWNER,
      transcription: createMockTranscriptionEngine([
        script(ASK_FERRY),
        script(ASK_RISKS),
        script(ASK_SIGNS),
      ]),
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

  it('goes under the section it is about, else the last one talked about, each its own block', async () => {
    const cookie = await signIn(OWNER);
    const r = await post(`/workspaces/${boardId}/huddles`, { kind: 'plan' });
    const docId = ((await r.json()) as { docId: string }).docId;
    expect(handle.docStore.setDocContent(docId, PLAN)).toEqual({ ok: true });
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
    const outline = () => {
      const doc = handle.docStore.get(docId);
      if (!doc) throw new Error(`no doc ${docId}`);
      return prose.readOutline(doc.ydoc);
    };
    const headingId = (text: string) =>
      outline().find((b) => b.kind === 'heading' && b.text === text)?.id;
    const holding = (words: string) => outline().filter((b) => b.text.includes(words));
    /** The texts of section `heading`'s blocks, in order. */
    const section = (heading: string) =>
      outline()
        .filter((b) => b.kind !== 'heading' && b.underHeadingId === headingId(heading))
        .map((b) => b.text);
    const fromLead = () => replies().filter((f) => f.route === LEAD_ANSWER_ROUTE).length;
    /** The owner asks, the lead takes it (nothing said) and answers with `minute`. */
    const askAndAnswer = async (ask: string, minute: string) => {
      const before = replies().length;
      const said = fromLead();
      listen();
      speak(ask);
      await waitFor(() => replies().length > before, { describe: `taken: ${ask}` });
      expect(replies()[before]?.spoken).toBe('');
      const queueId = handle.tasks.listQueuedVoice(boardId).at(-1)?.id ?? '';
      expect(queueId).not.toBe('');
      listen();
      const answered = await post(`/workspaces/${boardId}/voice-queue/${queueId}/answer`, {
        agentId: 'lead',
        text: 'Done.',
        minute,
      });
      expect(await answered.json()).toEqual({ ok: true, delivered: true });
      await waitFor(() => fromLead() === said + 1, { describe: `the lead’s answer to: ${ask}` });
      await waitFor(() => holding(minute).length === 1, { describe: `the minute: ${minute}` });
    };

    // Names no section, and nothing has been talked about: the end of the plan.
    await askAndAnswer(ASK_FERRY, FERRY_MINUTE);
    expect(section('Open questions')).toEqual([
      'Who runs the ticket office?',
      `Claude: ${FERRY_MINUTE}`,
    ]);

    // Names Risks: under Risks, after what it already said, as its own block.
    await askAndAnswer(ASK_RISKS, RISKS_MINUTE);
    expect(section('Risks')).toEqual([
      'The Riverbend channel silts up.',
      `Claude: ${RISKS_MINUTE}`,
    ]);

    // Names no section again: under Risks, the section last talked about.
    await askAndAnswer(ASK_SIGNS, SIGNS_MINUTE);
    expect(section('Risks')).toEqual([
      'The Riverbend channel silts up.',
      `Claude: ${RISKS_MINUTE}`,
      `Claude: ${SIGNS_MINUTE}`,
    ]);
    expect(section('Goals')).toEqual(['Open the Saltmarsh berth in spring.']);

    audio.ws.send(JSON.stringify({ type: 'stop' }));
    await waitFor(() => audio.frames.some((f) => f.type === 'stopped'), { describe: 'stopped' });
    audio.ws.close();
    page.ws.close();
    // Ending the meeting writes neither a second time.
    expect(holding(RISKS_MINUTE)).toHaveLength(1);
    expect(holding(FERRY_MINUTE)).toHaveLength(1);
    expect(holding(SIGNS_MINUTE)).toHaveLength(1);
  });
});
