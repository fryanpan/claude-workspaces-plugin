/**
 * A wake nobody took stays owed.
 *
 * `send` reports how many streams took the frame. The nudger used to throw
 * that number away and record the board as told, so a lead whose stream had
 * closed between the reachability check and the write came back to a board
 * that had decided it told them, and heard nothing for a repeat window.
 * Measured 2026-09-11: nineteen wake lines for one board in seven hours, four
 * frames in the lead's transcript.
 */
import { describe, expect, it } from 'vitest';
import type { StalledRow } from '../src/stall-gate.ts';
import { type StallNudgeFrame, StallNudger } from '../src/stall-nudge.ts';

const MIN = 60_000;

function harness(streams: { value: number }) {
  const world = { now: 1_000_000, stalled: [] as StalledRow[] };
  const sent: StallNudgeFrame[] = [];
  const lines: string[] = [];
  const nudger = new StallNudger({
    now: () => world.now,
    snapshot: () => [
      {
        workspaceId: 'w-riverbend',
        leadAgentId: 'agent-cartographer',
        retired: false,
        stalled: world.stalled,
        unfiled: [],
        considered: 1,
        undetermined: [],
      },
    ],
    canReach: () => true,
    send: (_workspaceId, _agentId, frame) => {
      sent.push(frame);
      return streams.value;
    },
    report: (line) => {
      lines.push(line);
    },
  });
  return { world, sent, lines, nudger };
}

const QUIET: StalledRow = {
  id: 't-1',
  title: 'Rebuild the Riverbend index nightly',
  bucket: 'in-progress',
  quietMs: 21 * MIN,
};

describe('a wake that reached no stream', () => {
  it('is reported as undelivered and said again once a stream takes it', () => {
    const streams = { value: 0 };
    const { world, sent, lines, nudger } = harness(streams);
    world.stalled = [QUIET];
    nudger.tick();
    expect(sent).toHaveLength(1);
    expect(lines.filter((l) => l.startsWith('[stall] wake ws='))).toEqual([]);
    expect(lines.some((l) => l.startsWith('[stall] wake undelivered ws=w-riverbend'))).toBe(true);
    streams.value = 1;
    world.now += MIN;
    nudger.tick();
    expect(sent).toHaveLength(2);
    expect(lines.filter((l) => l.startsWith('[stall] wake ws=w-riverbend'))).toHaveLength(1);
    expect(lines.at(-1)).toContain('streams=1');
  });

  it('control: a delivered wake is not said again on the next tick', () => {
    const streams = { value: 1 };
    const { world, sent, nudger } = harness(streams);
    world.stalled = [QUIET];
    nudger.tick();
    world.now += MIN;
    nudger.tick();
    expect(sent).toHaveLength(1);
  });
});
