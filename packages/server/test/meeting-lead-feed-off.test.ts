/**
 * The board's lead and the meeting its lead chat runs, through the REAL
 * server, with the lead feed at its default: off since 2026-11-04, pending a
 * redesign (`meetingLeadFeedEnabled`). A running meeting takes notes on its own: starting it and the
 * room's lines reach every open page and are NOT sent to the lead, which
 * hears only a "Lead, …" line. When the lead does speak,
 * one call to the `say` route (what `say_in_meeting` posts) puts its line in
 * the meeting on every page, and the page holding the microphone can fetch
 * it voiced.
 *
 * The voice is a fake that answers fixed PCM: no network, no audio. These
 * cases wait on frames arriving and assert their order, never how long the
 * machine took; the batch window itself is `lead-meeting-feed.test.ts`'s,
 * on an injected clock. Every name is a house fixture name.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LEAD_CHAT_MEETING_LINE_EVENT,
  type LeadChatMeeting,
  type LeadChatMeetingLine,
} from '@claude-workspaces/core/lead-chat';
import {
  LEAD_MEETING_HEARD_EVENT,
  LEAD_MEETING_SINCE,
  LEAD_MEETING_STARTED_EVENT,
} from '../src/lead-chat/meeting-feed.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import type { SpokenVoice } from '../src/spoken-reply/tts.ts';
import { waitFor } from './wait-for.ts';

setDefaultTimeout(30_000);

type Frame = { event?: string } & Record<string, unknown>;

/** A board stream (a page's, or with `agentId` an agent's own), keeping
 *  every frame whole and in order. */
async function boardStream(base: string, workspaceId: string, agentId?: string) {
  const controller = new AbortController();
  const q = agentId ? `?agentId=${encodeURIComponent(agentId)}` : '';
  const res = await fetch(`${base}/workspaces/${workspaceId}/events:stream${q}`, {
    signal: controller.signal,
    headers: { accept: 'text/event-stream' },
  });
  if (!res.ok) throw new Error(`stream: HTTP ${res.status}`);
  const frames: Frame[] = [];
  const reader = res.body?.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  void (async () => {
    if (!reader) return;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        buf += decoder.decode(value, { stream: true });
        let cut = buf.indexOf('\n\n');
        while (cut !== -1) {
          const block = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          cut = buf.indexOf('\n\n');
          const data = block
            .split('\n')
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trim())
            .join('');
          if (!data) continue;
          try {
            frames.push(JSON.parse(data) as Frame);
          } catch {
            // A keepalive.
          }
        }
      }
    } catch {
      // Aborted by close().
    }
  })();
  return { frames, close: () => controller.abort() };
}

const PCM = new Uint8Array([1, 0, 2, 0, 3, 0, 4, 0]);

