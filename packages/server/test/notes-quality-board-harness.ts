/**
 * The boards and the clock a quality-filer test drives, in one place.
 *
 * Two files ask the same questions of the filer from opposite ends — what it
 * does with a reading that keeps saying the same thing
 * (`notes-quality-filing.test.ts`) and what it does with one that stopped
 * saying it (`notes-quality-withdrawal.test.ts`) — and both need the same
 * pair of board stubs: one where the meeting's doc has a row to file on, and
 * one where it has none and the item goes on the doc itself. Spelling them
 * twice is how the two halves drift.
 *
 * Every name and every note is invented. The repo is public.
 */

import { expect } from 'bun:test';
import type { Ref, TaskReviewItem } from '@claude-workspaces/core';
import type { Task } from '@claude-workspaces/core/task-wire';
import type { TickScheduler } from '../src/meeting-notes.ts';
import { buildNotesQualityReport } from '../src/notes-quality-report.ts';
import type { NotesQualityBoard, NotesQualityFileInput } from '../src/notes-quality-review.ts';

export const ACTOR: { id: string; name: string } = {
  id: 'meeting-notes',
  name: 'Meeting Assistant',
};

/** One line a meeting's notes repeat, which is what crosses the bullet bar. */
export const REPEAT: string = '- The Saltmarsh ferry keeps its winter crew until April';

/** A reading that crossed the duplicate-bullet bar. */
export function badReading(docId: string, repeats = 5): NotesQualityFileInput {
  const report = buildNotesQualityReport({
    notes: ['## Meeting notes', ...Array.from({ length: repeats }, () => REPEAT)].join('\n'),
    transcript: [],
  });
  expect(report.flags.length).toBeGreaterThan(0);
  return { workspaceId: 'w-harbour', docId, report };
}

/** A reading that crossed no bar at all. */
export function cleanReading(docId: string): NotesQualityFileInput {
  const report = buildNotesQualityReport({
    notes: ['## Meeting notes', REPEAT, '- The Harborlight slipway reopens in March'].join('\n'),
    transcript: [],
  });
  expect(report.flags).toEqual([]);
  return { workspaceId: 'w-harbour', docId, report };
}

/** A board that remembers every call the filer made against it. */
export interface Recorder extends NotesQualityBoard {
  readonly filed: string[];
  readonly revised: string[];
  /** Every item id this board was asked to take back, in order. */
  readonly withdrawn: string[];
}

export function recordingBoard(): Recorder {
  const filed: string[] = [];
  const revised: string[] = [];
  const withdrawn: string[] = [];
  const row = { id: 't-season', status: 'todo' } as Task;
  // Distinct ids per filing, so a test can tell a second item from the first
  // one's revision — which is the whole difference between refiling and
  // revising after a withdrawal.
  let n = 0;
  return {
    filed,
    revised,
    withdrawn,
    backlinksFor: (_ref: Ref) => [row],
    addReviewItem: (taskId) => {
      n += 1;
      filed.push(taskId);
      return { ok: true as const, task: row, item: { id: `ri-${n}` } as TaskReviewItem };
    },
    reviseReviewItem: (_taskId, reviewItemId) => {
      revised.push(reviewItemId);
      return { ok: true as const };
    },
    withdrawReviewItem: (_taskId, reviewItemId) => {
      withdrawn.push(reviewItemId);
      return { ok: true as const };
    },
  };
}

/**
 * A board with no row for the meeting's doc, so the item goes on the doc
 * itself. The two filing paths are separate code and only one of them was
 * covered; a meeting whose doc has no task is the ordinary case for a doc
 * nobody has filed work against.
 */
export function recordingDocBoard(): Recorder {
  const filed: string[] = [];
  const revised: string[] = [];
  const withdrawn: string[] = [];
  return {
    filed,
    revised,
    withdrawn,
    backlinksFor: (_ref: Ref) => [],
    // Reached only if the filer picks the row path, which this board has no
    // row for — so the throw is the assertion that the doc path was taken.
    addReviewItem: () => {
      throw new Error('this meeting doc has no row to file on');
    },
    fileOnDoc: (docId) => {
      filed.push(docId);
      return { ok: true as const, threadId: 'th-1', commentId: 'c-1' };
    },
    reviseOnDoc: (_docId, _threadId, commentId) => {
      revised.push(commentId);
      return { ok: true as const };
    },
    withdrawOnDoc: (_docId, _threadId, commentId) => {
      withdrawn.push(commentId);
      return { ok: true as const };
    },
  };
}

/** A scheduler the test fires by hand, so the resume grace costs no wall clock. */
export class HandScheduler implements TickScheduler {
  private fns = new Map<number, () => void>();
  private n = 0;
  set(fn: () => void, _ms: number): unknown {
    this.n += 1;
    this.fns.set(this.n, fn);
    return this.n;
  }
  clear(handle: unknown): void {
    this.fns.delete(handle as number);
  }
  /** How many graces are waiting — the read that tells a hold from a commit. */
  get armed(): number {
    return this.fns.size;
  }
  fire(): void {
    for (const fn of [...this.fns.values()]) fn();
    this.fns.clear();
  }
}
