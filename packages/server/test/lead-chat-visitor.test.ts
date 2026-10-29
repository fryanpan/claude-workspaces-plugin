/**
 * The owner's chat with the board's lead never reaches a share visitor.
 *
 * Both lead-chat routes refuse a visitor, but the frames that keep an open
 * page current ride the board stream `ws~<id>`, which a visitor may open. So
 * the visitor's copy of that stream has to drop every `lead-chat.*` frame —
 * dropped, not redacted, because the whole frame is the conversation.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LEAD_CHAT_EVENT,
  LEAD_CHAT_MEETING_EVENT,
  LEAD_CHAT_MEETING_LINE_EVENT,
} from '@claude-workspaces/core/lead-chat';
import { type ServerHandle, createServer } from '../src/server.ts';
import { type AccessHarness, accessHarness, mintAccessShare } from './access-share.ts';
import { waitFor } from './wait-for.ts';

setDefaultTimeout(30_000);

/** Every frame's `event` field, in arrival order, until `close()`. */
async function boardStream(url: string, headers: Record<string, string>) {
  const controller = new AbortController();
  const res = await fetch(url, {
    signal: controller.signal,
    headers: { accept: 'text/event-stream', ...headers },
  });
  if (!res.ok) throw new Error(`board stream: HTTP ${res.status}`);
  const events: string[] = [];
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
          const data = buf
            .slice(0, cut)
            .split('\n')
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trim())
            .join('');
          buf = buf.slice(cut + 2);
          cut = buf.indexOf('\n\n');
          if (!data) continue;
          try {
            const p = JSON.parse(data) as { event?: string };
            if (p.event) events.push(p.event);
          } catch {
            // A keepalive.
          }
        }
      }
    } catch {
      // Aborted by close().
    }
  })();
  return { events, close: () => controller.abort() };
}

describe('the lead chat and a share visitor', () => {
  let handle: ServerHandle;
  let access: AccessHarness;
  let dataDir: string;
  let base: string;
  let boardId = '';
  const BRYAN = { id: 'known-bryan', name: 'Bryan', kind: 'known' };

  const local = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { host: `localhost:${handle.port}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-lead-chat-visitor-'));
    access = await accessHarness();
    handle = createServer({ port: 0, dataDir, ...access.serverOptions });
    base = `http://127.0.0.1:${handle.port}`;
    const ws = await local('/workspaces', { name: 'Harborlight' });
    boardId = ((await ws.json()) as { workspace: { id: string } }).workspace.id;
    handle.tasks.attachAgent(boardId, {
      agentId: 'harborlight-lead',
      agentName: 'Harborlight Lead',
      runtime: 'claude-code-local',
    });
    handle.tasks.setLeadAgent(boardId, 'harborlight-lead', { actor: BRYAN });
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("gives the owner's page the chat and the visitor's stream none of it", async () => {
    const minted = await mintAccessShare(
      base,
      { ...access, shareLinks: handle.shareLinks },
      boardId,
    );
    const streamUrl = `${base}/workspaces/${boardId}/events:stream`;
    const visitor = await boardStream(streamUrl, minted.headers);
    const owner = await boardStream(streamUrl, { host: `localhost:${handle.port}` });
    try {
      const said = await local(`/workspaces/${boardId}/lead-chat`, {
        text: 'Is the Saltmarsh launch on for Friday?',
        author: BRYAN,
      });
      expect(said.status).toBe(201);
      // One stream carries both frames in order, so once the visitor has the
      // task frame that came after it, the chat frame has had its chance.
      const filed = await local(`/workspaces/${boardId}/tasks`, {
        author: BRYAN,
        title: 'Riverbend signup copy',
      });
      expect(filed.status).toBe(200);

      await waitFor(() => owner.events.includes(LEAD_CHAT_EVENT), {
        describe: "owner's page shown the chat",
      });
      // Positive control: the visitor's stream is open and live.
      await waitFor(() => visitor.events.includes('task.created'), {
        describe: 'visitor stream got the later task frame',
      });
      expect(visitor.events.filter((e) => e.startsWith('lead-chat.'))).toEqual([]);
    } finally {
      visitor.close();
      owner.close();
    }
  });

  it("gives the owner's page the meeting and the visitor's stream none of it", async () => {
    const notes = join(dataDir, 'riverbend-sync.md');
    writeFileSync(notes, '# Riverbend sync\n');
    const made = await local(`/workspaces/${boardId}/docs`, {
      docId: 'riverbend-sync',
      sourceUrl: notes,
      title: 'Riverbend sync',
    });
    const docId = ((await made.json()) as { docId: string }).docId;
    const minted = await mintAccessShare(
      base,
      { ...access, shareLinks: handle.shareLinks },
      boardId,
    );
    const streamUrl = `${base}/workspaces/${boardId}/events:stream`;
    const visitor = await boardStream(streamUrl, minted.headers);
    const owner = await boardStream(streamUrl, { host: `localhost:${handle.port}` });
    const meetingPath = `/workspaces/${boardId}/lead-chat/meeting`;
    try {
      const started = await local(meetingPath, {
        action: 'start',
        author: BRYAN,
        docId,
        docTitle: 'Riverbend sync',
        notes: 'existing',
        source: 'mic',
        speakers: 'conversation',
        recorder: 'rec-1',
      });
      expect(started.status).toBe(201);
      const { meeting } = (await started.json()) as { meeting: { id: string } };
      const said = await local(meetingPath, {
        action: 'line',
        author: BRYAN,
        id: meeting.id,
        turn: 0,
        who: 'Bryan',
        text: 'The Saltmarsh slipway opens at nine.',
      });
      expect(said.status).toBe(200);
      const filed = await local(`/workspaces/${boardId}/tasks`, {
        author: BRYAN,
        title: 'Harborlight ferry times',
      });
      expect(filed.status).toBe(200);

      await waitFor(() => owner.events.includes(LEAD_CHAT_MEETING_LINE_EVENT), {
        describe: "owner's page shown the meeting line",
      });
      expect(owner.events).toContain(LEAD_CHAT_MEETING_EVENT);
      // Positive control: the visitor's stream is open and live.
      await waitFor(() => visitor.events.includes('task.created'), {
        describe: 'visitor stream got the later task frame',
      });
      expect(visitor.events.filter((e) => e.startsWith('lead-chat.'))).toEqual([]);
    } finally {
      visitor.close();
      owner.close();
    }
  });
});
