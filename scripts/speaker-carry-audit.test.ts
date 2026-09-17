/**
 * The zero-quota half of the speaker-carry measurement, driven through `main`.
 *
 * The meeting this runs against is confidential and is read by its owner, not
 * by the agent that wrote the script, so the first two cases are the ones the
 * file exists for: a name typed for a voice, and a sentence somebody said, go
 * into the fixture, and neither comes out on EITHER stream. Each of those
 * pairs its absence with a presence — the reading it did print — because an
 * empty output also contains no names.
 *
 * The other two pin the arithmetic the reading is quoted for:
 *
 * - a name typed only in the LAST leg makes the per-meeting and doc-wide
 *   columns disagree, which is the only thing that proves the doc-wide column
 *   is folded at all rather than a second copy of the first; and
 * - one named and one unnamed voice read as one of each, per label, so a fold
 *   that called a whole meeting named because SOMEBODY in it was cannot pass.
 *
 * Every name here is from the house fixture set. The repo is public.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { main } from './speaker-carry-audit.ts';

const DOC = 'd-ferry';

/** The name typed for voice A. Appears nowhere else in the fixture. */
const TYPED_NAME = 'Saltmarsh';
/** The name typed for voice B, in the same gesture. */
const OTHER_NAME = 'Riverbend';
/** A sentence only a speaker said, and one word only it holds. */
const SPOKEN = 'the quarry pontoon reopens after the equinox';
const SPOKEN_WORD = 'equinox';

interface Leg {
  id: string;
  /** Labels and what each said, in order. */
  turns: ReadonlyArray<readonly [label: string, text: string]>;
  /** The naming gesture made during this leg, if any. */
  speakers?: Readonly<Record<string, string>>;
}

const jsonl = (rows: readonly unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n');

/** A data dir holding one doc whose meetings are `legs`, in index order. */
function dataDir(legs: readonly Leg[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'cw-carry-audit-'));
  const meetings = join(dir, 'meetings', DOC);
  mkdirSync(meetings, { recursive: true });
  const index: unknown[] = [];
  legs.forEach((leg, i) => {
    const t0 = (i + 1) * 1000;
    index.push({
      meetingId: leg.id,
      startedAt: t0,
      engine: 'mock',
      mode: 'conversation',
      segment: i + 1,
    });
    if (leg.speakers) index.push({ meetingId: leg.id, speakers: leg.speakers });
    index.push({ meetingId: leg.id, endedAt: t0 + 900, turns: leg.turns.length });
    writeFileSync(
      join(meetings, `${leg.id}.jsonl`),
      jsonl(
        leg.turns.map(([speaker, text], n) => ({ turn: n + 1, ts: t0 + n + 1, text, speaker })),
      ),
    );
  });
  writeFileSync(join(meetings, 'meetings.jsonl'), jsonl(index));
  return dir;
}

/** Drive `main` and keep what it wrote, each stream on its own. */
function run(argv: readonly string[]): { code: number; stdout: string; stderr: string } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const realLog = console.log;
  const realError = console.error;
  console.log = (...parts: unknown[]) => void stdout.push(parts.map(String).join(' '));
  console.error = (...parts: unknown[]) => void stderr.push(parts.map(String).join(' '));
  try {
    const code = main(argv);
    return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
  } finally {
    console.log = realLog;
    console.error = realError;
  }
}

/** The cells of the totals row for one fold. */
function foldRow(stdout: string, fold: 'per-meeting (before)' | 'doc-wide (after)'): string[] {
  const line = stdout.split('\n').find((l) => l.startsWith(`| ${fold} |`));
  if (line === undefined) throw new Error(`no totals row for ${fold} in:\n${stdout}`);
  return line
    .split('|')
    .slice(2, -1)
    .map((c) => c.trim());
}

/** [named per-meeting, named doc-wide] for one label of one meeting. */
function labelVerdicts(stdout: string, ordinal: number, label: string): [string, string] {
  const line = stdout
    .split('\n')
    .find((l) => l.startsWith(`| ${ordinal} |`) && l.includes(`| ${label} |`));
  if (line === undefined) throw new Error(`no row for meeting ${ordinal} label ${label}`);
  const cells = line
    .split('|')
    .slice(1, -1)
    .map((c) => c.trim());
  return [cells[6] ?? '', cells[7] ?? ''];
}

