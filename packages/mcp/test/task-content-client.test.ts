/**
 * The tools that file tasks and write what a task says or points at call the
 * server through the typed client, over the task-content contract
 * (`packages/server/src/routes/task-content-contract.ts`) and, for a row's
 * title and body, the task-state contract.
 *
 * The cases record what reached `http`: the same method, path and body the
 * hand-spelled paths sent, ids percent-encoded as before, and no key for a
 * field the caller left out. `typeProbes` and `answerProbes` never run;
 * `bun run typecheck` compiles them, and each `@ts-expect-error` fails the
 * typecheck if the line under it stops being an error.
 */
import { describe, expect, it } from 'vitest';
import { taskContentClient, taskStateClient } from '../src/server-client.ts';
import { handleTaskTool } from '../src/tools/tasks.ts';

const AUTHOR = { id: 'agent-harborlight', name: 'Harborlight site', kind: 'agent' };
const B = '/workspaces/w-1';
const T = `${B}/tasks/t%201`;

const ROW = {
  id: 't-1',
  title: 'Riverbend survey',
  status: 'todo',
  assignee: 'Alice',
  goal: 'g-1',
  order: 1,
  body: 'Count the stalls.',
  quote: 'count them',
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
    const out = (await handleTaskTool(
      tool,
      { workspaceId: 'w-1', taskId: 't 1', ...args },
      ctx as never,
    )) as { content: Array<{ text: string }> };
    return JSON.parse(out.content[0]?.text ?? 'null') as Record<string, unknown>;
  };
  return { calls, run };
}

describe('the task-content tools, through the typed client', () => {
  it('files a batch, with and without a source doc', async () => {
    const r = recorder({
      workspaceId: 'w-1',
      tasks: [ROW],
      failures: [],
      shapeGaps: [{ taskId: 't-1', gaps: ['options'] }],
      placement: { unplaced: ['t-1'], goals: [] },
    });
    const rows = [{ title: 'Riverbend survey' }];
    const out = await r.run('create_tasks', { tasks: rows, sourceDoc: { docId: 'd-1' } });
    await r.run('create_tasks', { tasks: rows });
    expect(r.calls).toEqual([
      ['POST', `${B}/tasks/batch`, { tasks: rows, author: AUTHOR, sourceDoc: { docId: 'd-1' } }],
      ['POST', `${B}/tasks/batch`, { tasks: rows, author: AUTHOR }],
    ]);
    expect(out.failures).toEqual([]);
    expect(out.placement).toEqual({ unplaced: ['t-1'], goals: [] });
    expect(out.created).toEqual([
      {
        title: 'Riverbend survey',
        taskId: 't-1',
        goal: 'g-1',
        order: 1,
        status: 'todo',
        assignee: 'Alice',
        placed: false,
        shapeGaps: ['options'],
      },
    ]);
  });

  it('rewrites a task: its done-when list, its body, its title', async () => {
    const r = recorder({ ok: true, task: ROW, changed: true, lines: [{ id: 'dw-1' }] });
    const listed = await r.run('rewrite_task', { doneWhen: [{ text: 'counted' }] });
    const rewrote = await r.run('rewrite_task', { body: 'Count the stalls.', title: 'Survey' });
    await r.run('rewrite_task', { body: 'Count the stalls.', reason: 'clearer' });
    const renamed = await r.run('rewrite_task', { title: 'Survey' });
    await r.run('rewrite_task', { title: 'Survey', reason: 'shorter' });
    expect(r.calls).toEqual([
      ['POST', `${T}/done-when`, { lines: [{ text: 'counted' }], author: AUTHOR }],
      ['POST', `${T}/body`, { markdown: 'Count the stalls.', title: 'Survey', author: AUTHOR }],
      ['POST', `${T}/body`, { markdown: 'Count the stalls.', reason: 'clearer', author: AUTHOR }],
      ['POST', `${T}/title`, { title: 'Survey', author: AUTHOR }],
      ['POST', `${T}/title`, { title: 'Survey', reason: 'shorter', author: AUTHOR }],
    ]);
    expect(listed).toEqual({ taskId: 't 1', doneWhen: [{ id: 'dw-1' }] });
    expect(rewrote).toEqual({
      taskId: 't 1',
      title: 'Riverbend survey',
      body: 'Count the stalls.',
      quote: 'count them',
    });
    expect(renamed).toEqual({ taskId: 't 1', title: 'Riverbend survey', changed: true });
  });

  it('reports against the done-when list', async () => {
    const r = recorder({ taskId: 't 1', lines: [], closed: true, status: 'done' });
    const lines = [{ id: 'dw-1', verdict: 'met', proof: { text: 'counted 40' } }];
    const out = await r.run('report_done_when', { lines });
    expect(r.calls).toEqual([['POST', `${T}/done-when/report`, { lines, author: AUTHOR }]]);
    expect(out).toEqual({ taskId: 't 1', lines: [], closed: true, status: 'done' });
  });

  it('imports a tracker, as a dry run and for real', async () => {
    const r = recorder({ dryRun: true });
    expect(await r.run('import_tasks_markdown', { path: '/tmp/riverbend.md' })).toEqual({
      dryRun: true,
    });
    await r.run('import_tasks_markdown', { path: '/tmp/riverbend.md', apply: true });
    expect(r.calls).toEqual([
      ['POST', `${B}/import-tasks`, { path: '/tmp/riverbend.md', author: AUTHOR }],
      ['POST', `${B}/import-tasks`, { path: '/tmp/riverbend.md', apply: true, author: AUTHOR }],
    ]);
  });

  it('links, unlinks and lists backlinks', async () => {
    const ref = { kind: 'url', url: 'https://example.invalid/pr/1' };
    const r = recorder({ ok: true, changed: true, task: ROW, ref, tasks: [] });
    expect(await r.run('link_refs', { ref })).toEqual({ taskId: 't 1', changed: true });
    expect(await r.run('unlink_refs', { ref })).toEqual({ taskId: 't 1', changed: true });
    expect(await r.run('list_backlinks', { ref })).toEqual({ ref, tasks: [] });
    expect(r.calls).toEqual([
      ['POST', `${T}/links`, { ref }],
      ['DELETE', `${T}/links`, { ref }],
      ['POST', `${B}/refs:backlinks`, { ref }],
    ]);
  });
});

