/**
 * Step 4 of the stall-check rebuild (docs/architecture/stall-check/README.md):
 * a hold cannot become a silent ask. A review item the quality gate has held
 * is the FILER's to fix, and the filer is told at the store's short window;
 * one that outlives the quiet window is a finding against the board — named
 * in the lead's stall frame and counted on the verdict's `held` line.
 *
 * Wired through a real server because the two windows live in two modules
 * (`stall-wiring.ts` hands the store's window to the held-item read and the
 * quiet window to the nudger) and the unit suite next door can only prove
 * what the nudger does with a list it was handed.
 *
 * The judge is a stub that holds everything; every fixture is invented.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KeepMovingVerdict } from '../src/keep-moving-verdict.ts';
import type { ReviewJudgeVerdict } from '../src/review-judge.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { REVIEW_ITEM_HELD_EVENT, STALL_EVENT } from '../src/stall-nudge.ts';
import { type Frame, listenFrames, settle, waitForFrames } from './doc-activity-stall-harness.ts';
import { FILER, LEAD, PERSON } from './review-judge-harness.ts';
import { waitFor } from './wait-for.ts';

/**
 * The quiet window: real, so a hold younger than it is a state a test can
 * stand in, and long enough that "the lead was not told yet" is read while
 * the hold is still inside it on a loaded box. The store's held window is 0:
 * the filer is overdue the millisecond after the judge stamps the hold.
 */
const QUIET_MS = 1_000;

/** Valid at the door, and exactly what the gate holds. */
const BAD = {
  shape: 'decision' as const,
  headline: 'ri-77 cfg?',
  options: [
    { id: 'o-1', label: 'A' },
    { id: 'o-2', label: 'B' },
  ],
};

interface HeldReply {
  item: { id: string; judge?: { at: number } };
  held?: boolean;
}
interface ThreadReply {
  thread: { id: string; comments: Array<{ id: string; review?: unknown }> };
  held?: boolean;
}