describe('what the speaker-carry audit never prints', () => {
  const legs: Leg[] = [
    {
      id: 'm-1',
      turns: [
        ['A', SPOKEN],
        ['B', 'two sailings daily'],
      ],
    },
    {
      id: 'm-2',
      turns: [['A', 'the dock needs repair']],
      speakers: { A: TYPED_NAME, B: OTHER_NAME },
    },
  ];

  it('prints no name a person typed for a voice, on either stream', () => {
    const { code, stdout, stderr } = run(['--data-dir', dataDir(legs), '--doc', DOC]);
    expect(code).toBe(0);
    // It did print the reading the names decided — otherwise the absence
    // below would hold for a script that printed nothing.
    expect(labelVerdicts(stdout, 2, 'A')).toEqual(['yes', 'yes']);
    expect(stdout + stderr).not.toContain(TYPED_NAME);
    expect(stdout + stderr).not.toContain(OTHER_NAME);
  });

  it('prints nothing anybody said, only how many words it was', () => {
    const { code, stdout, stderr } = run(['--data-dir', dataDir(legs), '--doc', DOC]);
    expect(code).toBe(0);
    // "the quarry pontoon reopens after the equinox" is 7 words.
    expect(stdout).toContain('| 1 | 1 | conversation | A | 1 | 7 |');
    expect(stdout + stderr).not.toContain(SPOKEN);
    expect(stdout + stderr).not.toContain(SPOKEN_WORD);
  });

  it('keeps both out when --notes re-counts bullets that carry them', () => {
    const notes = join(mkdtempSync(join(tmpdir(), 'cw-carry-notes-')), 'notes.md');
    writeFileSync(
      notes,
      [
        '## Ferry',
        `- [@${TYPED_NAME}](speaker:A) said ${SPOKEN}`,
        `- [@Speaker B](speaker:B) asked about the ${SPOKEN_WORD} sailing`,
      ].join('\n'),
    );
    const { code, stdout, stderr } = run([
      '--data-dir',
      dataDir(legs),
      '--doc',
      DOC,
      '--notes',
      notes,
    ]);
    expect(code).toBe(0);
    expect(stdout).toContain('Bullets pointing at a nameless voice: 1');
    expect(stdout).toContain('Labels they point at: B');
    expect(stdout + stderr).not.toContain(TYPED_NAME);
    expect(stdout + stderr).not.toContain(SPOKEN_WORD);
  });
});

describe('what the speaker-carry audit counts', () => {
  it('reads a name typed only in the last leg differently under the two folds', () => {
    const { code, stdout } = run([
      '--data-dir',
      dataDir([
        { id: 'm-1', turns: [['A', 'one two three']] },
        { id: 'm-2', turns: [['A', 'four five']] },
        { id: 'm-3', turns: [['A', 'six']], speakers: { A: TYPED_NAME } },
      ]),
      '--doc',
      DOC,
    ]);
    expect(code).toBe(0);
    // The first two legs ran with nobody named: under their own maps A is
    // nameless, and the doc-wide fold carries the last leg's name back.
    expect(labelVerdicts(stdout, 1, 'A')).toEqual(['NO', 'yes']);
    expect(labelVerdicts(stdout, 2, 'A')).toEqual(['NO', 'yes']);
    expect(labelVerdicts(stdout, 3, 'A')).toEqual(['yes', 'yes']);
    expect(foldRow(stdout, 'per-meeting (before)')).toEqual(['2 of 3', '2', '5', '83.3%']);
    expect(foldRow(stdout, 'doc-wide (after)')).toEqual(['0 of 3', '0', '0', '0.0%']);
  });

  it('reads one named and one unnamed voice as one of each', () => {
    const { code, stdout } = run([
      '--data-dir',
      dataDir([
        {
          id: 'm-1',
          turns: [
            ['A', 'the tide is early'],
            ['B', 'noted'],
            ['B', 'and the gangway'],
          ],
          speakers: { A: TYPED_NAME },
        },
      ]),
      '--doc',
      DOC,
    ]);
    expect(code).toBe(0);
    expect(labelVerdicts(stdout, 1, 'A')).toEqual(['yes', 'yes']);
    expect(labelVerdicts(stdout, 1, 'B')).toEqual(['NO', 'NO']);
    // B: 2 turns, 1 + 3 words, of 8 words in all.
    expect(foldRow(stdout, 'per-meeting (before)')).toEqual(['1 of 2', '2', '4', '50.0%']);
    expect(foldRow(stdout, 'doc-wide (after)')).toEqual(['1 of 2', '2', '4', '50.0%']);
  });
});

describe('when there is nothing to read', () => {
  it('says so and exits non-zero when the doc has no meetings', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cw-carry-empty-'));
    const { code, stdout, stderr } = run(['--data-dir', dir, '--doc', DOC]);
    expect(code).not.toBe(0);
    expect(stderr).toContain('no meeting found');
    // Not a clean-looking reading with zeroes in it.
    expect(stdout).toBe('');
  });

  it('says so and exits non-zero when the index exists but lists no meeting', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cw-carry-noindex-'));
    const meetings = join(dir, 'meetings', DOC);
    mkdirSync(meetings, { recursive: true });
    // A naming line with no start line is not a meeting.
    writeFileSync(
      join(meetings, 'meetings.jsonl'),
      jsonl([{ meetingId: 'm-1', speakers: { A: TYPED_NAME } }]),
    );
    const { code, stdout, stderr } = run(['--data-dir', dir, '--doc', DOC]);
    expect(code).not.toBe(0);
    expect(stderr).toContain('its index lists none');
    expect(stdout).toBe('');
    expect(stderr).not.toContain(TYPED_NAME);
  });

  it('says so and exits non-zero when the data dir does not exist', () => {
    const { code, stdout, stderr } = run([
      '--data-dir',
      join(tmpdir(), 'cw-carry-absent-xyz'),
      '--doc',
      DOC,
    ]);
    expect(code).not.toBe(0);
    expect(stderr).toContain('no such data dir');
    expect(stdout).toBe('');
  });
});
