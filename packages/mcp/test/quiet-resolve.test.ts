/**
 * Resolving a thread wakes nobody, unless it closed an ask nobody answered.
 *
 * A resolve carries no words — it is a status flip, and `channel-messages.ts`
 * renders it with an empty body — so the agent that woke for one read a line
 * with nothing in it. This file drives resolves through
 * `createChannelMessages`, so what is asserted is whether the session was
 * woken, not what any predicate returned.
 *
 * It is the renderer's half. `packages/server/test/quiet-resolve.test.ts` is
 * the other half: the payloads below are written by hand, so a server that
 * renamed a field would leave this file green while production went back to
 * waking on a click.
 *
 * The cases that must NOT be suppressed are the point of the file, not its
 * trimming: a reply that arrives with a resolve, a reopen, an answer, and a
 * resolve that closes an ask nobody answered. A wrong suppression here is
 * silence, and an agent cannot tell silence from "nothing happened".
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

const actor = (id: string) => ({
  id,
  name: id,
  kind: id.startsWith('known-') ? 'person' : 'agent',
});

/** A comment as the fan-out sends it, optionally carrying a declared ask. */
function comment(
  id: string,
  who: string,
  text: string,
  review?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id,
    author: actor(who),
    text,
    ts: Date.UTC(2026, 8, 17, 11, 0, 0),
    ...(review ? { review } : {}),
  };
}

/** The `thread.resolved` frame `live-doc-fanout.ts` broadcasts. */
function resolvedFrame(
  who: string,
  comments: Array<Record<string, unknown>> = [comment('c1', PERSON, 'A comment.')],
): Record<string, unknown> {
  return {
    event: 'thread.resolved',
    docId: 'doc-one',
    threadId: 'th1',
    thread: { id: 'th1', status: 'resolved', anchor: { kind: 'subject' }, comments },
    actor: actor(who),
  };
}

describe('a resolve wakes nobody', () => {
  it('says nothing when a person resolves a thread', async () => {
    const { frames, messages } = harness();
    await messages.emitChannelMessage('thread.resolved', resolvedFrame(PERSON));
    expect(frames).toEqual([]);
  });

  it('says nothing when another AGENT resolves it either', async () => {
    // The self-echo rule would have delivered this one: the actor is not this
    // session. This rule is about the event, so a peer's resolve is no more
    // worth a turn than this session's own.
    const { frames, messages } = harness();
    await messages.emitChannelMessage('thread.resolved', resolvedFrame(PEER));
    expect(frames).toEqual([]);
  });

  it('still delivers a reply that came with the resolve', async () => {
    // A person who replies and resolves in one gesture performs two REST
    // calls, so the server fires two events. The words must survive the one
    // that carries them.
    const { frames, messages } = harness();
    await messages.emitChannelMessage('thread.replied', {
      docId: 'doc-one',
      threadId: 'th1',
      thread: {
        id: 'th1',
        status: 'open',
        anchor: { kind: 'subject' },
        comments: [comment('c1', PERSON, 'A comment.'), comment('c2', PERSON, 'Fixed, thanks.')],
      },
      comment: comment('c2', PERSON, 'Fixed, thanks.'),
    });
    await messages.emitChannelMessage('thread.resolved', resolvedFrame(PERSON));

    expect(frames).toHaveLength(1);
    expect(frames[0]?.meta.event).toBe('thread.replied');
    expect(frames[0]?.content).toContain('Fixed, thanks.');
  });

  it('still delivers a reopen — the inverse of a resolve', async () => {
    const { frames, messages } = harness();
    await messages.emitChannelMessage('thread.reopened', {
      docId: 'doc-one',
      threadId: 'th1',
      thread: { id: 'th1', status: 'open', anchor: { kind: 'subject' }, comments: [] },
      actor: actor(PERSON),
    });
    expect(frames).toHaveLength(1);
    expect(frames[0]?.meta.event).toBe('thread.reopened');
  });

  it('still delivers a resolve that closed an ask nobody answered', async () => {
    // Resolving RETIRES every review item on the thread. The agent that filed
    // one is waiting on it, and nothing else in the server will tell it the
    // question went away.
    const { frames, messages } = harness();
    await messages.emitChannelMessage(
      'thread.resolved',
      resolvedFrame(PERSON, [
        comment('c1', SELF, 'Which way?', { shape: 'decision', headline: 'Which way?' }),
      ]),
    );
    expect(frames).toHaveLength(1);
    expect(frames[0]?.meta.event).toBe('thread.resolved');
  });

  // The two cases below moved from `channel-messages.test.ts`, which is where
  // the resolve LINE's wording has been asserted since 17 resolves in the
  // field were each attributed to the thread's creator. The rule they check is
  // unchanged; only the fixture that produces a rendered resolve at all is,
  // and it belongs beside the rule that decides which resolves render.
  it('attributes the surviving resolve to the actor, never to a comment author', async () => {
    const { frames, messages } = harness();
    await messages.emitChannelMessage(
      'thread.resolved',
      resolvedFrame(PERSON, [
        comment('c1', PEER, 'not my words', { shape: 'decision', headline: 'Which way?' }),
      ]),
    );
    const f = frames[0];
    expect(f?.content).toContain(`by ${PERSON}`);
    expect(f?.content).not.toContain(PEER);
    expect(f?.content).not.toContain('not my words');
  });

  it('leaves the author blank when an older server sends no actor', async () => {
    const { frames, messages } = harness();
    await messages.emitChannelMessage('thread.resolved', {
      docId: 'doc-one',
      threadId: 'th1',
      thread: {
        id: 'th1',
        status: 'resolved',
        anchor: { kind: 'subject' },
        comments: [comment('c1', PEER, 'x', { shape: 'decision', headline: 'Which way?' })],
      },
    });
    expect(frames).toHaveLength(1);
    expect(frames[0]?.meta.author).toBe('');
  });

  it('says nothing when the ask on the thread was already answered', async () => {
    const { frames, messages } = harness();
    await messages.emitChannelMessage(
      'thread.resolved',
      resolvedFrame(PERSON, [
        comment('c1', SELF, 'Which way?', {
          shape: 'decision',
          headline: 'Which way?',
          answeredAt: Date.UTC(2026, 8, 17, 11, 30, 0),
        }),
      ]),
    );
    expect(frames).toEqual([]);
  });

  it('says nothing when the ask was withdrawn by its asker', async () => {
    const { frames, messages } = harness();
    await messages.emitChannelMessage(
      'thread.resolved',
      resolvedFrame(PERSON, [
        comment('c1', SELF, 'Which way?', {
          shape: 'decision',
          headline: 'Which way?',
          withdrawnAt: Date.UTC(2026, 8, 17, 11, 30, 0),
        }),
      ]),
    );
    expect(frames).toEqual([]);
  });

  it('delivers a resolve whose payload carries no readable thread', async () => {
    // The question "was an ask open here" could not be asked, so the frame is
    // delivered — the same direction `self-authored.ts` fails in.
    const { frames, messages } = harness();
    await messages.emitChannelMessage('thread.resolved', {
      docId: 'doc-one',
      threadId: 'th1',
      actor: actor(PERSON),
    });
    expect(frames).toHaveLength(1);
    expect(frames[0]?.meta.event).toBe('thread.resolved');
  });
});

