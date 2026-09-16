import { describe, expect, it } from 'bun:test';
import { commentOfEvent, handedToAgent } from '../src/comment-receipt.ts';

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
