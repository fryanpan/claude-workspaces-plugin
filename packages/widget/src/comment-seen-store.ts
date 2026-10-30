import type { SeenMap } from './comment-view-model.ts';

/**
 * Where the comment view keeps what this reader has opened, per doc: in the
 * page's `localStorage`, under `cfw:seen:<docId>`.
 *
 * Inside a mock's sandboxed frame that storage is an in-memory stand-in, so
 * the bridge hands writes under this prefix to the page holding the frame,
 * which keeps the one key for its own doc and seeds it back on the next load
 * (`mock-bridge.ts`, `mock-host.ts`). The worst a mock's script can do with
 * that is mark this doc's threads read or unread for its own reader.
 *
 * Every call is wrapped: private mode and a cleared site throw on the
 * accessor, and the view must work with no memory at all.
 */

export const SEEN_PREFIX = 'cfw:seen:';
/** The most threads one doc's record keeps, newest kept. */
const MAX_THREADS = 400;

export interface SeenStore {
  /** Whether this reader had a record for the doc when the page loaded. */
  first: boolean;
  /** When the page loaded. */
  since: number;
  read(): SeenMap;
  mark(id: string, at: number): void;
}

export function seenStore(docId: string, now = Date.now()): SeenStore {
  const key = `${SEEN_PREFIX}${docId}`;
  const read = (): SeenMap => {
    try {
      const raw = JSON.parse(localStorage.getItem(key) ?? 'null') as unknown;
      if (!raw || typeof raw !== 'object') return {};
      const out: SeenMap = {};
      for (const [id, at] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof at === 'number') out[id] = at;
      }
      return out;
    } catch {
      return {};
    }
  };
  let first = true;
  try {
    first = localStorage.getItem(key) === null;
    // The visit is recorded now, so the next one is not a first.
    if (first) localStorage.setItem(key, '{}');
  } catch {}
  return {
    first,
    since: now,
    read,
    mark(id, at) {
      const m = read();
      if ((m[id] ?? 0) >= at) return;
      m[id] = at;
      const kept = Object.entries(m)
        .sort((a, b) => b[1] - a[1])
        .slice(0, MAX_THREADS);
      try {
        localStorage.setItem(key, JSON.stringify(Object.fromEntries(kept)));
      } catch {}
    },
  };
}
