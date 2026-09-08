/**
 * The wake path for a row whose BUCKET changes while the row does not.
 *
 * The nudger remembers what it told the lead, and a remembered row is not
 * news — so a row first reported as merely quiet, and then found to be an
 * unfiled ask (its status moved to owner-waiting with nothing filed), has to
 * wake the lead a second time on the strength of the bucket alone. That was
 * the actual failure on 2026-09-04: three rows already remembered under
 * `in-progress` never came back.
 *
 * Fixtures are synthetic; the repo is public.
 */
import { describe, expect, it } from 'bun:test';
import { STALL_EVENT, StallNudger, type StallSnapshot } from '../src/stall-nudge.ts';

const MIN = 60_000;
const now = 5_000 * MIN;

/** A board whose only change is the row's bucket. */
function nudgerHarness(boards: () => StallSnapshot[]) {
  const sent: Array<{ agentId: string; frame: { unfiled?: ReadonlyArray<{ id: string }> } }> = [];
  let clock = now;
  const nudger = new StallNudger({
    now: () => clock,
    snapshot: boards,
    canReach: () => true,
    attachedAgents: () => ['agent-lead'],
    send: (_workspaceId, agentId, frame) => {
      sent.push({ agentId, frame });
      return 1;
    },
    sendToFiler: () => 1,
    report: () => {},
  });
  return {
    sent,
    nudger,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

function snapshot(over: Partial<StallSnapshot>): StallSnapshot {
  return {
    workspaceId: 'w-atlas',
    leadAgentId: 'agent-lead',
    retired: false,
    stalled: [],
    unfiled: [],
    considered: 6,
    undetermined: [],
    ...over,
  };
}

describe('StallNudger — the same row coming back as an unfiled ask', () => {
  it('wakes the lead again, because the bucket changed even though the row did not', () => {
    const row = { id: 't-arm', title: 'Land the R12 standard arm', quietMs: 40 * MIN };
    let phase: 'stalled' | 'unfiled' = 'stalled';
    const { sent, nudger, advance } = nudgerHarness(() =>
      phase === 'stalled'
        ? [snapshot({ stalled: [{ ...row, bucket: 'in-progress' }] })]
        : [snapshot({ unfiled: [{ ...row, bucket: 'blocked-on-owner-unfiled' }] })],
    );

    // Told once, as a quiet row.
    nudger.tick();
    expect(sent).toHaveLength(1);
    // …and not told again while nothing about it changes. Without this the
    // second wake below would prove nothing.
    advance(5 * MIN);
    nudger.tick();
    expect(sent).toHaveLength(1);

    // Now the board says the owner is waiting, and nothing is filed for it.
    phase = 'unfiled';
    advance(5 * MIN);
    nudger.tick();
    expect(sent).toHaveLength(2);
    expect(sent[1]?.frame.unfiled?.map((r) => r.id)).toEqual(['t-arm']);
  });
});

describe('the stall event name is unchanged', () => {
  it('an unfiled-ask wake rides the same frame every lead already reads', () => {
    const { sent, nudger } = nudgerHarness(() => [
      snapshot({
        unfiled: [
          {
            id: 't-arm',
            title: 'Land the R12 standard arm',
            bucket: 'blocked-on-owner-unfiled',
            quietMs: 40 * MIN,
          },
        ],
      }),
    ]);
    nudger.tick();
    expect((sent[0]?.frame as { event?: string }).event).toBe(STALL_EVENT);
  });
});
