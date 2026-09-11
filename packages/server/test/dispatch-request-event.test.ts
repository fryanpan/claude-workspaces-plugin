/**
 * The dispatch timing marker, away from the server.
 *
 * Two properties matter more than the event's shape and are asserted here
 * because a route test cannot see either directly: the emit does NOT happen
 * inside the caller's call (so nothing in the dispatch path waits on it), and
 * an emit that throws is absorbed (so a broken audit log cannot turn a
 * dispatch into an error).
 */
import { describe, expect, it } from 'bun:test';
import {
  DISPATCH_REASON_MAX,
  type DispatchEventSink,
  buildDispatchRequestedEvent,
  normalizeDispatchReason,
  recordDispatchRequested,
} from '../src/dispatch-request-event.ts';
import type { TaskStoreEvent } from '../src/tasks.ts';

/** A sink that remembers, or a sink that breaks. */
function collector(): { sink: DispatchEventSink; seen: TaskStoreEvent[] } {
  const seen: TaskStoreEvent[] = [];
  return { sink: { emit: (e) => void seen.push(e) }, seen };
}

const THROWING: DispatchEventSink = {
  emit: () => {
    throw new Error('audit log is a directory (test)');
  },
};

const BASE = {
  workspaceId: 'w-test',
  taskId: 't-riverbend',
  outcome: 'registered' as const,
  ts: 1_700_000_000_000,
};

describe('dispatch.requested — what the event carries', () => {
  it('carries the task, the reason and the outcome', () => {
    const ev = buildDispatchRequestedEvent({
      ...BASE,
      reason: 'next in the goal band',
      agentName: 'harborlight-builder',
      actor: { id: 'agent-lead', name: 'Lead', kind: 'known' },
    });
    expect(ev.type).toBe('dispatch.requested');
    expect(ev.taskId).toBe('t-riverbend');
    expect(ev.reason).toBe('next in the goal band');
    expect(ev.outcome).toBe('registered');
    expect(ev.agentName).toBe('harborlight-builder');
    expect(ev.ts).toBe(BASE.ts);
  });

  it('records a request the cap refused, which is the leg it exists to date', () => {
    const ev = buildDispatchRequestedEvent({ ...BASE, outcome: 'cap-reached' });
    expect(ev.outcome).toBe('cap-reached');
    expect(ev.taskId).toBe('t-riverbend');
  });

  it('reads an author as an agent unless it says person', () => {
    // `register_dispatch` has no browser affordance: every caller is a lead
    // session, and `known` on the wire is about proof, not about species.
    expect(
      buildDispatchRequestedEvent({ ...BASE, actor: { id: 'a', name: 'A', kind: 'known' } }).actor
        ?.kind,
    ).toBe('agent');
    expect(
      buildDispatchRequestedEvent({ ...BASE, actor: { id: 'p', name: 'P', kind: 'person' } }).actor
        ?.kind,
    ).toBe('person');
  });

  it('leaves out a reason nobody gave rather than writing an empty one', () => {
    expect(buildDispatchRequestedEvent({ ...BASE, reason: '   ' }).reason).toBeUndefined();
    expect(buildDispatchRequestedEvent(BASE).reason).toBeUndefined();
    expect(normalizeDispatchReason(42)).toBeUndefined();
  });

  it('cuts a runaway reason instead of letting it into the audit log', () => {
    const ev = buildDispatchRequestedEvent({ ...BASE, reason: 'x'.repeat(2000) });
    expect(ev.reason?.length).toBe(DISPATCH_REASON_MAX);
  });
});

describe('dispatch.requested — the dispatch never waits on it and never fails for it', () => {
  it('emits nothing inside the call that asks for it', () => {
    // The default scheduler, deliberately: this is the assertion that the
    // dispatch path gained no blocking write. If the emit were inline, the
    // event would already be in `seen` when `recordDispatchRequested` returns.
    const { sink, seen } = collector();
    recordDispatchRequested(sink, BASE);
    expect(seen).toHaveLength(0);
  });

  it('does emit once the caller has moved on', async () => {
    // The positive control for the test above — otherwise "nothing emitted
    // yet" would pass just as well for an event that never lands at all.
    const { sink, seen } = collector();
    recordDispatchRequested(sink, BASE);
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.type).toBe('dispatch.requested');
  });

  it('absorbs an emit that throws after the caller has gone', () => {
    // The scheduler HOLDS the work rather than running it, which is what the
    // real timer does: by the time the emit runs, the caller's stack is gone
    // and the only thing that can absorb a throw is the module itself. Running
    // it inline instead would let the outer guard catch it and prove nothing —
    // it did exactly that, and the mutation that deletes the inner catch
    // passed until this test stopped running the emit in hand.
    let deferred: (() => void) | undefined;
    recordDispatchRequested(THROWING, BASE, (run) => {
      deferred = run;
    });
    expect(deferred).toBeDefined();
    expect(() => deferred?.()).not.toThrow();
  });

  it('absorbs a scheduler that throws', () => {
    const exploding = (): void => {
      throw new Error('no timers left (test)');
    };
    const { sink } = collector();
    expect(() => recordDispatchRequested(sink, BASE, exploding)).not.toThrow();
  });
});
