/**
 * The done-when ready reminder on its own, over plain objects standing in for
 * the store and the stream board: which tasks are waiting on a builder's
 * ready, who is told, and that a line is told once while it stands. The
 * route-level behaviour is done-when-needs-owner.test.ts. Fixtures are
 * invented.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

function harness(
  rows: Task[],
  reachable: Set<string>,
  extra: { toldPath?: string; lastCommentAt?: (task: Task) => number | undefined } = {},
) {
  const sent: Array<{ to: string; frame: Record<string, unknown> }> = [];
  const nudger = new DoneWhenReadyNudger({
    ...extra,
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

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function toldPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'done-when-ready-'));
  dirs.push(dir);
  return join(dir, 'told.json');
}

const BOTH = () => new Set(['agent-tidewright', 'agent-harborlight']);

describe('DoneWhenReadyNudger under a declared wait', () => {
  it('sends nothing while the wait stands, and tells once it lapses', () => {
    const row = {
      ...task([MET, PERSON]),
      updatedAt: 10,
      externalWait: {
        what: 'Riverbend landing the release',
        since: 20,
        declaredAt: 20,
        until: 1_000,
        by: 'Harborlight',
      },
    } as Task;
    const { nudger, sent } = harness([row], BOTH());
    expect(nudger.tick(100)).toBe(0);
    expect(nudger.tick(999)).toBe(0);
    expect(sent).toHaveLength(0);
    expect(nudger.tick(1_000)).toBe(1);
    expect(sent[0]?.frame.event).toBe(DONE_WHEN_READY_EVENT);
  });

  it('stays quiet when a wait lapses over a line already told', () => {
    const row = { ...task([MET, PERSON]), updatedAt: 10 } as Task;
    const { nudger, sent } = harness([row], BOTH());
    expect(nudger.tick(100)).toBe(1);
    row.externalWait = { what: 'Bob', since: 200, declaredAt: 200, until: 500, by: 'Alice' };
    expect(nudger.tick(300)).toBe(0);
    expect(nudger.tick(600)).toBe(0);
    expect(sent).toHaveLength(1);
  });
});

describe('DoneWhenReadyNudger, once per line until the task changes', () => {
  it('does not re-tell a standing line after a restart', () => {
    const path = toldPath();
    const row = { ...task([MET, PERSON]), updatedAt: 10 } as Task;
    const first = harness([row], BOTH(), { toldPath: path });
    expect(first.nudger.tick(100)).toBe(1);
    // Four restarts in a row: each a fresh nudger reading the same record.
    for (let i = 0; i < 4; i++) {
      const again = harness([row], BOTH(), { toldPath: path });
      expect(again.nudger.tick(200 + i)).toBe(0);
      expect(again.sent).toHaveLength(0);
    }
  });

  it('tells again after a field write or a comment on the task, and not before', () => {
    const path = toldPath();
    const row = { ...task([MET, PERSON]), updatedAt: 10 } as Task;
    const thread: { lastActivity?: number } = {};
    const { nudger, sent } = harness([row], BOTH(), {
      toldPath: path,
      lastCommentAt: () => thread.lastActivity,
    });
    expect(nudger.tick(100)).toBe(1);
    expect(nudger.tick(101)).toBe(0);
    row.updatedAt = 150; // a transition, a line reported
    expect(nudger.tick(200)).toBe(1);
    expect(nudger.tick(201)).toBe(0);
    thread.lastActivity = 250;
    expect(nudger.tick(300)).toBe(1);
    expect(nudger.tick(301)).toBe(0);
    expect(sent).toHaveLength(3);
  });

  it('forgets a line that stopped awaiting, so the record does not grow', () => {
    const path = toldPath();
    const row = { ...task([MET, PERSON]), updatedAt: 10 } as Task;
    const { nudger } = harness([row], BOTH(), { toldPath: path });
    expect(nudger.tick(100)).toBe(1);
    row.status = 'done';
    expect(nudger.tick(200)).toBe(0);
    row.status = 'in-progress';
    const restarted = harness([row], BOTH(), { toldPath: path });
    expect(restarted.nudger.tick(300)).toBe(1);
  });
});
