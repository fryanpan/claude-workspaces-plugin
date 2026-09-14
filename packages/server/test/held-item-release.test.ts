/**
 * A hold its filer never revises does not keep a question from the reader
 * forever: past the release window the item goes to the queue as filed, on
 * the stall tick, and a revision inside the window is still judged again.
 *
 * Written against the measured case (2026-09-14): an urgency question sat
 * held for two days because the agent that filed it had moved on.
 *
 * Wired through a real server because the release is the stall loop's walk
 * over every hold calling the gate's own write — neither half proves the
 * other. The judge is a stub; every fixture is invented.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ReviewJudgeVerdict } from '../src/review-judge.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { FILER, LEAD } from './review-judge-harness.ts';
import { waitFor } from './wait-for.ts';

/** Valid at the door, and exactly what the stub gate holds. */
const BAD = {
  shape: 'decision' as const,
  headline: 'ri-77 cfg?',
  options: [
    { id: 'o-1', label: 'A' },
    { id: 'o-2', label: 'B' },
  ],
};

interface Judged {
  held?: boolean;
  item?: { id: string; judge?: { verdict: string; reason: string } };
}
interface ThreadReply {
  held?: boolean;
  thread: {
    id: string;
    comments: Array<{ id: string; review?: { judge?: { verdict: string; reason: string } } }>;
  };
}
interface QueueRow {
  kind?: string;
  taskId?: string;
  reviewItemId?: string;
  threadId?: string;
}

let handle: ServerHandle | undefined;
let dataDir = '';
let base = '';
let verdict: ReviewJudgeVerdict = { ok: false, reason: 'No stakes.' };
let judgeCalls = 0;

function boot(heldReleaseMs?: number): void {
  dataDir = mkdtempSync(join(tmpdir(), 'held-release-'));
  verdict = { ok: false, reason: 'No stakes.' };
  judgeCalls = 0;
  handle = createServer({
    port: 0,
    dataDir,
    reviewJudge: async () => {
      judgeCalls += 1;
      return verdict;
    },
    keepMovingCadenceMs: 0,
    ...(heldReleaseMs !== undefined ? { heldReleaseMs } : {}),
  });
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
const jj = async <T>(res: Response | Promise<Response>): Promise<T> => {
  const r = await res;
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return (await r.json()) as T;
};

async function board(): Promise<{ workspaceId: string; taskId: string }> {
  const { workspace } = await jj<{ workspace: { id: string } }>(
    post('/workspaces', { name: 'index-rebuild', leadAgentId: LEAD.id }),
  );
  const { task } = await jj<{ task: { id: string } }>(
    post(`/workspaces/${workspace.id}/tasks`, {
      title: 'Rebuild the index nightly',
      body: 'Agent can rebuild the index so that search stays fresh.',
      assignee: FILER.name,
      assigneeKind: 'agent',
      author: FILER,
    }),
  );
  return { workspaceId: workspace.id, taskId: task.id };
}

async function queue(workspaceId: string): Promise<QueueRow[]> {
  const { items } = await jj<{ items: QueueRow[] }>(
    fetch(`${base}/workspaces/${workspaceId}/review-items`),
  );
  return items;
}

async function ticketItem(workspaceId: string, taskId: string, itemId: string) {
  const { tasks } = await jj<{
    tasks: Array<{ id: string; reviews?: Array<NonNullable<Judged['item']>> }>;
  }>(fetch(`${base}/workspaces/${workspaceId}/tasks?format=json`));
  return tasks.find((t) => t.id === taskId)?.reviews?.find((i) => i.id === itemId);
}

describe('a hold nobody revised goes to the reader as filed', () => {
  it('releases a ticket item on the stall tick once the window has passed', async () => {
    boot(0);
    const { workspaceId, taskId } = await board();
    const filed = await jj<Judged>(
      post(`/workspaces/${workspaceId}/tasks/${taskId}/review-items`, {
        author: FILER,
        review: BAD,
      }),
    );
    expect(filed.held).toBe(true);
    const itemId = filed.item?.id ?? '';
    expect((await queue(workspaceId)).some((r) => r.reviewItemId === itemId)).toBe(false);

    await waitFor(
      async () => {
        handle?.nudgeStalls();
        return (await queue(workspaceId)).some((r) => r.reviewItemId === itemId) || undefined;
      },
      { timeout: 10_000, interval: 25, describe: 'the held ticket item on the queue' },
    );
    const released = await ticketItem(workspaceId, taskId, itemId);
    expect(released?.judge?.verdict).toBe('ok');
    expect(released?.judge?.reason).toContain('after an hour unrevised');
    // The standing concern travels with it, so the reader sees why it was held.
    expect(released?.judge?.reason).toContain('No stakes');
  });

  it('releases a comment-borne item the same way', async () => {
    boot(0);
    const { workspaceId, taskId } = await board();
    const filed = await jj<ThreadReply>(
      post(`/workspaces/${workspaceId}/docs/task:${taskId}/threads`, {
        author: FILER,
        anchor: { kind: 'subject' },
        text: 'Which one?',
        review: BAD,
      }),
    );
    expect(filed.held).toBe(true);
    const threadId = filed.thread.id;
    expect((await queue(workspaceId)).some((r) => r.threadId === threadId)).toBe(false);

    await waitFor(
      async () => {
        handle?.nudgeStalls();
        return (await queue(workspaceId)).some((r) => r.threadId === threadId) || undefined;
      },
      { timeout: 10_000, interval: 25, describe: 'the held thread item on the queue' },
    );
  });

  it('the control: inside the default hour a tick releases nothing', async () => {
    boot();
    const { workspaceId, taskId } = await board();
    const filed = await jj<Judged>(
      post(`/workspaces/${workspaceId}/tasks/${taskId}/review-items`, {
        author: FILER,
        review: BAD,
      }),
    );
    const itemId = filed.item?.id ?? '';
    handle?.nudgeStalls();
    handle?.nudgeStalls();
    expect((await queue(workspaceId)).some((r) => r.reviewItemId === itemId)).toBe(false);
    expect((await ticketItem(workspaceId, taskId, itemId))?.judge?.verdict).toBe('held');
  });

  it('a revision inside the hour is judged again, and its verdict is what stands', async () => {
    boot();
    const { workspaceId, taskId } = await board();
    const filed = await jj<Judged>(
      post(`/workspaces/${workspaceId}/tasks/${taskId}/review-items`, {
        author: FILER,
        review: BAD,
      }),
    );
    const itemId = filed.item?.id ?? '';
    const before = judgeCalls;
    verdict = { ok: true, reason: 'The stakes are stated.' };
    const revised = await jj<Judged>(
      post(`/workspaces/${workspaceId}/tasks/${taskId}/review-items/${itemId}/revise`, {
        author: FILER,
        detail: 'Tonight’s rebuild waits on this choice.',
      }),
    );
    expect(judgeCalls).toBe(before + 1);
    expect(revised.held ?? false).toBe(false);
    expect((await ticketItem(workspaceId, taskId, itemId))?.judge?.reason).toBe(
      'The stakes are stated.',
    );
  });
});
