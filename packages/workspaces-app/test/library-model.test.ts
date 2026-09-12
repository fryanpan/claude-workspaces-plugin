/**
 * The Library page's pure rules: when a row happened, which order a list is
 * in, which docs live in one place, what a search finds, and which files a
 * generator wrote in one burst. All fixtures synthetic.
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
  libraryWhen,
  libraryWhenColumn,
  placeRows,
  searchLibrary,
  sortRows,
} from '../src/board/library-model.ts';

const NOW = 1_700_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('libraryWhen', () => {
  const fmt = { locale: 'en-US', timeZone: 'UTC' };
  // NOW is 2023-11-14 22:13 UTC.
  it.each([
    [30_000, 'just now'],
    [MIN, '1m ago'],
    [59 * MIN, '59m ago'],
    [HOUR, '1h ago'],
    [23 * HOUR, '23h ago'],
    [DAY, '1d ago'],
    [7 * DAY - MIN, '6d ago'],
    // Seven days on, a date — never "1w ago".
    [7 * DAY, 'Nov 7'],
    [40 * DAY, 'Oct 5'],
    // Another year says which.
    [365 * DAY, 'Nov 14, 2022'],
  ])('%i ms ago reads %s', (delta, text) => {
    expect(libraryWhen(NOW - delta, NOW, fmt)).toBe(text);
  });

  it('reads a time slightly in the future as just now, not a negative age', () => {
    expect(libraryWhen(NOW + 5_000, NOW, fmt)).toBe('just now');
  });
});

describe('the time column', () => {
  it('reads an em dash, never a substituted clock, when the row carries none', () => {
    // Positive control on the same function: a row that HAS one still reads.
    expect(libraryWhenColumn({ name: 'Volunteer handbook', at: NOW - HOUR }, NOW)).toBe('1h ago');
    expect(libraryWhenColumn({ name: 'A doc whose file went away' }, NOW)).toBe(LIBRARY_NO_TIME);
  });

  it('reads the clock the list is sorted by', () => {
    const row = { name: 'Ferry schedule', at: NOW - HOUR, created: NOW - 3 * DAY };
    expect(libraryWhenColumn(row, NOW, 'modified')).toBe('1h ago');
    expect(libraryWhenColumn(row, NOW, 'created')).toBe('3d ago');
    expect(libraryWhenColumn({ name: 'No birth time', at: NOW }, NOW, 'created')).toBe(
      LIBRARY_NO_TIME,
    );
  });
});

describe('sortRows', () => {
  const rows: LibraryRow[] = [
    { name: 'a', at: NOW, created: NOW - 5 * DAY },
    { name: 'b', at: NOW - HOUR, created: NOW - DAY },
    { name: 'c', at: NOW - 2 * HOUR },
    { name: 'd', at: NOW - 3 * HOUR, created: NOW - DAY },
  ];

  it('orders by creation newest first, unknown last, ties as sent', () => {
    expect(sortRows(rows, 'created').map((r) => r.name)).toEqual(['b', 'd', 'a', 'c']);
  });

  it('orders by last modified newest first, and leaves the input alone', () => {
    const shuffled = [rows[2], rows[0], rows[3], rows[1]] as LibraryRow[];
    expect(sortRows(shuffled, 'modified').map((r) => r.name)).toEqual(['a', 'b', 'c', 'd']);
    expect(shuffled.map((r) => r.name)).toEqual(['c', 'a', 'd', 'b']);
  });
});

describe('placeRows', () => {
  it("lists the docs of one place, from the list that place's kind is in", () => {
    const lib: LibraryPayload = {
      project: null,
      meetings: [
        { name: 'Kickoff', href: '/m/1', place: 'meetings:Stored by Workspaces:' },
        { name: 'Walkthrough', href: '/m/2', place: 'meetings:docs/meetings:' },
      ],
      files: [
        { name: 'dock-survey.md', href: '/f/1', place: 'documents:notes:not mounted' },
        { name: 'loose.md', open: 'loose.md' },
      ],
      where: [
        {
          kind: 'meetings',
          unset: false,
          places: [
            { key: 'meetings:docs/meetings:', label: 'docs/meetings', folder: true, stray: false },
            {
              key: 'meetings:Stored by Workspaces:',
              label: 'Stored by Workspaces',
              folder: false,
              stray: false,
            },
          ],
        },
        {
          kind: 'documents',
          unset: false,
          places: [
            {
              key: 'documents:notes:not mounted',
              label: 'notes',
              folder: true,
              note: 'not mounted',
              stray: true,
            },
          ],
        },
      ],
    };
    expect(placeRows(lib, 'meetings:Stored by Workspaces:').map((r) => r.name)).toEqual([
      'Kickoff',
    ]);
    expect(placeRows(lib, 'documents:notes:not mounted').map((r) => r.name)).toEqual([
      'dock-survey.md',
    ]);
    expect(placeRows(lib, 'mockups:nowhere:')).toEqual([]);
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
   * The measured run, shape for shape: two ordinary edits, a summary written
   * 4m16s after the seven files it summarises (spread over 27s
   * and four sibling folders), then more ordinary edits.
   */
  it('collapses a generated run into one entry and leaves its summary and every edit apart', () => {
    const t = NOW;
    const files = [
      file('trail-log.md', t, 'docs/crew'),
      file('culvert-estimate.md', t - 112 * SEC, 'docs'),
      file('2026-09-12-roundup.md', t - 60 * MIN, 'roundups'),
      file('low-tide-notes.md', t - 60 * MIN - 256 * SEC, 'clippings/heron-post'),
      file('boardwalk-repair.md', t - 60 * MIN - 256 * SEC, 'clippings/heron-post'),
      file('eelgrass-count.md', t - 60 * MIN - 268 * SEC, 'clippings/marsh-ledger'),
      file('kayak-launch.md', t - 60 * MIN - 275 * SEC, 'clippings/gull-gazette'),
      file('oyster-beds.md', t - 60 * MIN - 275 * SEC, 'clippings/gull-gazette'),
      file('levee-walk.md', t - 60 * MIN - 283 * SEC, 'clippings/reed-review'),
      file('sandbar-map.md', t - 60 * MIN - 283 * SEC, 'clippings/reed-review'),
      file('field-guide.md', t - 80 * MIN, ''),
    ];
    const entries = fileEntries(files);
    expect(shape(entries)).toEqual([
      'trail-log.md',
      'culvert-estimate.md',
      '2026-09-12-roundup.md',
      '[7 files in clippings]',
      'field-guide.md',
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

  it('groups by the clock the list is sorted by', () => {
    // Written a day apart, created a second apart: a burst only by creation.
    const files = [0, 1, 2].map((i) => ({
      name: `c${i}.md`,
      at: NOW - i * DAY,
      created: NOW - i * SEC,
      open: `c${i}.md`,
    }));
    expect(shape(fileEntries(files, 'modified'))).toEqual(['c0.md', 'c1.md', 'c2.md']);
    expect(shape(fileEntries(files, 'created'))).toEqual(['[3 files]']);
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
