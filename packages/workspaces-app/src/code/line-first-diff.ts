import { Change, diff, presentableDiff } from '@codemirror/merge';

/**
 * A diff that stays exact on a large file.
 *
 * `@codemirror/merge` compares characters, and `scanLimit` caps how long it
 * may look. Past 16,000 characters on the shorter side it stops looking
 * properly, and past 64,000 it answers one change covering everything between
 * the first and last edit. The view then draws the whole file as deleted and
 * again as added, so a one-character edit to a 480 KB file built 8,000 lines of
 * deletion widget, and that DOM is what froze a file switch. Raising the limit
 * is not the way out: uncapped, a 280 KB markdown file took 74 seconds.
 *
 * So a large file is compared by LINES first, the way git does it, and only
 * the lines that differ are compared by character. Two steps keep it cheap:
 *
 *  - A line found in only one side cannot match anything, so it is left out
 *    of the comparison (GNU diff's "discard confusing lines"). What is left
 *    is usually close to identical however many lines changed.
 *  - Each distinct line becomes one UTF-16 unit, so the library's own search
 *    runs on a string as long as the file has lines.
 */

/** Below this the stock diff is exact, so it runs unchanged. It is where
 *  `DIFF_SCAN_LIMIT` makes the library stop searching properly: half the
 *  limit, times 16. */
export const LINE_FIRST_MIN_CHARS = 16_000;

/** A line is one UTF-16 unit. The units stop short of the surrogates, which
 *  `diff` treats as pairs. */
const FIRST_UNIT = 0x100;
const MAX_DISTINCT_LINES = 0xd800 - FIRST_UNIT;

/** Keeps each line's newline, so the offsets add up to the text's own. */
function splitLines(s: string): string[] {
  const out: string[] = [];
  let at = 0;
  while (at < s.length) {
    const nl = s.indexOf('\n', at);
    const end = nl === -1 ? s.length : nl + 1;
    out.push(s.slice(at, end));
    at = end;
  }
  return out;
}

function lineOffsets(lines: readonly string[]): number[] {
  const offsets = [0];
  for (const line of lines) offsets.push((offsets.at(-1) as number) + line.length);
  return offsets;
}

/** The positions in `lines` of every line `other` also holds, and the string
 *  of their units. */
function comparable(
  lines: readonly string[],
  other: ReadonlySet<string>,
  units: Map<string, number>,
): { at: number[]; text: string } {
  const at: number[] = [];
  const codes: string[] = [];
  lines.forEach((line, i) => {
    if (!other.has(line)) return;
    let unit = units.get(line);
    if (unit === undefined) {
      unit = FIRST_UNIT + units.size;
      units.set(line, unit);
    }
    at.push(i);
    codes.push(String.fromCharCode(unit));
  });
  return { at, text: codes.join('') };
}

/** Every pair of lines the comparison held equal, in order. */
function matchedLines(
  a: { at: number[]; text: string },
  b: { at: number[]; text: string },
  scanLimit: number,
): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  let x = 0;
  let y = 0;
  const copyTo = (endX: number): void => {
    for (; x < endX; x++, y++) pairs.push([a.at[x] as number, b.at[y] as number]);
  };
  for (const c of diff(a.text, b.text, { scanLimit })) {
    copyTo(c.fromA);
    x = c.toA;
    y = c.toB;
  }
  copyTo(a.text.length);
  return pairs;
}

/** The stock diff's answer, or the line-first one for a file it cannot
 *  compare exactly. Its offsets are `a` and `b`'s own. */
export function lineFirstDiff(a: string, b: string, scanLimit: number): readonly Change[] {
  const stock = (): readonly Change[] => presentableDiff(a, b, { scanLimit });
  if (Math.min(a.length, b.length) < LINE_FIRST_MIN_CHARS) return stock();
  const linesA = splitLines(a);
  const linesB = splitLines(b);
  const setA = new Set(linesA);
  const setB = new Set(linesB);
  const units = new Map<string, number>();
  const keptA = comparable(linesA, setB, units);
  const keptB = comparable(linesB, setA, units);
  if (units.size > MAX_DISTINCT_LINES) return stock();

  const offA = lineOffsets(linesA);
  const offB = lineOffsets(linesB);
  const changes: Change[] = [];
  const compareBetween = (fromA: number, toA: number, fromB: number, toB: number): void => {
    if (fromA === toA && fromB === toB) return;
    const startA = offA[fromA] as number;
    const startB = offB[fromB] as number;
    const inner = presentableDiff(a.slice(startA, offA[toA]), b.slice(startB, offB[toB]), {
      scanLimit,
    });
    for (const c of inner) {
      changes.push(new Change(c.fromA + startA, c.toA + startA, c.fromB + startB, c.toB + startB));
    }
  };
  let nextA = 0;
  let nextB = 0;
  for (const [lineA, lineB] of matchedLines(keptA, keptB, scanLimit)) {
    compareBetween(nextA, lineA, nextB, lineB);
    nextA = lineA + 1;
    nextB = lineB + 1;
  }
  compareBetween(nextA, linesA.length, nextB, linesB.length);
  return changes;
}
