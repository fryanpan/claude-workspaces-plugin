/**
 * `agent-spots.ts` on its own: which thread events are an agent pointing,
 * and that one agent's point never erases another's.
 */
import { describe, expect, it } from 'bun:test';
import type { WebhookPayload } from '@claude-workspaces/core';
import { AGENT_SPOTS_FIELD, parseAgentSpots } from '@claude-workspaces/core/workspace-presence';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { createAgentSpots, spotFromThreadEvent } from '../src/agent-spots.ts';

const asDoc = () => 'doc' as const;
const frame = (event: string, author: { id: string; name: string }, inComment: boolean) =>
  ({
    event,
    docId: 'd-harbour',
    threadId: 't-1',
    ...(inComment ? { comment: { author } } : { thread: { comments: [{ author }] } }),
  }) as unknown as WebhookPayload;

describe('agent spots', () => {
  it('reads an agent comment as a point, from a reply or an opener', () => {
    const agent = { id: 'agent-harborlight', name: 'Harborlight' };
    expect(spotFromThreadEvent(frame('thread.replied', agent, true), asDoc)).toEqual({
      agentId: 'agent-harborlight',
      spot: { surface: 'doc', docId: 'd-harbour', threadId: 't-1', name: 'Harborlight' },
    });
    expect(spotFromThreadEvent(frame('thread.created', agent, false), asDoc)?.agentId).toBe(
      'agent-harborlight',
    );
    expect(spotFromThreadEvent(frame('thread.resolved', agent, true), asDoc)).toBeNull();
  });

  it('never reads a person as an agent, whatever their id shape', () => {
    for (const id of ['user-1h6', 'anon-e5s', 'known-reader']) {
      expect(
        spotFromThreadEvent(frame('thread.replied', { id, name: 'Alice' }, true), asDoc),
      ).toBeNull();
    }
  });

  it("keeps each agent's entry, and counts every point", () => {
    const aw = new Awareness(new Y.Doc());
    const spots = createAgentSpots({
      boardsForDoc: () => ['w-open'],
      boardAwareness: () => aw,
      surfaceOf: asDoc,
      listening: () => true,
    });
    spots.point('wb', 'agent-a', { surface: 'whiteboard', docId: 'wb', x: 1, y: 2, name: 'Alice' });
    spots.point('d', 'agent-b', { surface: 'doc', docId: 'd', threadId: 't', name: 'Bob' });
    spots.point('wb', 'agent-a', { surface: 'whiteboard', docId: 'wb', x: 5, y: 6, name: 'Alice' });
    const read = () => parseAgentSpots(aw.getLocalState()?.[AGENT_SPOTS_FIELD]);
    expect(read().get('agent-a')).toMatchObject({ x: 5, seq: 2 });
    expect(read().get('agent-b')).toMatchObject({ threadId: 't', seq: 1 });
    spots.point('wb', 'agent-a', null);
    expect([...read().keys()]).toEqual(['agent-b']);
    aw.destroy();
  });

  it('writes only to boards whose room is open', () => {
    const open = new Awareness(new Y.Doc());
    const spots = createAgentSpots({
      boardsForDoc: () => ['w-open', 'w-closed'],
      boardAwareness: (w) => (w === 'w-open' ? open : null),
      surfaceOf: asDoc,
      listening: () => true,
    });
    spots.onDocEvent('d-harbour', frame('thread.replied', { id: 'agent-x', name: 'X' }, true));
    expect(
      parseAgentSpots(open.getLocalState()?.[AGENT_SPOTS_FIELD]).get('agent-x')?.threadId,
    ).toBe('t-1');
    open.destroy();
  });

  it('publishes to a room that opens after the agent pointed', () => {
    const spots = createAgentSpots({
      boardsForDoc: () => ['w-later'],
      boardAwareness: () => null,
      surfaceOf: asDoc,
      listening: () => true,
    });
    spots.onDocEvent('d-harbour', frame('thread.replied', { id: 'agent-x', name: 'X' }, true));
    const later = new Awareness(new Y.Doc());
    spots.restore('w-later', later);
    expect(
      parseAgentSpots(later.getLocalState()?.[AGENT_SPOTS_FIELD]).get('agent-x'),
    ).toMatchObject({ threadId: 't-1', seq: 1 });
    // A board nobody's agent pointed on gets nothing written.
    const other = new Awareness(new Y.Doc());
    spots.restore('w-other', other);
    expect(other.getLocalState()?.[AGENT_SPOTS_FIELD]).toBeUndefined();
    later.destroy();
    other.destroy();
  });

  it('draws only an agent holding its stream, and redraws when that changes', () => {
    const aw = new Awareness(new Y.Doc());
    const live = new Set(['agent-a']);
    const spots = createAgentSpots({
      boardsForDoc: () => ['w-1'],
      boardAwareness: () => aw,
      surfaceOf: asDoc,
      listening: (_w, id) => live.has(id),
    });
    spots.point('d', 'agent-a', { surface: 'doc', docId: 'd', threadId: 't', name: 'Alice' });
    spots.point('d', 'agent-b', { surface: 'doc', docId: 'd', threadId: 'u', name: 'Bob' });
    const read = () => [...parseAgentSpots(aw.getLocalState()?.[AGENT_SPOTS_FIELD]).keys()];
    expect(read()).toEqual(['agent-a']);
    live.add('agent-b');
    live.delete('agent-a');
    spots.streamsChanged('w-1');
    expect(read()).toEqual(['agent-b']);
    aw.destroy();
  });
});
