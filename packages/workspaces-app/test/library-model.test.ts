/**
 * The Library page's two pure rules: how long ago a row happened, and what a
 * search finds. All fixtures synthetic.
 */
import { describe, expect, it } from 'vitest';
import {
  LIBRARY_MAX_HITS,
  LIBRARY_NO_TIME,
  type LibraryPayload,
  libraryAgo,
  libraryLength,
  libraryWhenColumn,
  meetingSubtitle,
  searchLibrary,
} from '../src/board/library-model.ts';

const NOW = 1_700_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('libraryAgo', () => {
  it.each([
    [30_000, 'just now'],
    [MIN, '1m ago'],
    [59 * MIN, '59m ago'],
    [HOUR, '1h ago'],
    [23 * HOUR, '23h ago'],
    [DAY, '1d ago'],
    [13 * DAY, '13d ago'],
    [14 * DAY, '2w ago'],
    [29 * DAY, '4w ago'],
    [30 * DAY, '1mo ago'],
    [364 * DAY, '12mo ago'],
    [365 * DAY, '1y ago'],
  ])('%i ms ago reads %s', (delta, text) => {
    expect(libraryAgo(NOW - delta, NOW)).toBe(text);
  });

  it('reads a time slightly in the future as just now, not a negative age', () => {
    expect(libraryAgo(NOW + 5_000, NOW)).toBe('just now');
  });
});

describe('the time column', () => {
  it('reads an em dash, never a substituted clock, when the row carries none', () => {
    // Positive control on the same function: a row that HAS one still reads.
    expect(libraryWhenColumn({ name: 'Volunteer handbook', at: NOW - HOUR }, NOW)).toBe('1h ago');
    expect(libraryWhenColumn({ name: 'A doc whose file went away' }, NOW)).toBe(LIBRARY_NO_TIME);
  });
});

describe('a meeting row', () => {
  it.each([
    [5 * MIN, '5 min'],
    [30_000, '1 min'],
    [47 * MIN, '47 min'],
    [HOUR, '1 hr'],
    [72 * MIN, '1 hr 12 min'],
  ])('%i ms of recording reads %s', (ms, text) => {
    expect(libraryLength(ms)).toBe(text);
  });

  /**
   * The finding this exists for: a board's meetings are all titled from the
   * clock at the minute they opened, so the LIST has to separate them.
   */
  it('is told apart from another of the same title by when it ran and for how long', () => {
    const fmt = { locale: 'en-US', timeZone: 'UTC' };
    const one = { name: 'Meeting notes 2026-09-11 16:11', at: NOW, durationMs: 5 * MIN };
    const two = {
      name: 'Meeting notes 2026-09-11 16:11',
      at: NOW - 26 * HOUR,
      durationMs: 47 * MIN,
    };
    expect(meetingSubtitle(one, fmt)).toBe('Nov 14, 22:13 · 5 min');
    expect(meetingSubtitle(two, fmt)).toBe('Nov 13, 20:13 · 47 min');
    expect(meetingSubtitle(one, fmt)).not.toBe(meetingSubtitle(two, fmt));
  });

  it('claims no length while it is still running, and nothing at all with no start', () => {
    const fmt = { locale: 'en-US', timeZone: 'UTC' };
    expect(meetingSubtitle({ name: 'Live', at: NOW }, fmt)).toBe('Nov 14, 22:13');
    expect(meetingSubtitle({ name: 'Nothing', href: '/m/9' }, fmt)).toBe('');
  });
});

const payload: LibraryPayload = {
  project: { name: 'riverbend', path: '~/dev/riverbend' },
  meetings: [
    { name: 'Harborlight weekly sync', at: NOW, href: '/m/1' },
    { name: 'Trail map review', at: NOW - DAY, href: '/m/2' },
  ],
  files: [
    { name: 'Trail map — round 3', at: NOW, href: '/f/1' },
    { name: 'Volunteer handbook', at: NOW - HOUR, open: 'handbook.md' },
  ],
};

describe('searchLibrary', () => {
  it('finds a name case-insensitively, meetings before files', () => {
    const hits = searchLibrary(payload, '  TRAIL ');
    expect(hits.map((h) => [h.list, h.row.name])).toEqual([
      ['meetings', 'Trail map review'],
      ['files', 'Trail map — round 3'],
    ]);
  });

  it('finds every row of a list by the list name, as the mock does', () => {
    expect(searchLibrary(payload, 'meetings').map((h) => h.row.name)).toEqual([
      'Harborlight weekly sync',
      'Trail map review',
    ]);
  });

  it('finds nothing for a blank term', () => {
    expect(searchLibrary(payload, '   ')).toEqual([]);
  });

  it('stops at the hit cap', () => {
    const many: LibraryPayload = {
      project: null,
      meetings: [],
      files: Array.from({ length: LIBRARY_MAX_HITS + 5 }, (_, i) => ({
        name: `Saltmarsh note ${i}`,
        at: NOW - i,
        href: `/f/${i}`,
      })),
    };
    expect(searchLibrary(many, 'saltmarsh')).toHaveLength(LIBRARY_MAX_HITS);
  });
});
