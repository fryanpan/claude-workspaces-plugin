/**
 * The owner-line module on its own, over a plain object standing in for the
 * store: which lines get an item, which items are taken back, and what an
 * answer does to its line. The route-level behaviour is
 * done-when-owner-items.test.ts. All fixtures are synthetic.
 */
import { describe, expect, it } from 'bun:test';
import type { DoneWhenLine } from '@claude-workspaces/core/done-when';
import type { StoredReviewItem, Task } from '@claude-workspaces/core/task-wire';
import {
  OWNER_CHECK_FILER,
  OWNER_CHECK_MET,
  type OwnerItemDeps,
  applyOwnerAnswer,
  ownerCheckReview,
  refuseOwnerAnswer,
  syncOwnerItems,
} from '../src/review-items/done-when-owner.ts';

const PERSON = { id: 'known-reader', name: 'Reader', kind: 'known' };
const AGENT = { id: 'agent-otter', name: 'Otter', kind: 'agent' };

function fixture(lines: DoneWhenLine[], status: Task['status'] = 'in-progress') {
  const task = {
    id: 't-1',
    title: 'A task',
    status,
    doneWhen: lines,
    reviews: [],
  } as unknown as Task;
  const calls = {
    add: 0,
    withdraw: [] as string[],
    revise: [] as string[],
    check: [] as string[],
    notes: [] as string[],
  };
  let n = 0;
  const deps: OwnerItemDeps = {
    getTask: () => task,
    addReviewItem: (_t, review, opts) => {
      calls.add++;
      const item = {
        id: `r-${++n}`,
        review,
        createdAt: 1,
        createdBy: opts.actor.name,
        doneWhenLineId: opts.doneWhenLineId,
      } as unknown as StoredReviewItem;
      task.reviews = [...(task.reviews ?? []), item];
      return { ok: true, item };
    },
    withdrawReviewItem: (_t, id) => {
      calls.withdraw.push(id);
      const item = task.reviews?.find((r) => r.id === id);
      if (item) item.review = { ...item.review, withdrawnAt: 2 };
      return { ok: true };
    },
    ownerCheck: (_t, lineId, verdict) => {
      calls.check.push(`${lineId}:${verdict}`);
      const line = task.doneWhen?.find((l) => l.id === lineId);
      if (line) line.verdict = verdict;
      return { ok: true };
    },
    reviseReviewItem: (_t, id, patch) => {
      calls.revise.push(id);
      const item = task.reviews?.find((r) => r.id === id);
      if (item) item.review = { ...item.review, ...patch };
      return { ok: true };
    },
    appendNote: (_t, input) => calls.notes.push(input.text),
  };
  return { task, deps, calls };
}

