/**
 * What a hold may SAY, and what a card says about how an item got through —
 * driven end to end through the real filing and revising routes.
 *
 * Three defects, reported by the owner on 2026-09-14 after reading four held
 * items across five boards:
 *
 *  1. the gate proposed replacement sentences carrying specifics the item's
 *     source does not support, because it cannot see that source;
 *  2. the last-hold rule admitted items in silence, so a filer read a 200 and
 *     saw a pass;
 *  3. the reader could not tell a first-time item from one that took three
 *     rounds, or a judged one from an admitted one.
 *
 * The bound itself is unit-tested in `packages/core/src/review-hold.test.ts`
 * and the wording in `review-hold-message.test.ts`. What is only provable
 * here is that a real filing reaches a real filer with those bounds applied,
 * and that the facts survive a later revision.
 *
 * The judge is a stub throughout; all fixtures are invented, because the repo
 * is public.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  REVIEW_HOLD_UNUSABLE_REASON,
  hasNumberNotIn,
  judgedText,
  numberTokens,
} from '@claude-workspaces/core/review-hold';
import {
  COSTS_IN_OPTIONS,
  FILER,
  type Held,
  type JudgeHarness,
  contradictoryJudge,
  inventingJudge,
  startJudgeHarness,
} from './review-judge-harness.ts';

/** Every word the judge was shown — the only figures a hold about this item
 *  is allowed to repeat. */
const ITEM_WORDS = judgedText(COSTS_IN_OPTIONS);

/**
 * The hold's message with the paste-ready revise call taken out.
 *
 * That call carries the board's own generated ids, and `t-4xK…` has digits
 * in it. They are not figures the gate invented — they are the address the
 * filer types back — so counting them would make every hold fail a check
 * about specifics the item does not support.
 */
function wordsOfHold(message: string): string {
  return message.replace(/revise_review_item\([^)]*\)/g, 'revise_review_item(…)');
}

describe('a hold stays inside the item it is about', () => {
  let h: JudgeHarness;
  const jj = <T>(res: Response | Promise<Response>) => h.jj<T>(res);
  const post = (path: string, body?: unknown) => h.post(path, body);

  beforeEach(() => {
    h = startJudgeHarness();
  });
  afterEach(async () => {
    await h.stop();
  });

  it('carries no figure the item does not state, and no quote it does not contain', async () => {
    const { workspaceId, taskId } = await board(h);
    h.judge = inventingJudge;
    const out = await jj<Held>(
      await post(`/workspaces/${workspaceId}/tasks/${taskId}/review-items`, {
        author: FILER,
        review: COSTS_IN_OPTIONS,
      }),
    );
    expect(out.held).toBe(true);
    const message = out.message ?? '';
    // The item states 02:00, 2GB and 1GB. "45" is the judge's own invention,
    // and the whole sentence carrying it is dropped rather than patched.
    expect(hasNumberNotIn(wordsOfHold(message), ITEM_WORDS)).toBe(false);
    expect(numberTokens(wordsOfHold(message))).not.toContain('45');
    // The quote named words the item never says, so the filer is not sent
    // looking for them.
    expect(message).not.toContain('release train');
    expect(out.item?.judge?.quote).toBeUndefined();
  });

  it('proposes no replacement text, and points the filer at the source instead', async () => {
    const { workspaceId, taskId } = await board(h);
    h.judge = contradictoryJudge();
    const out = await jj<Held>(
      await post(`/workspaces/${workspaceId}/tasks/${taskId}/review-items`, {
        author: FILER,
        review: COSTS_IN_OPTIONS,
      }),
    );
    const message = out.message ?? '';
    expect(message).toContain('Re-read the source');
    // Every figure in the message is one the item already carried — the
    // mechanical form of "the gate drafts nothing".
    expect(hasNumberNotIn(wordsOfHold(message), ITEM_WORDS)).toBe(false);
  });
});

