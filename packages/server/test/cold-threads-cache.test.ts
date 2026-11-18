/**
 * The cold-threads cache on its own: it decodes once per unchanged doc,
 * stays inside both of its bounds, and every state verb that changes what a
 * read returns forgets the doc. The server-level behaviour is
 * `home-cold-threads-cache.test.ts`.
 */
import { describe, expect, it } from 'bun:test';
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
