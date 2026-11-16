import * as Y from 'yjs';
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
 * versions, so nothing is lost without the app hearing of it.
 */
import { splice } from '../client/text-binding.ts';
import type { RoomDocs } from '../collab/index.ts';

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
  onConflict?: (conflict: FileConflict) => void;
  onSaveError?: (err: unknown) => void;
}

export interface MarkdownFileRoom {
  readonly doc: Y.Doc;
  /** For `createRoomHost` / `createDurableRoom`: every room is this doc. */
  readonly docs: RoomDocs;
  /** The doc's text now. */
  text(): string;
  /** Whether the doc holds changes the file does not. */
  dirty(): boolean;
  /** Write the doc to the file now, if it has changed. */
  flush(): Promise<void>;
  /** Read the file again and merge an outside edit into the doc. */
  refresh(): Promise<void>;
}

const KEY_DOC = 'doc';
const KEY_BASE = 'base';

/** Transactions the room itself makes, so they are not taken for edits. */
const FROM_FILE = Symbol('markdown-file');

const b64encode = (bytes: Uint8Array): string => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};
const b64decode = (text: string): Uint8Array => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

export async function markdownFileRoom(opts: MarkdownFileOptions): Promise<MarkdownFileRoom> {
  const debounceMs = opts.debounceMs ?? 2000;
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

  const persist = (): void => {
    opts.state.write(KEY_DOC, b64encode(Y.encodeStateAsUpdate(doc)));
  };
  const setBase = (value: string): void => {
    base = value;
    opts.state.write(KEY_BASE, value);
  };

  const applySplice = (index: number, remove: number, insert: string): void => {
    doc.transact(() => {
      if (remove) text.delete(index, remove);
      if (insert) text.insert(index, insert);
    }, FROM_FILE);
  };

  const merge = (remote: string): void => {
    if (base === null) {
      // First open: the file is the doc.
      applySplice(0, text.length, remote);
      setBase(remote);
      persist();
      return;
    }
    if (remote === base) return;
    const current = text.toString();
    const ext = splice(base, remote);
    if (current === base) {
      applySplice(ext.index, ext.remove, ext.insert);
    } else {
      const local = splice(base, current);
      const extEnd = ext.index + ext.remove;
      const localEnd = local.index + local.remove;
      if (extEnd < local.index) {
        applySplice(ext.index, ext.remove, ext.insert);
      } else if (ext.index > localEnd) {
        const shift = local.insert.length - local.remove;
        applySplice(ext.index + shift, ext.remove, ext.insert);
      } else {
        opts.onConflict?.({ base, remote, local: current });
      }
    }
    setBase(remote);
    persist();
    if (text.toString() !== base) schedule(debounceMs);
  };

  merge(await opts.load());
  // Woken with changes the file never got (an eviction mid-debounce).
  if (text.toString() !== base) schedule(debounceMs);

  doc.on('update', (_update: Uint8Array, origin: unknown) => {
    if (origin === FROM_FILE) return;
    persist();
    schedule(debounceMs);
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
    flush: () =>
      serial(async () => {
        const now = text.toString();
        if (now === base) return;
        try {
          await opts.save(now);
        } catch (err) {
          opts.onSaveError?.(err);
          schedule(debounceMs);
          return;
        }
        setBase(now);
        // Edited again while the save was in flight: save that too.
        if (text.toString() !== now) schedule(debounceMs);
      }),
    refresh: () =>
      serial(async () => {
        merge(await opts.load());
      }),
  };
  return room;
}
