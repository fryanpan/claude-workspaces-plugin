/**
 * A done-when proof's url, as `TaskDoneWhenStore.report` stores it.
 *
 * Split from `task-done-when-store.test.ts` for length. The property: a board
 * path an agent copies off the board ("/workspaces/<id>?task=<id>") becomes a
 * link the reader can open, made absolute on the server's public base, where
 * it used to be dropped without a word — which turned an owner line carrying
 * one into a "no link" refusal. With no base known it is refused, naming the
 * line. The route half is in `done-when-owner-gate.test.ts`.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { describe, expect, it } from 'bun:test';
import type { DoneWhenLine } from '@claude-workspaces/core/done-when';
import type { Task } from '@claude-workspaces/core/task-wire';
import { type DoneWhenActor, TaskDoneWhenStore } from '../src/task-done-when.ts';

const AGENT: DoneWhenActor = { id: 'a-harborlight', name: 'Harborlight', kind: 'agent' };

function makeTask(...texts: string[]): Task {
  const doneWhen: DoneWhenLine[] = texts.map((text, i) => ({ id: `d-${i}`, text }));
  return {
    id: 't-1',
    workspaceId: 'ws-1',
    title: 'A task',
    status: 'in-progress',
    doneWhen,
  } as Task;
}

/** The verbs' persistence, recording only what these tests read back. */
function fake(task: Task) {
  const saved: string[] = [];
  const store = new TaskDoneWhenStore({
    getTask: (id) => (id === task.id ? task : undefined),
    scheduleSave: (id) => {
      saved.push(id);
    },
    transition: () => ({ ok: false }),
    appendNote: () => undefined,
  });
  return { store, saved };
}

describe('a proof url that is a board path', () => {
  it("makes a board path absolute on the server's base, so the link opens", () => {
    const task = makeTask('the queue shows the item', 'the item reads right');
    const { store } = fake(task);

    const res = store.report(
      task.id,
      [
        // The board path an agent copies off the board used to be dropped here
        // without a word, for `met` and `owner` alike.
        {
          id: 'd-0',
          verdict: 'met',
          proof: [{ text: 'the task', url: '/workspaces/w-1?task=t-1' }],
        },
        { id: 'd-1', verdict: 'owner', proof: [{ text: 'the item', url: '/review/doc-1' }] },
      ],
      AGENT,
      'https://board.example.test',
    );

    expect(res.ok).toBe(true);
    expect(task.doneWhen?.[0]?.proof?.[0]?.url).toBe(
      'https://board.example.test/workspaces/w-1?task=t-1',
    );
    expect(task.doneWhen?.[1]?.verdict).toBe('owner');
    expect(task.doneWhen?.[1]?.proof?.[0]?.url).toBe('https://board.example.test/review/doc-1');
  });

  it('keeps a url that only looks like a board path off the base, and drops its link', () => {
    const task = makeTask('the only outcome');
    const { store } = fake(task);

    const res = store.report(
      task.id,
      [
        {
          id: 'd-0',
          verdict: 'met',
          proof: [
            // Both parse as ANOTHER origin against the base.
            { text: 'protocol-relative', url: '//elsewhere.example.test/x' },
            { text: 'backslash', url: '/\\elsewhere.example.test/x' },
          ],
        },
      ],
      AGENT,
      'https://board.example.test',
    );

    expect(res.ok).toBe(true);
    expect((task.doneWhen?.[0]?.proof ?? []).map((p) => p.url)).toEqual([undefined, undefined]);
  });

  it('refuses a board path when no base is known, naming the line and asking for an absolute url', () => {
    const task = makeTask('the first outcome', 'the queue shows the item');
    const { store, saved } = fake(task);

    const res = store.report(
      task.id,
      [
        { id: 'd-0', verdict: 'met', proof: [{ text: 'ran it', url: 'https://example.test/run' }] },
        { id: 'd-1', verdict: 'owner', proof: [{ text: 'the task', url: '/workspaces/w-1' }] },
      ],
      AGENT,
    );

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('absolute-url-required');
    expect(res.message).toContain('the queue shows the item');
    expect(res.message).toContain('absolute http(s) url');
    expect(task.doneWhen?.[0]?.verdict).toBeUndefined();
    expect(saved).toEqual([]);
  });
});
