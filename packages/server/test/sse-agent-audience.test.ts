/**
 * A broadcast that pages and only SOME agents may hear: an addressed comment
 * on a board channel. Pages see it live and on replay; an agent outside the
 * audience sees it neither way, and its cursor stays up to date.
 */
import { describe, expect, it } from 'bun:test';
import { SseBus } from '../src/sse.ts';

const sinkOf = (log: string[]) => ({
  write: (event: string) => {
    log.push(event);
  },
  close: () => {},
});

describe('SseBus.broadcast with an agent audience', () => {
  it('reaches pages and the named agent, and skips every other agent stream', () => {
    const bus = new SseBus();
    const page: string[] = [];
    const named: string[] = [];
    const other: string[] = [];
    bus.add('ws~b1', sinkOf(page));
    bus.add('ws~b1', sinkOf(named), undefined, 'agent-riverbend');
    bus.add('ws~b1', sinkOf(other), undefined, 'agent-harborlight');
    bus.broadcast('ws~b1', { event: 'thread.created' }, undefined, {
      agentAudience: ['agent-riverbend'],
    });
    expect(page).toEqual(['thread.created']);
    expect(named).toEqual(['thread.created']);
    expect(other).toEqual([]);
  });

  it('skips a sink whose forSink answers null', () => {
    const bus = new SseBus();
    const a: string[] = [];
    const b: string[] = [];
    bus.add('ws~b1', sinkOf(a), undefined, 'agent-a');
    bus.add('ws~b1', sinkOf(b), undefined, 'agent-b');
    bus.broadcast('ws~b1', { event: 'thread.created' }, (who) =>
      who.agentId === 'agent-b' ? null : undefined,
    );
    expect(a).toEqual(['thread.created']);
    expect(b).toEqual([]);
  });

  it('replays to pages and the named agent only, and leaves a bystander current', () => {
    const bus = new SseBus();
    bus.broadcast('ws~b1', { event: 'task.created' });
    const before = bus.lastIdOn('ws~b1') ?? '';
    bus.broadcast('ws~b1', { event: 'thread.created' }, undefined, {
      agentAudience: ['agent-riverbend'],
    });
    const forPage = bus.replayAfter('ws~b1', before);
    const forNamed = bus.replayAfter('ws~b1', before, 'agent-riverbend');
    const forOther = bus.replayAfter('ws~b1', before, 'agent-harborlight');
    expect(forPage.ok && forPage.events.map((e) => e.payload.event)).toEqual(['thread.created']);
    expect(forNamed.ok && forNamed.events.map((e) => e.payload.event)).toEqual(['thread.created']);
    expect(forOther.ok && forOther.events).toEqual([]);
  });
});
