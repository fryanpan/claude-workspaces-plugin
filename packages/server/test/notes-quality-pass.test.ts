/**
 * The pass a meeting's stop runs: read the section this meeting wrote, judge
 * it, store it, and put a bad one in front of somebody.
 *
 * The three things worth driving end to end are the ones the wiring can get
 * wrong without any single module being wrong: the section is found by the
 * heading's BLOCK ID and stops at the next section, so a second meeting's
 * notes on the same doc are not read as this one's; the reading is stored
 * where the rollup will find it; and the line the caller appends carries the
 * counts.
 *
 * All notes and all speech here are invented and every name is fictional.
 * The repo is public.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prose } from '@claude-workspaces/core';
import type { Ref, TaskReviewItem } from '@claude-workspaces/core';
import type { Task } from '@claude-workspaces/core/task-wire';
import * as Y from 'yjs';
import type { NotesDocStore } from '../src/notes-doc-access.ts';
import { readSectionMarkdown, runNotesQualityPass } from '../src/notes-quality-pass.ts';
import type { NotesQualityBoard } from '../src/notes-quality-review.ts';
import { readNotesQuality } from '../src/notes-quality-store.ts';

const dirs: string[] = [];
const freshDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'cw-quality-pass-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A doc store over one Y.Doc built from markdown, with block ids minted. */
function docStoreFrom(markdown: string): { store: NotesDocStore; ydoc: Y.Doc } {
  const ydoc = new Y.Doc();
  prose.applyMarkdownToFragment(prose.getProseFragment(ydoc), markdown);
  const store: NotesDocStore = {
    get: (docId) =>
      docId === 'd-harbour' ? { ydoc, meta: { type: 'markdown' as const } } : undefined,
    readOutline: (docId) => (docId === 'd-harbour' ? { blocks: prose.readOutline(ydoc) } : null),
    applyBlockEdits: () => {
      throw new Error('the quality pass must not write');
    },
  };
  // Minting happens on the first outline read; do it once so ids are stable.
  store.readOutline('d-harbour');
  return { store, ydoc };
}

/** The block id of the nth heading, as the heading memory would have kept it. */
function headingIdAt(store: NotesDocStore, index: number): string {
  const heads = (store.readOutline('d-harbour')?.blocks ?? []).filter((b) => b.kind === 'heading');
  const id = heads[index]?.id;
  if (id === undefined) throw new Error(`no heading at ${index}`);
  return id;
}

const TWO_MEETINGS = [
  '## Meeting notes',
  '### Ferry timetable',
  '- The harbour run moves to the half hour',
  '- Kestrel Lane keeps the winter crew until April',
  '',
  '## Meeting notes',
  '### Slipway signage',
  '- New boards go up before the season',
].join('\n');

describe('reading the section this meeting wrote', () => {
  it('stops at the next section rather than swallowing it', () => {
    const { store } = docStoreFrom(TWO_MEETINGS);
    const first = readSectionMarkdown(store, 'd-harbour', headingIdAt(store, 0));
    expect(first).toContain('Ferry timetable');
    expect(first).not.toContain('Slipway signage');
  });

  it('reads the second section when that is the one the meeting opened', () => {
    const { store } = docStoreFrom(TWO_MEETINGS);
    const second = readSectionMarkdown(store, 'd-harbour', headingIdAt(store, 2));
    expect(second).toContain('Slipway signage');
    expect(second).not.toContain('Ferry timetable');
  });

  it('is empty for a meeting that opened no section', () => {
    const { store } = docStoreFrom(TWO_MEETINGS);
    expect(readSectionMarkdown(store, 'd-harbour', undefined)).toBe('');
  });

  it('is empty for a heading somebody has since deleted', () => {
    const { store } = docStoreFrom(TWO_MEETINGS);
    expect(readSectionMarkdown(store, 'd-harbour', 'b-not-here')).toBe('');
  });

  it('keeps the speaker tags the invented-voice check reads', () => {
    const { store } = docStoreFrom(
      ['## Meeting notes', '- [@Priya Raman](speaker:A) wants the winter crew kept'].join('\n'),
    );
    expect(readSectionMarkdown(store, 'd-harbour', headingIdAt(store, 0))).toContain('speaker:A');
  });
});

