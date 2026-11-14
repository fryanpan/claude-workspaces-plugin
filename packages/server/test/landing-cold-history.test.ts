/**
 * Home's cold read loads only the docs whose threads it shows.
 *
 * `/` ranks every board by its last real activity and renders the cross-board
 * review queue. The activity reading used to load every task body on every
 * board — archived history and retired boards included — to find the newest
 * comment, and the queue's warm pass loaded the same set ahead of it. On a
 * synthetic 20-board corpus (130 live rows plus 130 archived per board, 3,000
 * docs) the first Home read after an idle sweep loaded 4,910 docs, and every
 * one of them then stayed resident for the short window. The newest comment
 * on a doc is already on its index row, so the activity reading needs no load
 * at all, and the queue reads threads only on rows that are not done.
 *
 * Each case boots a second server on the first one's data and releases every
 * resident doc, which is the state an idle sweep leaves.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { collectLandingWorkspaces } from '../src/shells.ts';

const AGENT = { id: 'agent:harborlight', name: 'Harborlight Lead', kind: 'agent' as const };
const PERSON = { id: 'known-alice', name: 'Alice', kind: 'known' as const, color: '#123456' };

let dataDir: string;
let handle: ServerHandle;
let base: string;
let board: string;
let liveTask: string;
let doneTask: string;
let archivedTask: string;
let retiredTask: string;
let archivedCommentAt: number;

async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(res.ok, `${path} ${res.status} ${await res.clone().text()}`).toBe(true);
  return (await res.json()) as Record<string, unknown>;
}

async function comment(ws: string, taskId: string, text: string): Promise<void> {
  await post(`/workspaces/${ws}/docs/task:${taskId}/threads`, {
    anchor: { kind: 'subject' },
    author: PERSON,
    text,
  });
}

function task(h: ServerHandle, ws: string, title: string): string {
  const res = h.tasks.createTask(ws, {
    title,
    assignee: 'Harborlight Lead',
    assigneeKind: 'agent',
    actor: AGENT,
  });
  if (!res.ok) throw new Error(JSON.stringify(res));
  return res.task.id;
}

const HOUR = 3_600_000;

/** Move every timestamp in a board's task file back by `by`, at rest. */
function backdateRows(ws: string, by: number): void {
  const path = join(dataDir, 'workspaces', `${ws}.tasks.json`);
  const shift = (v: unknown): unknown => {
    if (typeof v === 'number' && v > 1_000_000_000_000) return v - by;
    if (Array.isArray(v)) return v.map(shift);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shift(x)]));
    }
    return v;
  };
  writeFileSync(path, JSON.stringify(shift(JSON.parse(readFileSync(path, 'utf8')))));
}

/** Release the four task bodies, as the idle sweep does after its window. */
function releaseAll(h: ServerHandle): void {
  for (const id of [liveTask, doneTask, archivedTask, retiredTask]) {
    h.docStore.evictDoc(`task:${id}`);
    expect(h.docStore.peek(`task:${id}`)).toBeUndefined();
  }
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'landing-cold-history-'));
  const first = createServer({ port: 0, dataDir });
  base = `http://127.0.0.1:${first.port}`;
  board = first.tasks.createWorkspace('Harborlight').id;
  const retired = first.tasks.createWorkspace('Saltmarsh').id;

  liveTask = task(first, board, 'Draft the Riverbend notes');
  doneTask = task(first, board, 'Ship the Riverbend export');
  archivedTask = task(first, board, 'Retire the old Riverbend feed');
  retiredTask = task(first, retired, 'Close the Saltmarsh board');

  await comment(board, liveTask, 'Which Riverbend source should this read?');
  await comment(board, doneTask, 'Shipped and checked.');
  await comment(retired, retiredTask, 'Nothing left here.');
  first.tasks.transition(doneTask, 'done', { actor: AGENT });
  first.tasks.archiveTask(archivedTask, { actor: AGENT });
  first.tasks.setWorkspaceRetired(retired, true, { actor: AGENT });
  await comment(board, archivedTask, 'Old feed is gone.');
  archivedCommentAt = Math.max(
    ...first.docStore.listThreads(`task:${archivedTask}`).map((t) => t.lastActivity),
  );
  await first.stop();
  // Every row's own update an hour back, so the archived row's comment is the
  // board's newest activity and only a thread reading can find it.
  backdateRows(board, HOUR);

  handle = createServer({ port: 0, dataDir });
  base = `http://127.0.0.1:${handle.port}`;
});

afterAll(async () => {
  await handle.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

const resident = (taskId: string) => handle.docStore.peek(`task:${taskId}`) !== undefined;

describe("Home's cold read", () => {
  it('reads a board’s last activity from the index, loading no task body', () => {
    releaseAll(handle);
    const rows = collectLandingWorkspaces(handle.docStore, handle.tasks);

    // The archived row's comment is the newest thing on the board.
    expect(rows.find((w) => w.id === board)?.lastActivity).toBe(archivedCommentAt);
    for (const id of [liveTask, doneTask, archivedTask, retiredTask]) {
      expect(resident(id)).toBe(false);
    }
  });

  it('loads the live rows the queue shows and leaves history on disk', async () => {
    releaseAll(handle);
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    await res.text();

    // Control: the walk ran, and it read the open row's thread.
    expect(resident(liveTask)).toBe(true);
    expect(resident(doneTask)).toBe(false);
    expect(resident(archivedTask)).toBe(false);
    expect(resident(retiredTask)).toBe(false);
  });
});
