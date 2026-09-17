/**
 * Delivery bookkeeping wakes nobody.
 *
 * Three frames say the transport did its job: `comment.delivered` (words the
 * session was just handed reached somebody), `agent.listening` (a peer's
 * presence circle moved) and `replay.gap` (frames were lost). None asks the
 * reader for anything, and each cost a wake turn per attached session.
 *
 * Driven through the two entry points a real frame crosses —
 * `createChannelMessages` for the first two, `createFrameHandler` for the
 * gap, which is answered before the renderer is reached — so what is asserted
 * is whether the session was woken, not what a predicate returned.
 *
 * `packages/server/test/quiet-bookkeeping.test.ts` is the other half: it
 * proves the server really puts these frames on an agent's stream (a rule
 * about a frame nobody sends is worth nothing) and that a gap loses the agent
 * nothing.
 *
 * The survival cases are the point of the file, not its trimming. A wrong
 * suppression is silence, and an agent cannot tell silence from nothing
 * happening.
 *
 * All fixtures synthetic. Nothing here opens a socket.
 */
import { describe, expect, it } from 'vitest';
import { type ChannelNotification, createChannelMessages } from '../src/channel-messages.ts';
import { type FrameHandlerDeps, createFrameHandler } from '../src/frame-handler.ts';

const SELF = 'agent-harborlight';
const PEER = 'agent-riverbend';
const PERSON = 'known-bryan';
const FIXED_MS = Date.UTC(2026, 8, 17, 12, 0, 0);

const actor = (id: string) => ({
  id,
  name: id,
  kind: id.startsWith('known-') ? 'person' : 'agent',
});

