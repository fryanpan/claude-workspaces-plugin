/**
 * The tools that read a board's tasks and write its goal bands call the
 * server through the typed client, over the task-board contract
 * (`packages/server/src/routes/task-board-contract.ts`).
 *
 * The cases record what reached `http`: the same method, path, query and body
 * the hand-spelled paths sent, ids percent-encoded as before, and no key for
 * a field the caller left out. `typeProbes` never runs; `bun run typecheck`
 * compiles it, and each `@ts-expect-error` fails the typecheck if the line
 * under it stops being an error.
 */
import { describe, expect, it } from 'vitest';
import { taskBoardClient } from '../src/server-client.ts';
import { handleTaskTool } from '../src/tools/tasks.ts';

const AUTHOR = { id: 'agent-harborlight', name: 'Harborlight site', kind: 'agent' };
const B = '/workspaces/w-1';

const ROW = {
  id: 't-1',
  title: 'Riverbend survey',
  status: 'todo',
  assignee: 'Alice',
  goal: 'g-1',
  order: 1,
};

function recorder(answer: unknown) {
  const calls: Array<[string, string, unknown]> = [];
  const ctx = {
    http: async (method: string, path: string, body?: unknown) => {
      calls.push([method, path, body]);
      return answer;
    },
    ok: (data: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(data) }] }),
    err: (message: string) => ({ isError: true, content: [{ type: 'text', text: message }] }),
    AUTHOR,
    claimNoticeFor: async () => undefined,
  };
  /** The tool's answer, parsed. */
  const run = async (tool: string, args: Record<string, unknown>) => {
    const out = (await handleTaskTool(tool, { workspaceId: 'w-1', ...args }, ctx as never)) as {
      content: Array<{ text: string }>;
    };
    return JSON.parse(out.content[0]?.text ?? 'null') as Record<string, unknown>;
  };
  return { calls, run };
}

