/**
 * The history file's format (`doc-history/log.ts`): records read back as
 * written, an author is stored once, a record cut short by a crash is cut off
 * before the next append, and the disk store keeps its files private.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Y from 'yjs';
import {
  DiskHistoryStore,
  type HistoryAuthor,
  HistoryLog,
  MemoryHistoryStore,
  parseLog,
} from '../src/doc-history/log.ts';
import { versionAt } from '../src/doc-history/replay.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const ALICE: HistoryAuthor = { kind: 'person', id: 'person-alice', name: 'Alice' };
const BOB: HistoryAuthor = { kind: 'person', id: 'person-bob', name: 'Bob' };

/** Three updates to one text, in order. */
function threeUpdates(): Uint8Array[] {
  const doc = new Y.Doc();
  const out: Uint8Array[] = [];
  doc.on('update', (u: Uint8Array) => out.push(u));
  const t = doc.getText('content');
  t.insert(0, 'Harborlight');
  t.insert(11, ' and Riverbend');
  t.delete(0, 12);
  return out;
}

describe('the history log', () => {
  it('reads every record back as written, with its seq, time and author', () => {
    const store = new MemoryHistoryStore();
    const { log } = HistoryLog.open(store, 'harborlight-notes');
    const [a, b, c] = threeUpdates();
    expect(log.append({ at: 1000, kind: 'update', author: ALICE, update: a! })).toBe(0);
    expect(log.append({ at: 2000, kind: 'update', author: BOB, update: b! })).toBe(1);
    expect(
      log.append({ at: 3000, kind: 'restore', author: ALICE, update: c!, restoredTo: 0 }),
    ).toBe(2);
    const records = HistoryLog.open(store, 'harborlight-notes').log.records();
    expect(records.map((r) => [r.seq, r.at, r.kind, r.author.name, r.restoredTo])).toEqual([
      [0, 1000, 'update', 'Alice', undefined],
      [1, 2000, 'update', 'Bob', undefined],
      [2, 3000, 'restore', 'Alice', 0],
    ]);
    expect(versionAt(records, 1).getText('content').toString()).toBe('Harborlight and Riverbend');
    expect(versionAt(records, 2).getText('content').toString()).toBe('and Riverbend');
  });

  it('stores an author once, however many records name it', () => {
    const store = new MemoryHistoryStore();
    const { log } = HistoryLog.open(store, 'riverbend');
    const [a] = threeUpdates();
    log.append({ at: 1, kind: 'update', author: ALICE, update: a! });
    const one = store.size('riverbend');
    log.append({ at: 2, kind: 'update', author: ALICE, update: a! });
    const second = store.size('riverbend') - one;
    // The second record carries the update and a few bytes, not the author again.
    expect(second).toBeLessThan(a!.length + 8);
    expect(second).toBeLessThan(one);
  });

  it('cuts a torn last record before the next append, keeping every whole one', () => {
    const store = new MemoryHistoryStore();
    const [a, b, c] = threeUpdates();
    HistoryLog.open(store, 'saltmarsh').log.append({
      at: 1,
      kind: 'update',
      author: ALICE,
      update: a!,
    });
    const whole = store.size('saltmarsh');
    HistoryLog.open(store, 'saltmarsh').log.append({
      at: 2,
      kind: 'update',
      author: ALICE,
      update: b!,
    });
    // A crash mid-write: the second record is half there.
    store.truncate('saltmarsh', whole + 3);
    expect(parseLog(store.read('saltmarsh')).records).toHaveLength(1);
    const { log } = HistoryLog.open(store, 'saltmarsh');
    expect(store.size('saltmarsh')).toBe(whole);
    expect(log.append({ at: 3, kind: 'update', author: BOB, update: c! })).toBe(1);
    expect(log.records().map((r) => r.author.name)).toEqual(['Alice', 'Bob']);
  });

  it('keeps a disk log in a private file under the data folder', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'cw-history-log-'));
    dirs.push(dataDir);
    const store = new DiskHistoryStore(dataDir);
    const [a] = threeUpdates();
    HistoryLog.open(store, 'harborlight').log.append({
      at: 1,
      kind: 'update',
      author: ALICE,
      update: a!,
    });
    const path = store.pathOf('harborlight');
    expect(path.startsWith(join(dataDir, '_history'))).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(HistoryLog.open(store, 'harborlight').log.records()).toHaveLength(1);
  });
});