describe('the lead in a meeting, with the lead feed at its default', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let boardId = '';
  let docId = '';
  let lead: Awaited<ReturnType<typeof boardStream>>;
  let helper: Awaited<ReturnType<typeof boardStream>>;
  let page: Awaited<ReturnType<typeof boardStream>>;
  const said: string[] = [];
  const ALICE = { id: 'known-alice', name: 'Alice', kind: 'known' };
  const voice: SpokenVoice = {
    name: 'fake',
    async speak(text, onAudio) {
      said.push(text);
      onAudio(PCM);
    },
  };

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const act = (body: Record<string, unknown>) =>
    post(`/workspaces/${boardId}/lead-chat/meeting`, { author: ALICE, ...body });
  let callerIs: string | null = null;
  const tokens = new Map<string, string>();
  const tokenFor = async (agentId: string): Promise<string> => {
    const held = tokens.get(agentId);
    if (held) return held;
    callerIs = agentId;
    const res = await fetch(`${base}/api/agents/${agentId}/token`);
    const token = ((await res.json()) as { token: string }).token;
    tokens.set(agentId, token);
    return token;
  };
  const say = async (agentId: string, text: string) =>
    fetch(`${base}/workspaces/${boardId}/lead-chat/meeting/say`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${await tokenFor(agentId)}`,
      },
      body: JSON.stringify({ agentId, text }),
    });
  const of = (s: { frames: Frame[] }, event: string) => s.frames.filter((f) => f.event === event);

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-lead-in-meeting-'));
    handle = createServer({
      port: 0,
      dataDir,
      spokenReply: { listener: null, voices: { 1: voice, 2: null }, gemini: null },
      // The say route takes the lead's token; the process check that the
      // mint route asks is injected, as agent-stream-auth.test.ts does.
      identifyAgentCaller: async () => ({ ok: true, agentId: callerIs, via: 'session' }),
    });
    base = `http://127.0.0.1:${handle.port}`;
    const ws = await post('/workspaces', { name: 'Harborlight' });
    boardId = ((await ws.json()) as { workspace: { id: string } }).workspace.id;
    for (const [agentId, agentName] of [
      ['harborlight-lead', 'Harborlight Lead'],
      ['riverbend-helper', 'Riverbend Helper'],
    ] as const) {
      handle.tasks.attachAgent(boardId, {
        agentId,
        agentName,
        runtime: 'claude-code-local',
        pluginVersion: LEAD_MEETING_SINCE,
      });
    }
    handle.tasks.setLeadAgent(boardId, 'harborlight-lead', { actor: ALICE });
    const path = join(dataDir, 'saltmarsh-plan.md');
    writeFileSync(path, '# Saltmarsh plan\n');
    const made = await post(`/workspaces/${boardId}/docs`, {
      docId: 'saltmarsh-plan',
      sourceUrl: path,
      title: 'Saltmarsh plan',
    });
    docId = ((await made.json()) as { docId: string }).docId;
    lead = await boardStream(base, boardId, 'harborlight-lead');
    helper = await boardStream(base, boardId, 'riverbend-helper');
    page = await boardStream(base, boardId);
  });

  afterAll(async () => {
    lead.close();
    helper.close();
    page.close();
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  let meeting: LeadChatMeeting;

  it('refuses to speak when no meeting is running', async () => {
    const res = await say('harborlight-lead', 'Is anyone here?');
    expect(res.status).toBe(409);
  });

  /** Every event the lead's stream carried that names this meeting. */
  const leadMeetingFrames = () =>
    lead.frames.filter(
      (f) => f.event === LEAD_MEETING_STARTED_EVENT || f.event === LEAD_MEETING_HEARD_EVENT,
    );

  it('does not tell the lead, or anyone’s session, that the meeting started', async () => {
    const res = await act({
      action: 'start',
      docId,
      docTitle: 'Saltmarsh plan',
      notes: 'existing',
      source: 'mic',
      speakers: 'conversation',
      recorder: 'rec-1',
    });
    expect(res.status).toBe(201);
    meeting = ((await res.json()) as { meeting: LeadChatMeeting }).meeting;
    expect(of(helper, LEAD_MEETING_STARTED_EVENT)).toEqual([]);
    expect(of(page, LEAD_MEETING_STARTED_EVENT)).toEqual([]);
  });

  it('sends the room’s lines to the pages and not to the lead', async () => {
    const lines = [
      'The Harborlight ferry runs at six.',
      'Riverbend wants the slipway priced.',
      'Saltmarsh opens at nine.',
    ];
    for (const [turn, text] of lines.entries()) {
      const res = await act({ action: 'line', id: meeting.id, turn, who: 'Alice', text });
      expect(res.status).toBe(200);
    }
    await act({ action: 'line', id: meeting.id, turn: 3, who: 'Alice', text: 'Next topic.' });
    // Positive control: the same lines reached an open page.
    const shown = () =>
      of(page, LEAD_CHAT_MEETING_LINE_EVENT).map((f) => (f.line as LeadChatMeetingLine).text);
    await waitFor(() => shown().includes('Next topic.'), { describe: 'every line on the page' });
    expect(shown()).toEqual([...lines, 'Next topic.']);
    // And the lead's stream is live: a frame addressed to the lead after the
    // lines still arrives, so its silence about them is not a dead stream.
    await post(`/workspaces/${boardId}/lead-chat`, {
      author: ALICE,
      text: 'Is the Harborlight plan ready?',
    });
    await waitFor(() => lead.frames.some((f) => JSON.stringify(f).includes('Harborlight plan')), {
      describe: 'the lead’s stream carries a chat message',
    });
    expect(leadMeetingFrames()).toEqual([]);
    expect(of(helper, LEAD_MEETING_HEARD_EVENT)).toEqual([]);
  });

  it('refuses a speaker that is not the board’s lead', async () => {
    const res = await say('riverbend-helper', 'I am not the lead.');
    expect(res.status).toBe(403);
    expect((await say('harborlight-lead', '   ')).status).toBe(400);
    expect((await say('harborlight-lead', 'x'.repeat(1001))).status).toBe(400);
  });

  it('puts what the lead says in the meeting on every page, voiced for the recorder', async () => {
    const res = await say('harborlight-lead', 'Who is the slipway pricing for?');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { turn: number; played: boolean; meetingId: string };
    expect(body).toMatchObject({ meetingId: meeting.id, played: true });
    // After the last line and before the room's next turn.
    expect(body.turn).toBeGreaterThan(3);
    expect(body.turn).toBeLessThan(4);
    await waitFor(
      () =>
        of(page, LEAD_CHAT_MEETING_LINE_EVENT).some(
          (f) => (f.line as LeadChatMeetingLine).text === 'Who is the slipway pricing for?',
        ),
      { describe: 'the lead’s line on an open page' },
    );
    const line = of(page, LEAD_CHAT_MEETING_LINE_EVENT)
      .map((f) => f.line as LeadChatMeetingLine)
      .find((l) => l.lead);
    expect(line).toMatchObject({ who: 'Harborlight Lead', lead: true, turn: body.turn });

    const voiced = await act({ action: 'voice', id: meeting.id, turn: body.turn });
    expect(voiced.status).toBe(200);
    expect(voiced.headers.get('x-sample-rate')).toBe('24000');
    expect(new Uint8Array(await voiced.arrayBuffer())).toEqual(PCM);
    expect(said).toEqual(['Who is the slipway pricing for?']);
    // Only a line the lead said is voiced.
    expect((await act({ action: 'voice', id: meeting.id, turn: 1 })).status).toBe(404);

    // The room's answer goes to the pages, and still not to the lead.
    await act({ action: 'line', id: meeting.id, turn: 4, who: 'Alice', text: 'For Riverbend.' });
    await waitFor(
      () =>
        of(page, LEAD_CHAT_MEETING_LINE_EVENT).some(
          (f) => (f.line as LeadChatMeetingLine).text === 'For Riverbend.',
        ),
      { describe: 'the answer on the page' },
    );
    expect(leadMeetingFrames()).toEqual([]);
  });

  it('drops the lead’s own voice heard back by the room: not shown', async () => {
    const res = await say('harborlight-lead', 'Is Saltmarsh paying for it?');
    expect(res.status).toBe(200);
    const echo = await act({
      action: 'line',
      id: meeting.id,
      turn: 5,
      who: 'Alice',
      text: 'is saltmarsh paying for it',
    });
    expect(await echo.json()).toMatchObject({ echo: true });
    // The room's real answer after it still goes through to the page.
    await act({ action: 'line', id: meeting.id, turn: 6, who: 'Bob', text: 'Riverbend is.' });
    await waitFor(
      () =>
        of(page, LEAD_CHAT_MEETING_LINE_EVENT).some(
          (f) => (f.line as LeadChatMeetingLine).text === 'Riverbend is.',
        ),
      { describe: 'the answer on the page' },
    );
    const shown = of(page, LEAD_CHAT_MEETING_LINE_EVENT).map((f) => f.line as LeadChatMeetingLine);
    expect(shown.some((l) => l.turn === 5)).toBe(false);
  });

  it('stops the lead after ten lines in a row until the room speaks', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) codes.push((await say('harborlight-lead', `Point ${i}.`)).status);
    expect(codes.slice(0, 10).every((c) => c === 200)).toBe(true);
    const refused = await say('harborlight-lead', 'One more.');
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: 'room-first' });
    await act({ action: 'line', id: meeting.id, turn: 7, who: 'Alice', text: 'Go on.' });
    expect((await say('harborlight-lead', 'Thank you.')).status).toBe(200);
  });

  it('holds nothing for the lead once the meeting has ended', async () => {
    const res = await act({ action: 'end', id: meeting.id });
    expect(res.status).toBe(200);
    expect((await say('harborlight-lead', 'One more thing.')).status).toBe(409);
  });
});
