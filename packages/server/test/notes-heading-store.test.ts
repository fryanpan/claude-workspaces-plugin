/**
 * The file behind the note-taker's memory of which heading a meeting writes
 * under: where it puts a record, what it answers for a meeting that has none,
 * and what it does when the disk will not cooperate.
 *
 * All fixtures are synthetic. The repo is public.
 */

import { afterAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { meetingSectionPath, meetingTranscriptPath } from '../src/meetings.ts';
import { createNotesHeadingFileStore } from '../src/notes-heading-store.ts';

const dirs: string[] = [];
const freshDataDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'cw-heading-store-'));
  dirs.push(dir);
  return dir;
};

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const ids = { docId: 'd-plan', meetingId: 'm-1750000000000' };

describe('the meeting heading store', () => {
  it('reads back the heading it was given', () => {
    const store = createNotesHeadingFileStore(freshDataDir());
    store.write(ids, 'b-section-1');
    expect(store.read(ids)).toBe('b-section-1');
  });

  it('answers nothing for a meeting that has opened no section', () => {
    const store = createNotesHeadingFileStore(freshDataDir());
    expect(store.read(ids)).toBeUndefined();
  });

  it('keeps one record per meeting, so a second recording reads its own', () => {
    const store = createNotesHeadingFileStore(freshDataDir());
    const other = { docId: ids.docId, meetingId: 'm-1750000900000' };
    store.write(ids, 'b-section-1');
    store.write(other, 'b-section-2');
    expect(store.read(ids)).toBe('b-section-1');
    expect(store.read(other)).toBe('b-section-2');
  });

  it('overwrites the record when the meeting opens a different section', () => {
    const store = createNotesHeadingFileStore(freshDataDir());
    store.write(ids, 'b-section-1');
    store.write(ids, 'b-section-2');
    expect(store.read(ids)).toBe('b-section-2');
  });

  it('clears a record, and clearing one that was never written is quiet', () => {
    const store = createNotesHeadingFileStore(freshDataDir());
    store.write(ids, 'b-section-1');
    store.clear(ids);
    expect(store.read(ids)).toBeUndefined();
    store.clear(ids);
    expect(store.read(ids)).toBeUndefined();
  });

  it('writes beside the meeting’s own transcript', () => {
    // The placement is the point: the record, the words it describes and the
    // timings all live in the meeting's folder, so deleting the folder cannot
    // leave a memory of a section behind.
    const dataDir = freshDataDir();
    createNotesHeadingFileStore(dataDir).write(ids, 'b-section-1');
    const path = meetingSectionPath(dataDir, ids.docId, ids.meetingId);
    expect(existsSync(path)).toBe(true);
    expect(dirname(path)).toBe(dirname(meetingTranscriptPath(dataDir, ids.docId, ids.meetingId)));
  });

  it('leaves no temp file behind', () => {
    // The write is a temp file plus a rename, so a restart between the two
    // halves cannot produce a half-written record. What must not survive is
    // the temp file itself.
    const dataDir = freshDataDir();
    createNotesHeadingFileStore(dataDir).write(ids, 'b-section-1');
    const path = meetingSectionPath(dataDir, ids.docId, ids.meetingId);
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });

  it('holds the ids and the heading, and no meeting words', () => {
    const dataDir = freshDataDir();
    createNotesHeadingFileStore(dataDir).write(ids, 'b-section-1');
    const record = JSON.parse(
      readFileSync(meetingSectionPath(dataDir, ids.docId, ids.meetingId), 'utf8'),
    ) as Record<string, unknown>;
    expect(record.headingId).toBe('b-section-1');
    expect(record.docId).toBe(ids.docId);
    expect(record.meetingId).toBe(ids.meetingId);
    expect(Object.keys(record).sort()).toEqual(['at', 'docId', 'headingId', 'meetingId']);
  });

  it('reads a corrupt record as no record rather than throwing', () => {
    // A record truncated by a crash must cost the meeting its memory of the
    // section, never its notes.
    const dataDir = freshDataDir();
    const path = meetingSectionPath(dataDir, ids.docId, ids.meetingId);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{"headingId": "b-sec');
    expect(createNotesHeadingFileStore(dataDir).read(ids)).toBeUndefined();
  });

  it('ignores a record whose heading is not a usable id', () => {
    const dataDir = freshDataDir();
    const path = meetingSectionPath(dataDir, ids.docId, ids.meetingId);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ headingId: '' }));
    expect(createNotesHeadingFileStore(dataDir).read(ids)).toBeUndefined();
    writeFileSync(path, JSON.stringify({ headingId: 7 }));
    expect(createNotesHeadingFileStore(dataDir).read(ids)).toBeUndefined();
    writeFileSync(path, JSON.stringify(['b-section-1']));
    expect(createNotesHeadingFileStore(dataDir).read(ids)).toBeUndefined();
  });

  it('a write it cannot make is not an exception', () => {
    // The data dir is a FILE here, so every mkdir under it fails. The meeting
    // must keep taking notes; it simply remembers the heading only for as
    // long as the process lives.
    const dir = freshDataDir();
    const notADir = join(dir, 'blocked');
    writeFileSync(notADir, 'not a directory');
    const store = createNotesHeadingFileStore(notADir);
    expect(() => store.write(ids, 'b-section-1')).not.toThrow();
    expect(store.read(ids)).toBeUndefined();
    expect(() => store.clear(ids)).not.toThrow();
  });

  it('keeps a doc id with a path separator inside the meetings tree', () => {
    // A doc id reaches a path here, so it is sanitized before it can mean
    // `..` — the same rule the transcript path holds.
    const dataDir = freshDataDir();
    const hostile = { docId: '../../escape', meetingId: 'm-1' };
    const store = createNotesHeadingFileStore(dataDir);
    store.write(hostile, 'b-section-1');
    const path = meetingSectionPath(dataDir, hostile.docId, hostile.meetingId);
    expect(path.startsWith(join(dataDir, 'meetings'))).toBe(true);
    expect(existsSync(path)).toBe(true);
    expect(store.read(hostile)).toBe('b-section-1');
  });
});
