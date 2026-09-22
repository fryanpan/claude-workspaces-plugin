/**
 * A review item filed on a TASK wakes its reader with the task in the line.
 *
 * THE DEFECT, seen on prod 2026-09-22. `review_item.added` / `.revised` /
 * `.withdrawn` are emitted by `packages/server/src/review-items/store.ts` with
 * `workspaceId`, `taskId`, `reviewItemId`, `shape`, `headline` and `actor` —
 * and not one of those fields is read by the doc-shaped tail of
 * `emitChannelMessage`, which is where they landed because `review_item.` is
 * not in `BOARD_EVENT_RE`. The lead received the scheduler's stale-rule item
 * on its own task as `doc_id="unknown"` with an empty thread id and an empty
 * author, and spent six tool calls failing to find what the frame was about.
 *
 * So these assert the rendered frame, not the source: the line names the ask,
 * the item and the task, and the meta carries the ids a reader would address
 * the answer to. A doc-thread comment on a review item is the control in the
 * same file — it must keep rendering `doc_id` and `thread_id` exactly as it
 * did, because the branch added here is on the presence of `taskId`.
 */
import { describe, expect, it } from 'vitest';
import { type ChannelNotification, createChannelMessages } from '../src/channel-messages.ts';
import { isTaskReviewItemEvent, reviewItemTaskLine } from '../src/review-item-line.ts';

const FIXED_MS = Date.UTC(2026, 8, 22, 9, 0, 0);
const SELF = 'agent-riverbend';

function harness(authorId = SELF) {
  const frames: ChannelNotification['params'][] = [];
  const messages = createChannelMessages({
    notify: async (n) => {
      frames.push(n.params);
    },
    http: async () => ({}),
    authorId,
    now: () => FIXED_MS,
  });
  return { frames, messages };
}

function only(frames: ChannelNotification['params'][]) {
  expect(frames).toHaveLength(1);
  return frames[0] as ChannelNotification['params'];
}

/** The server's exact `ReviewItemAddedEvent`, as `server.ts` puts it on the
 *  workspace channel: the store's row with `type` renamed to `event`. */
const ADDED = {
  workspaceId: 'w-DRa',
  taskId: 't-ZOz',
  reviewItemId: 'ri-4',
  shape: 'decision' as const,
  headline: 'Saltmarsh has not run for eleven days — retire the rule or fix it?',
  actor: { id: 'agent-harborlight', name: 'Harborlight' },
  links: [],
  ts: FIXED_MS,
};

describe('review_item.added on a task', () => {
  it('names the ask, the item and the task in the line the agent reads', async () => {
    const { frames, messages } = harness();
    await messages.emitChannelMessage('review_item.added', ADDED);
    expect(only(frames).content).toBe(
      '[review item added] "Saltmarsh has not run for eleven days — retire the rule or fix it?" — item ri-4 on task t-ZOz by Harborlight',
    );
  });

  it('carries the board, the task and the item in the meta, and never doc_id', async () => {
    const { frames, messages } = harness();
    await messages.emitChannelMessage('review_item.added', ADDED);
    const f = only(frames);
    expect(f.meta).toEqual({
      workspace_id: 'w-DRa',
      task_id: 't-ZOz',
      review_item_id: 'ri-4',
      event: 'review_item.added',
      author: 'Harborlight',
    });
    // The whole defect in one assertion: the doc fallback stamped this key
    // with the literal string 'unknown', which reads as a doc that exists.
    expect('doc_id' in f.meta).toBe(false);
  });

  it('truncates a headline written as a paragraph rather than a question', async () => {
    const { frames, messages } = harness();
    await messages.emitChannelMessage('review_item.added', { ...ADDED, headline: 'x'.repeat(200) });
    const content = only(frames).content;
    expect(content).toContain('…');
    expect(content).toContain('item ri-4 on task t-ZOz');
    expect(content.length).toBeLessThan(180);
  });

  it('renders without an actor name, which an older server may omit', async () => {
    const { frames, messages } = harness();
    const { actor: _actor, ...noActor } = ADDED;
    await messages.emitChannelMessage('review_item.added', noActor);
    const f = only(frames);
    expect(f.content).toBe(
      '[review item added] "Saltmarsh has not run for eleven days — retire the rule or fix it?" — item ri-4 on task t-ZOz',
    );
    expect('author' in f.meta).toBe(false);
  });
});

