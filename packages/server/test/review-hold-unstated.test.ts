/**
 * The hold the gate cannot put in words — `REVIEW_HOLD_UNUSABLE_REASON` —
 * driven through the real filing and revising routes.
 *
 * Reported 2026-11-04: one item was held six times for that reason, each
 * round naming a different sentence; another was held a second time naming
 * no sentence at all, with the last-hold notice; and answering it with
 * `lessSpecific` did not clear it. Its reason is one fixed sentence, so the
 * quote is all the filer is told, and a hold with a moving or missing quote
 * is one nobody can fix.
 *
 * The judge is a stub throughout; the real model is never called. Fixtures
 * are invented, because the repo is public.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { REVIEW_HOLD_UNUSABLE_REASON } from '@claude-workspaces/core/review-hold';
import type { ReviewJudge } from '../src/review-judge.ts';
import {
  FILER,
  type Held,
  type JudgeHarness,
  inventingJudge,
  startJudgeHarness,
} from './review-judge-harness.ts';

const FIRST = 'The rebuild runs at 02:00 and has to finish before the morning sync.';
const SECOND = 'The rebuild now starts after the backup and ends before people log in.';

const ITEM = {
  shape: 'decision' as const,
  headline: 'Which cache size for the nightly rebuild',
  detail: FIRST,
  options: [
    { id: 'o-1', label: 'Keep it', detail: 'costs 2GB of disk and no extra time' },
    { id: 'o-2', label: 'Halve it', detail: 'frees 1GB but adds an hour to every night' },
  ],
};

/**
 * A judge whose every diagnosis carries a figure the item never states — so
 * the gate replaces it — and quotes whichever sentence of the item's detail
 * it is handed. A different raw sentence each round, like the live judge.
 */
function quotingInventor(): ReviewJudge {
  let n = 0;
  return async (input) => ({
    ok: false,
    reason: `Round ${90 + n++}: the detail understates what waits by 45 minutes.`,
    quote: input.item.detail ?? '',
  });
}

describe('a hold the gate could not put in words', () => {
  let h: JudgeHarness;
  const post = (path: string, body?: unknown) => h.post(path, body);
  const file = async (ws: string, task: string) =>
    h.jj<Held>(
      await post(`/workspaces/${ws}/tasks/${task}/review-items`, { author: FILER, review: ITEM }),
    );
  const revise = async (ws: string, task: string, id: string, body: Record<string, unknown>) =>
    h.jj<Held>(
      await post(`/workspaces/${ws}/tasks/${task}/review-items/${id}/revise`, {
        author: FILER,
        ...body,
      }),
    );

  beforeEach(() => {
    h = startJudgeHarness();
  });
  afterEach(async () => {
    await h.stop();
  });

  it('is not raised again once the sentence it named is fixed', async () => {
    const { workspaceId, taskId } = await h.board();
    h.judge = quotingInventor();
    const filed = await file(workspaceId, taskId);
    expect(filed.held).toBe(true);
    expect(filed.item?.judge?.reason).toBe(REVIEW_HOLD_UNUSABLE_REASON);
    expect(filed.item?.judge?.quote).toBe(FIRST);

    // The filer rewrites the sentence it named. The judge comes back with the
    // same unstateable concern, now quoting the new sentence.
    const out = await revise(workspaceId, taskId, filed.item?.id as string, { detail: SECOND });
    expect(out.held ?? false).toBe(false);
    expect(out.item?.judge?.verdict).toBe('ok');
    expect(out.message ?? '').not.toContain('last hold');
  });

  it('is raised again on the SAME sentence while that sentence is still there', async () => {
    // The control for the test above: a revision that leaves the named
    // sentence in place has not fixed it, and is held naming it again rather
    // than a new one.
    const { workspaceId, taskId } = await h.board();
    h.judge = quotingInventor();
    const filed = await file(workspaceId, taskId);
    const out = await revise(workspaceId, taskId, filed.item?.id as string, {
      detail: `${FIRST} Nothing else changed.`,
    });
    expect(out.held).toBe(true);
    expect(out.item?.judge?.quote).toBe(FIRST);
  });

  it('is cleared by lessSpecific', async () => {
    const { workspaceId, taskId } = await h.board();
    h.judge = quotingInventor();
    const filed = await file(workspaceId, taskId);
    const out = await revise(workspaceId, taskId, filed.item?.id as string, {
      detail: `${FIRST} Nothing else changed.`,
      lessSpecific: 'The log gives no duration for the wait, only that one happens.',
    });
    expect(out.held ?? false).toBe(false);
    expect(out.item?.judge?.admitted).toBe('less-specific');
  });

  it('is not issued when it names no sentence of the item', async () => {
    const { workspaceId, taskId } = await h.board();
    // Invents a figure AND quotes words the item does not contain, so the
    // gate keeps neither: nothing is left to tell the filer.
    h.judge = inventingJudge;
    const filed = await file(workspaceId, taskId);
    expect(filed.held ?? false).toBe(false);
    expect(filed.item?.judge?.verdict).toBe('ok');
    expect(filed.message ?? '').not.toContain('last hold');
  });

  it('does not stop a stateable hold from being raised', async () => {
    // The control for the rule above: a hold whose words the gate CAN show
    // is still a hold with no quote at all.
    const { workspaceId, taskId } = await h.board();
    h.judge = async () => ({ ok: false, reason: 'No option says what waits on the answer.' });
    const filed = await file(workspaceId, taskId);
    expect(filed.held).toBe(true);
    expect(filed.heldReason).toContain('No option says what waits');
  });
});
