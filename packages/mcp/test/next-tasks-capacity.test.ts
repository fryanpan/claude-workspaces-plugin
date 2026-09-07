/**
 * A short queue must say why it is short.
 *
 * Measured on this board on 2026-09-06: the System cleanup band held five
 * unblocked `todo` rows assigned to the reading agent, and `next_tasks`
 * returned two of them — with `limit: 15`, with `includeBlocked: true`, and
 * with an explicit `assignee`. The row that noticed guessed the cause wrong
 * ("the queue stops handing out rows while I hold claimed ones") because
 * there was nothing in the answer to read.
 *
 * The server was not the problem. `/workspaces/<id>/next` trims the todo rows
 * it offers to the board's free parallelism slots — deliberately, so the
 * queue and the ready-work nudge cannot tell a lead two different things —
 * and it returns `capacity` saying the cap, the slots in use, and how many
 * ready rows it held back. `parallelism-cap.test.ts` covers that end.
 *
 * This tool dropped the field on the floor. So the trim was correct, the
 * explanation was computed, and the only reader that mattered never saw it:
 * a lead reads a two-row queue as a band with nothing ready and stands down
 * with capacity free, which is the exact failure the keep-moving protocol
 * exists to prevent.
 *
 * Driven through the committed bundle, so what is asserted is what a session
 * actually receives. All fixtures are synthetic.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type BundleHarness, type Recorded, startBundle } from './harness/mcp-bundle.ts';

/** The measured case: two rows offered, three ready rows held back. */
const QUEUE = {
  tasks: [
    { id: 't-1', title: 'Offered', status: 'todo', ready: true, blocked: false },
    { id: 't-2', title: 'Also offered', status: 'in-progress', ready: true, blocked: false },
  ],
  capacity: { cap: 2, inUse: 0, free: 2, heldForCapacity: 3 },
};

let mcp: BundleHarness;

beforeAll(async () => {
  mcp = await startBundle((req: Recorded) => (req.path.includes('/next') ? QUEUE : { tasks: [] }));
}, 60_000);
afterAll(async () => {
  await mcp?.stop();
});

describe('next_tasks explains a queue trimmed by the parallelism cap', () => {
  it('POSITIVE CONTROL: the running bundle serves the tool at all', () => {
    expect(mcp.tool('next_tasks')).toBeDefined();
  });

  it('hands the caller the rows the server offered', async () => {
    const res = await mcp.call('next_tasks', { workspaceId: 'w-1' });
    expect(res.isError).toBe(false);
    const out = res.json as { tasks: Array<{ id: string }> };
    expect(out.tasks.map((t) => t.id)).toEqual(['t-1', 't-2']);
  });

  it('carries capacity through, so a short list reads as the cap and not as an empty band', async () => {
    const res = await mcp.call('next_tasks', { workspaceId: 'w-1' });
    const out = res.json as {
      capacity?: { cap: number; inUse: number; free: number; heldForCapacity?: number };
    };
    expect(out.capacity).toEqual({ cap: 2, inUse: 0, free: 2, heldForCapacity: 3 });
  });

  it('says the trim in the tool description, for a reader who never gets a short list', () => {
    // The field only speaks when rows are actually withheld. An agent whose
    // board has never hit its cap learns the rule here or nowhere.
    const description = mcp.tool('next_tasks')?.description ?? '';
    expect(description).toMatch(/capacity/);
    expect(description).toMatch(/parallelism|cap/i);
  });
});
