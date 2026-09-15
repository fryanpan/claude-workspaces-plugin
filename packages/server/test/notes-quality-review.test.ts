/**
 * Where a bad meeting's finding lands, and what a person is shown.
 *
 * The choices worth asserting are the ones that decide whether anybody ever
 * sees it: a healthy meeting files nothing, a doc that belongs to no row is
 * reported rather than given an invented one, and of the rows that do link
 * the doc it is an OPEN one that gets the item. The words themselves are
 * checked against the gate every filed item passes, so a headline that would
 * be refused is caught here rather than in production.
 *
 * All fixtures are invented and every name is fictional. The repo is public.
 */

import { describe, expect, it } from 'bun:test';
import { checkReviewPayload, readReviewPayload } from '@claude-workspaces/core';
import type { Anchor, Ref, ReviewPayload, TaskReviewItem, User } from '@claude-workspaces/core';
import type { Task } from '@claude-workspaces/core/task-wire';
import { buildNotesQualityReport } from '../src/notes-quality-report.ts';
import {
  type NotesQualityBoard,
  buildNotesQualityReview,
  fileNotesQualityReview,
  fileOnMeetingDoc,
  rowForMeetingDoc,
} from '../src/notes-quality-review.ts';

const ACTOR = { id: 'meeting-notes', name: 'Meeting Assistant' };

/** A meeting whose notes went past two bars: repeats, and an invented voice. */
function badReport(): ReturnType<typeof buildNotesQualityReport> {
  const repeat = '- Kestrel Lane keeps the winter crew until April';
  const notes = [
    '## Meeting notes',
    '### Ferry timetable',
    '- The harbour run moves to the half hour',
    repeat,
    repeat,
    repeat,
    repeat,
    '- [@Devon Marsh](speaker:Z) will write to the harbour office',
  ].join('\n');
  return buildNotesQualityReport({
    notes,
    transcript: [{ text: 'The harbour run moves to the half hour from Monday.' }],
    voices: { labels: ['A'], names: ['Priya Raman'] },
  });
}

function task(over: Partial<Task>): Task {
  return { id: 't-1', title: 'Harbour season', status: 'todo', updatedAt: 1, ...over } as Task;
}

/** A board that records what was filed on it. */
function board(rows: Task[]): NotesQualityBoard & { filed: Array<{ taskId: string }> } {
  const filed: Array<{ taskId: string }> = [];
  return {
    filed,
    backlinksFor: (_ref: Ref) => rows,
    addReviewItem: (taskId, _review, _opts) => {
      filed.push({ taskId });
      return {
        ok: true as const,
        task: rows[0] ?? task({}),
        item: { id: `ri-${filed.length}` } as TaskReviewItem,
      };
    },
  };
}

describe('which row the item goes on', () => {
  it('prefers an open row over a closed one, however recent the closed one is', () => {
    const rows = [
      task({ id: 't-open', status: 'in-progress', updatedAt: 10 }),
      task({ id: 't-done', status: 'done', updatedAt: 99 }),
    ];
    expect(rowForMeetingDoc(board(rows), 'd-harbour')?.id).toBe('t-open');
  });

  it('takes the newest of several open rows', () => {
    const rows = [task({ id: 't-old', updatedAt: 10 }), task({ id: 't-new', updatedAt: 99 })];
    expect(rowForMeetingDoc(board(rows), 'd-harbour')?.id).toBe('t-new');
  });

  it('falls back to a closed row when nothing is open', () => {
    const rows = [task({ id: 't-done', status: 'done', updatedAt: 5 })];
    expect(rowForMeetingDoc(board(rows), 'd-harbour')?.id).toBe('t-done');
  });

  it('ignores an archived row entirely', () => {
    const rows = [task({ id: 't-gone', archivedAt: 4 })];
    expect(rowForMeetingDoc(board(rows), 'd-harbour')).toBeUndefined();
  });
});

describe('filing', () => {
  it('files nothing at all for a meeting that went fine', () => {
    const b = board([task({})]);
    const report = buildNotesQualityReport({
      notes: '## Meeting notes\n- The harbour run moves to the half hour',
      transcript: [],
    });
    const filing = fileNotesQualityReview(b, ACTOR, {
      workspaceId: 'w-1',
      docId: 'd-harbour',
      report,
    });
    expect(filing).toEqual({ filed: false, reason: 'healthy' });
    expect(b.filed).toEqual([]);
  });

  it('files on the doc’s row when the meeting went badly', () => {
    const b = board([task({ id: 't-season' })]);
    const filing = fileNotesQualityReview(b, ACTOR, {
      workspaceId: 'w-1',
      docId: 'd-harbour',
      docTitle: 'Harbour season',
      report: badReport(),
    });
    expect(filing).toEqual({ filed: true, taskId: 't-season', itemId: 'ri-1' });
    expect(b.filed).toEqual([{ taskId: 't-season' }]);
  });

  it('says so, and invents nothing, when the doc belongs to no row', () => {
    const b = board([]);
    const filing = fileNotesQualityReview(b, ACTOR, {
      workspaceId: 'w-1',
      docId: 'd-harbour',
      report: badReport(),
    });
    expect(filing).toEqual({ filed: false, reason: 'no-row' });
    expect(b.filed).toEqual([]);
  });

  it('says so when the doc belongs to no board', () => {
    const b = board([task({})]);
    const filing = fileNotesQualityReview(b, ACTOR, {
      workspaceId: undefined,
      docId: 'd-harbour',
      report: badReport(),
    });
    expect(filing).toEqual({ filed: false, reason: 'no-board' });
    expect(b.filed).toEqual([]);
  });

  it('reports a refusal rather than swallowing it', () => {
    const refusing: NotesQualityBoard = {
      backlinksFor: () => [task({})],
      addReviewItem: () => ({ ok: false as const, error: 'bad-review', message: 'nope' }),
    };
    const filing = fileNotesQualityReview(refusing, ACTOR, {
      workspaceId: 'w-1',
      docId: 'd-harbour',
      report: badReport(),
    });
    expect(filing).toEqual({ filed: false, reason: 'refused', message: 'nope' });
  });
});

