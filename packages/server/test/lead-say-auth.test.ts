/**
 * Who may speak into a board's meeting (`POST …/lead-chat/meeting/say`), with
 * the agent token required: the board's lead with its own token, and nobody
 * else. An agent id is a hash of a name shown on the board, so without the
 * token any process on the machine could post the lead's id and speak into
 * the meeting as the lead.
 *
 * And who hears the meeting: a lead whose session reported a plugin older
 * than the frames' renderer is sent neither the start nor the lines.
 *
 * The process check is injected as agent-stream-auth.test.ts injects it; the
 * token comes from the server's own mint route. Every name is a house
 * fixture name; port 0; no production server is touched.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LEAD_MEETING_HEARD_EVENT,
  LEAD_MEETING_STARTED_EVENT,
} from '../src/lead-chat/meeting-feed.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { waitFor } from './wait-for.ts';

const LEAD = 'harborlight-lead';
const OTHER = 'riverbend-lead';
const ALICE = { id: 'known-alice', name: 'Alice', kind: 'known' };

describe('speaking into a meeting, with the agent token required', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let board = '';
  let docId = '';
  let callerIs: string | null = null;

  const headers = (extra: Record<string, string> = {}) => ({
    host: `localhost:${handle.port}`,
    'content-type': 'application/json',
    ...extra,
  });
  const post = (path: string, body: unknown, extra: Record<string, string> = {}) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: headers(extra),
      body: JSON.stringify(body),
    });
  const tokenFor = async (agentId: string): Promise<string> => {
    callerIs = agentId;
    const res = await fetch(`${base}/api/agents/${agentId}/token`, { headers: headers() });
    expect(res.status, await res.clone().text()).toBe(200);
    return ((await res.json()) as { token: string }).token;
  };
  const say = (agentId: string, extra: Record<string, string> = {}) =>
    post(`/workspaces/${board}/lead-chat/meeting/say`, { agentId, text: 'Who is it for?' }, extra);

  async function start(pluginVersion: string, requireAgentToken = true): Promise<void> {
    dataDir = mkdtempSync(join(tmpdir(), 'lead-say-auth-'));
    handle = createServer({
      port: 0,
      dataDir,
      requireAgentToken,
      identifyAgentCaller: async () => ({ ok: true, agentId: callerIs, via: 'session' }),
    });
    base = `http://127.0.0.1:${handle.port}`;
    board = (
      (await (await post('/workspaces', { name: 'Harborlight' })).json()) as {
        workspace: { id: string };
      }
    ).workspace.id;
    for (const agentId of [LEAD, OTHER]) {
      handle.tasks.attachAgent(board, { agentId, runtime: 'claude-code-local', pluginVersion });
    }
    handle.tasks.setLeadAgent(board, LEAD, { actor: ALICE });
    const path = join(dataDir, 'saltmarsh-plan.md');
    writeFileSync(path, '# Saltmarsh plan\n');
    const doc = (await (
      await post(`/workspaces/${board}/docs`, { docId: 'saltmarsh-plan', sourceUrl: path })
    ).json()) as { docId: string };
    docId = doc.docId;
    const res = await post(`/workspaces/${board}/lead-chat/meeting`, {
      author: ALICE,
      action: 'start',
      docId,
      docTitle: 'Saltmarsh plan',
      notes: 'existing',
      source: 'mic',
      speakers: 'conversation',
      recorder: 'rec-1',
    });
    expect(res.status).toBe(201);
  }

  afterEach(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  describe('a lead on a current plugin', () => {
    beforeEach(() => start('0.1.347'));

    it('lets the lead speak with its own token', async () => {
      const res = await say(LEAD, { authorization: `Bearer ${await tokenFor(LEAD)}` });
      expect(res.status, await res.clone().text()).toBe(200);
    });

    it('refuses the lead’s id carried by another agent’s token, or a forged one', async () => {
      const other = await say(LEAD, { authorization: `Bearer ${await tokenFor(OTHER)}` });
      expect(other.status).toBe(403);
      expect(await other.json()).toMatchObject({ error: 'agent-token-mismatch' });
      const forged = await say(LEAD, { authorization: `Bearer at1.${LEAD}.notamac` });
      expect(forged.status).toBe(403);
    });

    it('refuses the lead’s id with no token at all', async () => {
      const res = await say(LEAD);
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ error: 'agent-token-required' });
    });

    it('refuses another agent with its own valid token: it is not the lead', async () => {
      const res = await say(OTHER, { authorization: `Bearer ${await tokenFor(OTHER)}` });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: 'not-lead' });
    });
  });

  describe('with the server’s token rollout still off', () => {
    beforeEach(() => start('0.1.347', false));

    it('still refuses the lead’s id with no token: no tokenless client ever called this', async () => {
      const res = await say(LEAD);
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ error: 'agent-token-required' });
      const ok = await say(LEAD, { authorization: `Bearer ${await tokenFor(LEAD)}` });
      expect(ok.status).toBe(200);
    });
  });

  describe('a lead on a plugin older than the meeting frames', () => {
    beforeEach(() => start('0.1.346'));

    it('is sent neither the start nor the room’s lines', async () => {
      const token = await tokenFor(LEAD);
      const controller = new AbortController();
      const stream = await fetch(`${base}/workspaces/${board}/events:stream?agentId=${LEAD}`, {
        signal: controller.signal,
        headers: headers({ accept: 'text/event-stream', authorization: `Bearer ${token}` }),
      });
      let text = '';
      const reader = stream.body?.getReader();
      const reading = (async () => {
        const dec = new TextDecoder();
        try {
          while (reader) {
            const { done, value } = await reader.read();
            if (done) return;
            text += dec.decode(value, { stream: true });
          }
        } catch {
          // Aborted.
        }
      })();
      const meetingId = async () =>
        (
          (await (
            await fetch(`${base}/workspaces/${board}/lead-chat`, { headers: headers() })
          ).json()) as { meeting?: { id: string } }
        ).meeting?.id ?? '';
      const act = (body: Record<string, unknown>) =>
        post(`/workspaces/${board}/lead-chat/meeting`, { author: ALICE, ...body });
      const id = await meetingId();
      await act({
        action: 'line',
        id,
        turn: 0,
        who: 'Alice',
        text: 'The Harborlight ferry runs at six.',
      });
      await act({ action: 'end', id });
      // The positive control: the same lead, once its session reports a
      // current plugin, is told of the next meeting on this same stream.
      handle.tasks.attachAgent(board, {
        agentId: LEAD,
        runtime: 'claude-code-local',
        pluginVersion: '0.1.347',
      });
      await act({
        action: 'start',
        docId,
        docTitle: 'Saltmarsh plan',
        notes: 'existing',
        source: 'mic',
        speakers: 'conversation',
        recorder: 'rec-1',
      });
      const second = await meetingId();
      expect(second).not.toBe('');
      expect(id).not.toBe('');
      await waitFor(() => text.includes(LEAD_MEETING_STARTED_EVENT), {
        describe: 'the current lead told of the second meeting',
      });
      controller.abort();
      await reading;
      // One SSE frame names its event twice: the `event:` line and the data.
      expect(text.split(`event: ${LEAD_MEETING_STARTED_EVENT}\n`)).toHaveLength(2);
      expect(text).toContain(second);
      expect(text).not.toContain(id);
      expect(text).not.toContain(LEAD_MEETING_HEARD_EVENT);
    });
  });
});