describe('an item admitted without a passing verdict', () => {
  let h: JudgeHarness;
  const jj = <T>(res: Response | Promise<Response>) => h.jj<T>(res);
  const post = (path: string, body?: unknown) => h.post(path, body);

  beforeEach(() => {
    h = startJudgeHarness();
  });
  afterEach(async () => {
    await h.stop();
  });

  it('tells the filer it went to the reader unjudged, and marks the row', async () => {
    const { workspaceId, taskId } = await board(h);
    h.judge = contradictoryJudge();
    const filed = await jj<Held>(
      await post(`/workspaces/${workspaceId}/tasks/${taskId}/review-items`, {
        author: FILER,
        review: COSTS_IN_OPTIONS,
      }),
    );
    const itemId = filed.item?.id as string;
    await jj(
      await post(`/workspaces/${workspaceId}/tasks/${taskId}/review-items/${itemId}/revise`, {
        author: FILER,
        detail: 'A second blurb, written after the first hold.',
      }),
    );
    const admitted = await jj<Held>(
      await post(`/workspaces/${workspaceId}/tasks/${taskId}/review-items/${itemId}/revise`, {
        author: FILER,
        detail: 'A third blurb, written after the second hold.',
      }),
    );
    expect(admitted.held ?? false).toBe(false);
    // The rule used to fire in silence. This is the whole of defect 2.
    expect(admitted.message ?? '').toContain('UNJUDGED');
    expect(admitted.item?.judge?.admitted).toBe('holds');
    expect(admitted.item?.judge?.heldFor).toHaveLength(2);

    // …and both facts survive a later revision, which is what the card reads.
    const later = await jj<Held>(
      await post(`/workspaces/${workspaceId}/tasks/${taskId}/review-items/${itemId}/revise`, {
        author: FILER,
        detail: 'A fourth blurb, written after the item was admitted.',
      }),
    );
    expect(later.item?.judge?.admitted).toBe('holds');
    expect(later.item?.judge?.heldFor).toHaveLength(2);
  });

  it('reaches the reader marked, rather than being skipped as held', async () => {
    const { workspaceId, taskId } = await board(h);
    h.judge = contradictoryJudge();
    const filed = await jj<Held>(
      await post(`/workspaces/${workspaceId}/tasks/${taskId}/review-items`, {
        author: FILER,
        review: COSTS_IN_OPTIONS,
      }),
    );
    const itemId = filed.item?.id as string;
    for (const detail of ['A second blurb.', 'A third blurb.']) {
      await jj(
        await post(`/workspaces/${workspaceId}/tasks/${taskId}/review-items/${itemId}/revise`, {
          author: FILER,
          detail,
        }),
      );
    }
    const queue = await jj<{ items: Array<{ reviewItemId?: string; gate?: unknown }> }>(
      await fetch(`${h.base}/workspaces/${workspaceId}/review-items`),
    );
    const row = queue.items.find((i) => i.reviewItemId === itemId);
    expect(row?.gate).toEqual({ holds: 2, admitted: 'holds' });
  });
});

