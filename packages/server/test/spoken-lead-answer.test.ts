/**
 * The lead's answer to a spoken request, said on the page that asked.
 *
 * "What's the status", "go research ferry fares": the router queues these for
 * the board's lead and says nothing: the page shows it working. The lead
 * answers with `answer_voice`, which posts to
 * `/workspaces/<ws>/voice-queue/<id>/answer`, and the socket the question
 * came from says the answer — the only words spoken for the request. Fake engines; nothing reaches a
 * vendor. Fixture names are the house ones.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import type { SpokenAnswer } from '../src/spoken-reply/answer.ts';
import {
  LEAD_ANSWER_MAX,
  LEAD_ANSWER_ROUTE,
  LEAD_ANSWER_WINDOW_MS,
  LEAD_MINUTE_MAX,
  LeadAnswers,
} from '../src/spoken-reply/lead-answer.ts';
import type { SpokenVoice } from '../src/spoken-reply/tts.ts';
import type { TranscriptionEngine, TranscriptionOpenOpts } from '../src/transcribe.ts';
import { ANSWER_VOICE_SINCE } from '../src/voice-quick.ts';
import { type AgentStream, openWorkspaceStream } from './agent-stream.ts';
import { waitFor } from './wait-for.ts';

setDefaultTimeout(30_000);

describe('LeadAnswers', () => {
  it('says the answer once, on the socket that waits for it', () => {
    const leads = new LeadAnswers();
    const a: SpokenAnswer[] = [];
    const b: SpokenAnswer[] = [];
    leads.wait('w1', 'q1', {}, (x) => a.push(x));
    leads.wait('w1', 'q2', {}, (x) => b.push(x));
    expect(leads.answer('w1', 'q1', 'Ferry fares start at twelve. The noon boat is full.')).toBe(
      true,
    );
    expect(a).toHaveLength(1);
    expect(a[0]?.route).toBe(LEAD_ANSWER_ROUTE);
    expect(a[0]?.spoken).toBe('Ferry fares start at twelve. The noon boat is full.');
    expect(b).toHaveLength(0);
    // Said once: a second answer to the same row reaches nobody.
    expect(leads.answer('w1', 'q1', 'Again.')).toBe(false);
  });

  it('an id from another board, an empty answer, a closed socket and an old wait reach nobody', () => {
    let now = 0;
    const leads = new LeadAnswers(() => now);
    const said: SpokenAnswer[] = [];
    const owner = {};
    leads.wait('w1', 'q1', owner, (x) => said.push(x));
    expect(leads.answer('w2', 'q1', 'Wrong board.')).toBe(false);
    expect(leads.answer('w1', 'q1', '   ')).toBe(false);
    leads.drop(owner);
    expect(leads.answer('w1', 'q1', 'Gone.')).toBe(false);
    leads.wait('w1', 'q3', {}, (x) => said.push(x));
    now = LEAD_ANSWER_WINDOW_MS + 1;
    expect(leads.answer('w1', 'q3', 'Too late.')).toBe(false);
    expect(said).toHaveLength(0);
  });

  it('a turn addressed to one agent takes only that agent’s answer', () => {
    const leads = new LeadAnswers();
    const said: SpokenAnswer[] = [];
    leads.wait('w1', 'q1', {}, (x) => said.push(x), 'riverbend');
    expect(leads.answer('w1', 'q1', 'Not mine.', undefined, 'harborlight')).toBe(false);
    expect(leads.answer('w1', 'q1', 'Not signed.')).toBe(false);
    expect(leads.answer('w1', 'q1', 'Mine.', undefined, 'riverbend')).toBe(true);
    expect(said.map((s) => s.spoken)).toEqual(['Mine.']);
  });
});

const PERSON = { id: 'known-alice', name: 'Alice', kind: 'known', color: '#2e7dd7' };

interface Frame {
  type: string;
  [k: string]: unknown;
}

describe('the lead’s answer through the real server', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let boardId = '';
  const opened: TranscriptionOpenOpts[] = [];
  const said: string[] = [];
  let leadStream: AgentStream | null = null;

  const listener: TranscriptionEngine = {
    name: 'fake',
    async open(opts) {
      opened.push(opts);
      return { send: () => {}, close: async () => {} };
    },
  };
  const voice: SpokenVoice = {
    name: 'fake',
    async speak(text, onAudio) {
      said.push(text);
      onAudio(new Uint8Array(480));
    },
  };

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-lead-answer-'));
    handle = createServer({
      port: 0,
      dataDir,
      spokenReply: { listener, voices: { 1: voice, 2: null }, gemini: null },
    });
    base = `http://127.0.0.1:${handle.port}`;
    const ws = await post('/workspaces', { name: 'Harborlight' });
    boardId = ((await ws.json()) as { workspace: { id: string } }).workspace.id;
    // The first agent on an empty seat is the lead; its open stream is what
    // makes it reachable, as the MCP opens it straight after attaching.
    handle.tasks.attachAgent(boardId, {
      agentId: 'lead',
      runtime: 'claude-code-local',
      pluginVersion: ANSWER_VOICE_SINCE,
    });
    leadStream = await openWorkspaceStream(base, boardId, {}, 'lead');
    expect(handle.tasks.hasLiveLeadAttachment(boardId)).toBe(true);
  });

  afterAll(async () => {
    await leadStream?.close();
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function connect() {
    const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/workspaces/${boardId}/voice/converse`);
    ws.binaryType = 'arraybuffer';
    const frames: Frame[] = [];
    ws.addEventListener('message', (ev) => {
      if (typeof ev.data === 'string') frames.push(JSON.parse(ev.data) as Frame);
    });
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('converse socket refused')));
    });
    await waitFor(() => frames.some((f) => f.type === 'ready'), { describe: 'ready' });
    return { ws, frames };
  }

  async function ask(ws: WebSocket, frames: Frame[], text: string): Promise<Frame | undefined> {
    const before = opened.length;
    const replies = frames.filter((f) => f.type === 'reply').length;
    ws.send(JSON.stringify({ type: 'start', setup: 1, mode: 'hold', author: PERSON }));
    await waitFor(() => opened.length > before, { describe: 'listener opened' });
    opened.at(-1)?.onTurn({ turn: 0, text, final: true });
    ws.send(JSON.stringify({ type: 'end' }));
    await waitFor(() => frames.filter((f) => f.type === 'reply').length > replies, {
      describe: 'reply',
    });
    return frames.filter((f) => f.type === 'reply').at(-1);
  }

  const queued = () => handle.tasks.listQueuedVoice(boardId).map((r) => r.id);

  it('a research request shows the page working and speaks only the lead’s answer', async () => {
    const asker = await connect();
    const other = await connect();
    const saidBefore = said.length;
    const reply = await ask(asker.ws, asker.frames, 'go research ferry fares to Riverbend');
    // No "On it.": the page is told the lead is working, and nothing is said.
    expect(reply?.spoken).toBe('');
    expect(reply).not.toHaveProperty('awaiting');
    const turnEnd = asker.frames.findIndex((f) => f.type === 'turn-end');
    const replyAt = asker.frames.indexOf(reply as Frame);
    expect(asker.frames.slice(turnEnd, replyAt).some((f) => f.type === 'working')).toBe(true);
    const queueId = queued().at(-1) ?? '';
    expect(queueId).not.toBe('');

    const answer = 'Ferry fares to Riverbend start at twelve dollars. The noon boat is full.';
    const r = await post(`/workspaces/${boardId}/voice-queue/${queueId}/answer`, {
      agentId: 'lead',
      text: answer,
    });
    expect(await r.json()).toEqual({ ok: true, delivered: true });
    await waitFor(() => asker.frames.some((f) => f.route === LEAD_ANSWER_ROUTE), {
      describe: 'lead answer on the asking socket',
    });
    const spoken = asker.frames.find((f) => f.route === LEAD_ANSWER_ROUTE);
    expect(spoken?.spoken).toBe(answer);
    await waitFor(() => said.slice(-2).join(' ') === answer, { describe: 'voice said it' });
    // The reply is the only thing spoken for the request.
    expect(said.slice(saidBefore).join(' ')).toBe(answer);
    // The other page on the same board is not told.
    expect(other.frames.some((f) => f.route === LEAD_ANSWER_ROUTE)).toBe(false);
    asker.ws.close();
    other.ws.close();
  });

  it('a status ask goes to the live lead, and a closed page reports the answer undelivered', async () => {
    const { ws, frames } = await connect();
    const reply = await ask(ws, frames, 'what’s the status');
    expect(reply?.spoken).toBe('');
    const queueId = queued().at(-1) ?? '';
    ws.close();
    const path = `/workspaces/${boardId}/voice-queue/${queueId}/answer`;
    await waitFor(
      async () =>
        (
          (await (await post(path, { agentId: 'lead', text: 'Three open.' })).json()) as {
            delivered: boolean;
          }
        ).delivered === false,
      { describe: 'undelivered once the socket closed' },
    );
  });

  it('refuses an empty answer and one over the cap', async () => {
    const path = `/workspaces/${boardId}/voice-queue/vq-x/answer`;
    const lead = { agentId: 'lead' };
    expect((await post(path, lead)).status).toBe(400);
    expect((await post(path, { ...lead, text: '  ' })).status).toBe(400);
    expect((await post(path, { ...lead, text: 'a'.repeat(LEAD_ANSWER_MAX + 1) })).status).toBe(400);
    // A minute is a line of text for a meeting's notes, and nothing else.
    expect((await post(path, { ...lead, text: 'Fine.', minute: ['a'] })).status).toBe(400);
    expect((await post(path, { ...lead, text: 'Fine.', minute: 7 })).status).toBe(400);
    expect(
      (await post(path, { ...lead, text: 'Fine.', minute: 'a'.repeat(LEAD_MINUTE_MAX + 1) }))
        .status,
    ).toBe(400);
    expect(
      await (await post(path, { ...lead, text: 'Fine.', minute: 'Decided: spring.' })).json(),
    ).toEqual({ ok: true, delivered: false });
    expect(await (await post(path, { ...lead, text: 'Fine.' })).json()).toEqual({
      ok: true,
      delivered: false,
    });
  });

  it('answers only for an agent on this board, proved the way its own feed is', async () => {
    const path = `/workspaces/${boardId}/voice-queue/vq-x/answer`;
    expect((await post(path, { text: 'Fine.' })).status).toBe(400);
    // An agent that is not on this board.
    expect((await post(path, { agentId: 'agent-elsewhere', text: 'Fine.' })).status).toBe(403);
    // A bearer that does not speak for the agent named.
    const forged = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer at1.not-signed-by-this-server',
      },
      body: JSON.stringify({ agentId: 'lead', text: 'Fine.' }),
    });
    expect(forged.status).toBe(403);
  });
});
