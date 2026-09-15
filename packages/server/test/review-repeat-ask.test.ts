/**
 * The gate can see what the reader has already been asked ON THIS ROW,
 * whichever of the two channels asked it.
 *
 * Written against the measured failure: on 2026-09-06 a question was filed on
 * a ticket, answered "Archive them" fifteen minutes later, filed again two
 * hours after that as a review payload on a comment in the ticket's own body
 * doc, and answered a second time with "didn't I already make this
 * decision?". Neither store could see the other's items, so the judge passed
 * the repeat.
 *
 * The judge stub here reads the PROMPT the real builder produces, not the
 * input object, so anything between the filing route and the model that drops
 * the history turns these into failures. All fixtures are invented.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { buildReviewJudgePrompt } from '@claude-workspaces/core/review-judge-prompt';
import {
  FILER,
  type Held,
  type JudgeHarness,
  PERSON,
  startJudgeHarness,
} from './review-judge-harness.ts';

let h: JudgeHarness;
const post = (...a: Parameters<JudgeHarness['post']>) => h.post(...a);
const jj = <T>(r: Response | Promise<Response>) => h.jj<T>(r);

/** Passes everything, and records what the prompt said about prior asks. */
const seenAsks: string[] = [];
function recordingJudge(): JudgeHarness['judge'] {
  return async (input) => {
    const { user } = buildReviewJudgePrompt(input.criteria, input.item);
    const start = user.indexOf('<prior-asks>');
    seenAsks.push(start < 0 ? '' : user.slice(start, user.indexOf('</prior-asks>')));
    return { ok: true, reason: 'Fine.' };
  };
}

const ARCHIVE_QUESTION = {
  shape: 'decision' as const,
  headline: 'Eleven documents have no address — archive them or give them a board?',
  detail: 'They hold their writing but nobody can open them. Archiving is reversible.',
  options: [
    { id: 'archive', label: 'Archive them', detail: 'they go where the others went; reversible' },
    { id: 'rehome', label: 'Rehome here', detail: 'they become reachable again on this board' },
  ],
};

interface ThreadReply {
  thread: { id: string; comments: Array<{ id: string; review?: unknown }> };
}

beforeEach(() => {
  seenAsks.length = 0;
  h = startJudgeHarness();
  h.judge = recordingJudge();
});
afterEach(async () => {
  await h.stop();
});

/**
 * A judge that holds ANY item whose prompt lists a prior ask — the worst case
 * of a model matching on topic. What it holds is therefore decided entirely
 * by what the server puts in front of it.
 */
function repeatHoldingJudge(): JudgeHarness['judge'] {
  return async (input) => {
    const { user } = buildReviewJudgePrompt(input.criteria, input.item);
    return user.includes('<prior-asks>')
      ? { ok: false, reason: 'This repeats a question already on the task.' }
      : { ok: true, reason: 'Fine.' };
  };
}

describe('a question asked on the ticket reaches an item filed on its thread', () => {
  it('carries the earlier headline while it is still open', async () => {
    const { workspaceId, taskId } = await h.board();
    await jj<Held>(
      await post(`/workspaces/${workspaceId}/tasks/${taskId}/review-items`, {
        author: FILER,
        review: ARCHIVE_QUESTION,
      }),
    );

    // The same question, down the OTHER channel.
    await jj<ThreadReply>(
      await post(`/workspaces/${workspaceId}/docs/task:${taskId}/threads`, {
        author: FILER,
        anchor: { kind: 'subject' },
        text: 'The last criterion is a call only you can make.',
        review: { ...ARCHIVE_QUESTION, headline: 'Documents that lost their board — what now?' },
      }),
    );

    const second = seenAsks[1] ?? '';
    expect(second).toContain('Eleven documents have no address');
    expect(second).toContain('still unanswered');
  });

  it('the control: the first item on a fresh row is given no history at all', async () => {
    const { workspaceId, taskId } = await h.board();
    await jj<Held>(
      await post(`/workspaces/${workspaceId}/tasks/${taskId}/review-items`, {
        author: FILER,
        review: ARCHIVE_QUESTION,
      }),
    );
    expect(seenAsks[0]).toBe('');
  });
});

