/**
 * The lead chat's meeting through the REAL server.
 *
 * A meeting started from the chat belongs to the board: an already-open page
 * is told it started, is sent every line said within a second, and is told it
 * ended — the "every surface is live" path. A line that opens with "Lead," goes
 * to the lead once, however often the recording page sends it; every other
 * line stays in the notes. A "No notes" meeting records and transcribes but
 * writes nothing into its doc.
 *
 * The engine is the mock and the composer is the stub: no network, no bill.
 * Every name is a house fixture name.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MEETING_AUDIO_ENCODING,
  MEETING_SAMPLE_RATE,
  meetingSocketPath,
  prose,
} from '@claude-workspaces/core';
import {
  LEAD_CHAT_MEETING_EVENT,
  LEAD_CHAT_MEETING_LINE_EVENT,
  type LeadChatMeeting,
  type LeadChatMeetingLine,
} from '@claude-workspaces/core/lead-chat';
import { LeadChatMeetings } from '../src/lead-chat/meeting.ts';
import { type TickScheduler, createStubNotesComposer } from '../src/meeting-notes.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { type MockScriptTurn, createMockTranscriptionEngine } from '../src/transcribe.ts';
import { agentStream } from './agent-voice-stream.ts';
import { waitFor } from './wait-for.ts';

setDefaultTimeout(30_000);

class ManualScheduler implements TickScheduler {
  private fns = new Map<number, () => void>();
  private n = 0;
  set(fn: () => void, _ms: number): unknown {
    this.n++;
    this.fns.set(this.n, fn);
    return this.n;
  }
  clear(handle: unknown): void {
    this.fns.delete(handle as number);
  }
  fire(): void {
    const pending = [...this.fns.values()];
    this.fns.clear();
    for (const fn of pending) fn();
  }
}

const SCRIPT: readonly MockScriptTurn[] = [
  { words: ['the', 'ferry', 'runs'], settled: 'The Harborlight ferry runs at six.', speaker: 'A' },
];

/** A page's board stream: each meeting frame and each line frame. */
async function pageStream(base: string, workspaceId: string) {
  const controller = new AbortController();
  const res = await fetch(`${base}/workspaces/${workspaceId}/events:stream`, {
    signal: controller.signal,
    headers: { accept: 'text/event-stream' },
  });
  const meetings: Array<LeadChatMeeting | null> = [];
  const lines: LeadChatMeetingLine[] = [];
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
            const p = JSON.parse(data) as {
              event?: string;
              meeting?: LeadChatMeeting | null;
              line?: LeadChatMeetingLine;
            };
            if (p.event === LEAD_CHAT_MEETING_EVENT) meetings.push(p.meeting ?? null);
            if (p.event === LEAD_CHAT_MEETING_LINE_EVENT && p.line) lines.push(p.line);
          } catch {
            // A keepalive.
          }
        }
      }
    } catch {
      // Aborted.
    }
  })();
  return { meetings, lines, close: () => controller.abort() };
}