describe('review_item.revised on a task — no headline on the wire', () => {
  it('names the item and the task, and the thread the revision answers', async () => {
    const { frames, messages } = harness();
    await messages.emitChannelMessage('review_item.revised', {
      workspaceId: 'w-DRa',
      taskId: 't-ZOz',
      reviewItemId: 'ri-4',
      threadId: 'th-2',
      actor: { id: 'known-bryan', name: 'Bryan' },
      links: [],
      ts: FIXED_MS,
    });
    const f = only(frames);
    expect(f.content).toBe(
      '[review item revised] item ri-4 on task t-ZOz by Bryan — answers thread th-2, back on the queue',
    );
    expect(f.meta).toMatchObject({
      workspace_id: 'w-DRa',
      task_id: 't-ZOz',
      review_item_id: 'ri-4',
      event: 'review_item.revised',
    });
  });

  it('drops the thread clause when the revision answered no thread', async () => {
    const { frames, messages } = harness();
    await messages.emitChannelMessage('review_item.revised', {
      workspaceId: 'w-DRa',
      taskId: 't-ZOz',
      reviewItemId: 'ri-4',
      actor: { id: 'known-bryan', name: 'Bryan' },
      links: [],
      ts: FIXED_MS,
    });
    expect(only(frames).content).toBe(
      '[review item revised] item ri-4 on task t-ZOz by Bryan — back on the queue',
    );
  });
});

/**
 * THE CONTROL for the whole branch. The renderer now reads `taskId`, so the
 * one thing that must not change is the path for an item that hangs on a DOC
 * thread: the reader addresses that one by doc and thread, and a frame that
 * lost either key would be the same defect pointing the other way.
 */
describe('a doc-thread review item keeps the doc rendering', () => {
  it('still renders doc_id and thread_id for a comment on a doc-borne item', async () => {
    const { frames, messages } = harness();
    await messages.emitChannelMessage('thread.created', {
      docId: 'plan',
      threadId: 'th-8',
      reviewItemId: 'ri-9',
      comment: { author: { id: 'known-bryan', name: 'Bryan' }, text: 'Which one?', ts: FIXED_MS },
    });
    const f = only(frames);
    expect(f.content).toBe('[created] on review item ri-9 — Bryan: Which one?');
    expect(f.meta).toMatchObject({ doc_id: 'plan', thread_id: 'th-8', review_item_id: 'ri-9' });
  });

  it('keeps the doc path for a review_item event that names a doc and no task', async () => {
    const { frames, messages } = harness();
    await messages.emitChannelMessage('review_item.added', {
      workspaceId: 'w-DRa',
      docId: 'plan',
      threadId: 'th-8',
      reviewItemId: 'ri-9',
      headline: 'Which one?',
      actor: { id: 'agent-harborlight', name: 'Harborlight' },
    });
    const f = only(frames);
    expect(f.meta.doc_id).toBe('plan');
    expect(f.meta.thread_id).toBe('th-8');
  });
});

/**
 * The self-echo gate ran on these events before this change and must still
 * run after it — the new branch sits BELOW `isSelfAuthoredEvent`, and a
 * branch placed above it would hand every filer its own ask back.
 */
describe('self-authored suppression still holds on the new path', () => {
  it('drops an item this session filed', async () => {
    const { frames, messages } = harness('agent-harborlight');
    await messages.emitChannelMessage('review_item.added', ADDED);
    expect(frames).toHaveLength(0);
  });

  it('delivers the same frame to anybody else', async () => {
    const { frames, messages } = harness('agent-riverbend');
    await messages.emitChannelMessage('review_item.added', ADDED);
    expect(frames).toHaveLength(1);
  });
});

