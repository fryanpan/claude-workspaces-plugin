/**
 * A tidy-up whose every edit is REFUSED, through the real route and the real
 * gate — and what the reply has to say so the offer can stay on screen.
 *
 * This is the 15 September shape, driven rather than described: every edit
 * the pass proposed was dropped by the gate, nothing reached the doc, and the
 * route answered `ok: true` with no field a reader could tell the difference
 * by. The dialog read that as a success and closed over notes it had not
 * touched.
 *
 * THE REFUSAL THAT DRIVES IT CHANGED (2026-09-15), THE ANSWER DID NOT. On the
 * day, the edits were refused for naming blocks OUTSIDE the meeting's notes
 * section; the gate is bounded by authorship now (`boundByAuthorship`), so
 * the refusal this case needs is one that still exists — a proposed DELETE of
 * a line the pass does not own, which is never offered and never applied.
 * What is asserted is unchanged: a pass that touched nothing says so.
 *
 * NOTHING HERE STUBS THE REFUSAL. The composer proposes edits the way the
 * model did — by naming block ids it read off the outline it was handed — and
 * the gate that refuses them is the one the route calls. What is asserted is
 * the answer a person's browser gets.
 *
 * The client half is `packages/workspaces-app/test/meeting-cleanup-offer.test.ts`
 * ("keeps the offer up, and says so, when the pass changed nothing"), which
 * presses the button against this body.
 *
 * All fixtures are synthetic and every name is fictional. The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prose } from '@claude-workspaces/core';
import type { NotesComposer } from '../src/meeting-notes.ts';
import { meetingDirPath, meetingIndexPath, meetingTranscriptPath } from '../src/meetings.ts';
import { createNotesHeadingFileStore } from '../src/notes-heading-store.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { seedBoard } from './workspace-seed.ts';

const MEETING = 'm-harborlight-1';
/** A line of the doc the note-taker does not own — a person wrote it. */
const OUTSIDE = 'A paragraph I wrote myself.';

/**
 * A composer every one of whose edits the gate drops: it reads the outline it
 * was given and proposes STRIKING OUT a line it does not own. Every edit is
 * well-formed; every one is out of bounds, which is the only thing the gate
 * gets to decide.
 */
const composerProposingRefusedEdits = (): NotesComposer => ({
  name: 'refused-edits',
  compose: (input) =>
    Promise.resolve(
      input.outline
        .filter((e) => e.text === OUTSIDE)
        .map((e) => ({ op: 'delete_block', blockId: e.id }) satisfies prose.BlockEdit),
    ),
});

let handle: ServerHandle;
let base: string;
let dataDir: string;
let WS: string;
let docId: string;

const markdownNow = (): string => {
  const doc = handle.docStore.get(docId);
  if (!doc) throw new Error('no doc');
  return prose.serializeFragmentToMarkdown(prose.getProseFragment(doc.ydoc));
};

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'cw-cleanup-nothing-'));
  handle = createServer({
    port: 0,
    dataDir,
    meetingNotes: { composer: composerProposingRefusedEdits() },
  });
  base = `http://127.0.0.1:${handle.port}`;
  WS = await seedBoard(base);

  const path = join(dataDir, 'harborlight.md');
  writeFileSync(
    path,
    [
      '# Harborlight quay',
      '',
      OUTSIDE,
      '',
      '## Meeting notes',
      '',
      '- The winter crew stays',
      '',
    ].join('\n'),
  );
  const created = await fetch(`${base}/workspaces/${WS}/docs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ docId: 'harborlight', sourceUrl: path, title: 'Harborlight quay' }),
  });
  expect(created.status, await created.clone().text()).toBe(200);
  docId = ((await created.json()) as { docId: string }).docId;

  mkdirSync(meetingDirPath(dataDir, docId), { recursive: true });
  writeFileSync(
    meetingTranscriptPath(dataDir, docId, MEETING),
    `${[
      { turn: 0, text: 'The winter crew stays on until April.', ts: 1 },
      { turn: 1, text: 'The quay lights need replacing before then.', ts: 2 },
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
  for (const el of prose.addressableBlocks(
    prose.getProseFragment(handle.docStore.get(docId)!.ydoc),
  ))
    if (el.toString().includes('winter crew')) el.setAttribute('cwAuthor', 'meeting-notes');
});

afterAll(async () => {
  await handle.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('a tidy-up whose every edit the gate refuses', () => {
  it('says it changed nothing, and leaves the notes exactly as they were', async () => {
    const before = markdownNow();
    const res = await fetch(
      `${base}/workspaces/${WS}/docs/${docId}/meetings/${MEETING}/notes-cleanup`,
      { method: 'POST' },
    );
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      changed?: boolean;
      proposed: number;
      refused: number;
      touched: number;
      blanks?: number;
      merged?: number;
      refusals?: string[];
      failures?: string[];
    };
    // The pass ran and answered — this is not an error, which is exactly why
    // the count alone could never be read as one.
    expect(body.ok).toBe(true);
    expect(body.proposed).toBeGreaterThan(0);
    expect(body.refused).toBe(body.proposed);
    expect(body.touched).toBe(0);
    // Nothing else moved either: the tidy found no blank line and no repeated
    // topic, so `changed` is the whole answer rather than one part of it.
    expect(body.blanks).toBe(0);
    expect(body.merged).toBe(0);
    // THE FIELD THE DIALOG KEYS ON. Without it an `ok` reply reads the same
    // whether the notes were rewritten or never touched.
    expect(body.changed).toBe(false);
    expect(markdownNow()).toBe(before);
  });

  /**
   * THE HALF A PERSON READS. The count has always crossed the wire; the
   * REASONS were built by the gate and then thrown away at the route, so the
   * only place they existed was the server log — which is precisely where
   * the person who asked for the tidy-up cannot look. The dialog groups these
   * by rule and shows them.
   */
  it('sends a reason for every edit it did not apply, naming the rule', async () => {
    const res = await fetch(
      `${base}/workspaces/${WS}/docs/${docId}/meetings/${MEETING}/notes-cleanup`,
      { method: 'POST' },
    );
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as {
      refused: number;
      refusals?: string[];
      failures?: string[];
    };
    // ONE LINE PER REFUSED EDIT, not one per pass: a reader chasing "why did
    // nothing change" has to be able to account for every edit.
    expect(body.refusals).toHaveLength(body.refused);
    // And each names the operation and the rule that dropped it, in words.
    for (const line of body.refusals ?? []) {
      expect(line).toContain('delete_block');
      expect(line).toContain('the document does not record the block as the note-taker');
    }
    // Nothing the gate kept went on to fail, so this stays empty — the two
    // lists answer different questions and must not be one field.
    expect(body.failures).toEqual([]);
  });
});
