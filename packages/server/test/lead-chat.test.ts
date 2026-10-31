/**
 * The lead chat through the REAL server: a message posted from a page reaches
 * the board's lead alone, the lead answers with the route `answer_voice`
 * calls, and an already-open page on the board is told of both on its board
 * stream — the "every surface is live" path — while no agent stream is.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LEAD_CHAT_EVENT, type LeadChatMessage } from '@claude-workspaces/core/lead-chat';
import { type ServerHandle, createServer } from '../src/server.ts';
import { agentStream } from './agent-voice-stream.ts';
import { pageStream } from './lead-chat-page-stream.ts';
import { waitFor } from './wait-for.ts';

setDefaultTimeout(30_000);

describe('the lead chat', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let boardId = '';
  let lead: Awaited<ReturnType<typeof agentStream>>;
  let helper: Awaited<ReturnType<typeof agentStream>>;
  let page: Awaited<ReturnType<typeof pageStream>>;
  let leadEvents: Awaited<ReturnType<typeof pageStream>>;
  const BRYAN = { id: 'known-bryan', name: 'Bryan', kind: 'known' };

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-lead-chat-http-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://127.0.0.1:${handle.port}`;
    const ws = await post('/workspaces', { name: 'Harborlight' });
    boardId = ((await ws.json()) as { workspace: { id: string } }).workspace.id;
    for (const [agentId, agentName] of [
      ['harborlight-lead', 'Harborlight Lead'],
      ['riverbend-helper', 'Riverbend Helper'],
    ] as const) {
      handle.tasks.attachAgent(boardId, { agentId, agentName, runtime: 'claude-code-local' });
    }
    handle.tasks.setLeadAgent(boardId, 'harborlight-lead', { actor: BRYAN });
    lead = await agentStream(base, boardId, 'harborlight-lead');
    helper = await agentStream(base, boardId, 'riverbend-helper');
    page = await pageStream(base, boardId);
    leadEvents = await pageStream(base, boardId, 'harborlight-lead');
  });

  afterAll(async () => {
    lead.close();
    helper.close();
    page.close();
    leadEvents.close();
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('names the lead to a page before anything is said', async () => {
    const res = await fetch(`${base}/workspaces/${boardId}/lead-chat`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      lead: { agentId: 'harborlight-lead', name: 'Harborlight Lead' },
      messages: [],
      more: false,
      meeting: null,
      canTalk: true,
    });
  });

  it('refuses an empty or oversized message', async () => {
    const path = `/workspaces/${boardId}/lead-chat`;
    expect((await post(path, { text: '  ', author: BRYAN })).status).toBe(400);
    expect((await post(path, { text: 'x'.repeat(4001), author: BRYAN })).status).toBe(400);
  });

  it('sends a message to the lead alone and shows its answer on an open page', async () => {
    const text = 'what is left on the Saltmarsh signup?';
    const res = await post(`/workspaces/${boardId}/lead-chat`, {
      text,
      author: BRYAN,
      context: { surface: 'doc', docId: 'd-saltmarsh' },
    });
    expect(res.status).toBe(201);
    const sent = ((await res.json()) as { message: LeadChatMessage }).message;
    expect(sent).toMatchObject({ role: 'person', text, state: 'sent', via: 'chat' });

    await waitFor(() => lead.voice.some((v) => v.transcript === text), {
      describe: 'lead got the message',
    });
    expect(helper.voice.some((v) => v.transcript === text)).toBe(false);
    await waitFor(() => page.messages.some((m) => m.id === sent.id), {
      describe: 'open page shown the message',
      timeout: 1000,
    });

    const queueId = lead.voice.find((v) => v.transcript === text)?.queueId ?? '';
    const answer = async (agentId: string, words: string) =>
      (await post(`/workspaces/${boardId}/voice-queue/${queueId}/answer`, {
        agentId,
        text: words,
      }).then((r) => r.json())) as { delivered: boolean };
    expect((await answer('riverbend-helper', 'Not mine.')).delivered).toBe(false);
    expect((await answer('harborlight-lead', 'The email field.')).delivered).toBe(true);

    await waitFor(() => page.messages.some((m) => m.text === 'The email field.'), {
      describe: 'open page shown the answer',
      timeout: 1000,
    });
    const snap = (await (await fetch(`${base}/workspaces/${boardId}/lead-chat`)).json()) as {
      messages: LeadChatMessage[];
    };
    expect(snap.messages.map((m) => [m.role, m.text, m.state ?? null])).toEqual([
      ['person', text, 'answered'],
      ['agent', 'The email field.', null],
    ]);
  });

  it('keeps the page frames off the lead’s own stream', () => {
    // The lead has its own voice.request; a page frame on its stream as well
    // would cost its session a second turn for the same message.
    expect(page.events).toContain(LEAD_CHAT_EVENT);
    expect(leadEvents.events).toContain('voice.request');
    expect(leadEvents.events).not.toContain(LEAD_CHAT_EVENT);
  });

  it('keeps a dictated message marked as said, and nothing else', async () => {
    const path = `/workspaces/${boardId}/lead-chat`;
    const said = await post(path, { text: 'read me the next one', author: BRYAN, via: 'voice' });
    expect(((await said.json()) as { message: LeadChatMessage }).message.via).toBe('voice');
    const odd = await post(path, { text: 'and this', author: BRYAN, via: 'telepathy' });
    expect(((await odd.json()) as { message: LeadChatMessage }).message.via).toBe('chat');
  });

  it('marks a message to a board with no lead as sent to nobody', async () => {
    const ws = await post('/workspaces', { name: 'Riverbend' });
    const empty = ((await ws.json()) as { workspace: { id: string } }).workspace.id;
    const res = await post(`/workspaces/${empty}/lead-chat`, { text: 'anyone?', author: BRYAN });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { message: LeadChatMessage }).message.state).toBe('no-lead');
    const snap = await (await fetch(`${base}/workspaces/${empty}/lead-chat`)).json();
    expect((snap as { lead: unknown }).lead).toBeNull();
  });
});
