/**
 * Where a doc's shared state is kept, keyed by doc id.
 *
 * "Shared state" is the Yjs update the server holds for a doc: a markdown
 * doc's content and threads, a board's projection, a whiteboard, the
 * `component-state:<id>` maps. It is what `DocStore` reads when it hydrates a
 * doc and writes on every debounced save. The `.md` write-back, the private
 * meta sidecar and the index row are NOT behind this interface; they stay
 * files in the data dir whichever backend holds the state.
 *
 * Two backends today:
 *   - `DiskDocStateStore` (`disk.ts`): `<dataDir>/<docId>.ydoc`, the format
 *     every server before this interface wrote. The default.
 *   - `MemoryDocStateStore` (`memory.ts`): a map, for tests and small apps.
 *     A "restart" is a new `DocStore` handed the same instance.
 *
 * The interface is synchronous because `DocStore`'s hydrate is: a doc is read
 * in the same turn that asks for it. A later SQLite backend (`bun:sqlite`) or
 * a Durable Object's SQL storage is synchronous as well and fits as is; an
 * asynchronous store (D1 over HTTP) would need hydrate to prefetch first.
 *
 * Every write hands over the whole state (`Y.encodeStateAsUpdate`), V1
 * encoding, so a backend never has to merge updates to answer a read.
 */

/** Live docs, or docs moved aside by an archive (`review-archive.ts`). */
export type DocStateArea = 'live' | 'archive';

/** What a pre-compaction backup did; see `pre-compact-backup.ts`. */
export type KeepOutcome = 'written' | 'exists' | 'failed';

export interface DocStateStore {
  /** Names the backend in logs and test titles. */
  readonly kind: string;

  /** Is there saved state for this doc in `area` (default `live`)? */
  has(docId: string, area?: DocStateArea): boolean;

  /**
   * The doc's saved state, or null when there is none. Throws when state
   * exists but cannot be read; the caller decides what a failed read means.
   */
  read(docId: string): Uint8Array | null;

  /** Replace the doc's saved state. Throws on failure. */
  write(docId: string, state: Uint8Array): void;

  /**
   * When the state was last written, in epoch ms, unrounded; undefined when
   * there is none. The file binding compares it with a bound file's mtime.
   */
  savedAt(docId: string): number | undefined;

  /** Every live doc id with saved state. Order is not defined. */
  list(): string[];

  /**
   * Move a doc's state between areas. True when it moved or there was
   * nothing to move; false when it could not be moved.
   */
  move(docId: string, from: DocStateArea, to: DocStateArea): boolean;

  /**
   * Set a doc's state aside for a delete that may still roll back. Staged
   * state is invisible to `has`, `read` and `list`. False when the state
   * exists and could not be staged.
   */
  stageDelete(docId: string): boolean;
  /** Put staged state back; the delete did not commit. */
  unstageDelete(docId: string): void;
  /** Discard staged state; the delete committed. */
  dropStaged(docId: string): void;

  /** Destroy a doc's live state. True when none is left. */
  remove(docId: string): boolean;

  /**
   * Keep `original` once, durably, before a compaction replaces it. A second
   * call for the same doc keeps the first copy and answers `exists`.
   */
  keepBeforeCompaction(docId: string, original: Uint8Array): KeepOutcome;

  /** Where `keepBeforeCompaction` kept the copy, for the log line. */
  keptCopyLabel(docId: string): string;
}
