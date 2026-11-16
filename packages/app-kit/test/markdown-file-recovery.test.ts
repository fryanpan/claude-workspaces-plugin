/**
 * `markdownFileRoom` when things go wrong: an outside edit that loses a
 * conflict waits for the app's async `onConflict` before anything is saved
 * over it, a failing save backs off, and a file that is gone is reported
 * once per disappearance and not retried.
 */
import { describe, expect, it } from 'vitest';
import {
  type FileConflict,
  MAX_RETRY_MS,
  defaultRetryDelayMs,
  markdownFileRoom,
} from '../src/markdown-file/index.ts';
import { manualSchedule, memoryState, open } from './markdown-file-fakes.ts';
import { until } from './poll.ts';

/** A promise the test settles. */
function gate() {
  let open!: () => void;
  let refuse!: (err: Error) => void;
  const done = new Promise<void>((resolve, reject) => {
    open = resolve;
    refuse = reject;
  });
  return { done, open, refuse };
}

describe('an outside edit that loses a conflict', () => {
  it('is kept by an async onConflict before the save overwrites the file', async () => {
    const order: string[] = [];
    const g = gate();
    const { room, f, body } = await open({
      initial: 'alpha beta gamma',
      onConflict: async (c) => {
        await g.done;
        order.push(`kept ${c.remote}`);
      },
    });
    f.file.during = () => order.push(`saved ${body.toString()}`);
    body.delete(6, 4);
    body.insert(6, 'Riverbend');
    f.file.text = 'alpha Saltmarsh gamma';
    const refreshing = room.refresh();
    const saving = room.flush();
    // The app's copy finishes on a later turn than any save could start.
    setTimeout(g.open, 0);
    await Promise.all([refreshing, saving]);
    expect(order).toEqual(['kept alpha Saltmarsh gamma', 'saved alpha Riverbend gamma']);
    expect(f.file.text).toBe('alpha Riverbend gamma');
  });

  it('is met again by a new instance when the old one went away inside onConflict', async () => {
    const state = memoryState();
    let entered = false;
    const first = await open({
      initial: 'alpha beta gamma',
      state,
      // The instance is evicted while the app's copy is still being written.
      onConflict: () => {
        entered = true;
        return new Promise<void>(() => {});
      },
    });
    first.body.delete(6, 4);
    first.body.insert(6, 'Riverbend');
    first.f.file.text = 'alpha Saltmarsh gamma';
    void first.room.refresh();
    await until('the first instance to call onConflict', () => entered);

    const seen: FileConflict[] = [];
    const second = await markdownFileRoom({
      load: first.f.load,
      save: first.f.save,
      state,
      schedule: manualSchedule().schedule,
      onConflict: async (c) => void seen.push(c),
    });
    expect(seen.map((c) => c.remote)).toEqual(['alpha Saltmarsh gamma']);
    expect(second.text()).toBe('alpha Riverbend gamma');
  });

  it('is not saved over while onConflict fails, and is saved over once it succeeds', async () => {
    let refuse = true;
    const kept: string[] = [];
    const errors: unknown[] = [];
    const { room, f, body } = await open({
      initial: 'alpha beta gamma',
      onConflict: async (c) => {
        if (refuse) throw new Error('the conflict copy could not be written');
        kept.push(c.remote);
      },
      onSaveError: (e) => errors.push(e),
    });
    body.delete(6, 4);
    body.insert(6, 'Riverbend');
    f.file.text = 'alpha Saltmarsh gamma';
    await expect(room.refresh()).rejects.toThrow('conflict copy');
    await room.flush();
    expect(f.file.writes).toEqual([]);
    expect(errors.length).toBe(1);
    refuse = false;
    await room.flush();
    expect(kept).toEqual(['alpha Saltmarsh gamma']);
    expect(f.file.text).toBe('alpha Riverbend gamma');
  });
});

