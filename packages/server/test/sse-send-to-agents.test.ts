/**
 * `SseBus.sendToAgents`: one frame to several agents, buffered once.
 *
 * Sending the same frame with `sendToAgent` once per addressee buffered one
 * entry per addressee under a single id. A reconnect anchors on the first
 * entry with that id, so the second addressee was replayed its own frame.
 */
import { describe, expect, it } from 'bun:test';
import { SseBus } from '../src/sse.ts';

const CH = 'ws~send-to-agents';

type Written = { event: string; data: Record<string, unknown>; id?: string };
const sinkOf = (log: Written[]) => ({
  write: (event: string, data: unknown, id?: string) => {
    log.push({ event, data: data as Record<string, unknown>, ...(id !== undefined ? { id } : {}) });
  },
  close: () => {},
});

describe('SseBus.sendToAgents', () => {
  it('gives each live addressee its own copy under one id, and nobody else a copy', () => {
    const bus = new SseBus();
    const a: Written[] = [];
    const b: Written[] = [];
    const page: Written[] = [];
    bus.add(CH, sinkOf(a), undefined, 'agent-a');
    bus.add(CH, sinkOf(b), undefined, 'agent-b');
    bus.add(CH, sinkOf(page));

    const reached = bus.sendToAgents(
      CH,
      ['agent-a', 'agent-b', 'agent-away'],
      { event: 'thread.created' },
      (agentId) => ({ event: 'thread.created', row: `row-${agentId}` }) as never,
    );

    expect([...reached].sort()).toEqual(['agent-a', 'agent-b']);
    expect(a.map((w) => w.data.row)).toEqual(['row-agent-a']);
    expect(b.map((w) => w.data.row)).toEqual(['row-agent-b']);
    expect(a[0]?.id).toBe(b[0]?.id as string);
    expect(page).toEqual([]);
  });

  it('buffers one entry, so a reconnect at that id replays nothing to any addressee', () => {
    const bus = new SseBus();
    bus.broadcast(CH, { event: 'task.created' });
    const anchor = bus.lastIdOn(CH) as string;
    bus.sendToAgents(
      CH,
      ['agent-a', 'agent-b'],
      { event: 'thread.created' },
      (agentId) =>
        ({
          event: 'thread.created',
          row: agentId,
        }) as never,
    );
    expect(bus.eventsOn(CH)).toHaveLength(2);
    const sent = bus.lastIdOn(CH) as string;

    for (const agentId of ['agent-a', 'agent-b']) {
      // The frame this agent already holds is not handed back to it.
      expect(bus.replayAfter(CH, sent, agentId)).toEqual({ ok: true, events: [] });
      // From before it, the agent catches up on the base payload, once.
      const caught = bus.replayAfter(CH, anchor, agentId);
      expect(caught.ok && caught.events.map((e) => e.payload)).toEqual([
        { event: 'thread.created' },
      ]);
    }
    // POSITIVE CONTROL: the same two sends made one per addressee leave two
    // entries, and the second addressee is replayed its own frame.
    const old = new SseBus();
    const frame = { event: 'thread.created', eid: 'e-1' } as never;
    old.sendToAgent(CH, 'agent-a', frame);
    old.sendToAgent(CH, 'agent-b', frame);
    const replayed = old.replayAfter(CH, 'e-1', 'agent-b');
    expect(replayed.ok && replayed.events).toHaveLength(1);
    // A page and a bystander agent replay none of it.
    const pageReplay = bus.replayAfter(CH, anchor);
    expect(pageReplay.ok && pageReplay.events).toEqual([]);
    const bystander = bus.replayAfter(CH, anchor, 'agent-c');
    expect(bystander.ok && bystander.events).toEqual([]);
  });

  it('an empty addressee list sends and buffers nothing', () => {
    const bus = new SseBus();
    expect(bus.sendToAgents(CH, [], { event: 'x' }, () => ({ event: 'x' })).size).toBe(0);
    expect(bus.eventsOn(CH)).toHaveLength(0);
  });
});