describe('the board list and goal tools, through the typed client', () => {
  it('reads the queue, with and without its filters', async () => {
    const r = recorder({
      workspaceId: 'w-1',
      tasks: [ROW],
      capacity: { cap: 2, inUse: 1, free: 1, heldForCapacity: 3 },
      retired: { since: 1, notice: 'retired' },
    });
    const out = await r.run('next_tasks', {});
    await r.run('next_tasks', {
      assignee: 'Alice',
      limit: 3,
      includeBlocked: true,
      includeArchived: true,
    });
    await r.run('next_tasks', { includeBlocked: false });
    expect(r.calls).toEqual([
      ['GET', `${B}/next`, undefined],
      [
        'GET',
        `${B}/next?assignee=Alice&limit=3&includeBlocked=true&includeArchived=true`,
        undefined,
      ],
      ['GET', `${B}/next`, undefined],
    ]);
    expect(out.capacity).toEqual({ cap: 2, inUse: 1, free: 1, heldForCapacity: 3 });
    expect(out.retired).toEqual({ since: 1, notice: 'retired' });
    expect((out.tasks as Array<{ id: string }>).map((t) => t.id)).toEqual(['t-1']);
  });

  it('reads the task list, its filters and named rows', async () => {
    const r = recorder({ workspaceId: 'w-1', tasks: [ROW, { ...ROW, id: 't-2' }] });
    await r.run('list_tasks', {});
    const out = await r.run('list_tasks', {
      goal: 'g 1',
      status: 'todo',
      assignee: 'Alice',
      needs: 'action',
      includeArchived: true,
      taskIds: ['t-2'],
    });
    expect(r.calls).toEqual([
      ['GET', `${B}/tasks?format=json`, undefined],
      [
        'GET',
        `${B}/tasks?format=json&goal=g+1&status=todo&assignee=Alice&needs=action&includeArchived=true`,
        undefined,
      ],
    ]);
    expect((out.tasks as Array<{ id: string }>).map((t) => t.id)).toEqual(['t-2']);
  });

  it('restores a goal band by its own route', async () => {
    const r = recorder({ ok: true, goal: { title: 'Saltmarsh' }, changed: true, taskIds: ['t-1'] });
    const out = await r.run('unarchive_task', { goalId: 'g 1' });
    expect(r.calls).toEqual([['POST', `${B}/goals/g%201/restore`, { author: AUTHOR }]]);
    expect(out).toEqual({
      goalId: 'g 1',
      title: 'Saltmarsh',
      restoredTaskIds: ['t-1'],
      changed: true,
    });
  });

  it('replaces the goal list, with and without drop', async () => {
    const r = recorder({
      ok: true,
      changed: true,
      created: [{ id: 'g-2', title: 'Riverbend' }],
      movedToChores: [],
      strandedDone: ['t-9'],
    });
    const goals = [{ id: 'g-1', title: 'Harborlight' }, { title: 'Riverbend' }];
    const out = await r.run('set_goal_list', { goals, drop: ['g-0'] });
    await r.run('set_goal_list', { goals });
    expect(r.calls).toEqual([
      ['PUT', `${B}/goals`, { goals, drop: ['g-0'], author: AUTHOR }],
      ['PUT', `${B}/goals`, { goals, author: AUTHOR }],
    ]);
    expect(Object.keys(r.calls[1]?.[2] as object)).toEqual(['goals', 'author']);
    expect(out).toEqual({
      workspaceId: 'w-1',
      changed: true,
      created: [{ id: 'g-2', title: 'Riverbend' }],
      movedToChores: [],
      strandedDone: ['t-9'],
    });
  });

  it('renames and reorders goal bands', async () => {
    const r = recorder({
      ok: true,
      changed: true,
      goal: { id: 'g-1', title: 'Harborlight' },
      order: ['g-2', 'g-1'],
    });
    const renamed = await r.run('rename_goal', { goal: 'g-1', title: 'Harborlight', dueAt: null });
    await r.run('rename_goal', { goal: 'g-1', title: 'Harborlight' });
    const reordered = await r.run('reorder_goals', { order: ['g-2', 'g-1'] });
    expect(r.calls).toEqual([
      [
        'POST',
        `${B}/goals/rename`,
        { goal: 'g-1', title: 'Harborlight', dueAt: null, author: AUTHOR },
      ],
      ['POST', `${B}/goals/rename`, { goal: 'g-1', title: 'Harborlight', author: AUTHOR }],
      ['POST', `${B}/goals/reorder`, { order: ['g-2', 'g-1'], author: AUTHOR }],
    ]);
    expect(Object.keys(r.calls[1]?.[2] as object)).toEqual(['goal', 'title', 'author']);
    expect(renamed.goal).toEqual({ id: 'g-1', title: 'Harborlight' });
    expect(reordered.order).toEqual(['g-2', 'g-1']);
  });
});

/** Compiled, never run: a renamed field fails the typecheck. */
async function typeProbes(http: never): Promise<void> {
  const api = taskBoardClient(http).workspaces[':ws'];
  const ws = { ws: 'w-1' };
  // @ts-expect-error -- the queue's flag is `includeArchived`.
  await api.next.$get({ param: ws, query: { include_archived: 'true' } });
  // @ts-expect-error -- the list's JSON switch is `format: 'json'`, nothing else.
  await api.tasks.$get({ param: ws, query: { format: 'html' } });
  // @ts-expect-error -- the goal list's acknowledgement is `drop`.
  await api.goals.$put({ param: ws, json: { goals: [], drops: ['g-1'] } });
  // @ts-expect-error -- a rename's date is `dueAt`.
  await api.goals.rename.$post({ param: ws, json: { goal: 'g-1', title: 'x', due: 1 } });
  const listed = await (await api.goals.$put({ param: ws, json: { goals: [] } })).json();
  // @ts-expect-error -- the server stopped sending `bucketReview` (#352).
  void listed.bucketReview;
  const restored = await (
    await api.goals[':goalId'].restore.$post({ param: { ...ws, goalId: 'g-1' }, json: {} })
  ).json();
  // @ts-expect-error -- a restore answers `taskIds`.
  void restored.restoredTaskIds;
}
void typeProbes;