describe('an answered item is never grounds for a hold', () => {
  // 2026-09-14: three of five items were held as "duplicates" of an item the
  // reader had already answered, when that answer did not settle them.
  it('passes a follow-up filed after the reader answered the earlier item', async () => {
    const { workspaceId, taskId } = await h.board();
    const first = await jj<Held>(
      await post(`/workspaces/${workspaceId}/tasks/${taskId}/review-items`, {
        author: FILER,
        review: ARCHIVE_QUESTION,
      }),
    );
    await jj(
      await post(
        `/workspaces/${workspaceId}/tasks/${taskId}/review-items/${first.item?.id}/answer`,
        { text: 'Archive them', answeredWith: 'archive', author: PERSON },
      ),
    );
    h.judge = repeatHoldingJudge();

    const onTicket = await jj<Held>(
      await post(`/workspaces/${workspaceId}/tasks/${taskId}/review-items`, {
        author: FILER,
        review: { ...ARCHIVE_QUESTION, headline: 'Archived — check them on your phone?' },
      }),
    );
    expect(onTicket.held ?? false).toBe(false);
    // Answered too, so the thread filing below has no OPEN ask on the row.
    await jj(
      await post(
        `/workspaces/${workspaceId}/tasks/${taskId}/review-items/${onTicket.item?.id}/answer`,
        { text: 'Checked, they are fine', author: PERSON },
      ),
    );
    const onThread = await jj<ThreadReply & Held>(
      await post(`/workspaces/${workspaceId}/docs/task:${taskId}/threads`, {
        author: FILER,
        anchor: { kind: 'subject' },
        text: 'One more on this.',
        review: { ...ARCHIVE_QUESTION, headline: 'Documents that lost their board — what now?' },
      }),
    );
    expect(onThread.held ?? false).toBe(false);
  });

  it('the control: a repeat of an item still OPEN is held', async () => {
    const { workspaceId, taskId } = await h.board();
    await jj<Held>(
      await post(`/workspaces/${workspaceId}/tasks/${taskId}/review-items`, {
        author: FILER,
        review: ARCHIVE_QUESTION,
      }),
    );
    h.judge = repeatHoldingJudge();
    const repeat = await jj<Held>(
      await post(`/workspaces/${workspaceId}/tasks/${taskId}/review-items`, {
        author: FILER,
        review: { ...ARCHIVE_QUESTION, headline: 'Same thing, asked again' },
      }),
    );
    expect(repeat.held).toBe(true);
  });
});

describe('a question asked on a thread reaches an item filed on the ticket', () => {
  it('carries it the other way round too', async () => {
    const { workspaceId, taskId } = await h.board();
    await jj<ThreadReply>(
      await post(`/workspaces/${workspaceId}/docs/task:${taskId}/threads`, {
        author: FILER,
        anchor: { kind: 'subject' },
        text: 'Which way?',
        review: ARCHIVE_QUESTION,
      }),
    );
    await jj<Held>(
      await post(`/workspaces/${workspaceId}/tasks/${taskId}/review-items`, {
        author: FILER,
        review: { ...ARCHIVE_QUESTION, headline: 'Same thing, asked again' },
      }),
    );
    expect(seenAsks[1]).toContain('Eleven documents have no address');
  });

  it('never shows an item its own words as a question it is repeating', async () => {
    const { workspaceId, taskId } = await h.board();
    await jj<Held>(
      await post(`/workspaces/${workspaceId}/tasks/${taskId}/review-items`, {
        author: FILER,
        review: ARCHIVE_QUESTION,
      }),
    );
    expect(seenAsks[0]).not.toContain('Eleven documents have no address');
  });
});

describe('a link that goes nowhere is held without spending a judge call', () => {
  it('names the dead link and never reaches the judge', async () => {
    const { workspaceId, taskId } = await h.board();
    const out = await jj<Held>(
      await post(`/workspaces/${workspaceId}/tasks/${taskId}/review-items`, {
        author: FILER,
        review: {
          ...ARCHIVE_QUESTION,
          detail: 'Look at the [mock](/mockup/d-anything) before you answer.',
        },
      }),
    );
    expect(out.held).toBe(true);
    expect(out.heldReason).toContain('/mockup/d-anything');
    expect(h.calls).toHaveLength(0);
  });

  it('holds an item whose board id does not exist', async () => {
    const { workspaceId, taskId } = await h.board();
    const out = await jj<Held>(
      await post(`/workspaces/${workspaceId}/tasks/${taskId}/review-items`, {
        author: FILER,
        review: {
          ...ARCHIVE_QUESTION,
          detail: 'See [the board](/workspaces/w-gone/docs/d-1).',
        },
      }),
    );
    expect(out.held).toBe(true);
    expect(out.heldReason).toContain('no board has that id');
  });

  it('the control: a link to this very board and ticket passes and IS judged', async () => {
    const { workspaceId, taskId } = await h.board();
    const out = await jj<Held>(
      await post(`/workspaces/${workspaceId}/tasks/${taskId}/review-items`, {
        author: FILER,
        review: {
          ...ARCHIVE_QUESTION,
          detail: `Answer on [the ticket](/workspaces/${workspaceId}?task=${taskId}).`,
        },
      }),
    );
    expect(out.held ?? false).toBe(false);
    expect(h.calls).toHaveLength(1);
  });
});
