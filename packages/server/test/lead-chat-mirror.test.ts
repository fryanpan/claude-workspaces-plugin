/**
 * The lead chat mirrors the lead's own Claude Code session, through the REAL
 * server: the plugin's UserPromptSubmit and Stop hooks post to the routes
 * they already post to, and an already-open page on the board is told of
 * each prompt and each turn's closing message. A message to the lead shows
 * received when the lead's MCP child acks its row and done when that
 * session's turn ends. Nothing mirrored is spoken: speech is `answer_voice`'s
 * alone. Fake listener and voice; nothing reaches a vendor.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LeadChatMessage } from '@claude-workspaces/core/lead-chat';
import { type ServerHandle, createServer } from '../src/server.ts';
import type { SpokenVoice } from '../src/spoken-reply/tts.ts';
import type { TranscriptionEngine, TranscriptionOpenOpts } from '../src/transcribe.ts';
import { agentStream } from './agent-voice-stream.ts';
import { pageStream } from './lead-chat-page-stream.ts';
import { waitFor } from './wait-for.ts';

setDefaultTimeout(30_000);

const BRYAN = { id: 'known-bryan', name: 'Bryan', kind: 'known', color: '#2e7dd7' };
const LEAD = 'Harborlight Lead';
const HELPER = 'Riverbend Helper';
/** The done-when line's bound: a change reaches an open page within 1s. The
 *  frame is pushed, so this deadline is the criterion, not a sleep. */
const WITHIN_1S = { timeout: 1000 } as const;

interface Frame {
  type: string;
  [k: string]: unknown;
}

