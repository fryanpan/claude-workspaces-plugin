import { describe, expect, it } from 'bun:test';
/**
 * The words on the fleet-wide unfiled-wait item, driven directly.
 *
 * The escalation's own suite reads these words back off a filed review item,
 * which proves the wiring; this drives the renderer itself, so a change to the
 * sentence a person reads fails here with the sentence in the message rather
 * than three layers down.
 *
 * Fixtures are synthetic — invented boards and titles. The repo is public.
 */
import { OWNER_UNFILED_BUCKET } from '../src/stall-gate.ts';
import { type AgingWait, buildWaitingUnfiledReview } from '../src/waiting-unfiled-review.ts';
import { WAITING_UNFILED_BUCKET } from '../src/waiting-unfiled.ts';

const MIN = 60_000;
const NOW = 10_000_000;

const row = (over: Partial<AgingWait> = {}): AgingWait => ({
  workspaceId: 'w-salt',
  taskId: 't-tide',
  title: 'Rebuild the tide table',
  bucket: WAITING_UNFILED_BUCKET,
  quietMs: 45 * MIN,
  firstSeen: NOW - 90 * MIN,
  ...over,
});

describe('the fleet-wide unfiled-wait item’s words', () => {
  it('names the one task in the headline, and links it in the detail', () => {
    const review = buildWaitingUnfiledReview({ rows: [row()], agingMs: 30 * MIN, now: NOW });
    expect(review.headline).toBe(
      '“Rebuild the tide table” is waiting on a person, with nothing filed',
    );
    expect(String(review.detail)).toContain('t-tide');
    expect(String(review.detail)).toContain('one board');
  });

  it('counts the tasks and the boards when there is more than one', () => {
    const review = buildWaitingUnfiledReview({
      rows: [row(), row({ workspaceId: 'w-harbor', taskId: 't-ferry' })],
      agingMs: 30 * MIN,
      now: NOW,
    });
    expect(review.headline).toBe('2 tasks are waiting on a person with nothing filed');
    expect(String(review.detail)).toContain('2 boards');
  });

  it('says which of the two ways each row got onto the list', () => {
    const detail = String(
      buildWaitingUnfiledReview({
        rows: [row(), row({ taskId: 't-berth', bucket: OWNER_UNFILED_BUCKET })],
        agingMs: 30 * MIN,
        now: NOW,
      }).detail,
    );
    // The agent's own closing words…
    expect(detail).toContain('said it is waiting on a person');
    // …and the board's ownership, which is a different claim about the row.
    expect(detail).toContain('has been down to its owner for');
  });

  it('drops brackets from a title so the markdown link still resolves', () => {
    const detail = String(
      buildWaitingUnfiledReview({
        rows: [row({ title: 'Rebuild [the] tide table' })],
        agingMs: 30 * MIN,
        now: NOW,
      }).detail,
    );
    expect(detail).toContain('[Rebuild the tide table](');
  });
});
