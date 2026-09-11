/**
 * `POST …/meetings/:meetingId/notes-cleanup` through the real server.
 *
 * The unit test beside this one drives the pass; what this file is for is the
 * half only the route can get wrong — which meeting it addresses, what it
 * refuses, and that the composed edits reach the live doc rather than a copy
 * of it. The meeting itself is built on disk (transcript, index line, section
 * record) instead of over the audio socket: this asks nothing about capture,
 * and a socket in the way would make a route test into a pipeline test.
 *
 * The composer is the deterministic stub — no network, no bill.
 *
 * All fixtures are synthetic and every name is fictional. The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prose } from '@claude-workspaces/core';
import { createStubNotesComposer } from '../src/meeting-notes.ts';
import { meetingDirPath, meetingIndexPath, meetingTranscriptPath } from '../src/meetings.ts';
import { createNotesHeadingFileStore } from '../src/notes-heading-store.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { seedBoard } from './workspace-seed.ts';

const MEETING = 'm-riverbend-1';

let handle: ServerHandle;
let base: string;
let dataDir: string;
let WS: string;
let docId: string;

/** The doc as it currently reads. */
const markdownNow = (): string => {
  const doc = handle.docStore.get(docId);
  if (!doc) throw new Error('no doc');
  return prose.serializeFragmentToMarkdown(prose.getProseFragment(doc.ydoc));
};

const cleanupUrl = (meetingId: string): string =>
  `${base}/workspaces/${WS}/docs/${docId}/meetings/${meetingId}/notes-cleanup`;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'cw-cleanup-route-'));
  handle = createServer({
    port: 0,
    dataDir,
    meetingNotes: { composer: createStubNotesComposer() },
  });
  base = `http://127.0.0.1:${handle.port}`;
  WS = await seedBoard(base);

  const path = join(dataDir, 'riverbend.md');
  writeFileSync(
    path,
    [
      '# Riverbend ferry',
      '',
      'A paragraph I wrote myself.',
      '',
      '## Meeting notes',
      '',
      '- The harbour run moves to the half hour',
      '',
    ].join('\n'),
  );
  const created = await fetch(`${base}/workspaces/${WS}/docs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ docId: 'riverbend', sourceUrl: path, title: 'Riverbend ferry' }),
  });
  expect(created.status, await created.clone().text()).toBe(200);
  docId = ((await created.json()) as { docId: string }).docId;

  // The state a finished meeting leaves behind: a transcript, an index line,
  // and the block id of the section it opened.
  mkdirSync(meetingDirPath(dataDir, docId), { recursive: true });
  writeFileSync(
    meetingTranscriptPath(dataDir, docId, MEETING),
    `${[
      { turn: 0, text: 'The slipway closes for maintenance in October.', ts: 1 },
      { turn: 1, text: 'Kestrel Lane keeps the winter crew until April.', ts: 2 },
    ]
      .map((t) => JSON.stringify(t))
      .join('\n')}\n`,
  );
  writeFileSync(
    meetingIndexPath(dataDir, docId),
    `${JSON.stringify({ meetingId: MEETING, docId, startedAt: 1, engine: 'mock', sampleRate: 16000 })}\n${JSON.stringify({ meetingId: MEETING, endedAt: 3, turns: 2 })}\n`,
  );
  const heading = (handle.docStore.readOutline(docId)?.blocks ?? []).find(
    (b) => b.text === 'Meeting notes',
  );
  if (!heading) throw new Error('no notes heading in the fixture');
  createNotesHeadingFileStore(dataDir).write({ docId, meetingId: MEETING }, heading.id);
  // The section's bullet has to read as the note-taker's own, or the gate
  // rightly treats the whole section as somebody's writing.
  for (const el of prose.addressableBlocks(
    prose.getProseFragment(handle.docStore.get(docId)!.ydoc),
  ))
    if (el.toString().includes('harbour run')) el.setAttribute('cwAuthor', 'meeting-notes');
});

afterAll(async () => {
  await handle.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('asking for a tidy-up', () => {
  it('refuses a meeting this doc never held', async () => {
    const res = await fetch(cleanupUrl('m-never'), { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('never reaches the pass for a doc this board does not hold', async () => {
    // The refusal is `middleware/workspace-scope.ts`'s, one layer above the
    // route: a canonical `/workspaces/<ws>/docs/<id>/…` whose member the
    // board does not own is 404 before any handler sees it. Asserted here
    // rather than assumed, because the route's own `isValidDocId` 400 is
    // consequently unreachable on this path and a reader of the handler
    // would otherwise expect 400.
    const res = await fetch(
      `${base}/workspaces/${WS}/docs/${encodeURIComponent('bad!id')}/meetings/${MEETING}/notes-cleanup`,
      { method: 'POST' },
    );
    expect(res.status).toBe(404);
  });

  it('reads the whole transcript and writes into the section the meeting opened', async () => {
    const res = await fetch(cleanupUrl(MEETING), { method: 'POST' });
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      turns: number;
      touched: number;
      refused: number;
    };
    expect(body.ok).toBe(true);
    // Both turns of the meeting, not just the last one — this is the whole
    // point of the pass over a tick.
    expect(body.turns).toBe(2);
    expect(body.touched).toBeGreaterThan(0);
    const after = markdownNow();
    expect(after).toContain('The slipway closes for maintenance in October.');
    // The person's own paragraph is untouched, and no second section opened.
    expect(after).toContain('A paragraph I wrote myself.');
    expect(after.match(/## Meeting notes/g) ?? []).toHaveLength(1);
  });
});
