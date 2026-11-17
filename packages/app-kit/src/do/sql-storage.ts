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

const KV_TABLE = 'cw_collab_kv';

/** A synchronous key-value store over `ctx.storage.sql`, one namespace per
 *  caller: `markdownFileRoom`'s `state` in a Durable Object. */
export function sqlKeyValue(
  sql: SqlLike,
  namespace: string,
): { read(key: string): string | null; write(key: string, value: string): void } {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS ${KV_TABLE} (ns TEXT NOT NULL, k TEXT NOT NULL, v TEXT NOT NULL, PRIMARY KEY (ns, k))`,
  );
  return {
    read(key) {
      const row = sql
        .exec(`SELECT v FROM ${KV_TABLE} WHERE ns = ? AND k = ?`, namespace, key)
        .toArray()[0];
      return typeof row?.v === 'string' ? row.v : null;
    },
    write(key, value) {
      sql.exec(
        `INSERT INTO ${KV_TABLE} (ns, k, v) VALUES (?, ?, ?)
         ON CONFLICT(ns, k) DO UPDATE SET v = excluded.v`,
        namespace,
        key,
        value,
      );
    },
  };
}

/** The slice of `DurableObjectStorage` an alarm needs. */
export interface AlarmStorage {
  setAlarm(scheduledTime: number): unknown;
}

/**
 * A debounce that survives eviction: each call moves the Durable Object's
 * one alarm to `ms` from now, and the object's `alarm()` handler does the
 * work (`markdownFileRoom`'s `flush`). An evicted object is woken for it.
 */
export function alarmSchedule(
  storage: AlarmStorage,
  now: () => number = Date.now,
): (ms: number) => void {
  return (ms) => {
    void storage.setAlarm(now() + ms);
  };
}
