import { presentableDiff } from '@codemirror/merge';
import { describe, expect, it } from 'vitest';
import { DIFF_SCAN_LIMIT, whitespaceFilter } from '../src/code/diff-extensions.ts';
import { LINE_FIRST_MIN_CHARS, lineFirstDiff } from '../src/code/line-first-diff.ts';

const SCAN = { scanLimit: DIFF_SCAN_LIMIT };

/** Rebuild the target from the base and a change list: a diff that does not
 *  do this is wrong however fast it is. */
function apply(a: string, b: string, changes: ReturnType<typeof lineFirstDiff>): string {
  let out = '';
  let at = 0;
  for (const c of changes) {
    out += a.slice(at, c.fromA) + b.slice(c.fromB, c.toB);
    at = c.toA;
  }
  return out + a.slice(at);
}

const lines = (n: number, text: (i: number) => string): string =>
  `${Array.from({ length: n }, (_, i) => text(i)).join('\n')}\n`;

const tideLine = (i: number, edited = false): string =>
  `  const harborlight_${i} = ${edited ? i + 1 : i}; // riverbend tide table entry ${i}`;

describe('lineFirstDiff', () => {
  it('finds each scattered edit in a file past the size where the stock diff gives up', () => {
    const a = lines(8000, (i) => tideLine(i));
    const b = lines(8000, (i) => tideLine(i, i % 100 === 5));
    // The stock diff answers one change the size of the file here, which the
    // view draws as the whole file deleted and the whole file added.
    expect(presentableDiff(a, b, SCAN)).toHaveLength(1);

    const changes = lineFirstDiff(a, b, DIFF_SCAN_LIMIT);

    expect(changes).toHaveLength(80);
    expect(Math.max(...changes.map((c) => c.toA - c.fromA))).toBeLessThan(10);
    expect(apply(a, b, changes)).toBe(b);
  });

  it('keeps every changed line apart when nearly every line changed', () => {
    const a = lines(6000, (i) => (i % 12 === 11 ? '}' : tideLine(i)));
    const b = lines(6000, (i) => (i % 12 === 11 ? '}' : tideLine(i, true)));

    const changes = lineFirstDiff(a, b, DIFF_SCAN_LIMIT);

    expect(changes.length).toBeGreaterThan(5000);
    expect(apply(a, b, changes)).toBe(b);
  });

  it('follows lines that were inserted, removed and moved', () => {
    const a = lines(3000, (i) => tideLine(i));
    const kept = Array.from({ length: 3000 }, (_, i) => tideLine(i)).filter(
      (_, i) => i % 500 !== 7,
    );
    kept.splice(1000, 0, 'added by Alice', 'added by Bob');
    kept.push(tideLine(0));
    const b = `${kept.join('\n')}\n`;

    expect(apply(a, b, lineFirstDiff(a, b, DIFF_SCAN_LIMIT))).toBe(b);
  });

  it('handles a file with no final newline and an empty side', () => {
    const a = lines(2000, (i) => tideLine(i)).trimEnd();
    const b = `${a}\nSaltmarsh`;
    expect(apply(a, b, lineFirstDiff(a, b, DIFF_SCAN_LIMIT))).toBe(b);
    expect(apply(a, '', lineFirstDiff(a, '', DIFF_SCAN_LIMIT))).toBe('');
    expect(apply('', b, lineFirstDiff('', b, DIFF_SCAN_LIMIT))).toBe(b);
  });

  it('leaves a file the stock diff handles exactly to the stock diff', () => {
    const a = lines(50, (i) => tideLine(i));
    const b = a.replace('harborlight_7 = 7', 'harborlight_7 = 77');
    expect(a.length).toBeLessThan(LINE_FIRST_MIN_CHARS);
    expect(lineFirstDiff(a, b, DIFF_SCAN_LIMIT)).toEqual(presentableDiff(a, b, SCAN));
  });
});

describe('whitespaceFilter on a large file', () => {
  const a = lines(4000, (i) => tideLine(i));
  const b = lines(4000, (i) =>
    i % 200 === 3 ? `    ${tideLine(i).trim()}` : tideLine(i, i === 50),
  );

  it('still sets a reindent aside when the file is large', () => {
    const filter = whitespaceFilter({ scanLimit: DIFF_SCAN_LIMIT, enabled: true });
    const kept = filter.diffConfig.override?.(a, b) ?? [];
    expect(kept).toHaveLength(1);
    expect(filter.hidden).toHaveLength(20);
  });

  it('reports every change when whitespace is shown', () => {
    const filter = whitespaceFilter({ scanLimit: DIFF_SCAN_LIMIT, enabled: false });
    const kept = filter.diffConfig.override?.(a, b) ?? [];
    expect(kept).toHaveLength(21);
    expect(filter.hidden).toHaveLength(0);
  });
});
