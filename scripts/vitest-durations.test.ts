/**
 * Reading per-file times out of a CI log, and the table built from them.
 *
 * audit: no-text — the log is inline; nothing here reads a source file.
 */
import { describe, expect, it } from 'vitest';
import { buildTable, median, parseDurations } from './vitest-durations.ts';

const ESC = String.fromCharCode(27);
const PREFIX = 'client (1)\tTest (client + unit)\t2026-11-14T14:35:57.4077992Z ';

describe('parseDurations', () => {
  it('reads the time vitest prints for each file, in ms or s, with or without colour', () => {
    const log = [
      `${PREFIX} ^[[32m✓^[[39m ^[[30m^[[45m dom ^[[49m^[[39m packages/widget/test/a.test.ts ^[[2m(14 tests)^[[22m^[[33m 95492^[[2mms^[[22m^[[39m`,
      `${PREFIX} ${ESC}[32m✓${ESC}[39m  node  scripts/b.test.ts (2 tests) 4ms`,
      `${PREFIX} ✓  node  scripts/c.test.ts (3 tests) 1.5s`,
      `${PREFIX} ↓  node  scripts/d.test.ts (2 tests | 2 skipped)`,
      `${PREFIX}      ✓ a slow case inside a file  1011ms`,
      `${PREFIX}  Test Files  158 passed (158)`,
    ].join('\n');
    expect(parseDurations(log)).toEqual({
      'dom:packages/widget/test/a.test.ts': 95.5,
      'node:scripts/b.test.ts': 0,
      'node:scripts/c.test.ts': 1.5,
      'node:scripts/d.test.ts': 0,
    });
  });

  it('reads nothing from a log with no file lines — the control', () => {
    expect(parseDurations(`${PREFIX} Run bun run test:vitest\n`)).toEqual({});
  });
});

describe('buildTable', () => {
  it('takes each kind’s median as the default for a file it has not measured', () => {
    const table = buildTable(
      { 'dom:x': 40, 'dom:y': 20, 'dom:z': 30, 'node:p': 1, 'node:q': 3 },
      (k) => k.startsWith('dom:'),
    );
    expect(table.unmeasured).toEqual({ browser: 30, other: 2 });
    expect(Object.keys(table.seconds)).toEqual(['dom:x', 'dom:y', 'dom:z', 'node:p', 'node:q']);
  });

  it('has a median of zero for an empty kind', () => {
    expect(median([])).toBe(0);
  });
});
