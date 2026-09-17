/**
 * The seeded cast, read back through the code a meeting reads it with.
 *
 * WHAT IS BEING PINNED is the thing the flag exists for and nothing smaller:
 * that a `--cast` an operator types on the command line ends up as the names
 * `docSpeakerNames` answers for the rerun's doc. That function is what
 * `MeetingStore.startMeeting` calls to build the `carried` map a new session
 * starts with, so a cast it does not see is a cast the meeting never had —
 * and the run's unnamed-voice count would read the same on every build, which
 * is the defect this flag was added to remove.
 *
 * NO MODEL AND NO SERVER. The seam is a data dir and two production readers
 * over it; the replay itself is exercised by `rerun-meeting-run.test.ts` with
 * a stub composer.
 *
 * Every name here is from the house fixture set. The repo is public.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { docSpeakerNames, listMeetings } from '../packages/server/src/meetings.ts';
import { UsageError, parseRerunArgs } from './rerun-meeting-args.ts';
import { castLine, seedCast } from './rerun-meeting-cast.ts';

const dataDir = (): string => mkdtempSync(join(tmpdir(), 'cw-rerun-cast-'));

/** The argv a rerun is actually started with, plus whatever is under test. */
const argv = (...extra: string[]): string[] => ['/m/riverbend', '--spend-usd', '1', ...extra];

describe('a rerun started with --cast', () => {
  it('is a doc whose voices are already named, as a meeting reads them', () => {
    // The whole path: the flag an operator types, the history it writes, and
    // the production read a new meeting makes of that history. On an unseeded
    // data dir this answers {} — every voice a placeholder, on every build.
    const dir = dataDir();
    const args = parseRerunArgs(argv('--cast', 'A=Riverbend,B=Harborlight'));
    expect(docSpeakerNames(dir, 'd-1')).toEqual({});
    seedCast(dir, 'd-1', args.cast as Record<string, string>, Date.UTC(2026, 8, 16, 10, 0));
    expect(docSpeakerNames(dir, 'd-1')).toEqual({ A: 'Riverbend', B: 'Harborlight' });
  });

  it('carries the cast on a meeting the index can actually show', () => {
    // A naming line for a meeting the index has no record of would be a doc
    // whose cast came from nowhere — readable by `docSpeakerNames`, invisible
    // to anyone opening a `--keep` data dir to see where the names came from.
    const dir = dataDir();
    const at = Date.UTC(2026, 8, 16, 10, 0);
    const meetingId = seedCast(dir, 'd-1', { A: 'Riverbend' }, at);
    const held = listMeetings(dir, 'd-1');
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({
      meetingId,
      startedAt: at,
      endedAt: at,
      speakers: { A: 'Riverbend' },
    });
  });

  it('leaves the cast beneath a name given later, which is the correction', () => {
    // `docSpeakerNames` folds in write order, so a naming made during the
    // replay is the one that stands. Seeding must not outrank it: an operator
    // who names a voice mid-run is fixing a carry that was wrong.
    const dir = dataDir();
    const at = Date.UTC(2026, 8, 16, 10, 0);
    seedCast(dir, 'd-1', { A: 'Riverbend' }, at);
    seedCast(dir, 'd-1', { A: 'Saltmarsh' }, at + 60_000);
    expect(docSpeakerNames(dir, 'd-1')).toEqual({ A: 'Saltmarsh' });
  });

  it('keeps a doc that was never given one with no cast at all', () => {
    // The control: seeding is what puts names there, not the data dir, not
    // the doc id, and not the act of reading.
    expect(parseRerunArgs(argv()).cast).toBeUndefined();
    expect(docSpeakerNames(dataDir(), 'd-1')).toEqual({});
  });
});

describe('--cast refuses what it cannot name', () => {
  const refused =
    (raw: string): (() => unknown) =>
    () =>
      parseRerunArgs(argv('--cast', raw));

  it('takes a namespaced label, as a two-stream recording hands them out', () => {
    expect(parseRerunArgs(argv('--cast', 'room:A=Riverbend,remote:A=Harborlight')).cast).toEqual({
      'room:A': 'Riverbend',
      'remote:A': 'Harborlight',
    });
  });

  it('takes a name with spaces in it, and trims around the pair', () => {
    expect(parseRerunArgs(argv('--cast', ' A = Riverbend Quay ')).cast).toEqual({
      A: 'Riverbend Quay',
    });
  });

  it('refuses a placeholder, which would name nothing and read as unnamed', () => {
    // The failure this guard exists for: "Speaker A" saved as a name is what
    // a voice is called when NOBODY has named it, so a run seeded with one
    // would report every bullet unnamed with the operator believing the room
    // was named — the exact unreadable number the flag removes.
    expect(refused('A=Speaker A')).toThrow(UsageError);
    expect(refused('A=Speaker A')).toThrow(/not a name/);
    expect(refused('room:A=Room Speaker C')).toThrow(/not a name/);
  });

  it('refuses an entry that names no voice', () => {
    expect(refused('A')).toThrow(/not label=name/);
    expect(refused('=Riverbend')).toThrow(/names no label/);
    expect(refused('A=')).toThrow(/not a name/);
    expect(refused('A=Riverbend,')).toThrow(/empty entry/);
  });

  it('refuses one label named twice, rather than keeping the last quietly', () => {
    expect(refused('A=Riverbend,A=Harborlight')).toThrow(/named twice/);
  });

  it('refuses a label the audio socket would have dropped the frame for', () => {
    expect(refused(`${'x'.repeat(17)}=Riverbend`)).toThrow(/longer than 16/);
  });

  it('refuses a name past the cap every other naming path enforces', () => {
    expect(refused(`A=${'x'.repeat(61)}`)).toThrow(/longer than 60/);
  });

  it('still needs a value, like every other flag that takes one', () => {
    expect(() => parseRerunArgs(argv('--cast'))).toThrow(/--cast needs a value/);
  });
});

describe('castLine', () => {
  it('reads as the pairs the operator typed', () => {
    expect(castLine({ A: 'Riverbend', 'remote:B': 'Harborlight' })).toBe(
      'A=Riverbend, remote:B=Harborlight',
    );
  });
});
