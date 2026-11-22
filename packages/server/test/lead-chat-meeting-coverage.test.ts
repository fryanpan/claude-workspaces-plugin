/**
 * A recording's coverage reaches an already-open page, through the REAL
 * server: the lead chat's meeting carries it on the board stream, so every
 * page shows "Recording" while audio arrives and the minutes once it stops,
 * without a reload. And the finished notes carry the coverage line.
 *
 * The gap and drop timing is `meeting-coverage.test.ts`, on a fake clock; this
 * file proves the path from the audio socket to a page's stream and to the
 * doc. Mock engine, stub composer; every name is a house fixture name.
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
import { LEAD_CHAT_MEETING_EVENT, type LeadChatMeeting } from '@claude-workspaces/core/lead-chat';
import { LeadChatMeetings } from '../src/lead-chat/meeting.ts';
import { createStubNotesComposer } from '../src/meeting-notes.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { createMockTranscriptionEngine } from '../src/transcribe.ts';
import { pageStream } from './lead-chat-page-stream.ts';
import { ManualScheduler } from './notes-tick-harness.ts';
import { waitFor } from './wait-for.ts';

setDefaultTimeout(30_000);

describe('a recording’s coverage on an open page', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let boardId = '';
  let docId = '';
  const schedule = new ManualScheduler();
  const BRYAN = { id: 'known-bryan', name: 'Bryan', kind: 'known' };

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-meeting-coverage-live-'));
    handle = createServer({
      port: 0,
      dataDir,
      transcription: createMockTranscriptionEngine([
        { words: ['the', 'slipway'], settled: 'The Saltmarsh slipway opens in May.', speaker: 'A' },
      ]),
      meetingNotes: { composer: createStubNotesComposer(), quietMs: 1_000, schedule },
    });
    base = `http://127.0.0.1:${handle.port}`;
    const ws = await post('/workspaces', { name: 'Harborlight' });
    boardId = ((await ws.json()) as { workspace: { id: string } }).workspace.id;
    const path = join(dataDir, 'saltmarsh-sync.md');
    writeFileSync(path, '# Saltmarsh sync\n');
    const made = await post(`/workspaces/${boardId}/docs`, {
      docId: 'saltmarsh-sync',
      sourceUrl: path,
      title: 'Saltmarsh sync',
    });
    docId = ((await made.json()) as { docId: string }).docId;
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('shows the recording live, then its minutes, and stamps the notes', async () => {
    const page = await pageStream(base, boardId);
    const meetings = () =>
      page.frames
        .filter((f) => f.event === LEAD_CHAT_MEETING_EVENT)
        .map((f) => f.meeting as LeadChatMeeting | null);
    const started = await post(`/workspaces/${boardId}/lead-chat/meeting`, {
      author: BRYAN,
      action: 'start',
      docId,
      docTitle: 'Saltmarsh sync',
      notes: 'existing',
      source: 'mic',
      speakers: 'conversation',
      recorder: 'rec-1',
    });
    expect(started.status).toBe(201);
    // Before the recording runs, the meeting carries no coverage.
    await waitFor(() => meetings().length > 0 || undefined, { describe: 'meeting on the page' });
    expect(meetings().at(-1)?.coverage).toBeUndefined();

    const socket = new WebSocket(
      `ws://127.0.0.1:${handle.port}${meetingSocketPath(boardId, docId)}`,
    );
    socket.binaryType = 'arraybuffer';
    const frames: Array<{ type: string; final?: boolean }> = [];
    socket.addEventListener('message', (ev) => frames.push(JSON.parse(ev.data as string)));
    await new Promise<void>((resolve) => socket.addEventListener('open', () => resolve()));
    socket.send(
      JSON.stringify({
        type: 'start',
        sampleRate: MEETING_SAMPLE_RATE,
        encoding: MEETING_AUDIO_ENCODING,
        mode: 'conversation',
      }),
    );
    await waitFor(() => meetings().at(-1)?.coverage?.state === 'recording' || undefined, {
      describe: 'the open page told the meeting is recording',
      timeout: 1000,
    });
    // Two seconds of audio, so the turn settles and a notes section exists.
    for (let i = 0; i < 4; i++) socket.send(new Uint8Array(16_000));
    await waitFor(() => frames.some((f) => f.type === 'transcript' && f.final) || undefined, {
      describe: 'the settled turn',
    });
    schedule.fire();
    const markdown = (): string => {
      const doc = handle.docStore.get(docId);
      return doc ? prose.serializeFragmentToMarkdown(prose.getProseFragment(doc.ydoc)) : '';
    };
    await waitFor(() => markdown().includes('Saltmarsh slipway') || undefined, {
      describe: 'the note in the doc',
    });
    socket.send(JSON.stringify({ type: 'stop' }));
    await waitFor(() => meetings().at(-1)?.coverage?.state === 'stopped' || undefined, {
      describe: 'the open page told the recording stopped',
      timeout: 1000,
    });
    expect(meetings().at(-1)?.coverage?.capturedMs).toBe(2_000);
    // Seconds, not minutes: the test meeting is shorter than one.
    await waitFor(() => /Coverage: captured \d+ of \d+ seconds\./.test(markdown()) || undefined, {
      describe: 'the coverage line in the notes',
    });
    socket.close();
    page.close();
  });

  it('forgets a live status after a restart, keeping a stopped one', () => {
    const deps = { dataDir, broadcast: () => {}, newId: () => 'lcm-restart' };
    const one = new LeadChatMeetings(deps);
    one.start('w-riverbend', {
      by: { id: BRYAN.id, name: 'Bryan' },
      docId,
      docTitle: 'Saltmarsh sync',
      notes: 'none',
      source: 'mic',
      speakers: 'solo',
      recorder: 'rec-9',
    });
    one.recording('w-riverbend', 'lcm-restart', { meetingId: 'm-9', recorder: 'rec-9' });
    const live = {
      meetingId: 'm-9',
      startedAt: 1,
      capturedMs: 60_000,
      asOf: 60_001,
      state: 'recording' as const,
      gapsClosed: 0,
    };
    one.coverageForDoc(docId, live);
    expect(one.current('w-riverbend')?.coverage?.state).toBe('recording');
    // Nothing watches the recording once the process is gone, so a page must
    // not be told it is still recording.
    expect(new LeadChatMeetings(deps).current('w-riverbend')?.coverage).toBeUndefined();
    one.coverageForDoc(docId, { ...live, state: 'stopped' });
    expect(new LeadChatMeetings(deps).current('w-riverbend')?.coverage?.state).toBe('stopped');
  });
});