/**
 * ITEM 2 — a withdrawal is bookkeeping; a reinstatement is an ask.
 *
 * A withdrawal retires an ask and leaves its reader with nothing to do, and
 * the filer's own recovery already exists: the row goes back to having no
 * open question, which is what `workspace.stalled` and `workspace.ready_idle`
 * report. The undo is the exact inverse — the ask is back on the ticket — so
 * it is delivered, for the same reason `thread.reopened` is not on the
 * bookkeeping list. The line stops at the ticket rather than claiming a
 * reader's queue, because a reinstated item still held by the quality gate is
 * on nobody's queue and the frame carries no held state to tell.
 */
describe('review_item.withdrawn', () => {
  const WITHDRAWN = {
    workspaceId: 'w-DRa',
    taskId: 't-ZOz',
    reviewItemId: 'ri-4',
    reason: 'a run succeeded',
    actor: { id: 'agent-scheduler', name: 'the scheduler' },
    links: [],
    ts: FIXED_MS,
  };

  it('wakes nobody — the ask is gone and there is nothing to answer', async () => {
    const { frames, messages } = harness();
    await messages.emitChannelMessage('review_item.withdrawn', WITHDRAWN);
    expect(frames).toHaveLength(0);
  });

  it('wakes on the undo, which puts the ask back on the ticket', async () => {
    const { frames, messages } = harness();
    await messages.emitChannelMessage('review_item.withdrawn', {
      ...WITHDRAWN,
      reason: undefined,
      reinstated: true,
    });
    const f = only(frames);
    expect(f.content).toBe(
      '[review item reinstated] item ri-4 on task t-ZOz by the scheduler — the ask is back on the ticket',
    );
    expect(f.meta).toMatchObject({ task_id: 't-ZOz', review_item_id: 'ri-4' });
  });
});

/**
 * The wording arm the bookkeeping gate keeps out of reach, driven directly.
 *
 * A plain withdrawal never reaches the renderer today — `isBookkeepingEvent`
 * answers first — so this drives the exported line function to pin what the
 * frame would say if that gate is ever narrowed, and to keep the arm from
 * rotting into an unreadable line nobody is looking at.
 */
describe('the withdrawal wording, if a narrowed gate ever delivers one', () => {
  it('names the task and the asker’s reason', () => {
    expect(
      reviewItemTaskLine('review_item.withdrawn', {
        taskId: 't-ZOz',
        reviewItemId: 'ri-4',
        reason: 'a run succeeded',
        actor: { name: 'the scheduler' },
      }),
    ).toBe('[review item withdrawn] item ri-4 on task t-ZOz by the scheduler — a run succeeded');
  });
});

/**
 * The two-part test for which items are ticket-borne, asserted on its own
 * because the branch it drives is the one thing that decides whether a frame
 * keeps the doc rendering.
 */
describe('isTaskReviewItemEvent', () => {
  it('claims a ticket-borne item', () => {
    expect(isTaskReviewItemEvent('review_item.added', { taskId: 't-1' })).toBe(true);
  });

  it('declines a measurement row, whatever it carries', () => {
    expect(isTaskReviewItemEvent('review_item.viewed', { taskId: 't-1' })).toBe(false);
    expect(isTaskReviewItemEvent('review_item.answered', { taskId: 't-1' })).toBe(false);
  });

  it('declines an event with no task to name, rather than inventing one', () => {
    expect(isTaskReviewItemEvent('review_item.added', { workspaceId: 'w-1' })).toBe(false);
    expect(isTaskReviewItemEvent('review_item.added', { taskId: '  ' })).toBe(false);
    expect(isTaskReviewItemEvent('review_item.added', null)).toBe(false);
    expect(isTaskReviewItemEvent('review_item.added', [])).toBe(false);
  });
});
