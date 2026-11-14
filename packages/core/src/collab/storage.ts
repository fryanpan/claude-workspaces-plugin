/**
 * Where a room's doc is kept between connections and restarts.
 *
 * The slice of the server's doc state interface the core needs: read a doc's
 * whole state, and replace it. Workspaces' disk and memory backends
 * (`packages/server/src/doc-state/`) satisfy it as they stand, so an app can
 * hand the core either; an app with neither uses `MemoryCollabStorage`.
 *
 * Every write hands over the whole state (`Y.encodeStateAsUpdate`, V1), so a
 * backend never merges updates to answer a read.
 */
export interface CollabStorage {
  /** The doc's saved state, or null when there is none. */
  read(docId: string): Uint8Array | null;
  /** Replace the doc's saved state. Throws on failure. */
  write(docId: string, state: Uint8Array): void;
}

/** State kept in a map: for tests and small apps. A restart is a new host
 *  handed the same instance. */
export class MemoryCollabStorage implements CollabStorage {
  private readonly states = new Map<string, Uint8Array>();

  read(docId: string): Uint8Array | null {
    const s = this.states.get(docId);
    return s ? s.slice() : null;
  }

  write(docId: string, state: Uint8Array): void {
    this.states.set(docId, state.slice());
  }
}
