/**
 * One read of a doc's JSON record per open, shared by everything that needs it.
 *
 * The record is `GET /workspaces/<ws>/docs/<id>?format=json`. Three modules
 * read it on a doc open: the router (`fetchDocMeta`, to pick the surface), and
 * both floats (`plan-gate.ts`, `review-float.ts`) when they mount. Each float
 * also re-read it whenever the synced `meta` map fired, and that map fires for
 * the Yjs initial sync, which changes nothing the floats show. So one open cost
 * five identical requests, and Sentry raised them as an N+1. The map also
 * fires on every `contentRevision` bump, so each edit burst cost two more.
 *
 * What replaces that:
 *  - The router's answer seeds the floats' first read (`rememberDocRecord` /
 *    `takeDocRecord`). It is taken once, so a later mount of the same doc
 *    that the router did not read for goes to the server.
 *  - Reads made while one is in flight, or before anything has moved since
 *    the last answer, share that answer.
 *  - A meta-map event counts as movement only when a stamp the floats render
 *    differs from what the record is known to say (`noteStamps`). The initial
 *    sync and a `contentRevision` bump carry none, so they read nothing.
 *  - A press or a board event, which the map does not describe, calls
 *    `invalidate` so the next read goes to the server.
 */

/** The synced meta keys a float renders from. The server writes each one into
 *  the Yjs `meta` map and the record's `meta` in the same call
 *  (`doc-store.ts`), so the two agree unless something moved. */
const RENDERED_STAMPS = [
  'planState',
  'planRequestedAt',
  'planRequestedBy',
  'reviewRequestedAt',
  'reviewRequestedBy',
  'reviewThreadId',
] as const;

export interface DocRecordReader {
  /** The record as of the last known movement. Shares an in-flight read, or
   *  the last answer if nothing has moved since it was asked for. */
  read(): Promise<unknown>;
  /** Something the synced map does not carry has moved: the next read asks
   *  the server. */
  invalidate(): void;
  /** Compare the synced meta map's rendered stamps with what the record is
   *  known to say — the last answer, or the stamps that already moved the
   *  read now under way. On a difference the next read asks the server, and
   *  this answers true. True while nothing has settled or been seen. */
  noteStamps(get: (key: string) => unknown): boolean;
}

const seeds = new Map<string, unknown>();

/** Keep the record the router just read, for the mount that follows it. */
export function rememberDocRecord(url: string, body: unknown): void {
  seeds.set(url, body);
}

/** The record the router read for this address, once. */
export function takeDocRecord(url: string): unknown {
  const body = seeds.get(url);
  seeds.delete(url);
  return body;
}

function metaOf(body: unknown): Record<string, unknown> {
  const meta = (body as { meta?: unknown } | null)?.meta;
  return typeof meta === 'object' && meta !== null ? (meta as Record<string, unknown>) : {};
}

export function createDocRecordReader(
  url: string,
  fetchJson: (url: string) => Promise<unknown>,
  seed?: unknown,
): DocRecordReader {
  /** Bumped by every movement; an answer asked for under an older one is
   *  not shared. */
  let generation = 0;
  let current: { generation: number; answer: Promise<unknown> } | undefined;
  /** The rendered stamps the record is known to hold: the last answer's, or
   *  the ones a later movement saw, until the read it started settles. */
  let known: Record<string, unknown> | undefined;

  if (seed !== undefined) {
    current = { generation, answer: Promise.resolve(seed) };
    known = metaOf(seed);
  }

  return {
    read() {
      if (current && current.generation === generation) return current.answer;
      const entry = {
        generation,
        answer: fetchJson(url).then(
          (body) => {
            if (current === entry && entry.generation === generation) known = metaOf(body);
            return body;
          },
          (err: unknown) => {
            // A failed read is not an answer: the next read tries again.
            if (current === entry) current = undefined;
            throw err;
          },
        ),
      };
      current = entry;
      return entry.answer;
    },
    invalidate() {
      generation++;
    },
    noteStamps(get) {
      const last = known;
      if (last && RENDERED_STAMPS.every((key) => get(key) === last[key])) return false;
      known = Object.fromEntries(RENDERED_STAMPS.map((key) => [key, get(key)]));
      generation++;
      return true;
    },
  };
}
