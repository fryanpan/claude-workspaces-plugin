/**
 * A done-when line can be written as needing a person from the start, and it
 * reaches that person only when its builder says it is ready.
 *
 * The owner's words (2026-09-14): "Sometimes the done criteria item is just
 * not ready to review yet — and I don't want to flag a human for review when
 * it's at that point." So the line files nothing while it is open, the
 * builder's `owner` report is the ready signal that files the item, and a
 * builder who has met everything else and not said so is reminded — the
 * builder, never the person.
 *
 * Driven over HTTP against a real server, read back off the queue route Home
 * renders and the event stream an agent listens on. No judge is wired, so no
 * model is called. All fixtures are invented — the repo is public.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DONE_WHEN_READY_EVENT } from '../src/review-items/done-when-ready.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import type { Task } from '../src/tasks.ts';
import { type Frame, listenFrames, settle } from './doc-activity-stall-harness.ts';
import { waitFor } from './wait-for.ts';

const BUILDER = { id: 'agent-tidewright', name: 'Tidewright', kind: 'agent' };
const LEAD = { id: 'agent-harborlight', name: 'Harborlight', kind: 'agent' };
const SHOT = 'https://example.com/saltmarsh-phone.png';

let handle: ServerHandle | undefined;
let dataDir = '';
let base = '';
let ws = '';
const streams: Array<ReturnType<typeof listenFrames>> = [];

afterEach(async () => {
  for (const s of streams.splice(0)) await s.stop();
  await handle?.stop();
  handle = undefined;
  rmSync(dataDir, { recursive: true, force: true });
});

const post = (path: string, body: unknown) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

async function fresh(): Promise<void> {
  dataDir = mkdtempSync(join(tmpdir(), 'needs-owner-'));
  handle = createServer({ port: 0, dataDir, keepMovingCadenceMs: 0 });
  base = `http://127.0.0.1:${handle.port}`;
  const res = await post('/workspaces', {
    name: 'Riverbend board',
    leadAgentId: LEAD.id,
    author: BUILDER,
  });
  ws = ((await res.json()) as { workspace: { id: string } }).workspace.id;
}

async function detail(taskId: string): Promise<Task> {
  const r = await fetch(`${base}/workspaces/${ws}/tasks/${taskId}/detail`);
  return ((await r.json()) as { task: Task }).task;
}

async function onQueue(taskId: string): Promise<Array<{ reviewItemId?: string }>> {
  const r = await fetch(`${base}/workspaces/${ws}/review-items`);
  const { items } = (await r.json()) as {
    items: Array<{ taskId?: string; reviewItemId?: string }>;
  };
  return items.filter((row) => row.taskId === taskId);
}

/** An in-progress task owned by the builder: an ordinary line, then a line
 *  written as needing a person. */
async function twoLineTask(): Promise<{ taskId: string; plain: string; person: string }> {
  const r = await post(`/workspaces/${ws}/tasks`, {
    author: BUILDER,
    assignee: BUILDER.name,
    assigneeKind: 'agent',
    title: 'Reader can read the tide chart on a phone',
    doneWhen: [
      { text: 'the chart route answers 200 with points' },
      { text: 'the chart reads at 430 wide', needs: 'owner' },
    ],
  });
  expect(r.status).toBe(200);
  const task = ((await r.json()) as { task: Task }).task;
  const moved = await post(`/workspaces/${ws}/tasks/${task.id}/transition`, {
    to: 'in-progress',
    author: BUILDER,
  });
  expect(moved.status).toBe(200);
  const lines = (await detail(task.id)).doneWhen ?? [];
  return { taskId: task.id, plain: lines[0]?.id ?? '', person: lines[1]?.id ?? '' };
}

async function report(taskId: string, lines: unknown[]) {
  const r = await post(`/workspaces/${ws}/tasks/${taskId}/done-when/report`, {
    author: BUILDER,
    lines,
  });
  return { status: r.status, body: (await r.json()) as { error?: string; message?: string } };
}

async function agentStream(agent: { id: string }) {
  await post(`/workspaces/${ws}/agents`, { agentId: agent.id, runtime: 'claude-code-local' });
  const res = await fetch(
    `${base}/workspaces/${ws}/events:stream?agentId=${encodeURIComponent(agent.id)}`,
    { headers: { accept: 'text/event-stream' } },
  );
  const stream = listenFrames(res);
  streams.push(stream);
  return stream;
}

const readyFrames = (frames: Frame[]) => frames.filter((f) => f.event === DONE_WHEN_READY_EVENT);

