import * as Y from 'yjs';
import type { RoomDocs } from '../collab/index.ts';
/**
 * A live doc whose record is a markdown file somewhere else (Dropbox, a
 * bucket, a disk), read and written by the app's own async `load` and
 * `save`.
 *
 * The file stays the record. The doc is a `Y.Text` the room host syncs
 * (`docs` mode, so the core never saves it); every change is written back
 * as the whole text, after a debounce.
 *
 * Nothing waits in memory. Every change also goes to `state`, a small
 * synchronous store (a Durable Object's SQLite), as the doc's Yjs state and a
 * dirty mark, and the debounce is `schedule` — in a Durable Object, an alarm.
 * So an eviction during the debounce loses nothing: the alarm wakes a new
 * instance, which rebuilds the doc from `state` and saves it.
 *
 * An edit made to the file outside the app arrives on `refresh()` (and on
 * open) and is merged as one splice: the text between what the two versions
 * share at the start and at the end. Where the people editing have unsaved
 * changes, an outside edit that does not touch them goes in beside them; one
 * that overlaps them loses to them, and `onConflict` is told, with both
 * versions, so nothing is lost without the app hearing of it. The merge,
 * and so any save behind it, waits for `onConflict` to finish; the file's
 * text is recorded as merged only once it has, so an eviction inside it
 * meets the same conflict again on the next open.
 *
 * A failed save is tried again after `retryDelayMs(failures)`, which grows
 * with each failure in a row (`defaultRetryDelayMs` unless the app passes its
 * own). A save or read that fails because the file is gone (`isMissing`, by
 * default a `FileMissingError`) is not retried: edits keep going to `state`,
 * and saving resumes when `refresh()` finds the file again. `onMissing` is
 * called once per disappearance: not again while the file stays gone, again
 * if it comes back and goes again. That it was called is recorded in `state`
 * only once it settles, so an eviction inside it, or a rejection, means the
 * next read that finds the file gone calls it again.
 */
import { splice } from '../text/splice.ts';

/** A synchronous key-value store that survives the app's process. */
export interface FileRoomState {
  read(key: string): string | null;
  write(key: string, value: string): void;
}

export interface FileConflict {
  /** The text both sides started from. */
  base: string;
  /** The file as it is now. */
  remote: string;
  /** The doc as the people editing it left it; this is what is kept. */
  local: string;
}

/** What an app's `load` or `save` throws when the file no longer exists. */
export class FileMissingError extends Error {
  override name = 'FileMissingError';
}

export interface MarkdownFileOptions {
  /** Read the file's current text. */
  load: () => Promise<string>;
  /** Replace the file's text. Throws on failure; the doc stays unsaved. */
  save: (text: string) => Promise<void>;
  /** Where the doc's unsaved state survives an eviction. */
  state: FileRoomState;
  /** Arrange for `flush()` to run in `ms`, replacing any earlier
   *  arrangement. Default: a timer. In a Durable Object, an alarm. */
  schedule?: (ms: number) => void;
  /** How long after the last change the file is written. Default 2000. */
  debounceMs?: number;
  /** The doc's text field. Default `body`. */
  field?: string;
  /** An outside edit overlapped unsaved local edits. The local text wins
   *  and the next save overwrites the file: keep `remote` here or lose it.
   *  It may return a promise (the type is `unknown` so that a 0.3.0
   *  callback returning any value still fits); no save starts until it
   *  settles. If it rejects, the
   *  outside edit is not counted as merged: no save runs until the merge is
   *  tried again (by `refresh()` or the next `flush()`) and succeeds. */
  onConflict?: (conflict: FileConflict) => unknown;
  onSaveError?: (err: unknown) => void;
  /** How long to wait before saving again after `failures` failed saves in
   *  a row. Default: `defaultRetryDelayMs(failures, debounceMs)`, which is
   *  `debounceMs` doubled per failure, at most 5 minutes. */
  retryDelayMs?: (failures: number) => number;
  /** Whether an error from `load` or `save` means the file is gone. Default:
   *  it is a `FileMissingError`. */
  isMissing?: (err: unknown) => boolean;
  /** The file is gone. Called once per disappearance (not again while it
   *  stays gone); saves stop until `refresh()` reads the file again. If it
   *  rejects, or the instance is evicted before it settles, the next read
   *  that finds the file gone calls it again; a rejection also goes to
   *  `onSaveError`. To put the file back, write `room.text()` to it, then
   *  refresh. */
  onMissing?: (err: unknown) => unknown;
}

export interface MarkdownFileRoom {
  readonly doc: Y.Doc;
  /** For `createRoomHost` / `createDurableRoom`: every room is this doc. */
  readonly docs: RoomDocs;
  /** The doc's text now. */
  text(): string;
  /** Whether the doc holds changes the file does not. */
  dirty(): boolean;
  /** Whether the file was found gone, so nothing is being saved. */
  missing(): boolean;
  /** Write the doc to the file now, if it has changed. */
  flush(): Promise<void>;
  /** Read the file again and merge an outside edit into the doc. */
  refresh(): Promise<void>;
}

const KEY_DOC = 'doc';
const KEY_BASE = 'base';
const KEY_MISSING = 'missing';
/** How long after the last change the file is written, by default. */
export const DEFAULT_DEBOUNCE_MS = 2000;
/** The longest a failed save waits before it is tried again, by default. */
export const MAX_RETRY_MS = 5 * 60_000;

/** The default `retryDelayMs`: `debounceMs` doubled per failure in a row,
 *  at most `MAX_RETRY_MS`. An app wrapping it (to log, or cap it lower)
 *  passes its own `debounceMs` if it set one. */