/** Compiled by `bun run typecheck`, never called. See the header. */
function typeProbes(
  content: ReturnType<typeof taskContentClient>,
  state: ReturnType<typeof taskStateClient>,
): void {
  const param = { ws: 'w', taskId: 't' };
  const links = content.workspaces[':ws'].tasks[':taskId'].links;
  // @ts-expect-error — a link names its target as `ref`.
  void links.$post({ param, json: { target: { kind: 'task', taskId: 't-2' } } });
  // The control: the same call, spelled as the contract declares it, compiles.
  void links.$post({ param, json: { ref: { kind: 'task', taskId: 't-2' } } });

  // WHY THE TOOLS SEND AN OPTIONAL FIELD AS A PLAIN KEY. `retitle` stands in
  // for an optional field whose name no longer matches the contract's
  // (`reason`). Sent as a plain key, the stale name fails typecheck:
  const retitle: string | undefined = 'clearer';
  const title = state.workspaces[':ws'].tasks[':taskId'].title;
  // @ts-expect-error — `retitle` is not a field of the title body.
  void title.$post({ param, json: { title: 'Survey', retitle } });
  // Sent through a conditional spread, the same stale name compiles, because
  // TypeScript does not check a spread member against the target type. This
  // line is the reason the tools were swept; if it ever starts failing, the
  // compiler has closed the gap and this note can go.
  void title.$post({
    param,
    json: { title: 'Survey', ...(retitle !== undefined ? { retitle } : {}) },
  });
}

/** The answers the tools read a field of are typed too. Compiled, never called. */
async function answerProbes(content: ReturnType<typeof taskContentClient>): Promise<void> {
  const board = content.workspaces[':ws'];
  const batch = await (
    await board.tasks.batch.$post({ param: { ws: 'w' }, json: { tasks: [] } })
  ).json();
  // @ts-expect-error — the refused rows are `failures`.
  void batch.errors;
  const report = await (
    await board.tasks[':taskId']['done-when'].report.$post({
      param: { ws: 'w', taskId: 't' },
      json: { lines: [] },
    })
  ).json();
  // @ts-expect-error — whether the report closed the row is `closed`.
  void report.done;
  // The control: the fields a tool reads are there, with their types.
  const gaps: string[] | undefined = batch.shapeGaps?.[0]?.gaps;
  const closed: boolean = report.closed;
  void [gaps, closed];
}
void typeProbes;
void answerProbes;