describe('a bad meeting on a doc no row links', () => {
  /** A doc store that records the threads posted on it. */
  function threads(docs: string[]) {
    const posted: Array<{
      docId: string;
      author: User;
      text: string;
      anchor: Anchor;
      review: ReviewPayload;
    }> = [];
    return {
      posted,
      get: (docId: string) => (docs.includes(docId) ? {} : undefined),
      postComment: async (
        docId: string,
        _threadId: null,
        author: User,
        text: string,
        anchor: Anchor,
        opts: { review: ReviewPayload },
      ) => {
        posted.push({ docId, author, text, anchor, review: opts.review });
        return {};
      },
      listThreads: (docId: string) => posted.filter((p) => p.docId === docId),
    };
  }

  it('files the item on the doc itself, as a question about the whole doc', () => {
    const store = threads(['d-harbour']);
    const b: NotesQualityBoard = {
      ...board([]),
      fileOnDoc: (docId, review, actor) => fileOnMeetingDoc(store, docId, review, actor),
    };
    const filing = fileNotesQualityReview(b, ACTOR, {
      workspaceId: 'w-1',
      docId: 'd-harbour',
      docTitle: 'Harbour season',
      report: badReport(),
    });
    expect(filing).toEqual({ filed: true, docId: 'd-harbour' });
    expect(store.posted).toHaveLength(1);
    const [post] = store.posted;
    expect(post?.anchor).toEqual({ kind: 'subject' });
    // The payload a `create_thread` with this review would store.
    expect(post?.review).toEqual(
      readReviewPayload(
        buildNotesQualityReview({
          workspaceId: 'w-1',
          docId: 'd-harbour',
          docTitle: 'Harbour season',
          report: badReport(),
        }),
      ) as ReviewPayload,
    );
    expect(post?.text).toBe(post?.review.headline as string);
    expect(post?.text).toContain('Harbour season');
    // Filed by the assistant, so the queue reads it as waiting on a person.
    expect(post?.author).toMatchObject({ id: ACTOR.id, kind: 'agent' });
  });

  it('reports a doc that could not take the thread rather than claiming it filed', () => {
    const store = threads([]);
    const b: NotesQualityBoard = {
      ...board([]),
      fileOnDoc: (docId, review, actor) => fileOnMeetingDoc(store, docId, review, actor),
    };
    const filing = fileNotesQualityReview(b, ACTOR, {
      workspaceId: 'w-1',
      docId: 'd-gone',
      report: badReport(),
    });
    expect(filing).toMatchObject({ filed: false, reason: 'refused' });
    expect(store.posted).toEqual([]);
  });

  it('reports a thread write that threw as not filed', () => {
    const store = {
      get: () => ({}),
      listThreads: () => [],
      postComment: async () => {
        throw new Error('the harbour doc is read-only');
      },
    };
    const b: NotesQualityBoard = {
      ...board([]),
      fileOnDoc: (docId, review, actor) => fileOnMeetingDoc(store, docId, review, actor),
    };
    const filing = fileNotesQualityReview(b, ACTOR, {
      workspaceId: 'w-1',
      docId: 'd-harbour',
      report: badReport(),
    });
    expect(filing).toMatchObject({ filed: false, reason: 'refused' });
  });

  it('still prefers a linked row over the doc', () => {
    const onDoc: string[] = [];
    const b: NotesQualityBoard = {
      ...board([task({ id: 't-season' })]),
      fileOnDoc: (docId) => {
        onDoc.push(docId);
        return true;
      },
    };
    const filing = fileNotesQualityReview(b, ACTOR, {
      workspaceId: 'w-1',
      docId: 'd-harbour',
      report: badReport(),
    });
    expect(filing).toMatchObject({ filed: true, taskId: 't-season' });
    expect(onDoc).toEqual([]);
  });
});

describe('what the person reads', () => {
  const item = (): Record<string, unknown> =>
    buildNotesQualityReview({
      workspaceId: 'w-1',
      docId: 'd-harbour',
      docTitle: 'Harbour season',
      report: badReport(),
    });

  it('passes the same gate every filed item passes', () => {
    expect(checkReviewPayload(item()).ok).toBe(true);
  });

  it('names each bar it went past and links the doc relatively', () => {
    const detail = String(item().detail);
    expect(detail).toContain('repeated bullets');
    expect(detail).toContain('Speakers the meeting never had');
    expect(detail).toContain('](/workspaces/w-1/docs/d-harbour)');
  });

  it('says the lateness is unknown when nothing measured it', () => {
    expect(String(item().detail)).toContain('not known');
  });
});
