import { describe, expect, it } from 'bun:test';
/**
 * The words on a board's unfiled-wait item, driven directly.
 *
 * The escalation's own suite reads these words back off a filed review item,
 * which proves the wiring; this drives the renderer itself, so a change to the
 * sentence a person reads fails here with the sentence in the message rather
 * than three layers down.
 *
 * Fixtures are synthetic — invented boards and titles. The repo is public.
 */
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
  tells: 0,
  ...over,
});

describe('a board’s unfiled-wait item’s words', () => {
  it('names the one task in the headline, and links it in the detail', () => {
    const review = buildWaitingUnfiledReview({ rows: [row()], agingMs: 30 * MIN, now: NOW });
    expect(review.headline).toBe(
      '“Rebuild the tide table” is waiting on a person, with nothing filed',
    );
    expect(String(review.detail)).toContain('t-tide');
    // Every row on one item is on the board the item hangs on, so the words
    // say so rather than counting boards (2026-09-22).
    expect(String(review.detail)).toContain('on this board');
  });

  it('counts the tasks when there is more than one', () => {
    const review = buildWaitingUnfiledReview({
      rows: [row(), row({ taskId: 't-ferry' })],
      agingMs: 30 * MIN,
      now: NOW,
    });
    expect(review.headline).toBe('2 tasks are waiting on a person with nothing filed');
    expect(String(review.detail)).toContain('t-ferry');
  });

  it('says the evidence every row here has: the agent’s own closing words', () => {
    const detail = String(
      buildWaitingUnfiledReview({
        rows: [row(), row({ taskId: 't-berth' })],
        agingMs: 30 * MIN,
        now: NOW,
      }).detail,
    );
    for (const line of detail.split('\n').filter((l) => l.startsWith('- ')))
      expect(line).toContain('said it is waiting on a person');
    // The board-ownership sentence is gone with the bucket that earned it:
    // no row reaching this renderer can carry that evidence any more.
    expect(detail).not.toContain('down to its owner');
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
