/**
 * `markdownFileRoom`: the file is read into the doc, changes are written back
 * as whole text after a debounce, an outside edit merges as one splice, and
 * unsaved changes survive the instance going away.
 */
import { describe, expect, it } from 'vitest';
import {
  type FileConflict,
  type FileRoomState,
  type MarkdownFileOptions,
  markdownFileRoom,
} from '../src/markdown-file/index.ts';
import { until } from './poll.ts';

/** A file the app reads and writes asynchronously, counting writes. */
function fakeFile(initial: string) {
  const file = {
    text: initial,
    writes: [] as string[],
    failNext: false,
    /** Runs while a save is in flight. */
    during: null as (() => void) | null,
  };
  return {
    file,
    load: async () => file.text,
    save: async (text: string) => {
      await Promise.resolve();
      file.during?.();
      file.during = null;
      if (file.failNext) {
        file.failNext = false;
        throw new Error('the file store refused the write');
      }
      file.text = text;
      file.writes.push(text);
    },
  };
}

function memoryState(): FileRoomState {
  const m = new Map<string, string>();
  return { read: (k) => m.get(k) ?? null, write: (k, v) => void m.set(k, v) };
}

/** A schedule the test drives: it records the last request. */
function manualSchedule() {
  const s = { requested: [] as number[] };
  return { s, schedule: (ms: number) => void s.requested.push(ms) };
}

async function open(extra: Partial<MarkdownFileOptions> & { initial?: string } = {}) {
  const f = fakeFile(extra.initial ?? '# Harborlight\n\nTide tables.\n');
  const state = extra.state ?? memoryState();
  const { s, schedule } = manualSchedule();
  const room = await markdownFileRoom({
    load: f.load,
    save: f.save,
    state,
    schedule,
    debounceMs: 2000,
    ...extra,
  });
  return { room, f, state, s, body: room.doc.getText('body') };
}

describe('markdownFileRoom', () => {
  it('reads the file into the doc and writes nothing until it changes', async () => {
    const { room, f, s } = await open();
    expect(room.text()).toBe('# Harborlight\n\nTide tables.\n');
    expect(room.dirty()).toBe(false);
    await room.flush();
    expect(f.file.writes).toEqual([]);
    expect(s.requested).toEqual([]);
  });

  it('asks for a save after the debounce on every change, and writes the whole text once', async () => {
    const { room, f, s, body } = await open();
    body.insert(body.length, 'High water at noon.\n');
    body.insert(body.length, 'Low water at six.\n');
    expect(s.requested).toEqual([2000, 2000]);
    await room.flush();
    expect(f.file.writes).toEqual([
      '# Harborlight\n\nTide tables.\nHigh water at noon.\nLow water at six.\n',
    ]);
    expect(room.dirty()).toBe(false);
  });

  it('saves on its own timer when no schedule is given', async () => {
    const f = fakeFile('one');
    const room = await markdownFileRoom({
      load: f.load,
      save: f.save,
      state: memoryState(),
      debounceMs: 30,
    });
    room.doc.getText('body').insert(3, ' two');
    await until('the debounced save', () => f.file.text === 'one two');
    expect(f.file.writes).toEqual(['one two']);
  });

  it('merges an outside edit as one splice when nobody has unsaved changes', async () => {
    const { room, f, body } = await open({ initial: 'alpha beta gamma' });
    const seen: unknown[] = [];
    body.observe((ev) => seen.push(ev.delta));
    f.file.text = 'alpha BETA gamma';
    await room.refresh();
    expect(room.text()).toBe('alpha BETA gamma');
    expect(seen).toEqual([[{ retain: 6 }, { delete: 4 }, { insert: 'BETA' }]]);
    expect(room.dirty()).toBe(false);
  });

  it('keeps unsaved changes and an outside edit that does not touch them', async () => {
    const { room, f, body } = await open({ initial: 'alpha beta gamma' });
    body.insert(16, ' delta');
    f.file.text = 'ALPHA beta gamma';
    await room.refresh();
    expect(room.text()).toBe('ALPHA beta gamma delta');
    await room.flush();
    expect(f.file.text).toBe('ALPHA beta gamma delta');
  });

  it('keeps unsaved changes over an outside edit to the same words, and says so', async () => {
    const conflicts: FileConflict[] = [];
    const { room, f, body } = await open({
      initial: 'alpha beta gamma',
      onConflict: (c) => conflicts.push(c),
    });
    body.delete(6, 4);
    body.insert(6, 'Riverbend');
    f.file.text = 'alpha Saltmarsh gamma';
    await room.refresh();
    expect(room.text()).toBe('alpha Riverbend gamma');
    expect(conflicts).toEqual([
      { base: 'alpha beta gamma', remote: 'alpha Saltmarsh gamma', local: 'alpha Riverbend gamma' },
    ]);
    expect(room.dirty()).toBe(true);
  });

  it('a new instance over the same state still has unsaved changes, and saves them', async () => {
    const state = memoryState();
    const first = await open({ initial: 'kept', state });
    first.body.insert(4, ' and more');
    // The instance goes away before its debounce fires; the file never got it.
    expect(first.f.file.writes).toEqual([]);

    const { s, schedule } = manualSchedule();
    const second = await markdownFileRoom({
      load: first.f.load,
      save: first.f.save,
      state,
      schedule,
    });
    expect(second.text()).toBe('kept and more');
    expect(s.requested.length).toBe(1);
    await second.flush();
    expect(first.f.file.text).toBe('kept and more');
  });

  it('keeps a change whose save failed, reports it and asks again', async () => {
    const errors: unknown[] = [];
    const { room, f, s, body } = await open({
      initial: 'x',
      onSaveError: (e) => errors.push(e),
    });
    body.insert(1, 'y');
    f.file.failNext = true;
    await room.flush();
    expect(errors.length).toBe(1);
    expect(room.dirty()).toBe(true);
    expect(s.requested.length).toBe(2);
    await room.flush();
    expect(f.file.text).toBe('xy');
  });

  it('saves again when the doc changed while a save was in flight', async () => {
    const { room, f, s, body } = await open({ initial: 'a' });
    body.insert(1, 'b');
    f.file.during = () => body.insert(2, 'c');
    await room.flush();
    expect(f.file.writes).toEqual(['ab']);
    expect(room.dirty()).toBe(true);
    expect(s.requested.at(-1)).toBe(2000);
    await room.flush();
    expect(f.file.writes).toEqual(['ab', 'abc']);
  });
});
