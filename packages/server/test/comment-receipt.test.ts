import { describe, expect, it } from 'bun:test';
import {
  type DeliveredFrame,
  commentIdOfReplay,
  commentOfEvent,
  handedToAgent,
  recordDelivery,
} from '../src/comment-receipt.ts';

const probe = (live: Record<string, string[]>, author = 'agent-author') => ({
  agentsOn: (channel: string): string[] => live[channel] ?? [],
  isAuthor: (agentId: string): boolean => agentId === author,
});

describe('handedToAgent', () => {
  it('is false when no session is holding any of the channels', () => {
    expect(handedToAgent(['doc-1', 'ws~w-1'], probe({}))).toBe(false);
  });

  it('is true when a session is live on the board channel', () => {
    expect(handedToAgent(['doc-1', 'ws~w-1'], probe({ 'ws~w-1': ['agent-lead'] }))).toBe(true);
  });

  it('is true when the session is live on the doc own channel instead', () => {
    expect(handedToAgent(['doc-1', 'ws~w-1'], probe({ 'doc-1': ['agent-lead'] }))).toBe(true);
  });

  it('does not count the author own session as a delivery', () => {
    expect(handedToAgent(['ws~w-1'], probe({ 'ws~w-1': ['agent-author'] }))).toBe(false);
  });

  it('counts a peer live beside the author', () => {
    expect(handedToAgent(['ws~w-1'], probe({ 'ws~w-1': ['agent-author', 'agent-peer'] }))).toBe(
      true,
    );
  });

  it('asks every channel, not only the first', () => {
    expect(handedToAgent(['doc-1', 'ws~w-1'], probe({ 'ws~w-1': ['agent-peer'] }))).toBe(true);
  });
});

describe('commentOfEvent', () => {
  const comment = { id: 'c-2', author: { id: 'u-1', name: 'Bryan' }, text: 'here' };

  it('takes the comment a reply carries', () => {
    const payload = { event: 'thread.replied', comment };
    expect(commentOfEvent(payload)?.id).toBe('c-2');
  });

  it('falls back to the newest comment on a thread.created', () => {
    const payload = {
      event: 'thread.created',
      thread: { comments: [{ id: 'c-1' }, { id: 'c-2' }] },
    };
    expect(commentOfEvent(payload)?.id).toBe('c-2');
  });

  it('names no comment for a state change', () => {
    for (const event of ['thread.resolved', 'thread.reopened', 'suggestion.accepted']) {
      expect(commentOfEvent({ event, comment })).toBeUndefined();
    }
  });

  it('names no comment when a created thread arrived with none', () => {
    expect(commentOfEvent({ event: 'thread.created', thread: { comments: [] } })).toBeUndefined();
  });
});

/** A sink that remembers what it was asked to write and to announce. */
function sink(verdict: 'stamped' | 'already' | 'gone' = 'stamped') {
  const told: Array<{ channel: string; frame: DeliveredFrame }> = [];
  const wrote: string[] = [];
  return {
    told,
    wrote,
    markDelivered: (docId: string, threadId: string, commentId: string) => {
      wrote.push(`${docId}/${threadId}/${commentId}`);
      return verdict;
    },
    announce: (channel: string, frame: DeliveredFrame) => {
      told.push({ channel, frame });
    },
  };
}

const args = {
  docId: 'd-1',
  threadId: 't-1',
  commentId: 'c-1',
  channels: ['d-1', 'ws~w-1', 'ws~w-2'],
  at: 1_700_000_000_000,
};

describe('recordDelivery', () => {
  it('writes the stamp once and tells every channel the comment travelled on', () => {
    const s = sink();
    expect(recordDelivery(args, s)).toBe(true);
    expect(s.wrote).toEqual(['d-1/t-1/c-1']);
    expect(s.told.map((t) => t.channel)).toEqual(['d-1', 'ws~w-1', 'ws~w-2']);
  });

  it('describes the delivery in the frame every page reads', () => {
    const s = sink();
    recordDelivery(args, s);
    expect(s.told[0]?.frame).toEqual({
      event: 'comment.delivered',
      docId: 'd-1',
      threadId: 't-1',
      commentId: 'c-1',
      deliveredAt: 1_700_000_000_000,
    });
  });

  it('tells a repeated channel once, so one page is not sent the same news twice', () => {
    const s = sink();
    recordDelivery({ ...args, channels: ['ws~w-1', 'ws~w-1', 'd-1'] }, s);
    expect(s.told.map((t) => t.channel)).toEqual(['ws~w-1', 'd-1']);
  });

  it('announces nothing when the comment was already stamped', () => {
    const s = sink('already');
    expect(recordDelivery(args, s)).toBe(false);
    expect(s.told).toEqual([]);
  });

  it('announces nothing when the doc is no longer resident', () => {
    const s = sink('gone');
    expect(recordDelivery(args, s)).toBe(false);
    expect(s.told).toEqual([]);
  });
});

describe('commentIdOfReplay', () => {
  it('reads the id off a replayed reply', () => {
    expect(commentIdOfReplay({ event: 'thread.replied', comment: { id: 'c-9' } })).toBe('c-9');
  });

  it('reads the newest comment off a replayed thread.created', () => {
    expect(
      commentIdOfReplay({
        event: 'thread.created',
        thread: { comments: [{ id: 'a' }, { id: 'b' }] },
      }),
    ).toBe('b');
  });

  it('answers undefined for a row whose payload is missing or is not a comment event', () => {
    expect(commentIdOfReplay(undefined)).toBeUndefined();
    expect(commentIdOfReplay('{}')).toBeUndefined();
    expect(commentIdOfReplay({ event: 'thread.resolved', comment: { id: 'c-9' } })).toBeUndefined();
    expect(commentIdOfReplay({ event: 'thread.replied', comment: { id: 7 } })).toBeUndefined();
  });
});
