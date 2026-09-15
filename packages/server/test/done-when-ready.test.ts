/**
 * The done-when ready reminder on its own, over plain objects standing in for
 * the store and the stream board: which tasks are waiting on a builder's
 * ready, who is told, and that a line is told once while it stands. The
 * route-level behaviour is done-when-needs-owner.test.ts. Fixtures are
 * invented.
 */
import { describe, expect, it } from 'bun:test';
import type { DoneWhenLine } from '@claude-workspaces/core/done-when';
import type { Task } from '@claude-workspaces/core/task-wire';
import {
  DONE_WHEN_READY_EVENT,
  DoneWhenReadyNudger,
  linesAwaitingReady,
} from '../src/review-items/done-when-ready.ts';

function task(lines: DoneWhenLine[], status: Task['status'] = 'in-progress'): Task {
  return {
    id: 't-1',
    workspaceId: 'w-1',
    title: 'Reader can read the tide chart',
    assignee: 'Tidewright',
    status,
    doneWhen: lines,
  } as unknown as Task;
}

const MET: DoneWhenLine = { id: 'd-1', text: 'route answers', verdict: 'met' };
const PERSON: DoneWhenLine = { id: 'd-2', text: 'reads at 430', needs: 'owner' };

describe('linesAwaitingReady', () => {
  it('names the person’s line once everything else is met', () => {
    expect(linesAwaitingReady(task([MET, PERSON])).map((l) => l.id)).toEqual(['d-2']);
    expect(linesAwaitingReady(task([MET, { ...PERSON, verdict: 'not-met' }]))).toHaveLength(1);
  });

  it('names every person’s line not yet handed over, since each waits on the same ready', () => {
    const second: DoneWhenLine = { id: 'd-3', text: 'reads aloud right', needs: 'owner' };
    expect(linesAwaitingReady(task([MET, PERSON, second])).map((l) => l.id)).toEqual([
      'd-2',
      'd-3',
    ]);
  });

  it('names nothing while other work is open, once handed over, or off in-progress', () => {
    expect(linesAwaitingReady(task([{ ...MET, verdict: 'unchecked' }, PERSON]))).toEqual([]);
    expect(linesAwaitingReady(task([MET, { ...PERSON, verdict: 'owner' }]))).toEqual([]);
    expect(linesAwaitingReady(task([MET, PERSON], 'todo'))).toEqual([]);
    expect(linesAwaitingReady(task([MET, { ...PERSON, needs: undefined }]))).toEqual([]);
    expect(
      linesAwaitingReady({ ...task([MET, PERSON]), archivedAt: 1 } as unknown as Task),
    ).toEqual([]);
  });
});

function harness(rows: Task[], reachable: Set<string>) {
  const sent: Array<{ to: string; frame: Record<string, unknown> }> = [];
  const nudger = new DoneWhenReadyNudger({
    workspaces: () => [{ id: 'w-1', leadAgentId: 'agent-harborlight' }],
    tasks: () => rows,
    ownerIdOf: () => 'agent-tidewright',
    canReach: (_ws, id) => reachable.has(id),
    send: (_ws, to, frame) => {
      sent.push({ to, frame });
      return 1;
    },
    taskUrl: (ws, id) => `https://example.com/workspaces/${ws}?task=${id}`,
  });
  return { nudger, sent };
}

describe('DoneWhenReadyNudger', () => {
  it('tells the task’s agent once, and again only after the line stopped waiting', () => {
    const row = task([MET, { ...PERSON }]);
    const { nudger, sent } = harness([row], new Set(['agent-tidewright', 'agent-harborlight']));
    expect(nudger.tick(1)).toBe(1);
    expect(nudger.tick(2)).toBe(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe('agent-tidewright');
    expect(sent[0]?.frame).toMatchObject({
      event: DONE_WHEN_READY_EVENT,
      taskId: 't-1',
      lineId: 'd-2',
      line: 'reads at 430',
      url: 'https://example.com/workspaces/w-1?task=t-1',
    });

    // Handed over, then sent back by the person: a fresh reminder.
    (row.doneWhen as DoneWhenLine[])[1] = { ...PERSON, verdict: 'owner' };
    expect(nudger.tick(3)).toBe(0);
    (row.doneWhen as DoneWhenLine[])[1] = { ...PERSON, verdict: 'not-met' };
    expect(nudger.tick(4)).toBe(1);
  });

  it('goes to the lead when the task’s agent holds no stream, and records nothing delivered to nobody', () => {
    const row = task([MET, PERSON]);
    const reachable = new Set<string>();
    const { nudger, sent } = harness([row], reachable);
    expect(nudger.tick(1)).toBe(0);
    expect(sent).toHaveLength(0);
    reachable.add('agent-harborlight');
    expect(nudger.tick(2)).toBe(1);
    expect(sent[0]?.to).toBe('agent-harborlight');
    expect(sent[0]?.frame.forAssignee).toBe('Tidewright');
  });
});
