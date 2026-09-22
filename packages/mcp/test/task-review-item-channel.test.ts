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
import { isTaskReviewItemEvent } from '../src/review-item-line.ts';

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
      '[review item filed] "Saltmarsh has not run for eleven days — retire the rule or fix it?" — item ri-4 on task t-ZOz by Harborlight',
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
      // What KIND of ask it is — a pick-an-option item reads differently from
      // a yes/no one, and it is on the payload, so a reader should not have to
      // fetch the item to learn it.
      shape: 'decision',
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
      '[review item filed] "Saltmarsh has not run for eleven days — retire the rule or fix it?" — item ri-4 on task t-ZOz',
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
      '[review item revised] item ri-4 on task t-ZOz by Bryan — after a question on thread th-2',
    );
    expect(f.meta).toMatchObject({
      workspace_id: 'w-DRa',
      task_id: 't-ZOz',
      review_item_id: 'ri-4',
      event: 'review_item.revised',
    });
  });

  it('drops the thread clause when the revision followed no question', async () => {
    const { frames, messages } = harness();
    await messages.emitChannelMessage('review_item.revised', {
      workspaceId: 'w-DRa',
      taskId: 't-ZOz',
      reviewItemId: 'ri-4',
      actor: { id: 'known-bryan', name: 'Bryan' },
      links: [],
      ts: FIXED_MS,
    });
    expect(only(frames).content).toBe('[review item revised] item ri-4 on task t-ZOz by Bryan');
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
 * ITEM 2 — a withdrawal and an answer are addressed to the item's FILER.
 *
 * The reader who can act on either is the agent that raised the ask: its
 * question went away, or it got the answer it stopped for. Nobody else on the
 * board has anything to do, and the wake used to reach all of them —
 * `withdraw_review_item` says in as many words that any agent may retire a
 * stale ask, and every server auto-withdrawal (the scheduler's stale-rule
 * item, the stall escalation's, the done-when owner's) fires as a board actor
 * that the self-echo gate suppresses for nobody.
 *
 * So the server stamps `filedById` and the child delivers only to that agent.
 * The self-echo gate still runs first, so a filer retiring or answering its
 * own ask is dropped as before.
 */
describe('review_item.withdrawn is addressed to the filer', () => {
  const WITHDRAWN = {
    workspaceId: 'w-DRa',
    taskId: 't-ZOz',
    reviewItemId: 'ri-4',
    reason: 'a run succeeded',
    filedById: 'agent-riverbend',
    actor: { id: 'agent-scheduler', name: 'the scheduler' },
    links: [],
    ts: FIXED_MS,
  };

  it('wakes the filer when somebody else retires their ask', async () => {
    const { frames, messages } = harness('agent-riverbend');
    await messages.emitChannelMessage('review_item.withdrawn', WITHDRAWN);
    const f = only(frames);
    expect(f.content).toBe(
      '[review item withdrawn] item ri-4 on task t-ZOz by the scheduler — a run succeeded',
    );
    expect(f.meta).toMatchObject({ task_id: 't-ZOz', review_item_id: 'ri-4' });
  });

  // THE CONTROL, in the same file: the identical frame reaching any other
  // attached agent is the noise this rule removes.
  it('wakes no other agent on the board', async () => {
    const { frames, messages } = harness('agent-harborlight');
    await messages.emitChannelMessage('review_item.withdrawn', WITHDRAWN);
    expect(frames).toHaveLength(0);
  });

  it('still drops a filer retiring their own ask, which the self-echo gate owns', async () => {
    const { frames, messages } = harness('agent-riverbend');
    await messages.emitChannelMessage('review_item.withdrawn', {
      ...WITHDRAWN,
      actor: { id: 'agent-riverbend', name: 'Riverbend' },
    });
    expect(frames).toHaveLength(0);
  });

  it('wakes the filer on the undo too — their ask is back', async () => {
    const { frames, messages } = harness('agent-riverbend');
    await messages.emitChannelMessage('review_item.withdrawn', {
      ...WITHDRAWN,
      reason: undefined,
      reinstated: true,
    });
    expect(only(frames).content).toBe(
      '[review item reinstated] item ri-4 on task t-ZOz by the scheduler — the ask is back on the ticket',
    );
  });

  it('wakes nobody at all when the item predates the stored filer', async () => {
    for (const who of ['agent-riverbend', 'agent-harborlight']) {
      const { frames, messages } = harness(who);
      const { filedById: _none, ...legacy } = WITHDRAWN;
      await messages.emitChannelMessage('review_item.withdrawn', legacy);
      expect(frames).toHaveLength(0);
    }
  });
});

/**
 * `review_item.answered` had the same defect in a milder form: it carries
 * `workspaceId`, `taskId`, `reviewItemId` and `actorId`, no `docId`, and was
 * rendering through the doc fallback as a bare slug with `doc_id: "unknown"`.
 * It is a measurement row, but it is NOT on the server's analytics list —
 * only `viewed` is — deliberately, because an answer is the thing an agent
 * waits for. Same line, same filer rule.
 */
describe('review_item.answered is addressed to the filer', () => {
  const ANSWERED = {
    workspaceId: 'w-DRa',
    taskId: 't-ZOz',
    reviewItemId: 'ri-4',
    actorId: 'known-bryan',
    filedById: 'agent-riverbend',
    isOwner: true,
    ts: FIXED_MS,
  };

  it('wakes the filer, naming the item and the task rather than a doc', async () => {
    const { frames, messages } = harness('agent-riverbend');
    await messages.emitChannelMessage('review_item.answered', ANSWERED);
    const f = only(frames);
    expect(f.content).toBe(
      '[review item answered] item ri-4 on task t-ZOz — the ask you filed has an answer',
    );
    expect(f.meta).toMatchObject({
      workspace_id: 'w-DRa',
      task_id: 't-ZOz',
      review_item_id: 'ri-4',
      event: 'review_item.answered',
    });
    expect('doc_id' in f.meta).toBe(false);
  });

  it('wakes no other agent on the board', async () => {
    const { frames, messages } = harness('agent-harborlight');
    await messages.emitChannelMessage('review_item.answered', ANSWERED);
    expect(frames).toHaveLength(0);
  });

  // A doc-thread answer names no task, so it keeps the doc path — the same
  // branch, proved on the event this describe is about.
  it('leaves a doc-thread answer on the doc path', async () => {
    const { frames, messages } = harness('agent-riverbend');
    await messages.emitChannelMessage('review_item.answered', {
      workspaceId: 'w-DRa',
      reviewItemId: 'ri-doc',
      actorId: 'known-bryan',
      isOwner: true,
      ts: FIXED_MS,
    });
    expect(only(frames).meta.doc_id).toBe('unknown');
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

  // `viewed` is the one review-item row the server really does keep off the
  // fan-out, so no child sees one; `answered` is deliberately not on that
  // list and is claimed here.
  it('declines the one row the server keeps off the stream, and claims the answer', () => {
    expect(isTaskReviewItemEvent('review_item.viewed', { taskId: 't-1' })).toBe(false);
    expect(isTaskReviewItemEvent('review_item.answered', { taskId: 't-1' })).toBe(true);
  });

  it('declines an event with no task to name, rather than inventing one', () => {
    expect(isTaskReviewItemEvent('review_item.added', { workspaceId: 'w-1' })).toBe(false);
    expect(isTaskReviewItemEvent('review_item.added', { taskId: '  ' })).toBe(false);
    expect(isTaskReviewItemEvent('review_item.added', null)).toBe(false);
    expect(isTaskReviewItemEvent('review_item.added', [])).toBe(false);
  });
});
