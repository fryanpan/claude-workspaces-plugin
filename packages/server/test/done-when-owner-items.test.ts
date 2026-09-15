/**
 * A done-when line marked for the owner is a review item on the reader's
 * queue, and the item's answer is the line's verdict.
 *
 * Measured before the fix (2026-09-14): seven owner lines across six open
 * tasks drew buttons on their task pages and nothing on Home. Driven over
 * HTTP and read back off the same queue route the Home pane renders, because
 * "filed" is only worth anything if that list shows it; the backfill is
 * proved by booting the same data directory twice.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import type { Task } from '../src/tasks.ts';
import { seedBoard } from './workspace-seed.ts';

const PERSON = { id: 'known-reader', name: 'Reader', kind: 'known', color: '#2e7dd7' };
const AGENT = { id: 'agent-lanternfish', name: 'Lanternfish', kind: 'known', color: '#888888' };

interface QueueRow {
  taskId?: string;
  reviewItemId?: string;
  review?: { headline?: string };
  askedBy?: string;
}

let handle: ServerHandle | undefined;
let dataDir = '';
let base = '';
let ws = '';

function boot(): void {
  handle = createServer({ port: 0, dataDir, keepMovingCadenceMs: 0 });
  base = `http://127.0.0.1:${handle.port}`;
}

afterEach(async () => {
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
  dataDir = mkdtempSync(join(tmpdir(), 'owner-items-'));
  boot();
  ws = await seedBoard(base);
}

async function detail(taskId: string): Promise<Task> {
  const r = await fetch(`${base}/workspaces/${ws}/tasks/${taskId}/detail`);
  return ((await r.json()) as { task: Task }).task;
}

async function queue(): Promise<QueueRow[]> {
  const r = await fetch(`${base}/workspaces/${ws}/review-items`);
  return ((await r.json()) as { items: QueueRow[] }).items;
}

async function ownerItemsOn(taskId: string): Promise<QueueRow[]> {
  return (await queue()).filter((row) => row.taskId === taskId);
}

/** A task with one line, reported `owner` by its builder. */
async function ownerLine(title: string, text: string): Promise<{ taskId: string; lineId: string }> {
  const r = await post(`/workspaces/${ws}/tasks`, { author: AGENT, title, doneWhen: [{ text }] });
  const task = ((await r.json()) as { task: Task }).task;
  const lineId = (await detail(task.id)).doneWhen?.[0]?.id as string;
  const reported = await post(`/workspaces/${ws}/tasks/${task.id}/done-when/report`, {
    author: AGENT,
    lines: [
      {
        id: lineId,
        verdict: 'owner',
        proof: [{ text: 'screenshot', url: 'https://example.com/shot.png' }],
      },
    ],
  });
  expect(reported.status).toBe(200);
  return { taskId: task.id, lineId };
}