/** A board that records what was filed on it. */
function recordingBoard(rows: Task[]): NotesQualityBoard & { filed: string[] } {
  const filed: string[] = [];
  return {
    filed,
    backlinksFor: (_ref: Ref) => rows,
    addReviewItem: (taskId) => {
      filed.push(taskId);
      return {
        ok: true as const,
        task: rows[0] as Task,
        item: { id: 'ri-1' } as TaskReviewItem,
      };
    },
  };
}

describe('the whole pass', () => {
  const ACTOR = { id: 'meeting-notes', name: 'Meeting Assistant' };

  it('reports a healthy meeting in counts, stores it, and files nothing', () => {
    const dataDir = freshDir();
    const { store } = docStoreFrom(TWO_MEETINGS);
    const board = recordingBoard([{ id: 't-season', status: 'todo' } as Task]);
    const result = runNotesQualityPass(
      {
        docStore: () => store,
        board: () => board,
        boardOf: () => 'w-1',
        dataDir,
        headingIdOf: () => headingIdAt(store, 0),
        actor: ACTOR,
        now: () => 5_000,
      },
      { docId: 'd-harbour', meetingId: 'm-1' },
    );
    expect(result.report.flags).toEqual([]);
    expect(result.filing).toEqual({ filed: false, reason: 'healthy' });
    expect(board.filed).toEqual([]);
    expect(result.line).toContain('repeated bullets');
    expect(readNotesQuality(dataDir, 'd-harbour', 'm-1')?.at).toBe(5_000);
  });

  it('files on the doc’s row and says so in the line when the notes went badly', () => {
    const dataDir = freshDir();
    const repeat = '- Kestrel Lane keeps the winter crew until April';
    const { store } = docStoreFrom(
      ['## Meeting notes', repeat, repeat, repeat, repeat, repeat].join('\n'),
    );
    const board = recordingBoard([{ id: 't-season', status: 'todo' } as Task]);
    const result = runNotesQualityPass(
      {
        docStore: () => store,
        board: () => board,
        boardOf: () => 'w-1',
        dataDir,
        headingIdOf: () => headingIdAt(store, 0),
        actor: ACTOR,
        now: () => 5_000,
      },
      { docId: 'd-harbour', meetingId: 'm-1', docTitle: 'Harbour season' },
    );
    expect(result.report.duplicateBulletLines).toBe(4);
    expect(board.filed).toEqual(['t-season']);
    expect(result.line).toContain('BAD');
    expect(result.line).toContain('/workspaces/w-1?task=t-season');
    expect(readNotesQuality(dataDir, 'd-harbour', 'm-1')?.flags).toContain('duplicate-bullets');
  });

  it('still counts and still stores when there is no board to file on', () => {
    const dataDir = freshDir();
    const repeat = '- Kestrel Lane keeps the winter crew until April';
    const { store } = docStoreFrom(
      ['## Meeting notes', repeat, repeat, repeat, repeat, repeat].join('\n'),
    );
    const result = runNotesQualityPass(
      {
        docStore: () => store,
        boardOf: () => undefined,
        dataDir,
        headingIdOf: () => headingIdAt(store, 0),
        actor: ACTOR,
        now: () => 5_000,
      },
      { docId: 'd-harbour', meetingId: 'm-1' },
    );
    expect(result.filing).toEqual({ filed: false, reason: 'no-board' });
    expect(result.line).toContain('NOT filed');
    expect(result.stored).toBe(true);
  });

  it('runs with no data dir at all, storing nothing and reading no transcript', () => {
    const { store } = docStoreFrom(TWO_MEETINGS);
    const result = runNotesQualityPass(
      {
        docStore: () => store,
        boardOf: () => 'w-1',
        headingIdOf: () => headingIdAt(store, 0),
        actor: ACTOR,
        now: () => 5_000,
      },
      { docId: 'd-harbour', meetingId: 'm-1' },
    );
    expect(result.stored).toBe(false);
    expect(result.report.ideas).toBe(0);
    expect(result.report.lateness.source).toBe('unavailable');
  });
});
