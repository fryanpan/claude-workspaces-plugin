/**
 * A builder who is working owes no check-in.
 *
 * The check-in finding names a row somebody holds and has stopped narrating.
 * It reads one clock — the row's silence — and the whole point of the stall
 * loop's second pass is that the board's own timestamps are not the only
 * evidence of somebody working: a builder's churn in a checkout the board
 * cannot see counts too, and arrives merged into the same seam. This file
 * pins that the check-in reads that merged clock rather than the raw one.
 *
 * The pair is the point. `a silent holder owes a check-in` is the positive
 * control — same board, same window, same dispatch, watcher never fires,
 * frame observed — so the exoneration below cannot pass vacuously by the
 * harness being unable to fire at all.
 *
 * The watcher is the injected fake, for the reason `dispatch-routes.test.ts`
 * gives: a real recursive watch drops events by design on Linux, and what is
 * under test here is the wiring, not the watcher.
 *
 * All fixtures are synthetic — invented names in the jordan@partner.example
 * register. The repo is public.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { CHECK_IN_BUCKET } from '../src/stall-gate.ts';
import { STALL_EVENT } from '../src/stall-nudge.ts';
import {
  type Frame,
  LEAD,
  PERSON,
  listenFrames,
  settle,
  waitForFrames,
} from './doc-activity-stall-harness.ts';
import { seedBoard } from './workspace-seed.ts';

/** A holder must out-quiet this before the lead is reminded to ask. */
const CHECK_IN_MS = 250;
/** Far above it, so no row in this file ever reads as stalled — the finding
 *  under test is only produced for a row the stall lists did NOT name. */
const QUIET_MS = 30_000;

describe('a holder whose worktree is moving owes no check-in', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  /** The fake watcher's handles, keyed by watched path. */
  let fired: Map<string, () => void>;

  const post = (path: string, body: unknown): Promise<Response> =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const jj = async <T>(res: Response): Promise<T> => {
    expect(res.ok, `${res.status} ${await res.clone().text()}`).toBe(true);
    return res.json() as Promise<T>;
  };

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'check-in-'));
    fired = new Map();
    handle = createServer({
      port: 0,
      dataDir,
      stallNudgeQuietMs: QUIET_MS,
      checkInMs: CHECK_IN_MS,
      dispatchWatchFactory: (path, onEvent) => {
        fired.set(path, onEvent);
        return { close: () => fired.delete(path) };
      },
    });
    base = `http://127.0.0.1:${handle.port}`;
    await seedBoard(base);
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function boardWithLead(): Promise<{
    workspaceId: string;
    lead: ReturnType<typeof listenFrames>;
  }> {
    const { workspace } = await jj<{ workspace: { id: string } }>(
      await post('/workspaces', { name: 'search-revamp', leadAgentId: LEAD.id }),
    );
    await jj(
      await post(`/workspaces/${workspace.id}/agents`, {
        agentId: LEAD.id,
        runtime: 'claude-code-local',
      }),
    );
    const leadRes = await fetch(
      `${base}/workspaces/${workspace.id}/events:stream?agentId=${encodeURIComponent(LEAD.id)}`,
      { headers: { accept: 'text/event-stream' } },
    );
    return { workspaceId: workspace.id, lead: listenFrames(leadRes) };
  }

  async function heldRow(workspaceId: string, title: string, worktree: string): Promise<string> {
    const { task } = await jj<{ task: { id: string } }>(
      await post(`/workspaces/${workspaceId}/tasks`, {
        title,
        body: `Agent can ${title.toLowerCase()} so that the queue keeps moving.`,
        assignee: LEAD.name,
        assigneeKind: 'agent',
        author: LEAD,
      }),
    );
    await jj(
      await post(`/workspaces/${workspaceId}/tasks/${task.id}/transition`, {
        to: 'todo',
        author: PERSON,
        workspaceId,
      }),
    );
    await jj(
      await post(`/workspaces/${workspaceId}/tasks/${task.id}/transition`, {
        to: 'in-progress',
        author: LEAD,
        workspaceId,
      }),
    );
    await jj(
      await post(`/workspaces/${workspaceId}/dispatches`, {
        taskId: task.id,
        worktreePath: worktree,
      }),
    );
    return task.id;
  }

  const stalls = (frames: Frame[]): Frame[] => frames.filter((f) => f.event === STALL_EVENT);

  it('a silent holder owes a check-in', async () => {
    const worktree = mkdtempSync(join(tmpdir(), 'wt-'));
    try {
      const ctx = await boardWithLead();
      const taskId = await heldRow(ctx.workspaceId, 'Rank results by recency', worktree);
      // Nobody touches the worktree. The row must out-quiet the window and be
      // named — this change removes false reminders, it does not make the
      // reminder unable to fire.
      await settle(CHECK_IN_MS + 150);

      handle.nudgeStalls();
      const got = await waitForFrames(ctx.lead.frames, STALL_EVENT, 1);
      expect(got).toHaveLength(1);
      const owed = (got[0]?.data?.checkIn ?? []) as Array<{ id: string; bucket: string }>;
      expect(owed.map((r) => r.id)).toEqual([taskId]);
      expect(owed[0]?.bucket).toBe(CHECK_IN_BUCKET);
      // And the row is NOT in the stall list: the lead is being asked to tap
      // its holder, not to find somebody to claim it.
      expect(got[0]?.data?.rows).toBeUndefined();
      await ctx.lead.stop();
    } finally {
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  it('a worktree that just moved keeps its holder out of the reminder', async () => {
    const worktree = mkdtempSync(join(tmpdir(), 'wt-'));
    try {
      const ctx = await boardWithLead();
      await heldRow(ctx.workspaceId, 'Rank results by recency', worktree);
      // Out-quiet the window first, so the row is one the first pass names and
      // only the worktree churn can save — the same ordering the linked-doc
      // suite uses, and the shape the worktree witness exists for.
      await settle(CHECK_IN_MS + 150);
      const ring = fired.get(worktree);
      expect(ring, 'the fake watcher should have armed on this worktree').toBeTruthy();
      ring?.();

      handle.nudgeStalls();
      // The control above is what proves this harness fires on this board with
      // this window; here the same wait must produce nothing.
      await settle(300);
      expect(stalls(ctx.lead.frames)).toHaveLength(0);
      await ctx.lead.stop();
    } finally {
      rmSync(worktree, { recursive: true, force: true });
    }
  });
});
