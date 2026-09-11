/**
 * A reconnect is not news, and the board should never hear about one.
 *
 * These drive `ListeningAnnouncer` directly with an injected clock rather
 * than through a real socket, because the behaviour under test is WHEN it
 * speaks, and a real stream would make that a wall-clock assertion.
 */
import { describe, expect, test } from 'vitest';
import {
  type AgentListeningFrame,
  type AnnouncerTimers,
  LISTENING_DEPARTURE_GRACE_MS,
  ListeningAnnouncer,
} from '../src/agent-listening.ts';

/** A clock the test advances by hand. */
function fakeTimers(): AnnouncerTimers & { advance(ms: number): void; pending(): number } {
  let now = 0;
  let seq = 0;
  const due = new Map<number, { at: number; run: () => void }>();
  return {
    schedule(run, ms) {
      const id = ++seq;
      due.set(id, { at: now + ms, run });
      return id;
    },
    cancel(handle) {
      due.delete(handle as number);
    },
    advance(ms) {
      now += ms;
      for (const [id, entry] of [...due.entries()]) {
        if (entry.at <= now) {
          due.delete(id);
          entry.run();
        }
      }
    },
    pending: () => due.size,
  };
}

function announcer(): {
  a: ListeningAnnouncer;
  sent: AgentListeningFrame[];
  clock: ReturnType<typeof fakeTimers>;
} {
  const sent: AgentListeningFrame[] = [];
  const clock = fakeTimers();
  const a = new ListeningAnnouncer((f) => sent.push(f), LISTENING_DEPARTURE_GRACE_MS, clock);
  return { a, sent, clock };
}

describe('a listening change is announced once, and only when it is one', () => {
  test('a reconnect inside the grace window says NOTHING — not a departure, not an arrival', () => {
    const { a, sent, clock } = announcer();
    a.observe('w1', 'agent-a', true);
    expect(sent).toEqual([
      { event: 'agent.listening', workspaceId: 'w1', agentId: 'agent-a', listening: true },
    ]);

    sent.length = 0;
    a.observe('w1', 'agent-a', false); // the socket dropped
    clock.advance(LISTENING_DEPARTURE_GRACE_MS - 1);
    a.observe('w1', 'agent-a', true); // and came straight back
    clock.advance(LISTENING_DEPARTURE_GRACE_MS * 10);

    expect(sent).toEqual([]);
    expect(clock.pending()).toBe(0);
  });

  test('an agent that really goes still disappears, once the window passes', () => {
    const { a, sent, clock } = announcer();
    a.observe('w1', 'agent-a', true);
    sent.length = 0;

    a.observe('w1', 'agent-a', false);
    expect(sent).toEqual([]); // held, not dropped

    clock.advance(LISTENING_DEPARTURE_GRACE_MS);
    expect(sent).toEqual([
      { event: 'agent.listening', workspaceId: 'w1', agentId: 'agent-a', listening: false },
    ]);
  });

  test('a second arrival for an agent already announced is silent', () => {
    const { a, sent } = announcer();
    a.observe('w1', 'agent-a', true);
    sent.length = 0;
    a.observe('w1', 'agent-a', true);
    a.observe('w1', 'agent-a', true);
    expect(sent).toEqual([]);
  });

  test('a departure for an agent nobody was told about is silent', () => {
    const { a, sent, clock } = announcer();
    a.observe('w1', 'never-seen', false);
    clock.advance(LISTENING_DEPARTURE_GRACE_MS * 10);
    expect(sent).toEqual([]);
  });

  test('two boards are tracked apart — one blip cannot silence the other', () => {
    const { a, sent, clock } = announcer();
    a.observe('w1', 'agent-a', true);
    a.observe('w2', 'agent-a', true);
    expect(sent.map((f) => f.workspaceId)).toEqual(['w1', 'w2']);

    sent.length = 0;
    a.observe('w1', 'agent-a', false); // drops on w1 only
    clock.advance(LISTENING_DEPARTURE_GRACE_MS);
    expect(sent).toEqual([
      { event: 'agent.listening', workspaceId: 'w1', agentId: 'agent-a', listening: false },
    ]);
  });

  test('two agents on one board are tracked apart', () => {
    const { a, sent, clock } = announcer();
    // Assert BOTH arrivals land. Without this the case passed while the
    // announcer keyed on the board alone and suppressed b entirely — the
    // second agent's circle would never have been drawn, and the test said
    // nothing, because it only ever looked at what happened afterwards.
    a.observe('w1', 'agent-a', true);
    a.observe('w1', 'agent-b', true);
    expect(sent.map((f) => f.agentId)).toEqual(['agent-a', 'agent-b']);

    sent.length = 0;
    a.observe('w1', 'agent-a', false);
    a.observe('w1', 'agent-a', true); // a reconnects
    clock.advance(LISTENING_DEPARTURE_GRACE_MS);
    expect(sent).toEqual([]); // and b is untouched either way

    // b leaving is still b's own departure, not a's.
    a.observe('w1', 'agent-b', false);
    clock.advance(LISTENING_DEPARTURE_GRACE_MS);
    expect(sent).toEqual([
      { event: 'agent.listening', workspaceId: 'w1', agentId: 'agent-b', listening: false },
    ]);
  });

  test('stop() leaves no timer behind to fire after the bus is gone', () => {
    const { a, sent, clock } = announcer();
    a.observe('w1', 'agent-a', true);
    sent.length = 0;
    a.observe('w1', 'agent-a', false);
    expect(clock.pending()).toBe(1);

    a.stop();
    clock.advance(LISTENING_DEPARTURE_GRACE_MS * 10);
    expect(clock.pending()).toBe(0);
    expect(sent).toEqual([]);
  });

  test('a departed agent leaves no entry behind, so the map cannot only grow', () => {
    const { a, sent, clock } = announcer();
    // Churn a hundred distinct agents through arrive-and-leave. Nothing they
    // leave behind may accumulate: absence already means not-announced, so a
    // remembered `false` would be a second spelling of the same fact that
    // nothing ever removes — one entry per agent-board pairing the process
    // ever saw, for the life of the process.
    for (let i = 0; i < 100; i++) {
      a.observe('w1', `agent-${i}`, true);
      a.observe('w1', `agent-${i}`, false);
    }
    clock.advance(LISTENING_DEPARTURE_GRACE_MS);
    expect(sent).toHaveLength(200); // every arrival and every departure said
    expect(a.trackedCount()).toBe(0);

    // And one still here is still tracked — the count is not just always 0.
    a.observe('w1', 'agent-stays', true);
    expect(a.trackedCount()).toBe(1);
  });

  test('the window is longer than the client’s first reconnect draw', async () => {
    // The MCP client draws its first retry from [0, RECONNECT_BASE_MS) with
    // full jitter. A grace shorter than that whole window would announce
    // departures the client is already on its way back from, which is the
    // bug this fix exists to remove — so this is a real constraint between
    // two modules, not a restatement of the constant.
    const { RECONNECT_BASE_MS } = await import('../../mcp/src/backoff.ts');
    expect(LISTENING_DEPARTURE_GRACE_MS).toBeGreaterThan(RECONNECT_BASE_MS);
  });
});
