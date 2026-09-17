/**
 * Every board event that tells an agent about something that agent just did.
 *
 * The list below is not read off the implementation. It was measured: a real
 * server, a real `/events/agent/<id>` stream, and one session performing each
 * act on its own board — see `packages/server/test/self-echo-suppression.test.ts`,
 * which drives the same set end to end and proves the frames still reach a
 * DIFFERENT agent. This file is the renderer's half: given the frame that
 * stream carries, the session that caused it is told nothing.
 *
 * Each payload is the shape the server actually broadcasts, including which
 * field names the actor — and that varies by family, which is the whole
 * reason the old inline `actor?.id` check missed three of them:
 *
 *   - `actor: {id}`       task.* / decision.* / workspace.* / review_item.added,
 *                         .revised, .withdrawn / thread.resolved, .reopened
 *   - `actorId: '…'`      review_item.viewed, review_item.answered
 *   - `agentId: '…'`      agent.attached, agent.detached
 *   - `comment.author.id` thread.replied (and thread.created, off the thread)
 *   - `suggestion.author` suggestion.created
 *
 * Driven through `createChannelMessages`, so what is asserted is whether the
 * session was woken — not what any predicate returned.
 *
 * All fixtures synthetic. Nothing here opens a socket.
 */
import { describe, expect, it } from 'vitest';
import { type ChannelNotification, createChannelMessages } from '../src/channel-messages.ts';

const SELF = 'agent-harborlight';
const PEER = 'agent-riverbend';
const PERSON = 'known-bryan';

function harness(authorId = SELF) {
  const frames: ChannelNotification['params'][] = [];
  const messages = createChannelMessages({
    notify: async (n) => {
      frames.push(n.params);
    },
    http: async () => ({}),
    authorId,
    now: () => Date.UTC(2026, 8, 17, 12, 0, 0),
  });
  return { frames, messages };
}

const actor = (id: string) => ({ id, name: id, kind: 'agent' as const });

/**
 * One frame per event, attributed to `who`, in the shape the server sends.
 *
 * Ordered as the probe observed them: attach, the ticket verbs, the review
 * item's four, the doc thread's four, the suggestion, detach.
 */
const FRAMES: Array<{ event: string; frame: (who: string) => Record<string, unknown> }> = [
  {
    event: 'agent.attached',
    frame: (who) => ({ workspaceId: 'w1', agentId: who, attachment: { agentId: who } }),
  },
  {
    event: 'task.created',
    frame: (who) => ({
      workspaceId: 'w1',
      taskId: 't1',
      task: { title: 'A task' },
      goal: 'chores',
      assignee: 'Harborlight',
      actor: actor(who),
    }),
  },
  {
    event: 'task.transitioned',
    frame: (who) => ({
      workspaceId: 'w1',
      taskId: 't1',
      from: 'triage',
      to: 'in-progress',
      actor: actor(who),
    }),
  },
  {
    event: 'task.assigned',
    frame: (who) => ({
      workspaceId: 'w1',
      taskId: 't1',
      from: 'Harborlight',
      to: 'human',
      actor: actor(who),
    }),
  },
  {
    event: 'task.retitled',
    frame: (who) => ({
      workspaceId: 'w1',
      taskId: 't1',
      titleFrom: 'A task',
      titleTo: 'A renamed task',
      actor: actor(who),
    }),
  },
  {
    event: 'task.archived',
    frame: (who) => ({
      workspaceId: 'w1',
      taskId: 't1',
      title: 'A task',
      reason: 'done',
      actor: actor(who),
    }),
  },
  {
    event: 'decision.answered',
    frame: (who) => ({
      workspaceId: 'w1',
      taskId: 't2',
      answer: 'Friday',
      links: [],
      actor: actor(who),
    }),
  },
  {
    event: 'review_item.added',
    frame: (who) => ({
      workspaceId: 'w1',
      taskId: 't1',
      reviewItemId: 'r1',
      shape: 'decision',
      headline: 'Which way?',
      links: [],
      actor: actor(who),
    }),
  },
  {
    event: 'review_item.revised',
    frame: (who) => ({
      workspaceId: 'w1',
      taskId: 't1',
      reviewItemId: 'r1',
      links: [],
      actor: actor(who),
    }),
  },
  {
    event: 'review_item.withdrawn',
    frame: (who) => ({
      workspaceId: 'w1',
      taskId: 't1',
      reviewItemId: 'r1',
      reason: 'answered elsewhere',
      links: [],
      actor: actor(who),
    }),
  },
  {
    event: 'review_item.answered',
    frame: (who) => ({
      workspaceId: 'w1',
      taskId: 't1',
      reviewItemId: 'r1',
      actorId: who,
      isOwner: false,
    }),
  },
  {
    event: 'review_item.viewed',
    frame: (who) => ({
      workspaceId: 'w1',
      taskId: 't1',
      reviewItemId: 'r1',
      actorId: who,
      isOwner: false,
    }),
  },
  {
    event: 'thread.created',
    frame: (who) => ({
      docId: 'd1',
      threadId: 'th1',
      thread: { comments: [{ author: actor(who), text: 'A comment.' }] },
    }),
  },
  {
    event: 'thread.replied',
    frame: (who) => ({
      docId: 'd1',
      threadId: 'th1',
      comment: { author: actor(who), text: 'A reply.' },
    }),
  },
  {
    event: 'thread.resolved',
    frame: (who) => ({ docId: 'd1', threadId: 'th1', actor: actor(who) }),
  },
  {
    event: 'thread.reopened',
    frame: (who) => ({ docId: 'd1', threadId: 'th1', actor: actor(who) }),
  },
  {
    event: 'suggestion.created',
    frame: (who) => ({
      docId: 'd1',
      sid: 's1',
      suggestion: { author: { id: who, name: who }, kind: 'replace', snippet: 'a → b' },
    }),
  },
  {
    event: 'agent.detached',
    frame: (who) => ({ workspaceId: 'w1', agentId: who, attachment: { agentId: who } }),
  },
];

