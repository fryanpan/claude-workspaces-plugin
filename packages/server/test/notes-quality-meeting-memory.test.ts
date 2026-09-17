/**
 * What the quality filer still knows about a meeting when a reading arrives:
 * the bound on how many meetings it remembers, which of them may be dropped,
 * and which half of the memory outlives the process.
 *
 * The store here is a fake that counts its calls, because the two ways this
 * can be wrong fail in opposite directions and one of them is invisible from
 * the outside: a memory that WRITES a record and never reads it, and one that
 * READS one and never writes it, both look correct to a single process.
 *
 * All fixtures are synthetic. The repo is public.
 */

import { describe, expect, it } from 'bun:test';
import type {
  NotesQualityFiledIds,
  NotesQualityFiledItem,
  NotesQualityFiledStore,
} from '../src/notes-quality-filed-store.ts';
import {
  REMEMBERED_MEETINGS,
  createNotesQualityMeetingMemory,
} from '../src/notes-quality-meeting-memory.ts';
import { badReading, cleanReading } from './notes-quality-board-harness.ts';

const ids = { docId: 'd-harbour', meetingId: 'm-1' };

const ITEM: NotesQualityFiledItem = {
  filed: { kind: 'row', taskId: 't-slipway', itemId: 'ri-1' },
  verdict: { kinds: ['duplicate-bullets'], counts: { 'duplicate-bullets': 4 }, ratios: {} },
};

/** A store that remembers in memory and counts what it was asked to do. */
interface CountingStore extends NotesQualityFiledStore {
  readonly reads: string[];
  readonly writes: NotesQualityFiledItem[];
  readonly clears: string[];
}

function countingStore(seed?: NotesQualityFiledItem): CountingStore {
  const reads: string[] = [];
  const writes: NotesQualityFiledItem[] = [];
  const clears: string[] = [];
  const held = new Map<string, NotesQualityFiledItem>();
  const key = (i: NotesQualityFiledIds): string => `${i.docId}/${i.meetingId}`;
  if (seed) held.set(key(ids), seed);
  return {
    reads,
    writes,
    clears,
    read(i) {
      reads.push(key(i));
      return held.get(key(i));
    },
    write(i, item) {
      writes.push(item);
      held.set(key(i), item);
    },
    clear(i) {
      clears.push(key(i));
      held.delete(key(i));
    },
  };
}