describe('a failed save', () => {
  it('is tried again after a delay that doubles with each failure in a row', async () => {
    const { room, f, s, body } = await open({ initial: 'x', onSaveError: () => {} });
    body.insert(1, 'y');
    f.file.failing = 3;
    await room.flush();
    await room.flush();
    // An edit during the failures waits out the backoff, not the debounce.
    body.insert(2, 'z');
    await room.flush();
    expect(s.requested).toEqual([2000, 2000, 4000, 4000, 8000]);
    await room.flush();
    expect(f.file.text).toBe('xyz');
    body.insert(3, '!');
    expect(s.requested.at(-1)).toBe(2000);
  });

  it('takes its backoff from retryDelayMs', async () => {
    const { room, f, s, body } = await open({
      initial: 'x',
      onSaveError: () => {},
      retryDelayMs: (failures) => failures * 100,
    });
    body.insert(1, 'y');
    f.file.failing = 2;
    await room.flush();
    await room.flush();
    expect(s.requested).toEqual([2000, 100, 200]);
  });

  it('by default waits defaultRetryDelayMs, which an app can wrap', async () => {
    expect([1, 2, 3].map((n) => defaultRetryDelayMs(n))).toEqual([2000, 4000, 8000]);
    expect(defaultRetryDelayMs(3, 500)).toBe(2000);
    expect(defaultRetryDelayMs(40)).toBe(MAX_RETRY_MS);
    const { room, f, s, body } = await open({
      initial: 'x',
      debounceMs: 300,
      onSaveError: () => {},
    });
    body.insert(1, 'y');
    f.file.failing = 2;
    await room.flush();
    await room.flush();
    expect(s.requested).toEqual([300, defaultRetryDelayMs(1, 300), defaultRetryDelayMs(2, 300)]);
  });
});

describe('a file that is gone', () => {
  it('is reported once, and nothing is saved or scheduled until it is back', async () => {
    const reported: unknown[] = [];
    const errors: unknown[] = [];
    const { room, f, s, body } = await open({
      initial: 'Harborlight',
      onMissing: (e) => void reported.push(e),
      onSaveError: (e) => errors.push(e),
    });
    body.insert(11, ' tides');
    f.file.gone = true;
    await room.flush();
    expect(room.missing()).toBe(true);
    expect(reported.length).toBe(1);
    const asked = s.requested.length;
    body.insert(17, ' at noon');
    await room.flush();
    await room.refresh();
    expect(s.requested.length).toBe(asked);
    expect(reported.length).toBe(1);
    expect(errors).toEqual([]);
    expect(room.dirty()).toBe(true);

    // The app puts the file back and refreshes: saving resumes.
    f.file.gone = false;
    f.file.text = room.text();
    await room.refresh();
    expect(room.missing()).toBe(false);
    expect(room.dirty()).toBe(false);
    body.insert(0, '# ');
    await room.flush();
    expect(f.file.text).toBe('# Harborlight tides at noon');
  });

  it('is reported when a refresh finds it gone', async () => {
    const reported: unknown[] = [];
    const { room, f } = await open({ onMissing: (e) => void reported.push(e) });
    f.file.gone = true;
    await room.refresh();
    expect(room.missing()).toBe(true);
    expect(reported.length).toBe(1);
  });

  it('is reported again when it comes back and goes again', async () => {
    const reported: unknown[] = [];
    const { room, f } = await open({ onMissing: (e) => void reported.push(e) });
    f.file.gone = true;
    await room.refresh();
    await room.refresh();
    expect(reported.length).toBe(1);
    f.file.gone = false;
    await room.refresh();
    f.file.gone = true;
    await room.refresh();
    expect(reported.length).toBe(2);
  });

  it('is not reported again by a new instance once onMissing settled', async () => {
    const state = memoryState();
    const first = await open({ state, onMissing: () => {} });
    first.f.file.gone = true;
    await first.room.refresh();
    const reported: unknown[] = [];
    const second = await markdownFileRoom({
      load: first.f.load,
      save: first.f.save,
      state,
      schedule: manualSchedule().schedule,
      onMissing: (e) => void reported.push(e),
    });
    expect(second.missing()).toBe(true);
    expect(reported).toEqual([]);
  });

  it('is reported again by a new instance when the old one went away inside onMissing', async () => {
    const state = memoryState();
    let entered = false;
    const first = await open({
      state,
      onMissing: () => {
        entered = true;
        return new Promise<void>(() => {});
      },
    });
    first.f.file.gone = true;
    void first.room.refresh();
    await until('the first instance to call onMissing', () => entered);
    expect(first.room.missing()).toBe(true);

    const reported: unknown[] = [];
    const second = await markdownFileRoom({
      load: first.f.load,
      save: first.f.save,
      state,
      schedule: manualSchedule().schedule,
      onMissing: (e) => void reported.push(e),
    });
    expect(reported.length).toBe(1);
    expect(second.missing()).toBe(true);
  });

  it('is reported again on the next refresh when onMissing rejected', async () => {
    let refuse = true;
    const reported: unknown[] = [];
    const errors: unknown[] = [];
    const { room, f } = await open({
      onMissing: async (e) => {
        if (refuse) throw new Error('the notice could not be sent');
        reported.push(e);
      },
      onSaveError: (e) => errors.push(e),
    });
    f.file.gone = true;
    await room.refresh();
    expect(room.missing()).toBe(true);
    expect(errors.map((e) => (e as Error).message)).toEqual(['the notice could not be sent']);
    refuse = false;
    await room.refresh();
    await room.refresh();
    expect(reported.length).toBe(1);
  });
});