export const defaultRetryDelayMs = (failures: number, debounceMs = DEFAULT_DEBOUNCE_MS): number =>
  Math.min(debounceMs * 2 ** (Math.max(1, failures) - 1), MAX_RETRY_MS);

/** Transactions the room itself makes, so they are not taken for edits. */
const FROM_FILE = Symbol('markdown-file');

const b64encode = (bytes: Uint8Array): string => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};
const b64decode = (text: string): Uint8Array => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

export async function markdownFileRoom(opts: MarkdownFileOptions): Promise<MarkdownFileRoom> {
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const retryDelayMs = opts.retryDelayMs ?? ((n: number) => defaultRetryDelayMs(n, debounceMs));
  const isMissing = opts.isMissing ?? ((err: unknown) => err instanceof FileMissingError);
  const doc = new Y.Doc();
  const text = doc.getText(opts.field ?? 'body');
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule =
    opts.schedule ??
    ((ms: number) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void room.flush();
      }, ms);
    });

  const saved = opts.state.read(KEY_DOC);
  if (saved) Y.applyUpdate(doc, b64decode(saved), FROM_FILE);
  /** The file's text as last read or written. */
  let base = opts.state.read(KEY_BASE);
  /** `onMissing` has been called, and settled, for this disappearance. */
  let notified = opts.state.read(KEY_MISSING) === '1';
  /** The file was found gone, so nothing is saved. */
  let missing = notified;
  /** Saves that have failed in a row. */
  let failures = 0;
  /** `onConflict` failed: the outside edit is not merged and must not be
   *  overwritten until it is. */
  let conflictPending = false;

  const persist = (): void => {
    opts.state.write(KEY_DOC, b64encode(Y.encodeStateAsUpdate(doc)));
  };
  const setBase = (value: string): void => {
    base = value;
    opts.state.write(KEY_BASE, value);
  };
  /** Ask for a save: after the debounce, or the backoff while saves fail. */
  const scheduleSave = (): void => {
    if (missing) return;
    schedule(failures > 0 ? retryDelayMs(failures) : debounceMs);
  };
  const failed = (err: unknown): void => {
    failures++;
    opts.onSaveError?.(err);
    scheduleSave();
  };
  const setMissing = async (err: unknown): Promise<void> => {
    missing = true;
    if (notified) return;
    try {
      await opts.onMissing?.(err);
    } catch (cbErr) {
      opts.onSaveError?.(cbErr);
      return;
    }
    notified = true;
    opts.state.write(KEY_MISSING, '1');
  };
  const found = (): void => {
    if (!missing && !notified) return;
    missing = false;
    notified = false;
    opts.state.write(KEY_MISSING, '');
  };

  const applySplice = (index: number, remove: number, insert: string): void => {
    doc.transact(() => {
      if (remove) text.delete(index, remove);
      if (insert) text.insert(index, insert);
    }, FROM_FILE);
  };

  const merge = async (remote: string): Promise<void> => {
    if (base === null) {
      // First open: the file is the doc.
      applySplice(0, text.length, remote);
      setBase(remote);
      persist();
      return;
    }
    const from = base;
    const current = text.toString();
    if (remote === from || remote === current) {
      conflictPending = false;
      setBase(remote);
      return;
    }
    const ext = splice(from, remote);
    if (current === from) {
      applySplice(ext.index, ext.remove, ext.insert);
    } else {
      const local = splice(from, current);
      const extEnd = ext.index + ext.remove;
      const localEnd = local.index + local.remove;
      if (extEnd < local.index) {
        applySplice(ext.index, ext.remove, ext.insert);
      } else if (ext.index > localEnd) {
        const shift = local.insert.length - local.remove;
        applySplice(ext.index + shift, ext.remove, ext.insert);
      } else {
        conflictPending = true;
        await opts.onConflict?.({ base: from, remote, local: current });
      }
    }
    conflictPending = false;
    setBase(remote);
    persist();
  };

  /** Read the file and merge it. A missing file is recorded, not thrown. */
  const reload = async (): Promise<void> => {
    let remote: string;
    try {
      remote = await opts.load();
    } catch (err) {
      if (base === null || !isMissing(err)) throw err;
      await setMissing(err);
      return;
    }
    found();
    await merge(remote);
    // Unsaved changes: edits beside the outside one, a conflict's winner,
    // or an eviction mid-debounce.
    if (text.toString() !== base) scheduleSave();
  };

  try {
    await reload();
  } catch (err) {
    // `onConflict` failed: open anyway, and let the save retry the merge.
    if (!conflictPending) throw err;
    failed(err);
  }

  doc.on('update', (_update: Uint8Array, origin: unknown) => {
    if (origin === FROM_FILE) return;
    persist();
    scheduleSave();
  });

  let chain: Promise<void> = Promise.resolve();
  const serial = (step: () => Promise<void>): Promise<void> => {
    chain = chain.then(step, step);
    return chain;
  };

  const room: MarkdownFileRoom = {
    doc,
    docs: { open: () => doc },
    text: () => text.toString(),
    dirty: () => text.toString() !== base,
    missing: () => missing,
    flush: () =>
      serial(async () => {
        if (missing) return;
        if (conflictPending) {
          try {
            await reload();
          } catch (err) {
            failed(err);
            return;
          }
          if (missing) return;
        }
        const now = text.toString();
        if (now === base) return;
        try {
          await opts.save(now);
        } catch (err) {
          if (isMissing(err)) await setMissing(err);
          else failed(err);
          return;
        }
        failures = 0;
        setBase(now);
        // Edited again while the save was in flight: save that too.
        if (text.toString() !== now) scheduleSave();
      }),
    refresh: () => serial(reload),
  };
  return room;
}