describe('syncOwnerItems', () => {
  it('files one item per owner line and nothing for the others, however often it runs', () => {
    const { task, deps, calls } = fixture([
      { id: 'd-1', text: 'reads well', verdict: 'owner', by: 'Otter' },
      { id: 'd-2', text: 'tests pass', verdict: 'met' },
      { id: 'd-3', text: 'unchecked' },
    ]);
    expect(syncOwnerItems('t-1', deps)).toEqual({ filed: 1, withdrawn: 0, revised: 0 });
    expect(syncOwnerItems('t-1', deps)).toEqual({ filed: 0, withdrawn: 0, revised: 0 });
    expect(calls.add).toBe(1);
    expect(task.reviews?.[0]?.doneWhenLineId).toBe('d-1');
    expect(task.reviews?.[0]?.createdBy).toBe('Otter');
  });

  it('files under its own name, never the stall escalation’s, when the line names nobody', () => {
    const { task, deps } = fixture([{ id: 'd-1', text: 'reads well', verdict: 'owner' }]);
    syncOwnerItems('t-1', deps);
    expect(task.reviews?.[0]?.createdBy).toBe(OWNER_CHECK_FILER);
  });

  it('takes the item back when its line leaves owner or is removed, and files again for a new owner mark', () => {
    const { task, deps, calls } = fixture([{ id: 'd-1', text: 'reads well', verdict: 'owner' }]);
    syncOwnerItems('t-1', deps);
    const line = task.doneWhen?.[0] as DoneWhenLine;
    line.verdict = 'not-met';
    expect(syncOwnerItems('t-1', deps)).toEqual({ filed: 0, withdrawn: 1, revised: 0 });
    line.verdict = 'owner';
    expect(syncOwnerItems('t-1', deps)).toEqual({ filed: 1, withdrawn: 0, revised: 0 });
    task.doneWhen = [];
    expect(syncOwnerItems('t-1', deps)).toEqual({ filed: 0, withdrawn: 1, revised: 0 });
    expect(calls.withdraw).toEqual(['r-1', 'r-2']);
  });

  it('revises the open item when its line gains new words or proof, and leaves it alone otherwise', () => {
    const { task, deps, calls } = fixture([{ id: 'd-1', text: 'reads well', verdict: 'owner' }]);
    syncOwnerItems('t-1', deps);
    expect(syncOwnerItems('t-1', deps).revised).toBe(0);
    const line = task.doneWhen?.[0] as DoneWhenLine;
    line.text = 'reads well at 430 wide';
    line.proof = [{ text: 'new shot', url: 'https://example.com/b.png' }];
    expect(syncOwnerItems('t-1', deps)).toEqual({ filed: 0, withdrawn: 0, revised: 1 });
    expect(calls.revise).toEqual(['r-1']);
    expect(task.reviews?.[0]?.review.headline).toContain('reads well at 430 wide');
    expect(task.reviews?.[0]?.review.detail).toContain('new shot');
    expect(syncOwnerItems('t-1', deps).revised).toBe(0);
  });

  it('files nothing on a done task', () => {
    const { deps, calls } = fixture([{ id: 'd-1', text: 'x', verdict: 'owner' }], 'done');
    syncOwnerItems('t-1', deps);
    expect(calls.add).toBe(0);
  });
});

describe('the answer', () => {
  it('meets the line only on the Looks right option', () => {
    const met = fixture([{ id: 'd-1', text: 'reads well', verdict: 'owner' }]);
    syncOwnerItems('t-1', met.deps);
    applyOwnerAnswer(
      't-1',
      'r-1',
      { text: 'Looks right', answeredWith: OWNER_CHECK_MET },
      PERSON,
      met.deps,
    );
    expect(met.calls.check).toEqual(['d-1:met']);
    expect(met.calls.notes).toEqual([]);

    const typed = fixture([{ id: 'd-1', text: 'reads well', verdict: 'owner' }]);
    syncOwnerItems('t-1', typed.deps);
    applyOwnerAnswer('t-1', 'r-1', { text: 'looks right to me' }, PERSON, typed.deps);
    expect(typed.calls.check).toEqual(['d-1:not-met']);
    expect(typed.calls.notes[0]).toContain('looks right to me');
  });

  it('does nothing for an item that is not linked to a line', () => {
    const { deps, calls } = fixture([{ id: 'd-1', text: 'x', verdict: 'owner' }]);
    applyOwnerAnswer('t-1', 'r-unlinked', { text: 'yes' }, PERSON, deps);
    expect(calls.check).toEqual([]);
  });

  it('refuses an agent on a linked item and nobody on an unlinked one', () => {
    const { task, deps } = fixture([{ id: 'd-1', text: 'x', verdict: 'owner' }]);
    syncOwnerItems('t-1', deps);
    expect(refuseOwnerAnswer(task, 'r-1', AGENT)).toBeString();
    expect(refuseOwnerAnswer(task, 'r-1', PERSON)).toBeUndefined();
    expect(refuseOwnerAnswer(task, 'r-other', AGENT)).toBeUndefined();
  });
});

describe('ownerCheckReview', () => {
  it('is a decision whose options are the two the answer reads, with proof linked', () => {
    const review = ownerCheckReview({ title: 'A task' } as Task, {
      id: 'd-1',
      text: 'reads well',
      proof: [{ text: 'shot', url: 'https://example.com/a.png' }],
    }) as { shape: string; options: Array<{ id: string }>; detail: string };
    expect(review.shape).toBe('decision');
    expect(review.options.map((o) => o.id)).toEqual([OWNER_CHECK_MET, 'not-met']);
    expect(review.detail).toContain('[shot](https://example.com/a.png)');
  });
});
