/**
 * The stand-ins `markdownFileRoom`'s tests open a room over: a file the app
 * reads and writes asynchronously, a state store in memory, and a schedule
 * the test drives.
 */
import {
  FileMissingError,
  type FileRoomState,
  type MarkdownFileOptions,
  markdownFileRoom,
} from '../src/markdown-file/index.ts';

/** A file the app reads and writes asynchronously, counting writes. */
export function fakeFile(initial: string) {
  const file = {
    text: initial,
    writes: [] as string[],
    failNext: false,
    /** Saves left to fail; each failure is a plain error. */
    failing: 0,
    /** The file is gone: reads and writes throw `FileMissingError`. */
    gone: false,
    /** Runs while a save is in flight. */
    during: null as (() => void) | null,
  };
  return {
    file,
    load: async () => {
      if (file.gone) throw new FileMissingError('no such file');
      return file.text;
    },
    save: async (text: string) => {
      await Promise.resolve();
      file.during?.();
      file.during = null;
      if (file.gone) throw new FileMissingError('no such file');
      if (file.failNext || file.failing > 0) {
        file.failNext = false;
        file.failing = Math.max(0, file.failing - 1);
        throw new Error('the file store refused the write');
      }
      file.text = text;
      file.writes.push(text);
    },
  };
}

export function memoryState(): FileRoomState {
  const m = new Map<string, string>();
  return { read: (k) => m.get(k) ?? null, write: (k, v) => void m.set(k, v) };
}

/** A schedule the test drives: it records the last request. */
export function manualSchedule() {
  const s = { requested: [] as number[] };
  return { s, schedule: (ms: number) => void s.requested.push(ms) };
}

export async function open(extra: Partial<MarkdownFileOptions> & { initial?: string } = {}) {
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
