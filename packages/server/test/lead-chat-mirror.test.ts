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
    expect(await other.json()).toEqual({ ok: true });
    const res = await prompt(LEAD, { typed: true, text: 'Check the Saltmarsh deploy' });
    expect(await res.json()).toEqual({ ok: true, mirrored: true, lead: true });
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
    // An injected prompt with no channel line shows nothing, and still says
    // the session is the lead, so its hook keeps mirroring.
    const bare = await prompt(LEAD, { typed: false });
    expect(await bare.json()).toEqual({ ok: true, lead: true });
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
    // The turn that takes it starts with the channel prompt carrying it.
    await prompt(LEAD, {
      typed: false,
      channel: { author: 'Bryan', text: '[voice.request] by Bryan', queueId },
    });
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

  it('marks a message taken mid-turn done at the end of the next turn, not this one', async () => {
    await prompt(LEAD, { typed: true, text: 'Tidy the Saltmarsh docs' });
    const before = lead.voice.length;
    const res = await post(`/workspaces/${boardId}/lead-chat`, {
      text: 'Also the Riverbend notes?',
      author: BRYAN,
    });
    const sent = ((await res.json()) as { message: LeadChatMessage }).message;
    await waitFor(() => lead.voice.length > before, { describe: 'the lead got it' });
    const queueId = lead.voice.at(-1)?.queueId ?? '';
    await post(`/workspaces/${boardId}/voice-queue/${queueId}/ack`, {});
    await waitFor(() => latest((x) => x.id === sent.id)?.state === 'received', {
      describe: 'received mid-turn',
    });
    await turnEnd(LEAD, 'Saltmarsh docs tidied.');
    await waitFor(() => latest((m) => m.text === 'Saltmarsh docs tidied.'), {
      describe: 'the turn ended',
    });
    expect(latest((x) => x.id === sent.id)?.state).toBe('received');
    await prompt(LEAD, {
      typed: false,
      channel: { author: 'Bryan', text: '[voice.request] by Bryan', queueId },
    });
    await turnEnd(LEAD, 'Riverbend notes done too.');
    await waitFor(() => latest((x) => x.id === sent.id)?.state === 'done', {
      describe: 'done at the end of the turn that took it',
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

  const mirror = (name: string, body: Record<string, unknown>) =>
    post(agentPath(name, 'mirror'), body);

  it('streams text the lead writes mid-turn into an open page, and keeps it once it is whole', async () => {
    const id = 'f1d2c3b4-0000-4000-8000-000000000001';
    const first = await mirror(LEAD, {
      kind: 'text',
      messageId: id,
      index: 0,
      final: false,
      text: 'Reading the Saltmarsh deploy log.',
    });
    expect(await first.json()).toEqual({ ok: true, mirrored: true });
    const growing = await waitFor(
      () => latest((m) => m.text === 'Reading the Saltmarsh deploy log.'),
      {
        ...WITHIN_1S,
        describe: 'the first flush on the page',
      },
    );
    expect(growing.role).toBe('agent');
    expect(growing.via).toBe('terminal');
    expect(growing.streaming).toBe(true);
    const whole = 'Reading the Saltmarsh deploy log.\nThe install step takes 40s.';
    await mirror(LEAD, { kind: 'text', messageId: id, index: 2, final: true, text: whole });
    // A flush that lands late is dropped, not shown over the newer text.
    await mirror(LEAD, { kind: 'text', messageId: id, index: 1, final: false, text: 'stale' });
    const done = await waitFor(
      () => {
        const m = latest((x) => x.id === growing.id);
        return m?.text === whole && !m.streaming ? m : undefined;
      },
      { ...WITHIN_1S, describe: 'the whole message, no longer streaming' },
    );
    expect(page.messages.filter((m) => m.id === done.id).at(-1)?.text).toBe(whole);
    // Kept: a page opened now reads it.
    const read = (await (await fetch(`${base}/workspaces/${boardId}/lead-chat`)).json()) as {
      messages: LeadChatMessage[];
    };
    expect(read.messages.find((m) => m.id === done.id)?.text).toBe(whole);
    // The turn ends on that same message: it becomes the closing message, not a second row.
    await turnEnd(LEAD, whole);
    await waitFor(() => latest((x) => x.id === done.id)?.turnEnd === true, {
      describe: 'the streamed message marked as the turn end',
    });
    expect(page.messages.filter((m) => m.text === whole && m.id !== done.id)).toEqual([]);
  });

  it('keeps one closing message when the last flush lands after the turn ended', async () => {
    // Streamed, then the Stop note, then the final flush: still the closing message.
    const id = 'f1d2c3b4-0000-4000-8000-000000000002';
    await prompt(LEAD, { typed: true, text: 'How long does the Riverbend restart take?' });
    await mirror(LEAD, { kind: 'text', messageId: id, index: 0, final: false, text: 'About' });
    const row = await waitFor(() => latest((m) => m.text === 'About'), {
      describe: 'the first flush on the page',
    });
    await turnEnd(LEAD, 'About 12 seconds.');
    await waitFor(() => latest((x) => x.id === row.id)?.turnEnd === true, {
      describe: 'the streamed row marked as the turn end',
    });
    await mirror(LEAD, {
      kind: 'text',
      messageId: id,
      index: 1,
      final: true,
      text: 'About 12 seconds.',
    });
    await waitFor(
      () => {
        const m = latest((x) => x.id === row.id);
        return m?.text === 'About 12 seconds.' && !m.streaming;
      },
      { describe: 'the late final flush applied to the same row' },
    );
    expect(latest((x) => x.id === row.id)?.turnEnd).toBe(true);

    // One flush, final, arriving after the Stop note made its own row.
    await prompt(LEAD, { typed: true, text: 'And the Harborlight one?' });
    await turnEnd(LEAD, 'About 9 seconds.');
    const note = await waitFor(() => latest((m) => m.text === 'About 9 seconds.'), {
      describe: 'the closing message from the Stop note',
    });
    const late = await mirror(LEAD, {
      kind: 'text',
      messageId: 'f1d2c3b4-0000-4000-8000-000000000003',
      index: 0,
      final: true,
      text: 'About 9 seconds.',
    });
    expect(await late.json()).toEqual({ ok: true, mirrored: true });
    const read = (await (await fetch(`${base}/workspaces/${boardId}/lead-chat`)).json()) as {
      messages: LeadChatMessage[];
    };
    const rows = read.messages.filter((m) => m.text === 'About 9 seconds.');
    expect(rows.map((m) => m.id)).toEqual([note.id]);
    expect(rows[0]?.turnEnd).toBe(true);
  });

  it('shows each tool call the lead made as its own row, with its input and output', async () => {
    const res = await mirror(LEAD, {
      kind: 'tools',
      calls: [
        { name: 'Bash', input: 'git status', output: 'nothing to commit' },
        { name: 'Read', input: 'docs/plan.md', output: 'no such file', failed: true },
      ],
    });
    expect(await res.json()).toEqual({ ok: true, mirrored: true });
    const bash = await waitFor(() => latest((m) => m.tool?.name === 'Bash'), {
      ...WITHIN_1S,
      describe: 'the Bash call on the page',
    });
    expect(bash.text).toBe('Bash: git status');
    expect(bash.tool).toEqual({ name: 'Bash', input: 'git status', output: 'nothing to commit' });
    const read = await waitFor(() => latest((m) => m.tool?.name === 'Read'), {
      describe: 'the Read call on the page',
    });
    expect(read.tool?.failed).toBe(true);
  });

  it('mirrors no other session’s text or tools, and refuses a body it cannot bound', async () => {
    const helper = await mirror(HELPER, {
      kind: 'tools',
      calls: [{ name: 'Bash', input: 'helper-only command' }],
    });
    expect(await helper.json()).toEqual({ ok: true });
    const bad = [
      { kind: 'text', messageId: '../x', index: 0, final: true, text: 'x' },
      { kind: 'text', messageId: 'a', index: -1, final: true, text: 'x' },
      { kind: 'text', messageId: 'a', index: 0, final: true, text: 'x'.repeat(8001) },
      { kind: 'tools', calls: [] },
      { kind: 'tools', calls: [{ name: 'Bash', input: 'x'.repeat(2001) }] },
      { kind: 'other' },
    ];
    for (const body of bad) expect((await mirror(LEAD, body)).status).toBe(400);
    expect(page.messages.some((m) => m.text.includes('helper-only command'))).toBe(false);
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