describe('a held review item past the quiet window is the lead’s finding', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let verdict: ReviewJudgeVerdict;
  const streams: Array<ReturnType<typeof listenFrames>> = [];

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const jj = async <T>(res: Response): Promise<T> => {
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  };

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'held-finding-'));
    verdict = { ok: false, reason: 'No stakes.' };
    handle = createServer({
      port: 0,
      dataDir,
      reviewJudge: async () => verdict,
      heldReviewItemMs: 0,
      stallNudgeQuietMs: QUIET_MS,
      keepMovingCadenceMs: 0,
    });
    base = `http://localhost:${handle.port}`;
  });

  afterEach(async () => {
    for (const s of streams.splice(0)) await s.stop();
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  /** A board with a lead seat and one ticket the filer owns. The ticket stays
   *  in triage, so the ROW is never a finding: whatever the lead is told
   *  about this board, it is told about the hold. */
  async function board(): Promise<{ workspaceId: string; taskId: string }> {
    const { workspace } = await jj<{ workspace: { id: string } }>(
      await post('/workspaces', { name: 'index-rebuild', leadAgentId: LEAD.id }),
    );
    const { task } = await jj<{ task: { id: string } }>(
      await post(`/workspaces/${workspace.id}/tasks`, {
        title: 'Rebuild the index nightly',
        body: 'Agent can rebuild the index so that search stays fresh.',
        assignee: FILER.name,
        assigneeKind: 'agent',
        author: FILER,
      }),
    );
    return { workspaceId: workspace.id, taskId: task.id };
  }

  async function agentStream(workspaceId: string, agent: { id: string }) {
    await jj(
      await post(`/workspaces/${workspaceId}/agents`, {
        agentId: agent.id,
        runtime: 'claude-code-local',
      }),
    );
    const res = await fetch(
      `${base}/workspaces/${workspaceId}/events:stream?agentId=${encodeURIComponent(agent.id)}`,
      { headers: { accept: 'text/event-stream' } },
    );
    const stream = listenFrames(res);
    streams.push(stream);
    return stream;
  }

  const stallFrames = (frames: Frame[]) => frames.filter((f) => f.event === STALL_EVENT);
  const heldItemsOf = (frame: Frame | undefined) =>
    (frame?.data?.heldItems ?? []) as Array<Record<string, unknown>>;

  /** Ticks the monitor until the lead holds a stall frame naming the item. */
  const leadToldOf = (lead: Frame[], reviewItemId: string) =>
    waitFor(
      () => {
        handle.nudgeStalls();
        return stallFrames(lead).find((f) =>
          heldItemsOf(f).some((h) => h.reviewItemId === reviewItemId),
        );
      },
      { timeout: 10_000, interval: 25, describe: `a stall frame naming ${reviewItemId}` },
    );

  const latestVerdict = async (workspaceId: string) =>
    jj<{ latest: KeepMovingVerdict | null }>(
      await fetch(`${base}/workspaces/${workspaceId}/keep-moving`),
    );

  it('the filer is told at once; the lead only once the hold outlives the window, then once', async () => {
    const { workspaceId, taskId } = await board();
    const lead = await agentStream(workspaceId, LEAD);
    const filer = await agentStream(workspaceId, FILER);
    const res = await jj<HeldReply>(
      await post(`/workspaces/${workspaceId}/tasks/${taskId}/review-items`, {
        review: BAD,
        author: FILER,
      }),
    );
    expect(res.held).toBe(true);
    // The create-time wake, then the overdue nudge — polled, because the
    // store's window is strictly greater-than and the first pass can land in
    // the millisecond the judge stamped.
    await waitForFrames(filer.frames, REVIEW_ITEM_HELD_EVENT, 1);
    await waitFor(
      () => {
        handle.nudgeStalls();
        return filer.frames.filter((f) => f.event === REVIEW_ITEM_HELD_EVENT).length >= 2;
      },
      { timeout: 5_000, interval: 25, describe: 'the filer’s overdue nudge' },
    );
    // The filer has been told twice and the hold is seconds old: nothing for
    // the lead yet. This is the line step 4 moved — the same pass used to
    // hand the lead the hold at the filer's window.
    expect(stallFrames(lead.frames)).toEqual([]);
    const { latest: young } = await latestVerdict(workspaceId);
    expect(young?.held).toEqual([]);

    const told = await leadToldOf(lead.frames, res.item.id);
    expect(told?.data).toMatchObject({ workspaceId, taskId, stalledCount: 0 });
    expect(heldItemsOf(told)).toHaveLength(1);
    expect(heldItemsOf(told)[0]).toMatchObject({
      id: taskId,
      reviewItemId: res.item.id,
      reason: 'No stakes.',
      filedBy: FILER.name,
    });
    // The lead's turn is not a third tap on the filer.
    expect(filer.frames.filter((f) => f.event === REVIEW_ITEM_HELD_EVENT)).toHaveLength(2);
    // …and it is a line in the measurement, the same item under the same window.
    const { latest } = await latestVerdict(workspaceId);
    expect(latest?.verdict).toBe('FAIL');
    expect(latest?.held).toEqual([res.item.id]);
    expect(latest?.stalled).toEqual([]);

    // Once: a further pass over the same hold says nothing more.
    handle.nudgeStalls();
    await settle(100);
    expect(stallFrames(lead.frames)).toHaveLength(1);
  }, 20_000);

  it('a hold revised away inside the window never reaches the lead', async () => {
    const { workspaceId, taskId } = await board();
    const lead = await agentStream(workspaceId, LEAD);
    const filer = await agentStream(workspaceId, FILER);
    const res = await jj<HeldReply>(
      await post(`/workspaces/${workspaceId}/tasks/${taskId}/review-items`, {
        review: BAD,
        author: FILER,
      }),
    );
    await waitForFrames(filer.frames, REVIEW_ITEM_HELD_EVENT, 1);
    verdict = { ok: true, reason: 'Clear.' };
    await jj(
      await post(`/workspaces/${workspaceId}/tasks/${taskId}/review-items/${res.item.id}/revise`, {
        detail: 'Stakes: the nightly window.',
        author: FILER,
      }),
    );
    // Past the window the hold WOULD have been the lead's — the control for
    // the test above: the frame there was the hold's doing, not the board's.
    const heldAt = res.item.judge?.at as number;
    expect(heldAt).toBeGreaterThan(0);
    await waitFor(() => Date.now() > heldAt + QUIET_MS, {
      timeout: 5_000,
      interval: 25,
      describe: 'the quiet window to pass',
    });
    handle.nudgeStalls();
    await settle(100);
    expect(stallFrames(lead.frames)).toEqual([]);
    const { latest } = await latestVerdict(workspaceId);
    expect(latest?.verdict).toBe('PASS');
    expect(latest?.held).toEqual([]);
  }, 20_000);

  it('a comment-borne hold reaches the lead with the doc-form address on it', async () => {
    const { workspaceId, taskId } = await board();
    const lead = await agentStream(workspaceId, LEAD);
    await agentStream(workspaceId, FILER);
    const weak = await jj<ThreadReply>(
      await post(`/workspaces/${workspaceId}/docs/task:${taskId}/threads`, {
        author: FILER,
        anchor: { kind: 'subject' },
        text: 'Jordan — which one?',
        review: BAD,
      }),
    );
    expect(weak.held).toBe(true);
    const commentId = weak.thread.comments.find((c) => c.review)?.id ?? weak.thread.comments[0]?.id;
    const told = await waitFor(
      () => {
        handle.nudgeStalls();
        return stallFrames(lead.frames).find((f) =>
          heldItemsOf(f).some((h) => h.threadId === weak.thread.id),
        );
      },
      { timeout: 10_000, interval: 25, describe: 'a stall frame naming the thread' },
    );
    expect(heldItemsOf(told)[0]).toMatchObject({
      docId: `task:${taskId}`,
      threadId: weak.thread.id,
      commentId,
      revise: `revise_review_item(docId="task:${taskId}", threadId="${weak.thread.id}", commentId="${commentId}")`,
      reason: 'No stakes.',
    });
  }, 20_000);

  it('a ticket that IS the ask reaches the lead with the ticket address on it', async () => {
    const { workspaceId } = await board();
    const lead = await agentStream(workspaceId, LEAD);
    await agentStream(workspaceId, FILER);
    verdict = { ok: false, reason: 'The headline is a ticket id, not a decision.' };
    // The batch door — what `create_tasks(needs: 'decision')` calls. A
    // decision-shaped body, because the shape gate at that door is a
    // different gate from the judge.
    const { tasks } = await jj<{ tasks: Array<{ id: string }> }>(
      await post(`/workspaces/${workspaceId}/tasks/batch`, {
        author: FILER,
        tasks: [
          {
            title: 'ri-77 cfg?',
            body: 'Which cache size should the nightly rebuild use? At stake: a full pass reads the index once, and halving the cache makes it read twice and adds an hour. Blocked until answered: the rollout.',
            needs: 'decision',
            assignee: PERSON.name,
            options: [{ label: 'Keep it' }, { label: 'Halve it' }],
          },
        ],
      }),
    );
    const taskId = tasks[0]?.id ?? '';
    const told = await leadToldOf(lead.frames, 'r-legacy');
    expect(heldItemsOf(told)[0]).toMatchObject({
      id: taskId,
      revise: `revise_review_item(taskId="${taskId}")`,
      reason: 'The headline is a ticket id, not a decision.',
    });
    expect(heldItemsOf(told)[0]?.docId).toBeUndefined();
  }, 20_000);
});
