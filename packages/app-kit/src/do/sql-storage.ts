/**
 * The core's `CollabStorage` over a SQLite-backed Durable Object's
 * `ctx.storage.sql`. Both are synchronous, so the core saves inside the
 * message that changed the doc and nothing waits on a timer an eviction
 * could drop.
 */
import type { CollabStorage } from '../collab/index.ts';

/** The slice of `SqlStorage` used here. */
export interface SqlLike {
  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
}

const TABLE = 'cw_collab_docs';

export function sqlCollabStorage(sql: SqlLike): CollabStorage {
  sql.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (id TEXT PRIMARY KEY, state BLOB NOT NULL)`);
  return {
    read(docId) {
      const row = sql.exec(`SELECT state FROM ${TABLE} WHERE id = ?`, docId).toArray()[0];
      const state = row?.state;
      if (state instanceof ArrayBuffer) return new Uint8Array(state);
      if (state instanceof Uint8Array) return state.slice();
      return null;
    },
    write(docId, state) {
      sql.exec(
        `INSERT INTO ${TABLE} (id, state) VALUES (?, ?)
         ON CONFLICT(id) DO UPDATE SET state = excluded.state`,
        docId,
        state,
      );
    },
  };
}
