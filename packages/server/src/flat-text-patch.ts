import type * as Y from 'yjs';

/**
 * Bring a flat doc's `content` Y.Text to `next` by changing only the lines
 * that differ, instead of deleting the whole text and inserting the new one.
 *
 * A whole-text replace looks the same as a line edit to a reader of the
 * string, but not to anything holding a position in it. Every open editor
 * receives it as "the whole document changed": CodeMirror's merge view drops
 * the collapsed unchanged regions of a diff (so a Diff view reads as the
 * whole file), a reviewer's scroll and cursor are lost, and a comment
 * anchored by `Y.RelativePosition` to a line nobody touched is anchored to
 * deleted items. Keeping unchanged lines as the same CRDT items keeps all of
 * those where they were.
 *
 * Line granularity, by Myers' diff over the lines left once the common
 * prefix and suffix are trimmed. When that middle is too different to diff
 * cheaply, the middle alone is replaced, which is still no worse than the
 * whole-text replace this replaces.
 */
export function patchFlatText(content: Y.Text, next: string): void {
  const prev = content.toString();
  if (prev === next) return;
  const hunks = lineHunks(prev, next);
  // Back to front, so each hunk's offset into `prev` is still valid.
  for (let i = hunks.length - 1; i >= 0; i--) {
    const h = hunks[i] as Hunk;
    if (h.deleteLength > 0) content.delete(h.from, h.deleteLength);
    if (h.insert.length > 0) content.insert(h.from, h.insert);
  }
}

export interface Hunk {
  /** Offset into the OLD text. */
  from: number;
  deleteLength: number;
  insert: string;
}

/** Cells of Myers' trace (edit distance x line count) beyond which the
 *  middle is replaced wholesale rather than diffed. */
const TRACE_BUDGET = 4_000_000;

/** Split keeping each line's terminator, so the parts join back exactly. */
function splitLines(s: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 10) {
      out.push(s.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < s.length) out.push(s.slice(start));
  return out;
}

/** The edits that turn `prev` into `next`, as non-overlapping hunks in
 *  ascending order of their offset into `prev`. */
export function lineHunks(prev: string, next: string): Hunk[] {
  const a = splitLines(prev);
  const b = splitLines(next);
  let lo = 0;
  while (lo < a.length && lo < b.length && a[lo] === b[lo]) lo++;
  let aHi = a.length;
  let bHi = b.length;
  while (aHi > lo && bHi > lo && a[aHi - 1] === b[bHi - 1]) {
    aHi--;
    bHi--;
  }
  let offset = 0;
  for (let i = 0; i < lo; i++) offset += (a[i] as string).length;

  const ops = myers(a.slice(lo, aHi), b.slice(lo, bHi));
  const hunks: Hunk[] = [];
  let ai = lo;
  let bi = lo;
  let pending: Hunk | null = null;
  const flush = () => {
    if (pending) hunks.push(pending);
    pending = null;
  };
  for (const op of ops) {
    if (op === '=') {
      flush();
      offset += (a[ai] as string).length;
      ai++;
      bi++;
      continue;
    }
    if (!pending) pending = { from: offset, deleteLength: 0, insert: '' };
    if (op === '-') {
      const line = a[ai] as string;
      pending.deleteLength += line.length;
      offset += line.length;
      ai++;
    } else {
      pending.insert += b[bi] as string;
      bi++;
    }
  }
  flush();
  return hunks;
}

type Op = '=' | '-' | '+';

/** Myers' O(ND) diff of two line arrays, as an edit script. Falls back to
 *  "delete all of a, insert all of b" when the trace would pass the budget. */
function myers(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const replaceAll = (): Op[] => [...Array<Op>(n).fill('-'), ...Array<Op>(m).fill('+')];
  if (n === 0 || m === 0) return replaceAll();
  const max = n + m;
  const maxD = Math.min(max, Math.floor(TRACE_BUDGET / (2 * max + 1)));
  const width = 2 * max + 1;
  let v = new Int32Array(width);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= maxD; d++) {
    trace.push(v.slice());
    const nv = v.slice();
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && (v[max + k - 1] as number) < (v[max + k + 1] as number));
      let x = down ? (v[max + k + 1] as number) : (v[max + k - 1] as number) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      nv[max + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    v = nv;
    if (found >= 0) break;
  }
  if (found < 0) return replaceAll();

  // Walk the trace back from (n, m), emitting the script in reverse.
  const rev: Op[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const pv = trace[d] as Int32Array;
    const k = x - y;
    const down = k === -d || (k !== d && (pv[max + k - 1] as number) < (pv[max + k + 1] as number));
    const prevK = down ? k + 1 : k - 1;
    const prevX = pv[max + prevK] as number;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      rev.push('=');
      x--;
      y--;
    }
    rev.push(down ? '+' : '-');
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    rev.push('=');
    x--;
    y--;
  }
  return rev.reverse();
}
