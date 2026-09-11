/**
 * Where a meeting lives, as a unit: the project's choice, the folder's
 * `.gitignore`, and the filing index.
 *
 * The three things worth pinning here are the ones a route test would only
 * reach by accident. Retention has to answer for BOTH halves of every value,
 * because "keep transcripts" and "keep audio" are one setting read twice and
 * a table that only checks the transcript half passes with the audio half
 * inverted. The gitignore writer has to refuse a file it did not write, since
 * that is the whole reason the body is a fixed string. And the index has to
 * fold like every other append-only file in this server: last line per doc
 * wins, a torn tail is skipped rather than thrown on.
 *
 * All fixtures are invented — Riverbend, Harborlight, Saltmarsh. The repo is
 * public.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_MEETING_RETENTION,
  MEETING_GITIGNORE_BODY,
  type MeetingFiling,
  applyMeetingGitignore,
  listMeetingFilings,
  meetingFileName,
  meetingFilingFor,
  meetingFilingIndexPath,
  meetingGitignorePath,
  meetingRetentionKeeps,
  noteMeetingProvider,
  parseMeetingRetention,
  recordMeetingFiling,
} from '../src/meeting-home.ts';

describe('meeting-home', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'cw-meeting-home-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  describe('what a project keeps', () => {
    it('reads back the three values and refuses everything else', () => {
      expect(parseMeetingRetention('transcripts-and-audio')).toBe('transcripts-and-audio');
      expect(parseMeetingRetention('transcripts')).toBe('transcripts');
      expect(parseMeetingRetention('none')).toBe('none');
      // A near miss, a wrong type and an absence are all "nobody said".
      expect(parseMeetingRetention('audio')).toBeNull();
      expect(parseMeetingRetention('')).toBeNull();
      expect(parseMeetingRetention(0)).toBeNull();
      expect(parseMeetingRetention(undefined)).toBeNull();
    });

    it('answers both halves of every value, so an inverted half cannot pass', () => {
      const table = (['transcripts-and-audio', 'transcripts', 'none'] as const).map((r) => [
        r,
        meetingRetentionKeeps(r, 'transcript'),
        meetingRetentionKeeps(r, 'audio'),
      ]);
      expect(table).toEqual([
        ['transcripts-and-audio', true, true],
        ['transcripts', true, false],
        ['none', false, false],
      ]);
    });

    it('defaults to keeping everything, so a project nobody asked loses nothing', () => {
      expect(DEFAULT_MEETING_RETENTION).toBe('transcripts-and-audio');
      expect(meetingRetentionKeeps(DEFAULT_MEETING_RETENTION, 'transcript')).toBe(true);
      expect(meetingRetentionKeeps(DEFAULT_MEETING_RETENTION, 'audio')).toBe(true);
    });
  });

  describe("the folder's .gitignore", () => {
    it('writes it, leaves it alone the second time, and takes it away when asked', () => {
      const folder = join(tmp, 'docs', 'meetings');
      expect(applyMeetingGitignore(folder, true)).toBe('written');
      expect(readFileSync(meetingGitignorePath(folder), 'utf8')).toBe(MEETING_GITIGNORE_BODY);
      expect(applyMeetingGitignore(folder, true)).toBe('kept');
      expect(applyMeetingGitignore(folder, false)).toBe('removed');
      expect(existsSync(meetingGitignorePath(folder))).toBe(false);
      expect(applyMeetingGitignore(folder, false)).toBe('absent');
    });

    it("refuses to touch somebody else's file, in either direction", () => {
      const folder = join(tmp, 'notes');
      mkdirSync(folder, { recursive: true });
      const hand = '# Riverbend keeps its own rules here\n*.wav\n';
      writeFileSync(meetingGitignorePath(folder), hand);

      expect(applyMeetingGitignore(folder, true)).toBe('foreign');
      expect(applyMeetingGitignore(folder, false)).toBe('foreign');
      // The point of the refusal: the bytes are exactly as they were.
      expect(readFileSync(meetingGitignorePath(folder), 'utf8')).toBe(hand);
    });
  });

  describe('the filing index', () => {
    const filing = (over: Partial<MeetingFiling> = {}): MeetingFiling => ({
      docId: 'd-tide',
      workspaceId: 'w-riverbend',
      filedAt: 1_000,
      repoKey: 'git:example.com/harborlight/riverbend',
      leadAgentId: 'a-saltmarsh',
      kind: 'discussion',
      provider: 'none',
      relPath: 'docs/meetings/huddle-20260829-1405-x7q2.md',
      retention: 'transcripts-and-audio',
      ...over,
    });

    it('reads back nothing before anything is filed', () => {
      expect(listMeetingFilings(tmp)).toEqual([]);
      expect(meetingFilingFor(tmp, 'd-tide')).toBeUndefined();
    });

    it('keeps every field a meeting was filed with', () => {
      const one = filing();
      recordMeetingFiling(tmp, one);
      expect(meetingFilingFor(tmp, one.docId)).toEqual(one);
    });

    it('lets a later line win, and orders what it returns by when each was filed', () => {
      recordMeetingFiling(tmp, filing({ docId: 'd-late', filedAt: 9_000, kind: 'plan' }));
      recordMeetingFiling(tmp, filing({ provider: 'none' }));
      // The same meeting again, an hour later, once a provider was heard.
      recordMeetingFiling(tmp, filing({ provider: 'assemblyai', filedAt: 1_000 }));

      expect(listMeetingFilings(tmp).map((f) => [f.docId, f.provider, f.kind])).toEqual([
        ['d-tide', 'assemblyai', 'discussion'],
        ['d-late', 'none', 'plan'],
      ]);
    });

    it('skips a torn line and an id-less one rather than losing the file', () => {
      recordMeetingFiling(tmp, filing());
      appendFileSync(meetingFilingIndexPath(tmp), '{"docId":"d-torn","workspac\n');
      appendFileSync(meetingFilingIndexPath(tmp), '{"workspaceId":"w-riverbend"}\n');
      recordMeetingFiling(tmp, filing({ docId: 'd-after', filedAt: 2_000 }));

      expect(listMeetingFilings(tmp).map((f) => f.docId)).toEqual(['d-tide', 'd-after']);
    });

    it('names the provider once something hears the meeting, and only then', () => {
      recordMeetingFiling(tmp, filing());
      expect(meetingFilingFor(tmp, 'd-tide')?.provider).toBe('none');

      noteMeetingProvider(tmp, 'd-tide', 'assemblyai');
      const heard = meetingFilingFor(tmp, 'd-tide');
      expect(heard?.provider).toBe('assemblyai');
      // Everything else the meeting was filed with survives the update.
      expect(heard).toEqual({ ...filing(), provider: 'assemblyai' });

      // Saying the same thing twice appends nothing — the index is a record,
      // not a log of every time somebody asked.
      const before = readFileSync(meetingFilingIndexPath(tmp), 'utf8');
      noteMeetingProvider(tmp, 'd-tide', 'assemblyai');
      expect(readFileSync(meetingFilingIndexPath(tmp), 'utf8')).toBe(before);

      // A doc nobody filed as a meeting stays out of the index entirely.
      noteMeetingProvider(tmp, 'd-plain', 'assemblyai');
      expect(meetingFilingFor(tmp, 'd-plain')).toBeUndefined();
    });

    it('falls back to honest values when a stored line says something unknown', () => {
      mkdirSync(join(tmp, 'meetings'), { recursive: true });
      appendFileSync(
        meetingFilingIndexPath(tmp),
        `${JSON.stringify({ docId: 'd-odd', workspaceId: 'w-riverbend', kind: 'seance', retention: 'some' })}\n`,
      );
      const row = meetingFilingFor(tmp, 'd-odd');
      expect(row?.kind).toBe('discussion');
      expect(row?.provider).toBe('none');
      // An unreadable retention keeps what the project was already keeping.
      expect(row?.retention).toBe(DEFAULT_MEETING_RETENTION);
    });
  });

  it("names a meeting's file after its alias, with nothing a path could read", () => {
    expect(meetingFileName('huddle-20260829-1405-x7q2')).toBe('huddle-20260829-1405-x7q2.md');
    expect(meetingFileName('../../etc/passwd')).toBe('.._.._etc_passwd.md');
    expect(meetingFileName('a/b c')).toBe('a_b_c.md');
  });
});
