/**
 * A short spoken answer and a fuller written one, through the REAL server.
 *
 * The owner talks to the board's lead by voice with the chat panel open. The
 * lead answers with `answer_voice`'s `text` and `written`: the page says only
 * `text`, and the lead chat shows `written` in its place. The page's context
 * reaches the lead saying the panel was open, which is what tells it to keep
 * the spoken part to a sentence. Fake engines; nothing reaches a vendor.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LeadChatMessage } from '@claude-workspaces/core/lead-chat';
import { type ServerHandle, createServer } from '../src/server.ts';
import { LEAD_ANSWER_ROUTE, LEAD_WRITTEN_MAX } from '../src/spoken-reply/lead-answer.ts';
import type { SpokenVoice } from '../src/spoken-reply/tts.ts';
import type { TranscriptionEngine } from '../src/transcribe.ts';
import { agentStream } from './agent-voice-stream.ts';
import { waitFor } from './wait-for.ts';

setDefaultTimeout(30_000);

interface Frame {
  type: string;
  [k: string]: unknown;
}

describe('a spoken answer with a written one', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let boardId = '';
  let lead: Awaited<ReturnType<typeof agentStream>>;
  const said: string[] = [];
  const BRYAN = { id: 'known-bryan', name: 'Bryan', kind: 'known' };

  const listener: TranscriptionEngine = {
    name: 'fake',
    async open() {
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

  const chat = async (): Promise<LeadChatMessage[]> =>
    (
      (await (await fetch(`${base}/workspaces/${boardId}/lead-chat`)).json()) as {
        messages: LeadChatMessage[];
      }
    ).messages;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-written-answer-'));
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
      agentName: 'Harborlight Lead',
      runtime: 'claude-code-local',
    });
    handle.tasks.setLeadAgent(boardId, 'harborlight-lead', { actor: BRYAN });
    lead = await agentStream(base, boardId, 'harborlight-lead');
  });

  afterAll(async () => {
    lead.close();
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('says only text, writes written to the chat, and tells the lead the panel was open', async () => {
    const sock = new WebSocket(
      `ws://127.0.0.1:${handle.port}/workspaces/${boardId}/voice/converse`,
    );
    const frames: Frame[] = [];
    sock.addEventListener('message', (ev) => {
      if (typeof ev.data === 'string') frames.push(JSON.parse(ev.data) as Frame);
    });
    await new Promise<void>((resolve, reject) => {
      sock.addEventListener('open', () => resolve());
      sock.addEventListener('error', () => reject(new Error('converse socket refused')));
    });
    await waitFor(() => frames.some((f) => f.type === 'ready'), { describe: 'ready' });

    const question = 'how did the Riverbend deploy go';
    sock.send(
      JSON.stringify({
        type: 'start',
        setup: 1,
        mode: 'hold',
        agent: 'harborlight-lead',
        author: BRYAN,
        context: { surface: 'board', chatOpen: true },
      }),
    );
    sock.send(JSON.stringify({ type: 'say', text: question }));
    await waitFor(() => lead.voice.some((v) => v.transcript === question), {
      describe: 'the lead got the spoken turn',
    });
    const asked = lead.voice.find((v) => v.transcript === question);
    expect(asked?.context?.chatOpen).toBe(true);

    const spoken = 'It shipped.';
    const written =
      'It shipped at 14:02. The release names the merge commit, and the health check reads healthy.';
    const res = await post(`/workspaces/${boardId}/voice-queue/${asked?.queueId}/answer`, {
      agentId: 'harborlight-lead',
      text: spoken,
      written,
    });
    expect(await res.json()).toEqual({ ok: true, delivered: true });

    await waitFor(() => frames.some((f) => f.route === LEAD_ANSWER_ROUTE), {
      describe: 'the answer on the asking socket',
    });
    expect(frames.find((f) => f.route === LEAD_ANSWER_ROUTE)?.spoken).toBe(spoken);
    await waitFor(() => said.includes(spoken), { describe: 'the voice said text' });
    expect(said.some((s) => s.includes('14:02'))).toBe(false);

    await waitFor(async () => (await chat()).some((m) => m.role === 'agent'), {
      describe: 'the chat holds the answer',
    });
    expect((await chat()).map((m) => [m.role, m.text])).toEqual([
      ['person', question],
      ['agent', written],
    ]);
    sock.close();
  });

  it('refuses a written answer that is not a string or is over the cap', async () => {
    const path = `/workspaces/${boardId}/voice-queue/vq-x/answer`;
    const lead = { agentId: 'harborlight-lead', text: 'Fine.' };
    expect((await post(path, { ...lead, written: 7 })).status).toBe(400);
    expect((await post(path, { ...lead, written: 'a'.repeat(LEAD_WRITTEN_MAX + 1) })).status).toBe(
      400,
    );
    // The old single-field payload is still accepted.
    expect(await (await post(path, lead)).json()).toEqual({ ok: true, delivered: false });
  });
});
