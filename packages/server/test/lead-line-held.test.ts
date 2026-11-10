/**
 * Through the REAL server: a line the board's lead says into a meeting waits
 * while the room is mid-thought, goes once the speaker has finished, and is
 * dropped when the talk never leaves room for it. The room is scripted
 * through the hold's ears seam, the judge is a script, and the hold's waits
 * are its production numbers scaled by the suite's timing factor, so every
 * ratio between them holds. Cases wait on the route's answer and assert the
 * order of events, never how long the machine took.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LeadChatMeeting } from '@claude-workspaces/core/lead-chat';
import { HOLD_TIMING, type HoldTiming } from '../src/lead-chat/lead-line-hold.ts';
import { LEAD_MEETING_SINCE } from '../src/lead-chat/meeting-feed.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import type { EngineTurn } from '../src/transcribe.ts';
import { waitFor } from './wait-for.ts';

setDefaultTimeout(30_000);

/** The factor `timing.preload.ts` gives every doc cadence in this suite. */
const SCALE = Number(process.env.CW_TEST_TIMING_SCALE ?? '1');
const TIMING: HoldTiming = Object.fromEntries(
  Object.entries(HOLD_TIMING).map(([k, v]) => [k, Math.round(v * SCALE)]),
) as unknown as HoldTiming;

describe('a held lead line through the say route', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let boardId = '';
  let meeting: LeadChatMeeting;
  const room = new Set<(t: EngineTurn) => void>();
  const asked: string[] = [];
  const ALICE = { id: 'known-alice', name: 'Alice', kind: 'known' };
  let turn = 0;
  const hear = (text: string, final = false) => {
    for (const fn of room) fn({ turn, text, final });
    if (final) turn += 1;
  };

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  let token = '';
  const say = (text: string) =>
    post(
      `/workspaces/${boardId}/lead-chat/meeting/say`,
      { agentId: 'harborlight-lead', text },
      { authorization: `Bearer ${token}` },
    ).then(async (r) => ({ status: r.status, body: (await r.json()) as Record<string, unknown> }));

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-lead-held-'));
    handle = createServer({
      port: 0,
      dataDir,
      spokenReply: { listener: null, voices: { 1: null, 2: null }, gemini: null },
      identifyAgentCaller: async () => ({ ok: true, agentId: 'harborlight-lead', via: 'session' }),
      voiceComplete: async ({ user }) => {
        asked.push(user);
        return user.includes('move the pier') ? 'FINISHED' : 'UNFINISHED';
      },
      leadHold: 'judge',
      leadHoldTiming: TIMING,
      leadHoldEars: {
        engine: () => ({
          name: 'scripted-room',
          open: async (o) => {
            room.add(o.onTurn);
            return { send: () => {}, close: async () => void room.delete(o.onTurn) };
          },
        }),
      },
    });
    base = `http://127.0.0.1:${handle.port}`;
    const ws = await post('/workspaces', { name: 'Harborlight' });
    boardId = ((await ws.json()) as { workspace: { id: string } }).workspace.id;
    handle.tasks.attachAgent(boardId, {
      agentId: 'harborlight-lead',
      agentName: 'Harborlight Lead',
      runtime: 'claude-code-local',
      pluginVersion: LEAD_MEETING_SINCE,
    });
    handle.tasks.setLeadAgent(boardId, 'harborlight-lead', { actor: ALICE });
    const path = join(dataDir, 'riverbend-plan.md');
    writeFileSync(path, '# Riverbend plan\n');
    const made = await post(`/workspaces/${boardId}/docs`, {
      docId: 'riverbend-plan',
      sourceUrl: path,
      title: 'Riverbend plan',
    });
    const docId = ((await made.json()) as { docId: string }).docId;
    token = (
      (await (await fetch(`${base}/api/agents/harborlight-lead/token`)).json()) as {
        token: string;
      }
    ).token;
    const started = await post(`/workspaces/${boardId}/lead-chat/meeting`, {
      author: ALICE,
      action: 'start',
      docId,
      docTitle: 'Riverbend plan',
      notes: 'existing',
      source: 'mic',
      speakers: 'conversation',
      recorder: 'rec-1',
    });
    meeting = ((await started.json()) as { meeting: LeadChatMeeting }).meeting;
    // The room said something before the lead had anything to say.
    await post(`/workspaces/${boardId}/lead-chat/meeting`, {
      author: ALICE,
      action: 'line',
      id: meeting.id,
      turn: 0,
      who: 'Alice',
      text: 'Right, the pier.',
    });
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  /** The lines the lead has said, off the meeting's own file. */
  const leadLines = () =>
    (
      JSON.parse(
        readFileSync(join(dataDir, 'workspaces', `${boardId}.lead-chat-meeting.json`), 'utf8'),
      ) as { meeting: LeadChatMeeting }
    ).meeting.lines.filter((l) => l.lead);

  it('waits while the speaker is mid-thought and goes once the thought is finished', async () => {
    let answered: Awaited<ReturnType<typeof say>> | null = null;
    const pending = say('The berth is free on Monday.').then((r) => {
      answered = r;
      return r;
    });
    // The hold opens its ears on the first line; then the room talks.
    await waitFor(() => room.size === 1, { describe: 'the hold listening' });
    hear('So we could, um');
    hear('So we could, um', true);
    // Past the unfinished wait the judge is asked, says unfinished, and the
    // line still waits: the speaker is searching for the rest.
    await waitFor(() => asked.length === 1, { describe: 'the judge asked once' });
    expect(answered).toBeNull();
    expect(leadLines()).toEqual([]);
    hear('move the pier to the east side.');
    hear('move the pier to the east side.', true);
    const r = await pending;
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, said: true });
    expect(asked.at(-1)).toContain('move the pier to the east side.');
    expect(leadLines().map((l) => l.text)).toEqual(['The berth is free on Monday.']);
  });

  it('drops a line the talk never leaves room for, and says so', async () => {
    const pending = say('One more on Saltmarsh.');
    let done = false;
    void pending.then(() => {
      done = true;
    });
    // Somebody keeps talking, one new word inside every quiet window.
    let words = 'and then';
    while (!done) {
      words += ' more';
      hear(words);
      await new Promise((r) => setTimeout(r, Math.max(10, TIMING.quietMs / 3)));
    }
    const r = await pending;
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, said: false, lapsed: 'lapsed' });
    expect(leadLines().map((l) => l.text)).toEqual(['The berth is free on Monday.']);
  });
});
