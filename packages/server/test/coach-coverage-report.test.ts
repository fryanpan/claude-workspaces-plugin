/**
 * The coverage report's counts: what he sent per hour by source, what the
 * coach let go and why, and what the digests carried, for one local day.
 * Counts only, kept on disk across a restart, and never more than eight
 * days of them.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CoachCoverage,
  KEEP_HOURS,
  hourOf,
  sessionSource,
  sourceOfDevice,
} from '../src/coach/coverage.ts';
import { carriedBy } from '../src/coach/session-feed.ts';
import { ZONE, at } from './coach-fixtures.ts';

const MIN = 60_000;
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'coach-coverage-report-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('the coverage report', () => {
  it('lists one local day hour by hour, received by source next to dropped and carried', () => {
    const c = new CoachCoverage(dir, at(9));
    c.received(at(21, 5), 'phone', 'view');
    c.received(at(21, 9), 'phone', 'view');
    c.received(at(21, 10), 'remote-control', 'typed-prompt');
    c.received(at(21, 12), 'terminal', 'turn-end');
    c.dropped(at(21, 12), 'outside-run');
    c.dropped(at(21, 9), 'repeat');
    c.carried(
      [
        [hourOf(at(21, 5)), 'phone', 'view', 1],
        [hourOf(at(21, 5)), 'phone', 'view-ms', 4 * MIN],
        [hourOf(at(21, 10)), 'remote-control', 'prompt', 1],
      ],
      at(21, 20),
    );
    const report = c.report('2026-10-07', ZONE);
    expect(report.hours).toHaveLength(24);
    expect(report.hours[0]?.local).toBe('00:00');
    const nine = report.hours[21];
    expect(nine).toMatchObject({
      local: '21:00',
      received: {
        phone: { view: 2 },
        'remote-control': { 'typed-prompt': 1 },
        terminal: { 'turn-end': 1 },
      },
      dropped: { 'outside-run': 1, repeat: 1 },
      carried: { phone: { view: 1, 'view-minutes': 4 }, 'remote-control': { prompt: 1 } },
    });
    expect(report.hours[20]).toMatchObject({ received: {}, dropped: {}, carried: {} });
  });

  it('keeps its counts across a restart, and at most eight days of them', () => {
    const c = new CoachCoverage(dir, at(9));
    c.received(at(9), 'desktop', 'comment');
    c.flush();
    const again = new CoachCoverage(dir, at(10));
    expect(again.report('2026-10-07', ZONE).hours[9]?.received).toEqual({
      desktop: { comment: 1 },
    });
    const HOUR = 60 * MIN;
    for (let h = 1; h <= KEEP_HOURS + 5; h++) again.received(at(9) + h * HOUR, 'ipad', 'view');
    again.flush();
    const file = JSON.parse(readFileSync(join(dir, 'coach', 'coverage.json'), 'utf8')) as {
      hours: Record<string, unknown>;
    };
    expect(Object.keys(file.hours)).toHaveLength(KEEP_HOURS);
    expect(file.hours[String(hourOf(at(9)))]).toBeUndefined();
  });

  it('names a source from the browser’s device or the session’s Remote Control flag', () => {
    expect(sourceOfDevice('phone')).toBe('phone');
    expect(sourceOfDevice('ipad')).toBe('ipad');
    expect(sourceOfDevice('desktop')).toBe('desktop');
    expect(sourceOfDevice('other')).toBe('other');
    expect(sourceOfDevice(undefined)).toBe('other');
    expect(sessionSource(true)).toBe('remote-control');
    expect(sessionSource(undefined)).toBe('terminal');
  });

  it('counts what a delivered digest carried per hour and source, a stay once with its minutes', () => {
    const counts = carriedBy([
      {
        from: at(21),
        to: at(21, 15),
        items: [
          { kind: 'view', boardId: 'w-harbor', at: at(21, 1), minutes: 6, source: 'phone' },
          { kind: 'comment', boardId: 'w-harbor', at: at(21, 7), text: 'x', source: 'phone' },
          { kind: 'left', boardId: 'w-harbor', at: at(21, 8) },
        ],
        turns: [
          {
            kind: 'prompt',
            at: at(21, 9),
            boardId: 'w-harbor',
            session: 's',
            repo: 'harborlight',
            creditMs: 3 * MIN,
            source: 'terminal',
          },
          {
            kind: 'turn',
            at: at(22, 1),
            boardId: 'w-harbor',
            session: 's',
            repo: 'harborlight',
            creditMs: 2 * MIN,
            source: 'terminal',
          },
        ],
      },
    ]);
    const nine = hourOf(at(21));
    const ten = hourOf(at(22));
    expect(counts).toEqual(
      expect.arrayContaining([
        [nine, 'phone', 'view', 1],
        [nine, 'phone', 'view-ms', 6 * MIN],
        [nine, 'phone', 'comment', 1],
        [nine, 'other', 'left', 1],
        [nine, 'terminal', 'prompt', 1],
        [nine, 'terminal', 'session-ms', 3 * MIN],
        [ten, 'terminal', 'turn', 1],
        [ten, 'terminal', 'session-ms', 2 * MIN],
      ]),
    );
    expect(counts).toHaveLength(8);
  });
});