describe('an agent is never told what it just did', () => {
  for (const { event, frame } of FRAMES) {
    it(`says nothing about this session's own ${event}`, async () => {
      const { frames, messages } = harness();
      await messages.emitChannelMessage(event, frame(SELF));
      expect(frames).toEqual([]);
    });
  }
});

describe('and every other reader is told exactly as before', () => {
  for (const { event, frame } of FRAMES) {
    it(`delivers a peer agent's ${event}`, async () => {
      const { frames, messages } = harness();
      await messages.emitChannelMessage(event, frame(PEER));
      expect(frames).toHaveLength(1);
      expect(frames[0]?.meta.event).toBe(event);
    });

    it(`delivers a person's ${event}`, async () => {
      const { frames, messages } = harness();
      await messages.emitChannelMessage(event, frame(PERSON));
      expect(frames).toHaveLength(1);
      expect(frames[0]?.meta.event).toBe(event);
    });
  }
});

describe('the gate fails open, so a wake is never lost to doubt', () => {
  // `CW_AGENT_NAME` unset resolves every anonymous session to `known-agent`.
  // A set keyed on that would have one session swallow a sibling's news.
  it('suppresses nothing for a session with no stable identity', async () => {
    for (const shared of ['known-agent', 'known-bryan', '', '   ']) {
      const { frames, messages } = harness(shared);
      await messages.emitChannelMessage('review_item.added', {
        workspaceId: 'w1',
        taskId: 't1',
        reviewItemId: 'r1',
        headline: 'Which way?',
        actor: actor(shared),
      });
      expect(frames).toHaveLength(1);
    }
  });

  it('delivers a frame that names nobody', async () => {
    const { frames, messages } = harness();
    await messages.emitChannelMessage('review_item.added', {
      workspaceId: 'w1',
      taskId: 't1',
      reviewItemId: 'r1',
      headline: 'From a server too old to stamp an actor.',
    });
    expect(frames).toHaveLength(1);
  });

  // The board's three addressed wakes are CAUSED by the reader's own work and
  // carry no top-level actor, which is exactly why they must keep arriving:
  // they are the server's verdict on that work, not an echo of it.
  it('delivers the addressed wakes, which name no actor at all', async () => {
    for (const event of [
      'workspace.ready_idle',
      'workspace.stalled',
      'workspace.review_item_held',
      'workspace.done_when_ready',
      'workspace.review_answered',
    ]) {
      const { frames, messages } = harness();
      await messages.emitChannelMessage(event, {
        workspaceId: 'w1',
        taskId: 't1',
        reviewItemId: 'r1',
        readyCount: 1,
        stalledCount: 1,
        rows: [],
      });
      expect(frames).toHaveLength(1);
    }
  });

  // A verdict on this session's own suggestion is the outcome it is waiting
  // on. The frame carries the SUGGESTER as author either way, so matching on
  // it would swallow the answer rather than the echo.
  it('delivers the verdict on a suggestion this session made', async () => {
    for (const event of ['suggestion.accepted', 'suggestion.rejected']) {
      const { frames, messages } = harness();
      await messages.emitChannelMessage(event, {
        docId: 'd1',
        sid: 's1',
        suggestion: {
          author: { id: SELF, name: 'Harborlight' },
          kind: 'replace',
          snippet: 'a → b',
        },
      });
      expect(frames).toHaveLength(1);
    }
  });
});