describe('the lead chat’s meeting', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let wsBase: string;
  let boardId = '';
  let docId = '';
  let lead: Awaited<ReturnType<typeof agentStream>>;
  let page: Awaited<ReturnType<typeof pageStream>>;
  const schedule = new ManualScheduler();
  const BRYAN = { id: 'known-bryan', name: 'Bryan', kind: 'known' };
  const ALICE = { id: 'known-alice', name: 'Alice', kind: 'known' };

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const act = (body: Record<string, unknown>) =>
    post(`/workspaces/${boardId}/lead-chat/meeting`, { author: BRYAN, ...body });
  const markdownOf = (id: string): string => {
    const doc = handle.docStore.get(id);
    if (!doc) throw new Error(`no doc ${id}`);
    return prose.serializeFragmentToMarkdown(prose.getProseFragment(doc.ydoc));
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-lead-chat-meeting-'));
    handle = createServer({
      port: 0,
      dataDir,
      transcription: createMockTranscriptionEngine(SCRIPT),
      meetingNotes: { composer: createStubNotesComposer(), quietMs: 1_000, schedule },
    });
    base = `http://127.0.0.1:${handle.port}`;
    wsBase = `ws://127.0.0.1:${handle.port}`;
    const ws = await post('/workspaces', { name: 'Harborlight' });
    boardId = ((await ws.json()) as { workspace: { id: string } }).workspace.id;
    handle.tasks.attachAgent(boardId, {
      agentId: 'harborlight-lead',
      agentName: 'Harborlight Lead',
      runtime: 'claude-code-local',
    });
    handle.tasks.setLeadAgent(boardId, 'harborlight-lead', { actor: BRYAN });
    const path = join(dataDir, 'riverbend-sync.md');
    writeFileSync(path, '# Riverbend sync\n');
    const made = await post(`/workspaces/${boardId}/docs`, {
      docId: 'riverbend-sync',
      sourceUrl: path,
      title: 'Riverbend sync',
    });
    docId = ((await made.json()) as { docId: string }).docId;
    lead = await agentStream(base, boardId, 'harborlight-lead');
    page = await pageStream(base, boardId);
  });

  afterAll(async () => {
    lead.close();
    page.close();
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  let meeting: LeadChatMeeting;

  it('refuses a doc the board does not hold, and a start missing its choices', async () => {
    const base = {
      action: 'start',
      docTitle: 'Riverbend sync',
      notes: 'existing',
      source: 'mic',
      speakers: 'conversation',
      recorder: 'rec-1',
    };
    expect((await act({ ...base, docId: 'd-nowhere' })).status).toBe(404);
    expect((await act({ ...base, docId, notes: 'some' })).status).toBe(400);
    expect((await act({ ...base, docId, recorder: '../x' })).status).toBe(400);
  });

  it('starts a meeting that an already-open page is told about', async () => {
    const res = await act({
      action: 'start',
      docId,
      docTitle: 'Riverbend sync',
      notes: 'existing',
      source: 'mic',
      speakers: 'conversation',
      recorder: 'rec-1',
    });
    expect(res.status).toBe(201);
    meeting = ((await res.json()) as { meeting: LeadChatMeeting }).meeting;
    expect(meeting).toMatchObject({ docId, notes: 'existing', recorder: 'rec-1', lines: [] });
    expect(meeting.people).toEqual([{ id: BRYAN.id, name: 'Bryan' }]);
    await waitFor(() => page.meetings.some((m) => m?.id === meeting.id), {
      describe: 'open page told the meeting started',
      timeout: 1000,
    });
    // A second start while one runs is refused: one meeting per board.
    const again = await act({ ...meeting, action: 'start', recorder: 'rec-2' });
    expect(again.status).toBe(409);
    const read = (await (await fetch(`${base}/workspaces/${boardId}/lead-chat`)).json()) as {
      meeting: LeadChatMeeting;
    };
    expect(read.meeting.id).toBe(meeting.id);
  });

  it('sends each line said to an open page within a second', async () => {
    const res = await act({
      action: 'line',
      id: meeting.id,
      turn: 0,
      who: 'Bryan',
      text: 'The ferry runs at six.',
    });
    expect(res.status).toBe(200);
    await waitFor(() => page.lines.some((l) => l.text === 'The ferry runs at six.'), {
      describe: 'open page shown the line',
      timeout: 1000,
    });
    const read = (await (await fetch(`${base}/workspaces/${boardId}/lead-chat`)).json()) as {
      meeting: LeadChatMeeting;
    };
    expect(read.meeting.lines.map((l) => l.text)).toEqual(['The ferry runs at six.']);
  });

  it('hands a "Lead," line to the lead once, and keeps the room’s talk from it', async () => {
    const ask = 'Lead, file a task to price the Saltmarsh slipway.';
    const send = (turn: number, text: string) =>
      act({ action: 'line', id: meeting.id, turn, who: 'Bryan', text });
    expect((await send(1, 'Alice, can you lead the review?')).status).toBe(200);
    const first = (await (await send(2, ask)).json()) as { message?: string };
    expect(first.message).toBeDefined();
    // The same turn again — a reconnect re-sending it — is not a second ask.
    const twice = (await (await send(2, ask)).json()) as { message?: string };
    expect(twice.message).toBeUndefined();
    await waitFor(() => lead.voice.some((v) => v.transcript === ask), {
      describe: 'lead got the ask',
    });
    expect(lead.voice.filter((v) => v.transcript === ask)).toHaveLength(1);
    expect(lead.voice.some((v) => v.transcript?.startsWith('Alice'))).toBe(false);
  });

  it('adds a member who opens a page, and lets only the owner end it', async () => {
    const joined = await post(`/workspaces/${boardId}/lead-chat/meeting`, {
      action: 'join',
      id: meeting.id,
      author: ALICE,
    });
    expect(joined.status).toBe(200);
    const m = ((await joined.json()) as { meeting: LeadChatMeeting }).meeting;
    expect(m.people.map((p) => p.name)).toEqual(['Bryan', 'Alice']);
    expect((await act({ action: 'end', id: 'lcm-other' })).status).toBe(409);
    expect((await act({ action: 'end', id: meeting.id })).status).toBe(200);
    await waitFor(() => page.meetings.at(-1) === null, {
      describe: 'open page told the meeting ended',
      timeout: 1000,
    });
    const read = (await (await fetch(`${base}/workspaces/${boardId}/lead-chat`)).json()) as {
      meeting: LeadChatMeeting | null;
    };
    expect(read.meeting).toBeNull();
  });

  it('comes back after a restart to the meeting it was running', () => {
    const frames: unknown[] = [];
    const deps = {
      dataDir,
      broadcast: (_ws: string, f: unknown) => frames.push(f),
      newId: () => 'lcm-restart',
    };
    const one = new LeadChatMeetings(deps);
    const started = one.start('w-saltmarsh', {
      by: { id: BRYAN.id, name: 'Bryan' },
      docId,
      docTitle: 'Riverbend sync',
      notes: 'none',
      source: 'mic',
      speakers: 'solo',
      recorder: 'rec-9',
    });
    expect(started.ok).toBe(true);
    one.recording('w-saltmarsh', 'lcm-restart', { meetingId: 'm-1', recorder: 'rec-9' });
    const two = new LeadChatMeetings(deps);
    expect(two.current('w-saltmarsh')).toMatchObject({ id: 'lcm-restart', meetingId: 'm-1' });
    two.end('w-saltmarsh', 'lcm-restart');
    expect(new LeadChatMeetings(deps).current('w-saltmarsh')).toBeNull();
  });

  it('records a "No notes" meeting without writing a note into its doc', async () => {
    const run = async (notes: boolean) => {
      const ws = new WebSocket(`${wsBase}${meetingSocketPath(boardId, docId)}`);
      ws.binaryType = 'arraybuffer';
      const frames: Array<{ type: string; final?: boolean }> = [];
      ws.addEventListener('message', (ev) => frames.push(JSON.parse(ev.data as string)));
      await new Promise<void>((resolve) => ws.addEventListener('open', () => resolve()));
      ws.send(
        JSON.stringify({
          type: 'start',
          sampleRate: MEETING_SAMPLE_RATE,
          encoding: MEETING_AUDIO_ENCODING,
          mode: 'solo',
          ...(notes ? {} : { notes: false }),
        }),
      );
      await waitFor(() => frames.some((f) => f.type === 'ready') || undefined, {
        describe: 'ready',
      });
      for (let i = 0; i < 4; i++) ws.send(new Uint8Array(640));
      await waitFor(() => frames.some((f) => f.type === 'transcript' && f.final) || undefined, {
        describe: 'the settled turn',
      });
      schedule.fire();
      ws.send(JSON.stringify({ type: 'stop' }));
      await waitFor(() => frames.some((f) => f.type === 'stopped') || undefined, {
        describe: 'stopped',
      });
      ws.close();
    };
    await run(false);
    expect(markdownOf(docId)).not.toContain('The Harborlight ferry runs at six.');
    // The control: the same meeting with notes on writes the line.
    await run(true);
    await waitFor(
      () => markdownOf(docId).includes('The Harborlight ferry runs at six.') || undefined,
      {
        describe: 'the note in the doc',
      },
    );
  });
});