/** The renderer, with every frame it wrote. */
function renderer(authorId = SELF) {
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

/** The frame handler, with everything it wrote, acked or rendered. */
function handler(over: Partial<FrameHandlerDeps> = {}) {
  const notified: unknown[] = [];
  const emitted: Array<{ event: string; payload: unknown }> = [];
  const sent: Array<{ method: string; path: string }> = [];
  const handle = createFrameHandler({
    notify: async (n) => {
      notified.push(n.params);
    },
    emitChannelMessage: async (event, payload) => {
      emitted.push({ event, payload });
    },
    http: async (method, path) => {
      sent.push({ method, path });
      return {};
    },
    shouldForward: () => true,
    now: () => FIXED_MS,
    ...over,
  });
  return { notified, emitted, sent, handle };
}

/** One SSE frame as the loop hands it over, minus the blank-line terminator. */
function wire(event: string, data: unknown, id?: string): string {
  return [...(id ? [`id: ${id}`] : []), `event: ${event}`, `data: ${JSON.stringify(data)}`].join(
    '\n',
  );
}

describe('a delivery receipt wakes nobody', () => {
  it('says nothing when somebody else was handed a comment', async () => {
    const { frames, messages } = renderer();
    await messages.emitChannelMessage('comment.delivered', {
      event: 'comment.delivered',
      docId: 'doc-one',
      threadId: 'th1',
      commentId: 'c1',
      deliveredAt: FIXED_MS,
    });
    expect(frames).toEqual([]);
  });

  it('says nothing when the receipt is for a comment this session wrote either', async () => {
    // The self-echo rule could not have dropped this one: a receipt names no
    // actor, so it fails open there. This rule reads the event name.
    const { frames, messages } = renderer();
    await messages.emitChannelMessage('comment.delivered', {
      event: 'comment.delivered',
      docId: 'doc-one',
      threadId: 'th1',
      commentId: 'c1',
      deliveredAt: FIXED_MS,
      actor: actor(SELF),
    });
    expect(frames).toEqual([]);
  });

  it('still delivers the comment the receipt is about', async () => {
    // The words and the tick are two different frames. Dropping the tick must
    // not touch the frame that carried what somebody said.
    const { frames, messages } = renderer();
    await messages.emitChannelMessage('thread.replied', {
      docId: 'doc-one',
      threadId: 'th1',
      thread: { id: 'th1', status: 'open', anchor: { kind: 'subject' }, comments: [] },
      comment: {
        id: 'c1',
        author: actor(PERSON),
        text: 'Please use the second shape.',
        ts: FIXED_MS,
      },
    });
    expect(frames).toHaveLength(1);
    expect(frames[0]?.meta.event).toBe('thread.replied');
    expect(frames[0]?.content).toContain('Please use the second shape.');
  });
});

describe('a listening notice wakes nobody', () => {
  it('says nothing when a peer starts listening', async () => {
    const { frames, messages } = renderer();
    await messages.emitChannelMessage('agent.listening', {
      event: 'agent.listening',
      workspaceId: 'w-riverbend',
      agentId: PEER,
      listening: true,
    });
    expect(frames).toEqual([]);
  });

  it('says nothing when a peer stops listening', async () => {
    const { frames, messages } = renderer();
    await messages.emitChannelMessage('agent.listening', {
      event: 'agent.listening',
      workspaceId: 'w-riverbend',
      agentId: PEER,
      listening: false,
    });
    expect(frames).toEqual([]);
  });

  it('still delivers a peer ATTACHING to the board', async () => {
    // Who can be handed work changed. That is the fact `agent.listening` is
    // not: a socket blinking is not somebody arriving.
    const { frames, messages } = renderer();
    await messages.emitChannelMessage('agent.attached', {
      workspaceId: 'w-riverbend',
      agentId: PEER,
      name: 'Riverbend',
    });
    expect(frames).toHaveLength(1);
    expect(frames[0]?.meta.event).toBe('agent.attached');
  });

  it('still delivers a peer DETACHING from it', async () => {
    const { frames, messages } = renderer();
    await messages.emitChannelMessage('agent.detached', {
      workspaceId: 'w-riverbend',
      agentId: PEER,
      name: 'Riverbend',
    });
    expect(frames).toHaveLength(1);
    expect(frames[0]?.meta.event).toBe('agent.detached');
  });
});

describe('a gap in the event history wakes nobody', () => {
  it('writes no channel line for a gap naming a doc', async () => {
    const { notified, emitted, handle } = handler();
    await handle(wire('replay.gap', { event: 'replay.gap', docId: 'plan', action: 'refetch' }));
    expect(notified).toEqual([]);
    // And it never falls through to the doc renderer, which would make a
    // garbled comment of it.
    expect(emitted).toEqual([]);
  });

  it('writes no channel line for a gap naming a watch key', async () => {
    const { notified, emitted, handle } = handler();
    await handle(
      wire('replay.gap', {
        event: 'replay.gap',
        docId: 'w-riverbend',
        watchKey: 'ws:w-riverbend',
        action: 'refetch',
      }),
    );
    expect(notified).toEqual([]);
    expect(emitted).toEqual([]);
  });

  it('acks nothing — a gap reports the frames it cannot claim to hold', async () => {
    const { sent, handle } = handler();
    await handle(wire('replay.gap', { event: 'replay.gap', docId: 'plan', commentQueueId: 'q1' }));
    expect(sent).toEqual([]);
  });

  it('still delivers the comment that was queued while the stream was gone', async () => {
    // What a gap covers comes back on its own: an addressed comment row stays
    // durable until this process acks it, so the redelivery is a real wake
    // carrying the words. The handler must forward it AND ack it.
    const { emitted, sent, handle } = handler();
    await handle(
      wire('thread.replied', {
        docId: 'plan',
        threadId: 't1',
        workspaceId: 'w-riverbend',
        commentQueueId: 'q1',
        comment: { id: 'c9', author: actor(PERSON), text: 'Missed this one.', ts: FIXED_MS },
      }),
    );
    expect(emitted.map((e) => e.event)).toEqual(['thread.replied']);
    expect(sent).toEqual([
      { method: 'POST', path: '/workspaces/w-riverbend/comment-queue/q1/ack' },
    ]);
  });
});
