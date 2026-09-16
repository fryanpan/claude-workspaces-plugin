/**
 * The filer's own edges: the two ways a held reading could be lost, and the
 * ending that must not be held through.
 *
 * `notes-quality-timing.test.ts` drives this module through a whole scripted
 * meeting, which is where the behaviour a person sees is proved. What is left
 * here is what a meeting cannot reach in one run — a filer holding more
 * meetings than it remembers, and a socket closing with the code a restarting
 * server sends.
 *
 * Every name and every note is invented. The repo is public.
 */

import { describe, expect, it } from 'bun:test';
import type { Ref, TaskReviewItem } from '@claude-workspaces/core';
import type { Task } from '@claude-workspaces/core/task-wire';
import type { TickScheduler } from '../src/meeting-notes.ts';
import { legIsResumable } from '../src/meeting-protocol.ts';
import { createNotesQualityFiler } from '../src/notes-quality-filing.ts';
import { buildNotesQualityReport } from '../src/notes-quality-report.ts';
import type { NotesQualityBoard, NotesQualityFileInput } from '../src/notes-quality-review.ts';

const ACTOR = { id: 'meeting-notes', name: 'Meeting Assistant' };
const REPEAT = '- The Saltmarsh ferry keeps its winter crew until April';

/** A reading that crossed the duplicate-bullet bar. */
function badReading(docId: string): NotesQualityFileInput {
  const report = buildNotesQualityReport({
    notes: ['## Meeting notes', REPEAT, REPEAT, REPEAT, REPEAT, REPEAT].join('\n'),
    transcript: [],
  });
  expect(report.flags.length).toBeGreaterThan(0);
  return { workspaceId: 'w-harbour', docId, report };
}

function recordingBoard(): NotesQualityBoard & { filed: string[] } {
  const filed: string[] = [];
  const row = { id: 't-season', status: 'todo' } as Task;
  return {
    filed,
    backlinksFor: (_ref: Ref) => [row],
    addReviewItem: (taskId) => {
      filed.push(taskId);
      return { ok: true as const, task: row, item: { id: 'ri-1' } as TaskReviewItem };
    },
  };
}

class HandScheduler implements TickScheduler {
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
  fire(): void {
    for (const fn of [...this.fns.values()]) fn();
    this.fns.clear();
  }
}

describe('a held reading is never lost', () => {
  it('keeps every meeting that is still waiting, past the remembered bound', () => {
    const board = recordingBoard();
    const schedule = new HandScheduler();
    const filer = createNotesQualityFiler({
      board: () => board,
      actor: ACTOR,
      schedule,
      say: () => {},
    });

    // Far more dropped meetings than the filer remembers, every one of them
    // holding the only copy of an item nothing else can rebuild.
    const meetings = 300;
    for (let i = 0; i < meetings; i++) {
      const ids = { docId: `d-${i}`, meetingId: `m-${i}` };
      filer.file(ids, badReading(ids.docId));
      filer.legEnded(ids, { resumable: true });
    }
    expect(filer.heldCount()).toBe(meetings);

    // Nobody reconnected to any of them: every grace fires and every item goes.
    schedule.fire();
    expect(board.filed).toHaveLength(meetings);
    expect(filer.heldCount()).toBe(0);
  });
});

describe('which endings are held through', () => {
  it('holds a network drop and files a restart, because a hold cannot survive one', () => {
    // The hold is a timer in this process. A restarting server exits before it
    // can fire, so holding through a restart risks losing the item outright,
    // while filing early costs at most a revision.
    expect(legIsResumable('network-drop')).toBe(true);
    expect(legIsResumable('server-restart')).toBe(false);
    expect(legIsResumable('client-stop')).toBe(false);
    expect(legIsResumable('silence')).toBe(false);
    expect(legIsResumable('tab-closed')).toBe(false);
  });

  it('files at once for the ending a restart reports', () => {
    const board = recordingBoard();
    const schedule = new HandScheduler();
    const filer = createNotesQualityFiler({
      board: () => board,
      actor: ACTOR,
      schedule,
      say: () => {},
    });
    const ids = { docId: 'd-harbour', meetingId: 'm-1' };
    filer.file(ids, badReading(ids.docId));
    filer.legEnded(ids, { resumable: legIsResumable('server-restart') });
    // No timer had to fire: the item is already on the row.
    expect(board.filed).toEqual(['t-season']);
  });
});
