/**
 * A meeting whose notes came out badly, on a huddle doc no row links, end to
 * end: the item reaches the board's review queue as a question on the doc.
 *
 * THE FAILURE THIS FILE IS ABOUT. A meeting on a doc nobody had linked to a
 * task was flagged BAD at the stop and then "NOT filed (no-row)" — a verdict
 * in a log nobody reads, and nothing on the queue. The unit tests cover the
 * choice of where the item goes; this covers the server's wiring of it, which
 * no unit test reaches.
 *
 * The engine is the mock, the composer is the stub, and the repeats are
 * pasted by a person the way `notes-quality-line.test.ts` pastes them — the
 * note-taker can no longer write one itself. All fixtures are synthetic.
 * The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MEETING_AUDIO_ENCODING,
  MEETING_SAMPLE_RATE,
  meetingSocketPath,
  prose,
} from '@claude-workspaces/core';
import { type TickScheduler, createStubNotesComposer } from '../src/meeting-notes.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { type MockScriptTurn, createMockTranscriptionEngine } from '../src/transcribe.ts';
import { waitFor } from './wait-for.ts';

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
  {
    words: ['the', 'ferry', 'moves'],
    settled: 'The Saltmarsh ferry moves to the half hour from Monday.',
    speaker: 'A',
  },
];

interface QueueRow {
  kind: string;
  docId?: string;
  threadId?: string;
  title?: string;
  headline?: string;
}

describe('a bad meeting on a doc no row links', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let workspaceId: string;
  let docId: string;
  const schedule = new ManualScheduler();
  let ticks = 0;

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'quality-unlinked-'));
    handle = createServer({
      port: 0,
      dataDir,
      transcription: createMockTranscriptionEngine(SCRIPT),
      meetingNotes: {
        composer: createStubNotesComposer(),
        quietMs: 1_000,
        schedule,
        onNotes: () => {
          ticks += 1;
        },
      },
    });
    base = `http://127.0.0.1:${handle.port}`;
    workspaceId = (
      (await (await post('/workspaces', { name: 'harborlight-board' })).json()) as {
        workspace: { id: string };
      }
    ).workspace.id;
    docId = (
      (await (await post(`/workspaces/${workspaceId}/huddles`, { kind: 'discussion' })).json()) as {
        docId: string;
      }
    ).docId;
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('puts the item on the board’s review queue, on the doc', async () => {
    const queue = async (): Promise<QueueRow[]> =>
      (
        (await (await fetch(`${base}/workspaces/${workspaceId}/review-items`)).json()) as {
          items: QueueRow[];
        }
      ).items.filter((i) => i.kind === 'doc-thread' && i.docId === docId);
    expect(handle.tasks.backlinksFor({ kind: 'doc', docId })).toEqual([]);
    expect(await queue()).toEqual([]);

    const ws = new WebSocket(
      `ws://127.0.0.1:${handle.port}${meetingSocketPath(workspaceId, docId)}`,
    );
    ws.binaryType = 'arraybuffer';
    const frames: Array<{ type: string; final?: boolean }> = [];
    ws.addEventListener('message', (ev) => frames.push(JSON.parse(ev.data as string)));
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('audio socket refused')));
    });
    ws.send(
      JSON.stringify({
        type: 'start',
        sampleRate: MEETING_SAMPLE_RATE,
        encoding: MEETING_AUDIO_ENCODING,
        mode: 'conversation',
      }),
    );
    await waitFor(() => frames.some((f) => f.type === 'ready'), { describe: 'ready' });
    for (let i = 0; i < 4; i++) ws.send(new Uint8Array(640));
    await waitFor(() => frames.some((f) => f.type === 'transcript' && f.final === true), {
      describe: 'the settled turn',
    });
    schedule.fire();
    await waitFor(() => ticks === 1, { describe: 'the first note' });

    // A person pastes one line five times: four repeats, past the bar of three.
    const doc = handle.docStore.get(docId);
    if (!doc) throw new Error(`no doc for ${docId}`);
    const line = '- The Saltmarsh ferry keeps its winter crew until April';
    prose.applyBlockEdits(
      doc.ydoc,
      [{ op: 'insert_at_end', markdown: [line, line, line, line, line].join('\n') }],
      {
        author: 'person-a',
        suggestionAuthor: { id: 'person-a', name: 'Riverbend', color: '#777777' },
      },
    );

    ws.send(JSON.stringify({ type: 'stop' }));
    await waitFor(() => frames.some((f) => f.type === 'stopped'), { describe: 'stopped' });
    ws.close();

    let rows: QueueRow[] = [];
    await waitFor(
      async () => {
        rows = await queue();
        return rows.length === 1;
      },
      { describe: 'the quality item on the queue' },
    );
    expect(JSON.stringify(rows[0])).toContain('came out badly');
    // Filed by the assistant, with the accent color every thread renderer
    // paints its author from.
    const thread = handle.docStore.listThreads(docId).find((t) => t.id === rows[0]?.threadId);
    expect(thread?.comments[0]?.author).toMatchObject({
      kind: 'agent',
      color: expect.stringMatching(/^#[0-9a-f]{6}$/),
    });
    // Still no row invented to hang it on.
    expect(handle.tasks.backlinksFor({ kind: 'doc', docId })).toEqual([]);
  });
});
