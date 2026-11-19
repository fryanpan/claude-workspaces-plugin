/**
 * The cold-threads cache on its own: it decodes once per unchanged doc,
 * stays inside both of its bounds, and every state verb that changes what a
 * read returns forgets the doc; what it saves, a later cache reads back only
 * for docs whose state is unchanged. The server-level behaviour is
 * `home-cold-threads-cache.test.ts`.
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Thread } from '@claude-workspaces/core';
import { ColdThreadsCache, forgettingWrites } from '../src/cold-threads-cache.ts';
import { MemoryDocStateStore } from '../src/doc-state/memory.ts';

const thread = (id: string, text = 'Alice, which tide?'): Thread =>
  ({ id, status: 'open', comments: [{ id: `${id}-c`, text }] }) as unknown as Thread;

/** A reader that counts how often it is asked. */
function reader(threads: Thread[]) {
  let calls = 0;
  return {
    read: () => {
      calls++;
      return threads;
    },
    calls: () => calls,
  };
}

describe('ColdThreadsCache', () => {
  it('reads a doc once, then answers from memory with a fresh array each time', () => {
    const cache = new ColdThreadsCache();
    const r = reader([thread('t1'), thread('t2')]);
    const a = cache.get('task:harborlight', r.read);
    a.reverse();
    const b = cache.get('task:harborlight', r.read);
    expect(r.calls()).toBe(1);
    expect(b.map((t) => t.id)).toEqual(['t1', 't2']);
    expect(cache.stats()).toMatchObject({ docs: 1, hits: 1, misses: 1 });
  });

  it('forget makes the next read decode again', () => {
    const cache = new ColdThreadsCache();
    const r = reader([thread('t1')]);
    cache.get('task:riverbend', r.read);
    cache.forget('task:riverbend');
    cache.get('task:riverbend', r.read);
    expect(r.calls()).toBe(2);
    expect(cache.stats().docs).toBe(1);
  });

  it('holds at most maxDocs, dropping the least recently read', () => {
    const cache = new ColdThreadsCache(2, Number.MAX_SAFE_INTEGER);
    const r = reader([thread('t1')]);
    cache.get('a', r.read);
    cache.get('b', r.read);
    cache.get('a', r.read); // a is now the most recent
    cache.get('c', r.read); // b goes
    expect(cache.stats().docs).toBe(2);
    const before = r.calls();
    cache.get('a', r.read);
    cache.get('c', r.read);
    expect(r.calls()).toBe(before);
    cache.get('b', r.read);
    expect(r.calls()).toBe(before + 1);
  });

  it('holds no more than maxChars of estimated text, and never keeps a doc bigger than that', () => {
    const big = [thread('t1', 'x'.repeat(5_000))];
    const cache = new ColdThreadsCache(100, 12_000);
    const r = reader(big);
    cache.get('a', r.read);
    cache.get('b', r.read);
    cache.get('c', r.read);
    expect(cache.stats().chars).toBeLessThanOrEqual(12_000);
    expect(cache.stats().docs).toBe(2);

    const tiny = new ColdThreadsCache(100, 1_000);
    const huge = reader(big);
    expect(tiny.get('a', huge.read)).toHaveLength(1);
    tiny.get('a', huge.read);
    expect(huge.calls()).toBe(2);
    expect(tiny.stats()).toMatchObject({ docs: 0, chars: 0 });
  });
});

describe('ColdThreadsCache across processes', () => {
  const withDir = (run: (path: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), 'cold-threads-save-'));
    try {
      run(join(dir, 'cold-threads.json'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('a restored entry answers while its stamp holds, and is decoded again once it moved', () => {
    withDir((path) => {
      const first = new ColdThreadsCache();
      first.get('task:harborlight', reader([thread('t1')]).read, () => 100);
      first.get('task:riverbend', reader([thread('t2')]).read, () => 200);
      expect(first.save(path)).toBe(2);

      const next = new ColdThreadsCache();
      expect(next.load(path)).toBe(2);
      const same = reader([thread('never')]);
      expect(next.get('task:harborlight', same.read, () => 100).map((t) => t.id)).toEqual(['t1']);
      expect(same.calls()).toBe(0);
      // Control: the riverbend doc was written after the save.
      const moved = reader([thread('t2-new')]);
      expect(next.get('task:riverbend', moved.read, () => 201).map((t) => t.id)).toEqual([
        't2-new',
      ]);
      expect(moved.calls()).toBe(1);
      // A reader that cannot say the stamp gets no restored answer either.
      const unstamped = new ColdThreadsCache();
      unstamped.load(path);
      const r = reader([thread('t1-read')]);
      expect(unstamped.get('task:harborlight', r.read).map((t) => t.id)).toEqual(['t1-read']);
      expect(r.calls()).toBe(1);
    });
  });

  it('saves no entry it holds without a stamp', () => {
    withDir((path) => {
      const cache = new ColdThreadsCache();
      cache.get('task:saltmarsh', reader([thread('t1')]).read);
      cache.get('task:harborlight', reader([thread('t2')]).read, () => undefined);
      expect(cache.save(path)).toBe(0);
      expect(new ColdThreadsCache().load(path)).toBe(0);
    });
  });

  it('a missing, damaged or foreign file loads nothing', () => {
    withDir((path) => {
      expect(new ColdThreadsCache().load(path)).toBe(0);
      writeFileSync(path, '{"v":1,"entries":[["task:a",1,[{"id":"t"}]]');
      expect(new ColdThreadsCache().load(path)).toBe(0);
      writeFileSync(path, JSON.stringify({ v: 2, entries: [['task:a', 1, [thread('t')]]] }));
      expect(new ColdThreadsCache().load(path)).toBe(0);
      // A thread with no comment list would break every reader: skipped.
      writeFileSync(
        path,
        JSON.stringify({
          v: 1,
          entries: [
            ['task:a', 1, [{ id: 't' }]],
            ['task:b', 1, [thread('t')]],
          ],
        }),
      );
      const cache = new ColdThreadsCache();
      expect(cache.load(path)).toBe(1);
      expect(cache.stats().docs).toBe(1);
    });
  });
});

describe('forgettingWrites', () => {
  it('forgets the doc on every verb that changes what read returns, and on no read', () => {
    const forgotten: string[] = [];
    const store = forgettingWrites(new MemoryDocStateStore(), (id) => forgotten.push(id));
    const bytes = new Uint8Array([1, 2, 3]);

    store.write('a', bytes);
    expect(store.read('a')).toEqual(bytes);
    expect(store.has('a')).toBe(true);
    store.savedAt('a');
    store.list();
    expect(forgotten).toEqual(['a']);

    store.move('a', 'live', 'archive');
    store.move('a', 'archive', 'live');
    store.stageDelete('a');
    store.unstageDelete('a');
    store.stageDelete('a');
    store.dropStaged('a');
    store.write('b', bytes);
    store.remove('b');
    expect(forgotten).toEqual(['a', 'a', 'a', 'a', 'a', 'a', 'a', 'b', 'b']);
    expect(store.kind).toBe(new MemoryDocStateStore().kind);
  });
});
