/**
 * The tools that move one task or change one of its fields call the server
 * through the typed client, over the task-state contract
 * (`packages/server/src/routes/task-state-contract.ts`).
 *
 * The cases record what reached `http`: the same method, path and body the
 * hand-spelled paths sent, the task id percent-encoded as before, and no key
 * for a field the caller left out. `typeProbes` and `answerProbes` never run;
 * `bun run typecheck` compiles them, and each `@ts-expect-error` fails the
 * typecheck if the line under it stops being an error.
 */
import { describe, expect, it } from 'vitest';
import { taskStateClient } from '../src/server-client.ts';
import { handleTaskTool } from '../src/tools/tasks.ts';

const AUTHOR = { id: 'agent-harborlight', name: 'Harborlight site', kind: 'agent' };
const T = '/workspaces/w-1/tasks/t%201';

const ROW = {
  status: 'in-progress',
  goal: 'g-riverbend',
  order: 2,
  assignee: 'Alice',
  after: ['t-2'],
  afterEnforce: ['t-2'],
  archivedAt: 5,
  archiveReason: 'done elsewhere',
};
const ANSWER = {
  ok: true,
  task: ROW,
  changed: true,
  blockers: [],
  after: ['t-2'],
  ownerKind: 'person',
  wait: { what: 'the vendor', since: 1, until: 2 },
};

function recorder(answer: unknown = ANSWER) {
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
    const out = (await handleTaskTool(
      tool,
      { workspaceId: 'w-1', taskId: 't 1', ...args },
      ctx as never,
    )) as {
      content: Array<{ text: string }>;
    };
    return JSON.parse(out.content[0]?.text ?? 'null') as Record<string, unknown>;
  };
  return { calls, run };
}

