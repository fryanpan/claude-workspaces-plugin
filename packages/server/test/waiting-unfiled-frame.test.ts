/**
 * The ONE fleet frame Team Lead is woken with about unfiled waits.
 *
 * Driven directly rather than through the escalation, because the shape is
 * the finding: a frame tagged with one board named rows from three, and the
 * receiving lead could only tell which row was its own by recognising an id
 * (2026-09-17). The escalation's own suite proves the wiring; this proves
 * what a reader gets.
 *
 * Fixtures are synthetic — invented boards and titles. The repo is public.
 */
import { describe, expect, it } from 'bun:test';
import { STALL_EVENT } from '../src/stall-nudge.ts';
import { buildFleetFrame } from '../src/waiting-unfiled-frame.ts';
import type { AgingWait } from '../src/waiting-unfiled-review.ts';
import { WAITING_UNFILED_BUCKET } from '../src/waiting-unfiled.ts';

const MIN = 60_000;
const NOW = 10_000_000;

const wait = (over: Partial<AgingWait> = {}): AgingWait => ({
  workspaceId: 'w-harbor',
  taskId: 't-ferry',
  title: 'Publish the winter timetable',
  bucket: WAITING_UNFILED_BUCKET,
  quietMs: 45 * MIN,
  firstSeen: NOW - 90 * MIN,
  tells: 0,
  leadAgentId: 'agent-cartographer',
  ...over,
});

const WINDOW = 30 * MIN;

describe('the fleet frame', () => {
  it('rides the stall event every lead already reads, anchored on the first row', () => {
    const frame = buildFleetFrame({
      due: [wait()],
      onBoard: 'w-elsewhere',
      now: NOW,
      agingMs: WINDOW,
    });

    expect(frame.event).toBe(STALL_EVENT);
    // The anchor's board, not the board the wake is delivered on.
    expect(frame.workspaceId).toBe('w-harbor');
    expect(frame.taskId).toBe('t-ferry');
    expect(frame.ts).toBe(NOW);
    // Nothing is claimed to be stalled: this frame is about unfiled asks.
    expect(frame.stalledCount).toBe(0);
    expect(frame.consideredCount).toBe(1);
  });

  it('gives every row its OWN board, so a fanned-in frame is readable', () => {
    const frame = buildFleetFrame({
      due: [wait(), wait({ workspaceId: 'w-riverbend', taskId: 't-berth' })],
      onBoard: 'w-harbor',
      now: NOW,
      agingMs: WINDOW,
    });

    const rows = frame.unfiled ?? [];
    expect(rows.map((r) => r.workspaceId)).toEqual(['w-harbor', 'w-riverbend']);
    // The fan-in is the design: one wake, both boards.
    expect(rows.map((r) => r.id)).toEqual(['t-ferry', 't-berth']);
    expect(rows.map((r) => r.bucket)).toEqual([WAITING_UNFILED_BUCKET, WAITING_UNFILED_BUCKET]);
    expect(rows.map((r) => r.quietMs)).toEqual([45 * MIN, 45 * MIN]);
  });

  it('falls back to the delivery board only when there is no row to anchor on', () => {
    const frame = buildFleetFrame({ due: [], onBoard: 'w-elsewhere', now: NOW, agingMs: WINDOW });

    expect(frame.workspaceId).toBe('w-elsewhere');
    expect(frame.taskId).toBeUndefined();
    expect(frame.unfiled).toEqual([]);
  });
});

/**
 * The step of the ladder this frame IS. Team Lead reads a stall event tagged
 * with a board it is not on; without this field the only other frame that
 * does that — the dead-board redirect — is indistinguishable from it, and a
 * lead spent a whole turn on 2026-09-22 deciding which one it had.
 */
describe('the fleet frame says which rung it is', () => {
  it('names the window each row already spent and every board lead that was told', () => {
    const frame = buildFleetFrame({
      due: [
        wait(),
        wait({
          workspaceId: 'w-riverbend',
          taskId: 't-berth',
          leadAgentId: 'agent-harbour-master',
        }),
      ],
      onBoard: 'w-elsewhere',
      now: NOW,
      agingMs: WINDOW,
    });

    expect(frame.unfiledCarry?.toldAtLeastMs).toBe(WINDOW);
    expect(frame.unfiledCarry?.boards).toEqual([
      { workspaceId: 'w-harbor', leadAgentId: 'agent-cartographer' },
      { workspaceId: 'w-riverbend', leadAgentId: 'agent-harbour-master' },
    ]);
    // The redirect's marker is the OTHER frame's; carrying both would make
    // the child render two contradictory first lines.
    expect(frame.escalatedFrom).toBeUndefined();
  });

  it('names a board once however many of its rows are due, and admits a board with no lead', () => {
    const frame = buildFleetFrame({
      due: [
        wait(),
        wait({ taskId: 't-slip' }),
        wait({ workspaceId: 'w-saltmarsh', taskId: 't-tide', leadAgentId: undefined }),
      ],
      onBoard: 'w-harbor',
      now: NOW,
      agingMs: WINDOW,
    });

    expect(frame.unfiledCarry?.boards).toEqual([
      { workspaceId: 'w-harbor', leadAgentId: 'agent-cartographer' },
      { workspaceId: 'w-saltmarsh' },
    ]);
  });

  it('carries nothing to say when no row is due', () => {
    const frame = buildFleetFrame({ due: [], onBoard: 'w-elsewhere', now: NOW, agingMs: WINDOW });
    expect(frame.unfiledCarry).toBeUndefined();
    // POSITIVE CONTROL: the same builder with one row does carry it, so the
    // absence above is the empty list and not a field nobody ever sets.
    expect(
      buildFleetFrame({ due: [wait()], onBoard: 'w-elsewhere', now: NOW, agingMs: WINDOW })
        .unfiledCarry,
    ).toBeDefined();
  });
});
