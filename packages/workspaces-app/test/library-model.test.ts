/**
 * The Library page's pure rules: how long ago a row happened, what a search
 * finds, and which files a generator wrote in one burst. All fixtures
 * synthetic.
 */
import { describe, expect, it } from 'vitest';
import {
  BURST_GAP_MS,
  LIBRARY_MAX_HITS,
  LIBRARY_NO_TIME,
  type LibraryFileEntry,
  type LibraryPayload,
  type LibraryRow,
  burstLabel,
  fileEntries,
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

describe('fileEntries', () => {
  const SEC = 1000;
  const file = (name: string, at: number | undefined, folder?: string): LibraryRow => ({
    name,
    ...(at === undefined ? {} : { at }),
    open: `${folder ? `${folder}/` : ''}${name}`,
    ...(folder === undefined ? {} : { folder }),
  });
  /** What each entry reads as: a file's name, or a burst's label. */
  const shape = (entries: LibraryFileEntry[]) =>
    entries.map((e) => (e.kind === 'file' ? e.row.name : `[${burstLabel(e)}]`));

  /**
   * The measured run, shape for shape: two ordinary edits, a digest written
   * 4m16s after the seven subscription files it summarises (spread over 27s
   * and four sibling folders), then more ordinary edits.
   */
  it('collapses a digest run into one entry and leaves the digest and every edit apart', () => {
    const t = NOW;
    const files = [
      file('learnings.md', t, 'docs/process'),
      file('survey-estimate.md', t - 112 * SEC, 'docs'),
      file('2026-09-12-digest.md', t - 60 * MIN, 'digests'),
      file('dumb-networks.md', t - 60 * MIN - 256 * SEC, 'subscriptions/tide-letter'),
      file('patchwork-quilt.md', t - 60 * MIN - 256 * SEC, 'subscriptions/tide-letter'),
      file('driving-the-build.md', t - 60 * MIN - 268 * SEC, 'subscriptions/harbor-weekly'),
      file('duo-threats.md', t - 60 * MIN - 275 * SEC, 'subscriptions/field-notes'),
      file('personal-hub.md', t - 60 * MIN - 275 * SEC, 'subscriptions/field-notes'),
      file('reading-list.md', t - 60 * MIN - 283 * SEC, 'subscriptions/estuary-review'),
      file('embers.md', t - 60 * MIN - 283 * SEC, 'subscriptions/estuary-review'),
      file('knowledge-base.md', t - 80 * MIN, ''),
    ];
    const entries = fileEntries(files);
    expect(shape(entries)).toEqual([
      'learnings.md',
      'survey-estimate.md',
      '2026-09-12-digest.md',
      '[7 files in subscriptions]',
      'knowledge-base.md',
    ]);
    const burst = entries[3];
    expect(burst?.kind === 'burst' ? burst.rows : []).toEqual(files.slice(3, 10));
  });

  it('collapses a generator that writes three, and leaves a pair alone', () => {
    const three = [0, 20, 40].map((s, i) => file(`r${i}.md`, NOW - s * SEC, 'reports'));
    const pair = [file('a.md', NOW - HOUR, 'notes'), file('b.md', NOW - HOUR - 2 * SEC, 'notes')];
    expect(shape(fileEntries([...three, ...pair]))).toEqual([
      '[3 files in reports]',
      'a.md',
      'b.md',
    ]);
  });

  it('holds a run together while each gap is at most a minute, and splits past it', () => {
    const at = (gaps: number[]) => {
      let t = NOW;
      return [file('f0.md', t), ...gaps.map((g, i) => file(`f${i + 1}.md`, (t -= g)))];
    };
    // Chained: 3 minutes end to end, never more than a minute between two.
    expect(shape(fileEntries(at([BURST_GAP_MS, BURST_GAP_MS, BURST_GAP_MS])))).toEqual([
      '[4 files]',
    ]);
    expect(shape(fileEntries(at([BURST_GAP_MS + 1, 1_000, 1_000])))).toEqual([
      'f0.md',
      '[3 files]',
    ]);
  });

  it('names the deepest shared folder, and nothing when a member does not say', () => {
    const rows = (folders: (string | undefined)[]) =>
      fileEntries(folders.map((f, i) => file(`n${i}.md`, NOW - i * SEC, f)));
    expect(shape(rows(['a/b/c', 'a/b', 'a/b/d']))).toEqual(['[3 files in b]']);
    expect(shape(rows(['a', 'b', 'a']))).toEqual(['[3 files]']);
    expect(shape(rows(['', '', '']))).toEqual(['[3 files]']);
    expect(shape(rows(['a', undefined, 'a']))).toEqual(['[3 files]']);
  });

  it('never puts a file with no clock reading in a burst', () => {
    const files = [
      file('x.md', NOW),
      file('y.md', NOW - SEC),
      file('gone.md', undefined),
      file('also-gone.md', undefined),
      file('lost.md', undefined),
    ];
    expect(shape(fileEntries(files))).toEqual([
      'x.md',
      'y.md',
      'gone.md',
      'also-gone.md',
      'lost.md',
    ]);
  });
});
