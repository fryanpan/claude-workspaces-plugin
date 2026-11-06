/**
 * `agent-spots.ts` on its own: one agent's point never erases another's, a
 * point waits for a board whose room is not open, and only an agent holding
 * its stream is drawn. That a comment is not a point is
 * `workspace-presence-room.test.ts`, over the real server.
 */
import { describe, expect, it } from 'bun:test';
import { AGENT_SPOTS_FIELD, parseAgentSpots } from '@claude-workspaces/core/workspace-presence';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { createAgentSpots } from '../src/agent-spots.ts';

const at = { surface: 'doc' as const, docId: 'd-harbour', threadId: 't-1', name: 'X' };

describe('agent spots', () => {
  it("keeps each agent's entry, and counts every point", () => {
    const aw = new Awareness(new Y.Doc());
    const spots = createAgentSpots({
      boardsForDoc: () => ['w-open'],
      boardAwareness: () => aw,
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
      listening: () => true,
    });
    spots.point('d-harbour', 'agent-x', at);
    expect(
      parseAgentSpots(open.getLocalState()?.[AGENT_SPOTS_FIELD]).get('agent-x')?.threadId,
    ).toBe('t-1');
    open.destroy();
  });

  it('publishes to a room that opens after the agent pointed', () => {
    const spots = createAgentSpots({
      boardsForDoc: () => ['w-later'],
      boardAwareness: () => null,
      listening: () => true,
    });
    spots.point('d-harbour', 'agent-x', at);
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