describe('the task-state tools, through the typed client', () => {
  it('moves a task, and hands it over', async () => {
    const r = recorder();
    const moved = await r.run('task_transition', { to: 'in-progress', note: 'starting' });
    await r.run('task_transition', { to: 'done', usage: { inputTokens: 1, outputTokens: 2 } });
    const handed = await r.run('assign_task', { assignee: 'Bob', assigneeKind: 'person' });
    await r.run('assign_task', { assignee: 'Bob' });
    expect(r.calls).toEqual([
      ['POST', `${T}/transition`, { to: 'in-progress', author: AUTHOR, note: 'starting' }],
      [
        'POST',
        `${T}/transition`,
        { to: 'done', author: AUTHOR, usage: { inputTokens: 1, outputTokens: 2 } },
      ],
      ['POST', `${T}/assignee`, { assignee: 'Bob', assigneeKind: 'person', author: AUTHOR }],
      ['POST', `${T}/assignee`, { assignee: 'Bob', author: AUTHOR }],
    ]);
    expect(moved).toEqual({ taskId: 't 1', status: 'in-progress', blockers: [] });
    expect(handed).toEqual({
      taskId: 't 1',
      assignee: 'Alice',
      changed: true,
      ownerKind: 'person',
    });
  });

  it('blocks a task, and declares and clears a wait', async () => {
    const r = recorder();
    const blocked = await r.run('block_task', { blockedBy: 't-2' });
    const waiting = await r.run('declare_wait', { waitingOn: 'the vendor', hours: 4 });
    await r.run('declare_wait', { waitingOn: 'the vendor' });
    const cleared = await r.run('declare_wait', { clear: true });
    expect(r.calls).toEqual([
      ['POST', `${T}/park`, { blockedBy: ['t-2'], author: AUTHOR }],
      ['POST', `${T}/wait`, { what: 'the vendor', hours: 4, author: AUTHOR }],
      ['POST', `${T}/wait`, { what: 'the vendor', author: AUTHOR }],
      ['POST', `${T}/wait`, { clear: true, author: AUTHOR }],
    ]);
    expect(blocked).toEqual({
      taskId: 't 1',
      blockedBy: ['t-2'],
      status: 'in-progress',
      changed: true,
    });
    expect(waiting).toEqual({
      taskId: 't 1',
      waitingOn: 'the vendor',
      until: 2,
      waitingSince: 1,
      status: 'in-progress',
    });
    expect(cleared).toEqual({ taskId: 't 1', cleared: true, changed: true });
  });

  it('archives and restores a task', async () => {
    const r = recorder();
    const archived = await r.run('archive_task', { reason: 'done elsewhere' });
    await r.run('archive_task', {});
    const restored = await r.run('unarchive_task', {});
    expect(r.calls).toEqual([
      ['POST', `${T}/archive`, { reason: 'done elsewhere', author: AUTHOR }],
      ['POST', `${T}/archive`, { author: AUTHOR }],
      ['POST', `${T}/restore`, { author: AUTHOR }],
    ]);
    expect(archived).toEqual({
      taskId: 't 1',
      archivedAt: 5,
      archiveReason: 'done elsewhere',
      changed: true,
    });
    expect(restored).toEqual({
      taskId: 't 1',
      goal: 'g-riverbend',
      status: 'in-progress',
      changed: true,
    });
  });

  it('places a task in a goal, and sets what it waits on', async () => {
    const r = recorder();
    const placed = await r.run('set_task_goal', {
      goal: 'g-riverbend',
      position: 0,
      batchId: 'b1',
    });
    await r.run('set_task_goal', { goal: 'g-riverbend' });
    const deps = await r.run('set_task_dependencies', { after: ['t-2'], afterEnforce: ['t-2'] });
    await r.run('set_task_dependencies', { after: [] });
    expect(r.calls).toEqual([
      ['POST', `${T}/goal`, { goal: 'g-riverbend', author: AUTHOR, position: 0, batchId: 'b1' }],
      ['POST', `${T}/goal`, { goal: 'g-riverbend', author: AUTHOR }],
      ['POST', `${T}/after`, { after: ['t-2'], afterEnforce: ['t-2'], author: AUTHOR }],
      ['POST', `${T}/after`, { after: [], author: AUTHOR }],
    ]);
    expect(placed).toEqual({ taskId: 't 1', goal: 'g-riverbend', order: 2, changed: true });
    expect(deps).toEqual({ taskId: 't 1', changed: true, after: ['t-2'], afterEnforce: ['t-2'] });
  });

  it('sets and clears a schedule', async () => {
    const r = recorder({ ok: true, task: { ...ROW, schedule: undefined } });
    const rule = { kind: 'daily', at: '09:00' };
    await r.run('set_task_schedule', { rule, timezone: 'UTC', onMissed: 'skip' });
    const cleared = await r.run('set_task_schedule', { rule: null });
    expect(r.calls).toEqual([
      ['POST', `${T}/schedule`, { rule, timezone: 'UTC', onMissed: 'skip', author: AUTHOR }],
      ['POST', `${T}/schedule`, { rule: null, author: AUTHOR }],
    ]);
    expect(cleared).toEqual({ taskId: 't 1', schedule: null, nextAt: null });
  });
});

/** Compiled by `bun run typecheck`, never called. See the header. */
function typeProbes(api: ReturnType<typeof taskStateClient>): void {
  const row = api.workspaces[':ws'].tasks[':taskId'];
  const param = { ws: 'w', taskId: 't' };
  // @ts-expect-error — a hand-over names the new owner as `assignee`.
  void row.assignee.$post({ param, json: { owner: 'Bob' } });
  // @ts-expect-error — dependencies are `after`, not `blockedBy`.
  void row.after.$post({ param, json: { blockedBy: ['t-2'] } });
  // The control: the same calls, spelled as the contract declares them, compile.
  void row.assignee.$post({ param, json: { assignee: 'Bob' } });
  void row.after.$post({ param, json: { after: ['t-2'] } });
}

/** The answers the tools read a field of are typed too. Compiled, never called. */
async function answerProbes(api: ReturnType<typeof taskStateClient>): Promise<void> {
  const row = api.workspaces[':ws'].tasks[':taskId'];
  const param = { ws: 'w', taskId: 't' };
  const waited = await (await row.wait.$post({ param, json: { clear: true } })).json();
  // @ts-expect-error — a wait's text is `wait.what`.
  void waited.wait?.text;
  const moved = await (await row.transition.$post({ param, json: { to: 'done' } })).json();
  // @ts-expect-error — the moved row is `task`.
  void moved.row;
  // The control: the fields a tool reads are there, with their types.
  const what: string | undefined = waited.wait?.what;
  const status: string = moved.task.status;
  void [what, status];
}
void typeProbes;
void answerProbes;