describe('nothing else stopped waking', () => {
  it('still delivers an answer on a review item', async () => {
    // Kept deliberately: an answer is the outcome the filer is blocked on.
    // It is ids-only, like the analytics rows the server drops, which is
    // exactly why it is named here rather than left to a family prefix.
    const { frames, messages } = harness();
    await messages.emitChannelMessage('review_item.answered', {
      workspaceId: 'w1',
      reviewItemId: 'ri-1',
      taskId: 't1',
      actorId: PERSON,
      isOwner: true,
      ts: Date.UTC(2026, 8, 17, 11, 0, 0),
    });
    expect(frames).toHaveLength(1);
    expect(frames[0]?.meta.event).toBe('review_item.answered');
  });

  it('still delivers a person moving a task', async () => {
    const { frames, messages } = harness();
    await messages.emitChannelMessage('task.transitioned', {
      workspaceId: 'w1',
      taskId: 't1',
      from: 'triage',
      to: 'in-progress',
      actor: actor(PERSON),
    });
    expect(frames).toHaveLength(1);
    expect(frames[0]?.meta.event).toBe('task.transitioned');
  });

  it('still delivers a person archiving one', async () => {
    const { frames, messages } = harness();
    await messages.emitChannelMessage('task.archived', {
      workspaceId: 'w1',
      taskId: 't1',
      title: 'A task',
      reason: 'done',
      actor: actor(PERSON),
    });
    expect(frames).toHaveLength(1);
    expect(frames[0]?.meta.event).toBe('task.archived');
  });

  it('still delivers a person regrouping one', async () => {
    const { frames, messages } = harness();
    await messages.emitChannelMessage('task.regrouped', {
      workspaceId: 'w1',
      taskId: 't1',
      fromGoal: 'chores',
      toGoal: 'urgent',
      actor: actor(PERSON),
    });
    expect(frames).toHaveLength(1);
    expect(frames[0]?.meta.event).toBe('task.regrouped');
  });
});
