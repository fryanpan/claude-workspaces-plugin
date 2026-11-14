/**
 * A comment addressed to somebody else does not wake this session. The doc
 * channel cannot drop it server-side (code-health.md: `skipAgentStreams` is
 * exact only on board channels), so the MCP child drops it here.
 */
import { describe, expect, it } from 'vitest';
import { type ChannelNotification, createChannelMessages } from '../src/channel-messages.ts';

const SELF = 'agent-harborlight';
const OTHER = 'agent-riverbend';
const PERSON = { id: 'user-alice', name: 'Alice', kind: 'known' as const };

function harness(authorId = SELF) {
  const frames: ChannelNotification['params'][] = [];
  const messages = createChannelMessages({
    notify: async (n) => {
      frames.push(n.params);
    },
    http: async () => ({}),
    authorId,
    now: () => Date.UTC(2026, 10, 13, 12, 0, 0),
  });
  return { frames, messages };
}

const reply = (addressedTo?: Array<{ id: string; kind: string; name: string }>) => ({
  docId: 'd1',
  threadId: 'th1',
  comment: {
    id: 'c1',
    author: PERSON,
    text: 'A reply.',
    ts: 1,
    ...(addressedTo ? { addressedTo } : {}),
  },
});
const created = (addressedTo: Array<{ id: string; kind: string; name: string }>) => ({
  docId: 'd1',
  threadId: 'th2',
  thread: { comments: [{ id: 'c2', author: PERSON, text: 'New.', ts: 1, addressedTo }] },
});

describe('a doc-channel comment addressed to somebody else', () => {
  it('is dropped when it names another agent or only people', async () => {
    const { frames, messages } = harness();
    await messages.emitChannelMessage(
      'thread.replied',
      reply([{ id: OTHER, kind: 'agent', name: 'Riverbend' }]),
    );
    await messages.emitChannelMessage(
      'thread.created',
      created([{ id: 'user-bob', kind: 'person', name: 'Bob' }]),
    );
    expect(frames).toEqual([]);
  });

  it('is delivered when it names this agent, and when it names nobody', async () => {
    const { frames, messages } = harness();
    await messages.emitChannelMessage(
      'thread.replied',
      reply([
        { id: 'user-bob', kind: 'person', name: 'Bob' },
        { id: SELF, kind: 'agent', name: 'Harborlight' },
      ]),
    );
    await messages.emitChannelMessage('thread.created', {
      ...created([]),
      thread: { comments: [{ id: 'c3', author: PERSON, text: 'Open.', ts: 1 }] },
    });
    await messages.emitChannelMessage('thread.replied', reply());
    expect(frames).toHaveLength(3);
  });
});