describe('the lead chat mirrors the lead’s session', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let boardId = '';
  const opened: TranscriptionOpenOpts[] = [];
  const said: string[] = [];
  let lead: Awaited<ReturnType<typeof agentStream>>;
  let page: Awaited<ReturnType<typeof pageStream>>;

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
  const agentPath = (name: string, leaf: string) =>
    `/workspaces/${boardId}/agents/${encodeURIComponent(name)}/${leaf}`;
  const prompt = (name: string, body: Record<string, unknown>) =>
    post(agentPath(name, 'prompts'), { at: Date.now(), ...body });
  const turnEnd = (name: string, text: string) =>
    post(agentPath(name, 'notes'), { kind: 'turn', text, at: Date.now() });
  /** A message as the page holds it now: the last frame for its id. */
  const latest = (pred: (m: LeadChatMessage) => boolean): LeadChatMessage | undefined => {
    const hit = page.messages.filter(pred).at(-1);
    return hit ? page.messages.filter((m) => m.id === hit.id).at(-1) : undefined;
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-lead-chat-mirror-'));
    handle = createServer({
      port: 0,
      dataDir,
      spokenReply: { listener, voices: { 1: voice, 2: null }, gemini: null },
    });
    base = `http://127.0.0.1:${handle.port}`;
    const ws = await post('/workspaces', { name: 'Harborlight' });
    boardId = ((await ws.json()) as { workspace: { id: string } }).workspace.id;
    handle.tasks.attachAgent(boardId, {
      agentId: 'harborlight-lead',
      agentName: LEAD,
      runtime: 'claude-code-local',
    });
    handle.tasks.attachAgent(boardId, {
      agentId: 'riverbend-helper',
      agentName: HELPER,
      runtime: 'claude-code-local',
    });
    handle.tasks.setLeadAgent(boardId, 'harborlight-lead', { actor: BRYAN });
    lead = await agentStream(base, boardId, 'harborlight-lead');
    page = await pageStream(base, boardId);
  });

  afterAll(async () => {
    lead.close();
    page.close();
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('shows a prompt typed in the lead’s terminal on an open page, and no other session’s', async () => {
    const other = await prompt(HELPER, { typed: true, text: 'a helper’s own prompt' });
    expect(other.status).toBe(202);
    const res = await prompt(LEAD, { typed: true, text: 'Check the Saltmarsh deploy' });
    expect(await res.json()).toEqual({ ok: true, mirrored: true });
    const shown = await waitFor(() => latest((m) => m.text === 'Check the Saltmarsh deploy'), {
      ...WITHIN_1S,
      describe: 'the typed prompt on the page',
    });
    expect(shown.role).toBe('person');
    expect(shown.via).toBe('terminal');
    // Posted first, so had it been mirrored its frame would already be here.
    expect(page.messages.some((m) => m.text === 'a helper’s own prompt')).toBe(false);
  });

  it('shows a board event the lead took as a channel row naming who caused it', async () => {
    await prompt(LEAD, {
      typed: false,
      channel: { author: 'Riverbend', text: 'replied on Deploy plan: the install takes 40s' },
    });
    const row = await waitFor(() => latest((m) => m.via === 'channel'), {
      ...WITHIN_1S,
      describe: 'the channel row on the page',
    });
    expect(row.author.name).toBe('Riverbend');
    expect(row.text).toBe('replied on Deploy plan: the install takes 40s');
    // An injected prompt with no channel line shows nothing.
    const bare = await prompt(LEAD, { typed: false });
    expect(await bare.json()).toEqual({ ok: true });
  });

  it('refuses a channel line it cannot vouch for', async () => {
    const bad = await prompt(LEAD, { typed: false, channel: { text: 'x', queueId: '../q' } });
    expect(bad.status).toBe(400);
    const long = await prompt(LEAD, { typed: false, channel: { text: 'x'.repeat(1001) } });
    expect(long.status).toBe(400);
  });

  it('shows the message a turn ended on as the lead’s, and says none of it', async () => {
    const socket = await converse();
    const words = 'Shipped. The **PR** is green.';
    await turnEnd(LEAD, words);
    const shown = await waitFor(() => latest((m) => m.text === words), {
      ...WITHIN_1S,
      describe: 'the closing message on the page',
    });
    expect(shown.role).toBe('agent');
    expect(shown.turnEnd).toBe(true);
    expect(shown.author.name).toBe(LEAD);
    // A helper's turn is not the lead's.
    await turnEnd(HELPER, 'helper finished');
    await turnEnd(LEAD, 'Lead finished too.');
    await waitFor(() => latest((m) => m.text === 'Lead finished too.'), {
      describe: 'the second closing message',
    });
    expect(page.messages.some((m) => m.text === 'helper finished')).toBe(false);
    // Nothing was said, on the socket or by the voice.
    expect(said).toEqual([]);
    expect(socket.frames.filter((f) => f.type !== 'ready')).toEqual([]);
    socket.ws.close();
  });

  it('shows a message sent, then received when the lead’s session takes it, then done at its turn’s end', async () => {
    const before = lead.voice.length;
    const res = await post(`/workspaces/${boardId}/lead-chat`, {
      text: 'Is the Harborlight deploy fixed?',
      author: BRYAN,
    });
    const sent = ((await res.json()) as { message: LeadChatMessage }).message;
    expect(sent.state).toBe('sent');
    await waitFor(() => lead.voice.length > before, { describe: 'the lead got it' });
    const queueId = lead.voice.at(-1)?.queueId ?? '';
    // What the lead's MCP child posts once the frame is in its session.
    await post(`/workspaces/${boardId}/voice-queue/${queueId}/ack`, {});
    const received = await waitFor(
      () => {
        const m = latest((x) => x.id === sent.id);
        return m?.state === 'received' ? m : undefined;
      },
      { ...WITHIN_1S, describe: 'received on the page' },
    );
    expect(typeof received.receivedAt).toBe('number');
    await turnEnd(LEAD, 'Not yet: the install step still takes 40s.');
    await waitFor(() => latest((x) => x.id === sent.id)?.state === 'done', {
      ...WITHIN_1S,
      describe: 'done on the page',
    });
    // A later answer still lands.
    await post(`/workspaces/${boardId}/voice-queue/${queueId}/answer`, {
      agentId: 'harborlight-lead',
      text: 'Fixed now.',
    });
    await waitFor(() => latest((x) => x.id === sent.id)?.state === 'answered', {
      describe: 'answered',
    });
  });

  it('takes the channel prompt that delivers a chat message as received, not as a second row', async () => {
    const before = lead.voice.length;
    const res = await post(`/workspaces/${boardId}/lead-chat`, {
      text: 'And Riverbend?',
      author: BRYAN,
    });
    const sent = ((await res.json()) as { message: LeadChatMessage }).message;
    await waitFor(() => lead.voice.length > before, { describe: 'the lead got it' });
    const queueId = lead.voice.at(-1)?.queueId ?? '';
    const rows = page.messages.length;
    await prompt(LEAD, {
      typed: false,
      channel: { author: 'Bryan', text: '[voice.request] by Bryan: "And Riverbend?"', queueId },
    });
    await waitFor(() => latest((x) => x.id === sent.id)?.state === 'received', {
      ...WITHIN_1S,
      describe: 'received by its channel prompt',
    });
    expect(page.messages.slice(rows).filter((m) => m.via === 'channel')).toEqual([]);
  });

  it('shows a voice message as the person’s own at once, says no "Sent to", and speaks only the lead’s answer', async () => {
    const socket = await converse();
    const turns = lead.voice.length;
    const replies = socket.frames.filter((f) => f.type === 'reply').length;
    socket.ws.send(
      JSON.stringify({
        type: 'start',
        setup: 1,
        mode: 'hold',
        author: BRYAN,
        agent: 'harborlight-lead',
      }),
    );
    await waitFor(() => opened.length > 0, { describe: 'listener opened' });
    opened.at(-1)?.onTurn({ turn: 0, text: 'what is left on Saltmarsh', final: true });
    socket.ws.send(JSON.stringify({ type: 'end' }));
    const mine = await waitFor(() => latest((m) => m.text === 'what is left on Saltmarsh'), {
      ...WITHIN_1S,
      describe: 'the spoken message on the page',
    });
    expect(mine.role).toBe('person');
    expect(mine.via).toBe('voice');
    expect(mine.author.id).toBe(BRYAN.id);
    await waitFor(() => socket.frames.filter((f) => f.type === 'reply').length > replies, {
      describe: 'the turn’s reply frame',
    });
    expect(JSON.stringify(socket.frames)).not.toContain('Sent to');
    expect(JSON.stringify(page.messages)).not.toContain('Sent to');
    expect(said).toEqual([]);
    // The positive control: the speak tool is what makes a sound.
    await waitFor(() => lead.voice.length > turns, { describe: 'the lead got the turn' });
    const queueId = lead.voice.at(-1)?.queueId ?? '';
    await post(`/workspaces/${boardId}/voice-queue/${queueId}/answer`, {
      agentId: 'harborlight-lead',
      text: 'Two tasks.',
    });
    await waitFor(() => said.join(' ').includes('Two tasks.'), { describe: 'the answer said' });
    socket.ws.close();
  });

  async function converse() {
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
});