describe('a line written as needing a person', () => {
  it('is stored as such, files nothing while open, and an edit of its words keeps it', async () => {
    await fresh();
    const { taskId, person } = await twoLineTask();
    const task = await detail(taskId);
    expect(task.doneWhen?.[1]?.needs).toBe('owner');
    // An ordinary open line: no verdict, no item, nothing on the queue.
    expect(task.doneWhen?.[1]?.verdict).toBeUndefined();
    expect(task.doneWhen?.[0]?.needs).toBeUndefined();
    expect(task.reviews ?? []).toHaveLength(0);
    expect(await onQueue(taskId)).toHaveLength(0);

    // The panel sends `{id, text}` and nothing about needs: the flag stays.
    const lines = task.doneWhen ?? [];
    await post(`/workspaces/${ws}/tasks/${taskId}/done-when`, {
      author: BUILDER,
      lines: [
        { id: lines[0]?.id, text: lines[0]?.text },
        { id: person, text: 'the chart reads at 430 and 1180 wide' },
      ],
    });
    expect((await detail(taskId)).doneWhen?.[1]?.needs).toBe('owner');
    // `null` is the one way to clear it.
    await post(`/workspaces/${ws}/tasks/${taskId}/done-when`, {
      author: BUILDER,
      lines: [
        { id: lines[0]?.id, text: lines[0]?.text },
        { id: person, text: 'x', needs: null },
      ],
    });
    expect((await detail(taskId)).doneWhen?.[1]?.needs).toBeUndefined();
  });

  it('refuses any other needs value, naming the line', async () => {
    await fresh();
    const r = await post(`/workspaces/${ws}/tasks`, {
      author: BUILDER,
      title: 'Reader can pin a tide station',
      doneWhen: [{ text: 'the pin reads right', needs: 'human' }],
    });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { message?: string }).message).toContain('the pin reads right');
  });

  it('is not the builder’s to meet: it reports it owner when ready, which files exactly one item with the link', async () => {
    await fresh();
    const { taskId, person } = await twoLineTask();
    const met = await report(taskId, [
      { id: person, verdict: 'met', proof: [{ text: 'I looked', url: SHOT }] },
    ]);
    expect(met.status).toBe(400);
    expect(met.body.error).toBe('not-yours');
    expect(met.body.message).toContain('report it owner');
    expect(await onQueue(taskId)).toHaveLength(0);

    const ready = await report(taskId, [
      { id: person, verdict: 'owner', proof: [{ text: 'phone shot', url: SHOT }] },
    ]);
    expect(ready.status).toBe(200);
    const rows = await onQueue(taskId);
    expect(rows).toHaveLength(1);
    const item = (await detail(taskId)).reviews?.find((r) => r.id === rows[0]?.reviewItemId);
    expect(item?.review.headline).toBe('Check: the chart reads at 430 wide');
    expect(item?.review.detail).toContain(`](${SHOT})`);
  });
});

describe('the builder is reminded to say it is ready', () => {
  it('once every other line is met: one nudge to the task’s agent, nothing on the queue, not repeated', async () => {
    await fresh();
    const { taskId, plain, person } = await twoLineTask();
    const builder = await agentStream(BUILDER);
    const lead = await agentStream(LEAD);

    // With an ordinary line still open the builder has work left: no nudge.
    handle?.nudgeStalls();
    await settle(100);
    expect(readyFrames(builder.frames)).toHaveLength(0);

    await report(taskId, [{ id: plain, verdict: 'met', proof: [{ text: 'bun test chart' }] }]);
    await waitFor(
      () => {
        handle?.nudgeStalls();
        return readyFrames(builder.frames).length > 0 || undefined;
      },
      { timeout: 4_000, interval: 25, describe: 'the done-when ready nudge' },
    );
    const [frame] = readyFrames(builder.frames);
    expect(frame?.data?.taskId).toBe(taskId);
    expect(frame?.data?.lineId).toBe(person);
    expect(frame?.data?.line).toBe('the chart reads at 430 wide');
    expect(String(frame?.data?.url)).toContain(`?task=${taskId}`);

    // Further ticks say nothing more, the lead hears nothing, and the person
    // has nothing on their queue.
    handle?.nudgeStalls();
    handle?.nudgeStalls();
    await settle(100);
    expect(readyFrames(builder.frames)).toHaveLength(1);
    expect(readyFrames(lead.frames)).toHaveLength(0);
    expect(await onQueue(taskId)).toHaveLength(0);

    // Reported ready, the reminder has nothing left to say.
    await report(taskId, [{ id: person, verdict: 'owner', proof: [{ text: 'shot', url: SHOT }] }]);
    handle?.nudgeStalls();
    await settle(100);
    expect(readyFrames(builder.frames)).toHaveLength(1);
  });
});