describe('an owner line is a review item on the queue', () => {
  it('files one item for the line when the builder marks it owner, and only one', async () => {
    await fresh();
    const { taskId, lineId } = await ownerLine(
      'Reader can see the chart on a phone',
      'the chart reads at 430 wide',
    );
    const rows = await ownerItemsOn(taskId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.review?.headline).toContain('the chart reads at 430 wide');
    // Credited to the builder who handed the line over.
    expect(rows[0]?.askedBy).toBe('Lanternfish');
    const item = (await detail(taskId)).reviews?.find((r) => r.id === rows[0]?.reviewItemId);
    expect(item?.review.options?.map((o) => o.label)).toEqual(['Looks right', 'Not met']);

    // Reporting the same verdict again is not a second question.
    await post(`/workspaces/${ws}/tasks/${taskId}/done-when/report`, {
      author: AGENT,
      lines: [{ id: lineId, verdict: 'owner' }],
    });
    expect(await ownerItemsOn(taskId)).toHaveLength(1);

    // New proof on the same line: the one item now carries it.
    await post(`/workspaces/${ws}/tasks/${taskId}/done-when/report`, {
      author: AGENT,
      lines: [
        {
          id: lineId,
          verdict: 'owner',
          proof: [{ text: 'retaken at 430', url: 'https://example.com/430.png' }],
        },
      ],
    });
    const after = await ownerItemsOn(taskId);
    expect(after).toHaveLength(1);
    expect(after[0]?.reviewItemId).toBe(rows[0]?.reviewItemId);
    const revised = (await detail(taskId)).reviews?.find((r) => r.id === rows[0]?.reviewItemId);
    expect(revised?.review.detail).toContain('retaken at 430');
  });

  it('meets the line on Looks right, which closes a task whose last line it was', async () => {
    await fresh();
    const { taskId } = await ownerLine('Reader can print the report', 'the print preview fits A4');
    const [row] = await ownerItemsOn(taskId);
    const answered = await post(
      `/workspaces/${ws}/tasks/${taskId}/review-items/${row?.reviewItemId}/answer`,
      { author: PERSON, text: 'Looks right', answeredWith: 'looks-right' },
    );
    expect(answered.status).toBe(200);
    const after = await detail(taskId);
    expect(after.doneWhen?.[0]?.verdict).toBe('met');
    expect(after.doneWhen?.[0]?.by).toBe('Reader');
    expect(after.status).toBe('done');
    expect(await ownerItemsOn(taskId)).toHaveLength(0);
  });

  it('leaves the line not met on any other answer, with the words on the task', async () => {
    await fresh();
    const { taskId } = await ownerLine('Reader can sort the list', 'the sort holds after reload');
    const [row] = await ownerItemsOn(taskId);
    await post(`/workspaces/${ws}/tasks/${taskId}/review-items/${row?.reviewItemId}/answer`, {
      author: PERSON,
      text: 'It resets to newest first when I come back',
    });
    const after = await detail(taskId);
    expect(after.doneWhen?.[0]?.verdict).toBe('not-met');
    expect(after.status).not.toBe('done');
    const notes = (after.notes ?? []).map((n) => n.text);
    expect(notes.some((t) => t.includes('It resets to newest first when I come back'))).toBe(true);
    expect(await ownerItemsOn(taskId)).toHaveLength(0);
  });

  it('refuses an agent answer on the item, leaving the line and the item as they were', async () => {
    await fresh();
    const { taskId } = await ownerLine('Reader can rename a board', 'the new name reads right');
    const [row] = await ownerItemsOn(taskId);
    const byAgent = await post(
      `/workspaces/${ws}/tasks/${taskId}/review-items/${row?.reviewItemId}/answer`,
      { author: AGENT, text: 'Looks right', answeredWith: 'looks-right' },
    );
    expect(byAgent.status).toBe(400);
    expect((await detail(taskId)).doneWhen?.[0]?.verdict).toBe('owner');
    expect(await ownerItemsOn(taskId)).toHaveLength(1);
  });

  it('takes the item off the queue when the line is answered on the task page instead', async () => {
    await fresh();
    const { taskId, lineId } = await ownerLine(
      'Reader can pin a doc',
      'the pin sticks on the iPad',
    );
    expect(await ownerItemsOn(taskId)).toHaveLength(1);
    const checked = await post(`/workspaces/${ws}/tasks/${taskId}/done-when/${lineId}/check`, {
      author: PERSON,
      verdict: 'not-met',
    });
    expect(checked.status).toBe(200);
    expect(await ownerItemsOn(taskId)).toHaveLength(0);
    const withdrawn = (await detail(taskId)).reviews?.[0]?.review.withdrawnAt;
    expect(typeof withdrawn).toBe('number');
  });
});

describe('owner lines written before the items existed', () => {
  it('get their item at boot, and a second boot files no second item', async () => {
    await fresh();
    const { taskId } = await ownerLine('Reader can export a board', 'the export opens in a sheet');
    // Put the row back in its pre-deploy shape: an owner line with no item.
    // The live row is the store's own, so the next save writes this state.
    const live = handle?.tasks.getTask(taskId);
    if (!live) throw new Error('task missing');
    live.reviews = [];
    handle?.tasks.appendNote(taskId, {
      kind: 'status',
      text: 'pre-deploy',
      agent: 'test',
      ts: Date.now(),
    });
    expect(await ownerItemsOn(taskId)).toHaveLength(0);

    await handle?.stop();
    boot();
    expect(await ownerItemsOn(taskId)).toHaveLength(1);
    const first = (await ownerItemsOn(taskId))[0]?.reviewItemId;

    await handle?.stop();
    boot();
    const rows = await ownerItemsOn(taskId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reviewItemId).toBe(first);
    expect((await detail(taskId)).reviews).toHaveLength(1);
  });
});
