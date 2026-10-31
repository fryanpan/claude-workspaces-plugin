/**
 * A "Claude, …" in a meeting is asked with the meeting: the doc's text as it
 * stands and what the room said before the request, for the router's model
 * and for the lead (Bryan, 3 Oct: does it have "the full meeting notes
 * including whatever speech led up to the request"?). Both are fenced as
 * untrusted, because anyone in the room can speak.
 *
 * Through the REAL server: a mic meeting on a board with a live lead, the
 * router's model a script that records its prompt, and a lead that answers
 * only from what the request reached it with. Fixture names are the house
 * ones.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MEETING_AUDIO_ENCODING,
  MEETING_SAMPLE_RATE,
  meetingSocketPath,
} from '@claude-workspaces/core';
import { resetOwnerIdentities } from '../src/actor-identity.ts';
import { SESSION_COOKIE } from '../src/auth/session.ts';
import type { NotesComposer, TickScheduler } from '../src/meeting-notes.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { LEAD_ANSWER_ROUTE } from '../src/spoken-reply/lead-answer.ts';
import type { SpokenVoice } from '../src/spoken-reply/tts.ts';
import { type MockScriptTurn, createMockTranscriptionEngine } from '../src/transcribe.ts';
import { MEETING_DATA_BEGIN, MEETING_DATA_END } from '../src/voice-meeting-context.ts';
import { PROMPT_DATA_END } from '../src/voice-prompt.ts';
import { ANSWER_VOICE_SINCE } from '../src/voice-quick.ts';
import { waitFor } from './wait-for.ts';

setDefaultTimeout(30_000);
process.env.CW_LOG_LOGIN_CODES = '1';

const OWNER = ['owner', 'harborlight.test'].join('@');
const TALK = 'So the Saltmarsh channel has to be dredged before the thaw.';
const ASK = 'Claude, do you have enough information to create tasks?';
const NOTES =
  '## Berth work\n\n- Dredge the Saltmarsh channel to four metres\n- Move the ticket office to the new pier';
const script = (text: string): MockScriptTurn => ({ words: text.split(' '), settled: text });
const framesFor = (text: string) => text.split(' ').length + 1;
const NEVER: TickScheduler = { set: () => 0, clear: () => {} };

interface Frame {
  type: string;
  [k: string]: unknown;
}

interface VoiceRequest {
  queueId?: string;
  transcript?: string;
  meeting?: { notes?: string; heard?: string };
}

/** The lead, answering only from what the request reached it with. */
function leadAnswer(r: VoiceRequest): string {
  const notes = r.meeting?.notes ?? '';
  const heard = r.meeting?.heard ?? '';
  if (notes.includes('Move the ticket office') && heard.includes('dredged')) {
    return 'Yes: dredging the channel and moving the ticket office.';
  }
  return 'I can’t see the meeting.';
}

describe('a "Claude, …" in a meeting is asked with the meeting', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let wsBase: string;
  let boardId = '';
  const prompts: Array<{ system: string; user: string }> = [];
  const requests: VoiceRequest[] = [];
  const stream = new AbortController();
  const codes: string[] = [];
  const realLog = console.log;

  const voice: SpokenVoice = {
    name: 'recorded',
    async speak(_text, onAudio) {
      onAudio(new Uint8Array(480));
    },
  };
  const composer: NotesComposer = { name: 'quiet', compose: () => Promise.resolve([]) };

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  async function signIn(email: string): Promise<string> {
    const before = codes.length;
    expect((await post('/api/auth/start', { email })).status).toBe(200);
    expect(codes.length).toBe(before + 1);
    const res = await post('/api/auth/verify', { email, code: codes.at(-1) });
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
    dataDir = mkdtempSync(join(tmpdir(), 'cw-ask-context-'));
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
      // The router as prod runs it: one pick among options. This script
      // records its prompt and hands everything to the lead.
      voiceRouterArm: 'choice',
      voiceComplete: async (args) => {
        prompts.push(args);
        return JSON.stringify({ choice: 'none', confidence: 0.9 });
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
    // The lead's own stream, read for its voice requests.
    const res = await fetch(`${base}/workspaces/${boardId}/events:stream?agentId=lead`, {
      headers: { accept: 'text/event-stream' },
      signal: stream.signal,
    });
    const reader = res.body?.getReader();
    void (async () => {
      const dec = new TextDecoder();
      let buf = '';
      try {
        for (;;) {
          const chunk = await reader?.read();
          if (!chunk || chunk.done) return;
          buf += dec.decode(chunk.value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.startsWith('data:') || !line.includes('voice.request')) continue;
            requests.push(JSON.parse(line.slice(5)) as VoiceRequest);
          }
        }
      } catch {
        // Aborted at the end.
      }
    })();
  });

  afterAll(async () => {
    console.log = realLog;
    resetOwnerIdentities();
    stream.abort();
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

  it('"do you have enough information to create tasks?" is answered about the doc', async () => {
    const cookie = await signIn(OWNER);
    const r = await post(`/workspaces/${boardId}/huddles`, {});
    const docId = ((await r.json()) as { docId: string }).docId;
    handle.docStore.applyBlockEdits(docId, [{ op: 'insert_at_end', markdown: NOTES }], {
      author: 'fixture',
    });
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
    await waitFor(() => replies().length === 1, { describe: 'the talk heard' });
    listen();
    speak(ASK);
    await waitFor(() => replies().length === 2, { describe: 'the lead takes it' });
    // The lead took it: nothing is said until it answers.
    expect(replies()[1]?.spoken).toBe('');

    // The router's model read the meeting, fenced as meeting content, after
    // the workspace's fence and before the request.
    const routed = prompts.find((p) => p.user.includes('enough information to create tasks'));
    const user = routed?.user ?? '';
    expect(routed?.system).toContain(MEETING_DATA_BEGIN);
    const begin = user.indexOf(MEETING_DATA_BEGIN);
    expect(begin).toBeGreaterThan(user.indexOf(PROMPT_DATA_END));
    expect(user.indexOf('Move the ticket office')).toBeGreaterThan(begin);
    expect(user.indexOf(TALK)).toBeGreaterThan(begin);
    expect(user.indexOf(MEETING_DATA_END)).toBeLessThan(user.indexOf('Utterance:'));

    // The lead got the same, and answers about the doc from it.
    await waitFor(() => requests.some((q) => q.queueId), {
      describe: 'the request reached the lead',
    });
    const req = requests.find((q) => q.queueId) as VoiceRequest;
    listen();
    const answered = await post(`/workspaces/${boardId}/voice-queue/${req.queueId}/answer`, {
      agentId: 'lead',
      text: leadAnswer(req),
    });
    expect(await answered.json()).toEqual({ ok: true, delivered: true });
    await waitFor(() => replies().some((f) => f.route === LEAD_ANSWER_ROUTE), {
      describe: 'the lead’s answer said',
    });
    const said = String(replies().find((f) => f.route === LEAD_ANSWER_ROUTE)?.spoken ?? '');
    expect(said).toBe('Yes: dredging the channel and moving the ticket office.');
    for (const f of replies()) expect(String(f.spoken)).not.toMatch(/open —|in progress/);

    audio.ws.send(JSON.stringify({ type: 'stop' }));
    await waitFor(() => audio.frames.some((f) => f.type === 'stopped'), { describe: 'stopped' });
    audio.ws.close();
    page.ws.close();
  });
});
