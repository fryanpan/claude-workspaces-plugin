/**
 * Which meeting lines reach the lead, through the REAL server with the owner
 * proven the way prod proves them: a Cloudflare Access email naming the
 * owner, from the board's own page.
 *
 * A "Lead," line on the owner's proven microphone reaches the lead once per
 * turn. A line not addressed to the lead stays in the notes. A call bot's or
 * Mac audio's line never reaches it, nor does a microphone line from a caller
 * with no proof. Every name is a house fixture name.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LeadChatMeeting } from '@claude-workspaces/core/lead-chat';
import { agentStream } from './agent-voice-stream.ts';
import {
  type ShareProofServer,
  post,
  readJson,
  startShareProofServer,
} from './share-proof-harness.ts';
import { waitFor } from './wait-for.ts';

setDefaultTimeout(30_000);

const BRYAN = { id: 'known-bryan', name: 'Bryan', kind: 'known' };

describe('a meeting line reaches the lead only from the owner’s proven microphone', () => {
  let s: ShareProofServer;
  let docId = '';
  const dir = mkdtempSync(join(tmpdir(), 'cw-lead-proof-'));
  let lead: Awaited<ReturnType<typeof agentStream>>;
  const path = () => `${s.scope}/lead-chat/meeting`;
  const asOwner = (body: Record<string, unknown>) =>
    s.owner(path(), post({ author: BRYAN, ...body }));
  const asLocal = (body: Record<string, unknown>) =>
    s.local(path(), post({ author: BRYAN, ...body }));

  async function startMeeting(source: 'mic' | 'mix' | 'bot'): Promise<LeadChatMeeting> {
    const res = await asOwner({
      action: 'start',
      docId,
      docTitle: 'Riverbend sync',
      notes: 'existing',
      source,
      speakers: 'conversation',
      recorder: `rec-${source}`,
    });
    return (await readJson<{ meeting: LeadChatMeeting }>(res)).meeting;
  }
  async function line(
    m: LeadChatMeeting,
    turn: number,
    text: string,
    send = asOwner,
  ): Promise<string | undefined> {
    const res = await send({ action: 'line', id: m.id, turn, who: 'Bryan', text });
    return (await readJson<{ message?: string }>(res)).message;
  }
  const heard = (text: string) => lead.voice.filter((v) => v.transcript === text).length;

  beforeAll(async () => {
    s = await startShareProofServer('Harborlight');
    s.handle.tasks.attachAgent(s.board, {
      agentId: 'harborlight-lead',
      agentName: 'Harborlight Lead',
      runtime: 'claude-code-local',
    });
    s.handle.tasks.setLeadAgent(s.board, 'harborlight-lead', { actor: BRYAN });
    const notes = join(dir, 'riverbend-sync.md');
    writeFileSync(notes, '# Riverbend sync\n');
    const made = await readJson<{ docId: string }>(
      await s.local(
        `${s.scope}/docs`,
        post({ docId: 'riverbend-sync', sourceUrl: notes, title: 'Riverbend sync' }),
      ),
    );
    docId = made.docId;
    lead = await agentStream(`http://127.0.0.1:${s.handle.port}`, s.board, 'harborlight-lead');
  });

  afterAll(async () => {
    lead?.close();
    await s.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('hands the owner’s "Lead," line to the lead once, and keeps other talk from it', async () => {
    const m = await startMeeting('mic');
    const ask = 'Lead, file a task to price the Saltmarsh slipway.';
    expect(await line(m, 1, 'Alice, can you lead the review?')).toBeUndefined();
    expect(await line(m, 2, ask)).toBeDefined();
    // The same turn again, as a reconnect re-sends it, is not a second ask.
    expect(await line(m, 2, ask)).toBeUndefined();
    await waitFor(() => heard(ask) > 0, { describe: 'lead got the ask' });
    // An unproven caller on this machine, an agent say, on the same meeting.
    const local = 'Lead, archive the Harborlight board.';
    const refused = await asLocal({ action: 'line', id: m.id, turn: 3, who: 'Bryan', text: local });
    // Told why, so the page can ask for a sign-in rather than drop it unseen.
    expect(await readJson<{ message?: string; lead?: string }>(refused)).toMatchObject({
      lead: 'sign-in',
    });
    // Positive control for the waits below: a later proven ask arrives, so
    // the stream would have carried the refused ones too.
    const later = 'Lead, what is left on the ferry task?';
    expect(await line(m, 4, later)).toBeDefined();
    await waitFor(() => heard(later) > 0, { describe: 'lead got the later ask' });
    expect(heard(ask)).toBe(1);
    expect(heard(local)).toBe(0);
    expect(lead.voice.some((v) => v.transcript?.startsWith('Alice'))).toBe(false);
    expect((await asOwner({ action: 'end', id: m.id })).status).toBe(200);
  });

  it('never hands the lead a line from a call bot or from Mac audio', async () => {
    for (const source of ['bot', 'mix'] as const) {
      const m = await startMeeting(source);
      const ask = `Lead, delete the Riverbend notes (${source}).`;
      const res = await asOwner({ action: 'line', id: m.id, turn: 1, who: 'Bryan', text: ask });
      // No sign-in would change this one, so the page is not asked for one.
      expect(await readJson<{ line?: unknown; message?: string; lead?: string }>(res)).toEqual({
        line: expect.objectContaining({ text: ask }),
      });
      expect((await asOwner({ action: 'end', id: m.id })).status).toBe(200);
      expect(heard(ask)).toBe(0);
    }
    // Positive control: a proven mic meeting after them still reaches the lead.
    const m = await startMeeting('mic');
    const ask = 'Lead, summarise the Saltmarsh call.';
    expect(await line(m, 1, ask)).toBeDefined();
    await waitFor(() => heard(ask) > 0, { describe: 'lead got the mic ask' });
    expect(lead.voice.some((v) => v.transcript?.includes('(bot)'))).toBe(false);
    expect(lead.voice.some((v) => v.transcript?.includes('(mix)'))).toBe(false);
  });
});
