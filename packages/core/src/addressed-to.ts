/**
 * Who a comment is for, read back off the ydoc, and who an open thread is
 * waiting on. The server writes `addressedTo` (`addressees.ts` there); this
 * is the defensive read every peer runs, as for every other comment field.
 */
import type { Addressee, Comment, ThreadStatus } from './types.ts';

/** A comment's `addressedTo`, read as defensively as every other field on
 *  the map: anything malformed degrades to "addressed to nobody". */
export function readAddressedTo(raw: unknown): Addressee[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out: Addressee[] = [];
  for (const a of raw) {
    if (!a || typeof a !== 'object') return undefined;
    const { id, kind, name } = a as Record<string, unknown>;
    if (typeof id !== 'string' || typeof name !== 'string') return undefined;
    if (kind !== 'person' && kind !== 'agent') return undefined;
    out.push({ id, kind, name });
  }
  return out;
}

/** The ids an open thread waits on: its latest comment's addressees. */
export function waitingOnOf(status: ThreadStatus, comments: Comment[]): string[] | undefined {
  const latest = comments[comments.length - 1]?.addressedTo;
  return status === 'open' && latest ? latest.map((a) => a.id) : undefined;
}
