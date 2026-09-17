/**
 * The file behind the memory of where a meeting's quality item went: what it
 * writes, what it answers for a meeting that has no item, what it does with a
 * record it cannot trust, and what it does when the disk will not cooperate.
 *
 * All fixtures are synthetic. The repo is public.
 */

import { afterAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { meetingTranscriptPath } from '../src/meetings.ts';
import {
  FILED_MEMORY_MAX_AGE_MS,
  type NotesQualityFiledItem,
  createNotesQualityFiledFileStore,
  notesQualityFiledPath,
} from '../src/notes-quality-filed-store.ts';

const dirs: string[] = [];
const freshDataDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'cw-filed-store-'));
  dirs.push(dir);
  return dir;
};

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const ids = { docId: 'd-harbour', meetingId: 'm-1750000000000' };

const ROW_ITEM: NotesQualityFiledItem = {
  filed: { kind: 'row', taskId: 't-slipway', itemId: 'ri-1' },
  verdict: { kinds: ['duplicate-bullets'], counts: { 'duplicate-bullets': 4 }, ratios: {} },
};

describe('the quality filing store', () => {
  it('reads back the item it was given, with the verdict that item carries', () => {
    const store = createNotesQualityFiledFileStore(freshDataDir());
    store.write(ids, ROW_ITEM);
    expect(store.read(ids)).toEqual(ROW_ITEM);
  });

  it('reads back a comment on a doc as readily as an item on a row', () => {
    // The two filing paths are separate shapes, and a store that only round
    // trips the row one would lose every meeting whose doc has no task.
    const store = createNotesQualityFiledFileStore(freshDataDir());
    const onDoc: NotesQualityFiledItem = {
      filed: { kind: 'doc', docId: ids.docId, threadId: 'th-1', commentId: 'c-1' },
    };
    store.write(ids, onDoc);
    expect(store.read(ids)).toEqual(onDoc);
  });

  it('answers nothing for a meeting that has filed nothing', () => {
    const store = createNotesQualityFiledFileStore(freshDataDir());
    expect(store.read(ids)).toBeUndefined();
  });

  it('keeps one record per meeting, so a second recording reads its own', () => {
    const store = createNotesQualityFiledFileStore(freshDataDir());
    const other = { docId: ids.docId, meetingId: 'm-1750000900000' };
    store.write(ids, ROW_ITEM);
    store.write(other, {
      filed: { kind: 'row', taskId: 't-slipway', itemId: 'ri-2' },
    });
    expect(store.read(ids)?.filed).toEqual(ROW_ITEM.filed);
    expect(store.read(other)?.filed).toEqual({
      kind: 'row',
      taskId: 't-slipway',
      itemId: 'ri-2',
    });
  });

  it('overwrites the record when the item is revised', () => {
    const store = createNotesQualityFiledFileStore(freshDataDir());
    store.write(ids, ROW_ITEM);
    store.write(ids, {
      filed: ROW_ITEM.filed,
      verdict: { kinds: ['duplicate-bullets'], counts: { 'duplicate-bullets': 9 }, ratios: {} },
    });
    expect(store.read(ids)?.verdict?.counts).toEqual({ 'duplicate-bullets': 9 });
  });

  it('clears a record, and clearing one that was never written is quiet', () => {
    const store = createNotesQualityFiledFileStore(freshDataDir());
    store.write(ids, ROW_ITEM);
    store.clear(ids);
    expect(store.read(ids)).toBeUndefined();
    store.clear(ids);
    expect(store.read(ids)).toBeUndefined();
  });

  it('writes beside the meeting’s own transcript', () => {
    // The placement is the point: the record and the words it is about live
    // in the meeting's folder, so deleting the folder cannot leave a pointer
    // to an ask about a meeting nothing can explain any more.
    const dataDir = freshDataDir();
    createNotesQualityFiledFileStore(dataDir).write(ids, ROW_ITEM);
    const path = notesQualityFiledPath(dataDir, ids.docId, ids.meetingId);
    expect(existsSync(path)).toBe(true);
    expect(dirname(path)).toBe(dirname(meetingTranscriptPath(dataDir, ids.docId, ids.meetingId)));
  });

  it('leaves no temp file behind', () => {
    // The write is a temp file plus a rename, so a restart between the two
    // halves cannot produce a half-written record. What must not survive is
    // the temp file itself.
    const dataDir = freshDataDir();
    createNotesQualityFiledFileStore(dataDir).write(ids, ROW_ITEM);
    expect(existsSync(`${notesQualityFiledPath(dataDir, ids.docId, ids.meetingId)}.tmp`)).toBe(
      false,
    );
  });

  it('holds the ids, the ask and the numbers — and no meeting words', () => {
    const dataDir = freshDataDir();
    createNotesQualityFiledFileStore(dataDir).write(ids, ROW_ITEM);
    const record = JSON.parse(
      readFileSync(notesQualityFiledPath(dataDir, ids.docId, ids.meetingId), 'utf8'),
    ) as Record<string, unknown>;
    expect(Object.keys(record).sort()).toEqual(['at', 'docId', 'filed', 'meetingId', 'verdict']);
    expect(record.docId).toBe(ids.docId);
    expect(record.meetingId).toBe(ids.meetingId);
  });

  it('reads a corrupt record as no record rather than throwing', () => {
    // A record truncated by a crash must cost the meeting its memory of the
    // ask, never the next filing.
    const dataDir = freshDataDir();
    const path = notesQualityFiledPath(dataDir, ids.docId, ids.meetingId);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{"filed": {"kind": "row", "taskId": "t-sli');
    expect(createNotesQualityFiledFileStore(dataDir).read(ids)).toBeUndefined();
  });

  it('ignores a record whose ask cannot be addressed', () => {
    // Half an address is not an address: the call it would be used in is a
    // write against somebody's queue, so every id is checked.
    const dataDir = freshDataDir();
    const path = notesQualityFiledPath(dataDir, ids.docId, ids.meetingId);
    mkdirSync(dirname(path), { recursive: true });
    const store = createNotesQualityFiledFileStore(dataDir);
    for (const filed of [
      { kind: 'row', taskId: 't-slipway' },
      { kind: 'row', taskId: '', itemId: 'ri-1' },
      { kind: 'doc', docId: 'd-harbour', threadId: 'th-1' },
      { kind: 'gate', taskId: 't-slipway', itemId: 'ri-1' },
      'ri-1',
    ]) {
      writeFileSync(path, JSON.stringify({ filed, at: Date.now() }));
      expect(store.read(ids)).toBeUndefined();
    }
  });

  it('keeps the ask when only the verdict is unusable', () => {
    // The two answer different questions. Without the ask the item cannot be
    // addressed at all; without the verdict it is addressed once more than it
    // needs to be, which is the cheaper loss by far.
    const dataDir = freshDataDir();
    const path = notesQualityFiledPath(dataDir, ids.docId, ids.meetingId);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({ filed: ROW_ITEM.filed, at: Date.now(), verdict: { kinds: 'lots' } }),
    );
    const read = createNotesQualityFiledFileStore(dataDir).read(ids);
    expect(read?.filed).toEqual(ROW_ITEM.filed);
    expect(read?.verdict).toBeUndefined();
  });

  it('drops the numbers it cannot read out of a verdict it otherwise can', () => {
    const dataDir = freshDataDir();
    const path = notesQualityFiledPath(dataDir, ids.docId, ids.meetingId);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        filed: ROW_ITEM.filed,
        at: Date.now(),
        verdict: {
          kinds: ['duplicate-bullets', 'coverage'],
          counts: { 'duplicate-bullets': 4, 'flat-runs': null },
          ratios: { coverage: 0.51, late: 'half' },
        },
      }),
    );
    expect(createNotesQualityFiledFileStore(dataDir).read(ids)?.verdict).toEqual({
      kinds: ['duplicate-bullets', 'coverage'],
      counts: { 'duplicate-bullets': 4 },
      ratios: { coverage: 0.51 },
    });
  });

  it('forgets a record older than the bound, and deletes it', () => {
    // A restart is minutes. A record a day old names an item its reader has
    // long since seen, and reviving it would re-judge that item in front of
    // them; filing a fresh one is the safe direction.
    const dataDir = freshDataDir();
    let clock = 1_800_000_000_000;
    const store = createNotesQualityFiledFileStore(dataDir, { now: () => clock });
    store.write(ids, ROW_ITEM);
    clock += FILED_MEMORY_MAX_AGE_MS;
    expect(store.read(ids)?.filed).toEqual(ROW_ITEM.filed);
    clock += 1;
    expect(store.read(ids)).toBeUndefined();
    expect(existsSync(notesQualityFiledPath(dataDir, ids.docId, ids.meetingId))).toBe(false);
  });

  it('forgets a record that cannot say how old it is', () => {
    const dataDir = freshDataDir();
    const path = notesQualityFiledPath(dataDir, ids.docId, ids.meetingId);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ filed: ROW_ITEM.filed }));
    expect(createNotesQualityFiledFileStore(dataDir).read(ids)).toBeUndefined();
    expect(existsSync(path)).toBe(false);
  });

  it('a write it cannot make is not an exception', () => {
    // The data dir is a FILE here, so every mkdir under it fails. The stop
    // path must still file; it simply remembers where for as long as the
    // process lives.
    const dir = freshDataDir();
    const notADir = join(dir, 'blocked');
    writeFileSync(notADir, 'not a directory');
    const store = createNotesQualityFiledFileStore(notADir);
    expect(() => store.write(ids, ROW_ITEM)).not.toThrow();
    expect(store.read(ids)).toBeUndefined();
    expect(() => store.clear(ids)).not.toThrow();
  });
});