describe('the filer answers that the source is less specific than the hold asked for', () => {
  let h: JudgeHarness;
  const jj = <T>(res: Response | Promise<Response>) => h.jj<T>(res);
  const post = (path: string, body?: unknown) => h.post(path, body);

  beforeEach(() => {
    h = startJudgeHarness();
  });
  afterEach(async () => {
    await h.stop();
  });

  const NOTE = 'The log gives a range across five runs, not a single figure.';
  const GAP = 'The detail never says what it costs to wait.';
  /** A judge making the SAME demand every round — the loop the note answers. */
  const repeating = async () => ({ ok: false as const, reason: GAP });

  it('ends the hold, carries the note to the reader, and is not asked again', async () => {
    const { workspaceId, taskId } = await board(h);
    h.judge = repeating;
    const filed = await jj<Held>(
      await post(`/workspaces/${workspaceId}/tasks/${taskId}/review-items`, {
        author: FILER,
        review: COSTS_IN_OPTIONS,
      }),
    );
    const itemId = filed.item?.id as string;
    expect(filed.held).toBe(true);
    // The escape hatch is named in the hold, or nobody finds it.
    expect(filed.message ?? '').toContain('lessSpecific');

    const answered = await jj<Held>(
      await post(`/workspaces/${workspaceId}/tasks/${taskId}/review-items/${itemId}/revise`, {
        author: FILER,
        detail: 'A second blurb, as specific as the log allows.',
        lessSpecific: NOTE,
      }),
    );
    expect(answered.held ?? false).toBe(false);
    expect(answered.item?.judge?.admitted).toBe('less-specific');
    expect(answered.item?.judge?.lessSpecific).toBe(NOTE);

    // The reader gets the filer's own words on the card.
    const queue = await jj<{ items: Array<{ reviewItemId?: string; gate?: unknown }> }>(
      await fetch(`${h.base}/workspaces/${workspaceId}/review-items`),
    );
    expect(queue.items.find((i) => i.reviewItemId === itemId)?.gate).toEqual({
      holds: 1,
      admitted: 'less-specific',
      lessSpecific: NOTE,
    });

    // And THAT gap is not raised again: the judge repeats its demand on the
    // next revision and the item goes through, still carrying the note.
    const later = await jj<Held>(
      await post(`/workspaces/${workspaceId}/tasks/${taskId}/review-items/${itemId}/revise`, {
        author: FILER,
        detail: 'A third blurb, tightened after the note.',
      }),
    );
    expect(later.held ?? false).toBe(false);
    expect(later.item?.judge?.admitted).toBe('less-specific');
    expect(later.item?.judge?.lessSpecific).toBe(NOTE);
  });

  it('judges the words the note arrives with, rather than admitting them', async () => {
    const { workspaceId, taskId } = await board(h);
    h.judge = repeating;
    const filed = await jj<Held>(
      await post(`/workspaces/${workspaceId}/tasks/${taskId}/review-items`, {
        author: FILER,
        review: COSTS_IN_OPTIONS,
      }),
    );
    const itemId = filed.item?.id as string;
    // The same request answers the standing hold AND replaces the words. The
    // note must not buy those new words a pass: a revision carrying it is
    // still judged, and a fresh defect in it is still a hold (codex review).
    const before = h.calls.length;
    h.judge = async () => ({ ok: false as const, reason: 'The links go nowhere.' });
    const out = await jj<Held>(
      await post(`/workspaces/${workspaceId}/tasks/${taskId}/review-items/${itemId}/revise`, {
        author: FILER,
        detail: 'A second blurb, rewritten wholesale, with a dead link in it.',
        lessSpecific: NOTE,
      }),
    );
    expect(h.calls.length).toBe(before + 1);
    expect(out.held).toBe(true);
    expect(out.heldReason).toContain('links go nowhere');
    // The note is on the record even though it did not end this hold.
    expect(out.item?.judge?.lessSpecific).toBe(NOTE);
  });

  it('still holds the item for a DIFFERENT gap — the exemption is not a bypass', async () => {
    const { workspaceId, taskId } = await board(h);
    h.judge = repeating;
    const filed = await jj<Held>(
      await post(`/workspaces/${workspaceId}/tasks/${taskId}/review-items`, {
        author: FILER,
        review: COSTS_IN_OPTIONS,
      }),
    );
    const itemId = filed.item?.id as string;
    await jj(
      await post(`/workspaces/${workspaceId}/tasks/${taskId}/review-items/${itemId}/revise`, {
        author: FILER,
        detail: 'A second blurb, as specific as the log allows.',
        lessSpecific: NOTE,
      }),
    );
    // A new round, a genuinely different defect. One answered gap does not
    // buy the item a pass on everything that follows.
    h.judge = async () => ({ ok: false as const, reason: 'The links go nowhere.' });
    const held = await jj<Held>(
      await post(`/workspaces/${workspaceId}/tasks/${taskId}/review-items/${itemId}/revise`, {
        author: FILER,
        detail: 'A third blurb, with a link in it.',
      }),
    );
    expect(held.held).toBe(true);
    expect(held.heldReason).toContain('links go nowhere');
    // …and the filer's note is still on the record.
    expect(held.item?.judge?.lessSpecific).toBe(NOTE);
  });

  it('recognises a repeated gap even when the gate had to replace its words', async () => {
    const { workspaceId, taskId } = await board(h);
    // The judge's diagnosis carries a figure the item never states, so what is
    // STORED is the gate's own replacement sentence. A later round repeating
    // that same diagnosis has to be recognised as the same gap, or the escape
    // hatch silently does nothing (codex review).
    h.judge = inventingJudge;
    const filed = await jj<Held>(
      await post(`/workspaces/${workspaceId}/tasks/${taskId}/review-items`, {
        author: FILER,
        review: COSTS_IN_OPTIONS,
      }),
    );
    const itemId = filed.item?.id as string;
    expect(filed.held).toBe(true);
    expect(filed.item?.judge?.reason).toBe(REVIEW_HOLD_UNUSABLE_REASON);
    const out = await jj<Held>(
      await post(`/workspaces/${workspaceId}/tasks/${taskId}/review-items/${itemId}/revise`, {
        author: FILER,
        detail: 'A second blurb, as specific as the log allows.',
        lessSpecific: NOTE,
      }),
    );
    expect(out.held ?? false).toBe(false);
    expect(out.item?.judge?.admitted).toBe('less-specific');
  });

  it('does not let one bounded gap stand in for every other bounded gap', async () => {
    const { workspaceId, taskId } = await board(h);
    // Both diagnoses below carry a figure the item never states, so BOTH are
    // stored as the gate's one replacement sentence. If the answered gap were
    // identified by that stored text, answering the first would admit the
    // second — a different defect entirely — with nobody having looked (codex
    // review).
    h.judge = inventingJudge;
    const filed = await jj<Held>(
      await post(`/workspaces/${workspaceId}/tasks/${taskId}/review-items`, {
        author: FILER,
        review: COSTS_IN_OPTIONS,
      }),
    );
    const itemId = filed.item?.id as string;
    await jj(
      await post(`/workspaces/${workspaceId}/tasks/${taskId}/review-items/${itemId}/revise`, {
        author: FILER,
        detail: 'A second blurb, as specific as the log allows.',
        lessSpecific: NOTE,
      }),
    );
    h.judge = async () => ({ ok: false as const, reason: 'The first link answers 404.' });
    const held = await jj<Held>(
      await post(`/workspaces/${workspaceId}/tasks/${taskId}/review-items/${itemId}/revise`, {
        author: FILER,
        detail: 'A third blurb, with a link in it.',
      }),
    );
    expect(held.held).toBe(true);
    // Stored as the replacement sentence, exactly like the first hold — which
    // is the point: two holds that READ the same are still two gaps.
    expect(held.item?.judge?.reason).toBe(REVIEW_HOLD_UNUSABLE_REASON);
  });

  it('is refused as a body field that is not a string', async () => {
    const { workspaceId, taskId } = await board(h);
    h.judge = contradictoryJudge();
    const filed = await jj<Held>(
      await post(`/workspaces/${workspaceId}/tasks/${taskId}/review-items`, {
        author: FILER,
        review: COSTS_IN_OPTIONS,
      }),
    );
    const itemId = filed.item?.id as string;
    const res = await post(
      `/workspaces/${workspaceId}/tasks/${taskId}/review-items/${itemId}/revise`,
      { author: FILER, detail: 'A second blurb.', lessSpecific: 42 },
    );
    expect(res.status).toBe(400);
  });

  it('does not let an UNHELD item skip the judge', async () => {
    const { workspaceId, taskId } = await board(h);
    const before = h.calls.length;
    const filed = await jj<Held>(
      await post(`/workspaces/${workspaceId}/tasks/${taskId}/review-items`, {
        author: FILER,
        review: COSTS_IN_OPTIONS,
        lessSpecific: NOTE,
      }),
    );
    // Nothing was holding, so there was nothing to answer: the item was
    // judged like any other and carries no admission.
    expect(h.calls.length).toBe(before + 1);
    expect(filed.item?.judge?.admitted).toBeUndefined();
  });
});

/** The harness's board, named here so each block above reads as one call. */
function board(h: JudgeHarness) {
  return h.board();
}
