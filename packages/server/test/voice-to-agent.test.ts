/**
 * A voice conversation with one named agent, through the REAL server.
 *
 * The page opens the board's converse socket and names an agent in `start`.
 * Each turn reaches that agent's own stream and nobody else's; the agent
 * answers with `answer_voice`, and the answer is said on the page that asked.
 * Each turn carries the conversation so far, until the page names another
 * agent. Fake engines; nothing reaches a vendor. Fixture names are the house
 * ones.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { LEAD_ANSWER_ROUTE } from '../src/spoken-reply/lead-answer.ts';
import type { SpokenVoice } from '../src/spoken-reply/tts.ts';
import type { TranscriptionEngine, TranscriptionOpenOpts } from '../src/transcribe.ts';
import { agentStream } from './agent-voice-stream.ts';
import { waitFor } from './wait-for.ts';

setDefaultTimeout(30_000);

const PERSON = { id: 'known-alice', name: 'Alice', kind: 'known', color: '#2e7dd7' };

interface Frame {
  type: string;
  [k: string]: unknown;
}

describe('a voice conversation with a named agent', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let boardId = '';
  const opened: TranscriptionOpenOpts[] = [];
  const said: string[] = [];
  let lead: Awaited<ReturnType<typeof agentStream>>;
  let helper: Awaited<ReturnType<typeof agentStream>>;

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
    dataDir = mkdtempSync(join(tmpdir(), 'cw-voice-agent-'));
    handle = createServer({
      port: 0,
      dataDir,
      spokenReply: { listener, voices: { 1: voice, 2: null }, gemini: null },
    });
    base = `http://127.0.0.1:${handle.port}`;
    const ws = await post('/workspaces', { name: 'Harborlight' });
    boardId = ((await ws.json()) as { workspace: { id: string } }).workspace.id;
    // The first attach takes the lead seat; the helper is a bystander, which
    // is the point: nothing here routes by the seat.
    handle.tasks.attachAgent(boardId, {
      agentId: 'harborlight-lead',
      agentName: 'Harborlight Lead',
      runtime: 'claude-code-local',
    });
    handle.tasks.attachAgent(boardId, {
      agentId: 'riverbend-helper',
      agentName: 'Riverbend Helper',
      runtime: 'claude-code-local',
    });
    handle.tasks.attachAgent(boardId, {
      agentId: 'saltmarsh-away',
      agentName: 'Saltmarsh Away',
      runtime: 'claude-code-local',
    });
    lead = await agentStream(base, boardId, 'harborlight-lead');
    helper = await agentStream(base, boardId, 'riverbend-helper');
  });

  afterAll(async () => {
    lead.close();
    helper.close();
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

  async function say(ws: WebSocket, frames: Frame[], agent: string, text: string) {
    const before = opened.length;
    const replies = frames.filter((f) => f.type === 'reply').length;
    ws.send(JSON.stringify({ type: 'start', setup: 1, mode: 'hold', author: PERSON, agent }));
    await waitFor(() => opened.length > before, { describe: 'listener opened' });
    opened.at(-1)?.onTurn({ turn: 0, text, final: true });
    ws.send(JSON.stringify({ type: 'end' }));
    await waitFor(() => frames.filter((f) => f.type === 'reply').length > replies, {
      describe: 'reply',
    });
    return frames.filter((f) => f.type === 'reply').at(-1);
  }

  const answer = (queueId: string, agentId: string, text: string) =>
    post(`/workspaces/${boardId}/voice-queue/${queueId}/answer`, { agentId, text });

  it('a turn reaches only the named agent, and its answer is said on the page that asked', async () => {
    const page = await connect();
    const other = await connect();
    const reply = await say(page.ws, page.frames, 'riverbend-helper', 'how far is Saltmarsh');
    // Nothing is said or shown for a turn that reached the agent: the turn is
    // the message, and the agent's answer is the reply.
    expect(reply?.spoken).toBe('');
    expect(reply?.detail).toEqual([]);

    await waitFor(() => helper.voice.length === 1, { describe: 'helper got the turn' });
    const turn = helper.voice[0];
    expect(turn?.transcript).toBe('how far is Saltmarsh');
    expect(turn?.to).toBe('riverbend-helper');
    // The lead holds a stream on the same board and hears nothing of it.
    expect(lead.voice.some((v) => v.transcript === 'how far is Saltmarsh')).toBe(false);

    const queueId = turn?.queueId ?? '';
    // Another agent on the board cannot answer it aloud.
    expect(await (await answer(queueId, 'harborlight-lead', 'Wrong one.')).json()).toEqual({
      ok: true,
      delivered: false,
    });
    const words = 'Twelve miles. The ferry takes forty minutes.';
    expect(await (await answer(queueId, 'riverbend-helper', words)).json()).toEqual({
      ok: true,
      delivered: true,
    });
    await waitFor(() => page.frames.some((f) => f.route === LEAD_ANSWER_ROUTE), {
      describe: 'answer on the asking page',
    });
    expect(page.frames.find((f) => f.route === LEAD_ANSWER_ROUTE)?.spoken).toBe(words);
    await waitFor(() => said.slice(-2).join(' ') === words, { describe: 'voice said it' });
    expect(other.frames.some((f) => f.route === LEAD_ANSWER_ROUTE)).toBe(false);
    // Nothing on the page, in words or in voice, ever said where it was sent.
    expect(JSON.stringify(page.frames)).not.toContain('Sent to');
    expect(said.join(' ')).not.toContain('Sent to');

    // The next turn carries the conversation so far, under the same id.
    await say(page.ws, page.frames, 'riverbend-helper', 'and the return trip');
    await waitFor(() => helper.voice.length === 2, { describe: 'second turn' });
    const second = helper.voice[1];
    expect(second?.conversationId).toBe(turn?.conversationId);
    expect(second?.conversation).toEqual([
      { from: 'owner', text: 'how far is Saltmarsh' },
      { from: 'agent', text: words },
    ]);

    // Switching agents starts a new conversation with the new agent.
    await say(page.ws, page.frames, 'harborlight-lead', 'what is left this week');
    await waitFor(() => lead.voice.some((v) => v.transcript === 'what is left this week'), {
      describe: 'lead got the switched turn',
    });
    const switched = lead.voice.find((v) => v.transcript === 'what is left this week');
    expect(switched?.conversationId).not.toBe(turn?.conversationId);
    expect(switched?.conversation).toEqual([]);
    expect(helper.voice).toHaveLength(2);
    page.ws.close();
    other.ws.close();
  });

  it('an agent with no stream is told later, and the page says so aloud', async () => {
    const page = await connect();
    const reply = await say(page.ws, page.frames, 'saltmarsh-away', 'book the noon boat');
    expect(reply?.spoken).toBe('Saltmarsh Away is away. I’ll pass it on when they’re back.');
    const rows = handle.tasks.listQueuedComments(boardId);
    const row = rows.find((r) => r.agentId === 'saltmarsh-away');
    expect(row?.event).toBe('voice.request');
    expect(row?.text).toBe('book the noon boat');
    expect(rows.filter((r) => r.text === 'book the noon boat')).toHaveLength(1);
    page.ws.close();
  });

  it('an agent that is not on this board gets nothing', async () => {
    const page = await connect();
    const reply = await say(page.ws, page.frames, 'bob-elsewhere', 'hello');
    expect(reply?.spoken).toBe('That agent isn’t on this board.');
    expect(
      handle.tasks.listQueuedComments(boardId).some((r) => r.agentId === 'bob-elsewhere'),
    ).toBe(false);
    page.ws.close();
  });
});