describe('the filer’s memory of a meeting', () => {
  it('hydrates an entry it has never seen from the store', () => {
    // The restart case at its smallest: this process filed nothing, and the
    // one before it filed everything.
    const store = countingStore(ITEM);
    const memory = createNotesQualityMeetingMemory(store);

    const entry = memory.get(ids);

    expect(entry.filed).toEqual(ITEM.filed);
    expect(entry.verdict).toEqual(ITEM.verdict);
  });

  it('does not go back to the store for an entry it already has', () => {
    // THE MUTATION THIS CATCHES: reading the store on every `get`. A record
    // is the OLDER copy of the same thing, so re-reading it over a live entry
    // would revive an item this process has already withdrawn.
    const store = countingStore(ITEM);
    const memory = createNotesQualityMeetingMemory(store);

    const first = memory.get(ids);
    memory.forget(ids, first);
    const second = memory.get(ids);

    expect(store.reads).toEqual(['d-harbour/m-1']);
    expect(second.filed).toBeUndefined();
  });

  it('answers nothing for a meeting nothing has read, without touching the store', () => {
    // `peek` is what a leg ending uses. A leg that ends on a meeting no
    // reading arrived for has nothing to commit, and must not make an entry.
    const store = countingStore(ITEM);
    const memory = createNotesQualityMeetingMemory(store);

    expect(memory.peek(ids)).toBeUndefined();
    expect(store.reads).toEqual([]);
  });

  it('writes nothing down for a meeting that filed nothing', () => {
    // THE MUTATION THIS CATCHES: a store written on every leg rather than on
    // a filing. A record naming no item can only mislead the next process,
    // and the commonest meeting of all is one that filed nothing.
    const store = countingStore();
    const memory = createNotesQualityMeetingMemory(store);

    const entry = memory.get(ids);
    entry.input = cleanReading(ids.docId);
    memory.remember(ids, entry);

    expect(store.writes).toEqual([]);
  });

  it('writes the ask and the verdict down when there is one', () => {
    const store = countingStore();
    const memory = createNotesQualityMeetingMemory(store);

    const entry = memory.get(ids);
    entry.filed = ITEM.filed;
    entry.verdict = ITEM.verdict;
    memory.remember(ids, entry);

    expect(store.writes).toEqual([ITEM]);
  });

  it('drops both halves when the item stops standing', () => {
    // THE MUTATION THIS CATCHES: forgetting in memory only. The record would
    // outlive the withdrawal, and the next process would revise an ask nobody
    // is being asked any more.
    const store = countingStore(ITEM);
    const memory = createNotesQualityMeetingMemory(store);

    const entry = memory.get(ids);
    memory.forget(ids, entry);

    expect(entry.filed).toBeUndefined();
    expect(entry.verdict).toBeUndefined();
    expect(store.clears).toEqual(['d-harbour/m-1']);
  });

  it('keeps working with no store at all', () => {
    // A server with no data dir, and every test that models two meetings in
    // one process. The memory is then this process's alone, which is what it
    // was before the store existed.
    const memory = createNotesQualityMeetingMemory();
    const entry = memory.get(ids);
    entry.filed = ITEM.filed;
    expect(() => memory.remember(ids, entry)).not.toThrow();
    memory.forget(ids, entry);
    expect(memory.get(ids).filed).toBeUndefined();
  });

  it('counts the meetings holding a reading, and no others', () => {
    const memory = createNotesQualityMeetingMemory();
    memory.get({ docId: 'd-a', meetingId: 'm-1' }).input = cleanReading('d-a');
    memory.get({ docId: 'd-b', meetingId: 'm-1' });
    expect(memory.heldCount()).toBe(1);
  });

  it('drops the oldest settled meetings once it is over its bound', () => {
    const memory = createNotesQualityMeetingMemory();
    const first = { docId: 'd-a', meetingId: 'm-0' };
    memory.get(first).filed = ITEM.filed;
    for (let n = 1; n <= REMEMBERED_MEETINGS; n++) {
      memory.get({ docId: 'd-a', meetingId: `m-${n}` }).filed = ITEM.filed;
    }
    expect(memory.peek(first)).toBeUndefined();
    expect(memory.peek({ docId: 'd-a', meetingId: 'm-1' })).toBeDefined();
  });

  it('never drops a meeting still holding a flagged reading or an armed grace', () => {
    // These two entries are the only copy of an item nothing can recreate:
    // the reading has not been committed and the store has no record of it,
    // because there is nothing filed yet to record.
    const memory = createNotesQualityMeetingMemory();
    const flagged = { docId: 'd-a', meetingId: 'm-flagged' };
    const waiting = { docId: 'd-a', meetingId: 'm-waiting' };
    memory.get(flagged).input = badReading('d-a');
    memory.get(waiting).timer = 'armed';
    for (let n = 1; n <= REMEMBERED_MEETINGS; n++) {
      memory.get({ docId: 'd-a', meetingId: `m-${n}` }).filed = ITEM.filed;
    }
    expect(memory.peek(flagged)).toBeDefined();
    expect(memory.peek(waiting)).toBeDefined();
  });

  it('reads an evicted meeting back out of the store', () => {
    // The bound costs this process its memory of a meeting; it does not cost
    // the meeting its item, because the durable half is still there.
    const store = countingStore(ITEM);
    const memory = createNotesQualityMeetingMemory(store);
    expect(memory.get(ids).filed).toEqual(ITEM.filed);
    for (let n = 1; n <= REMEMBERED_MEETINGS; n++) {
      memory.get({ docId: 'd-a', meetingId: `m-${n}` }).filed = ITEM.filed;
    }
    expect(memory.peek(ids)).toBeUndefined();
    expect(memory.get(ids).filed).toEqual(ITEM.filed);
  });
});
