/**
 * The would-refuse summary, driven over log lines whose answer is known.
 *
 * The property worth protecting is the honest one: the gate's lines carry no
 * clock, so a record is placed in a window only by a stamp above it, and one
 * that cannot be placed is counted apart rather than guessed in or out.
 *
 * Every board, doc and line here is invented.
 */
import { describe, expect, it } from 'vitest';
import { parseArgs, render, summarise } from './roles-would-refuse.ts';

const would = (doc: string, board: string, role: string, op = 'role') =>
  `[roles] report-only, would refuse a ${op} write on ${doc} (board ${board}, role ${role})`;
const refused = (doc: string, board: string, role: string, op = 'role') =>
  `[roles] refused a ${op} write on ${doc} (board ${board}, role ${role})`;
const stamp = (iso: string) => `${iso} [sharing] a stamped line from elsewhere`;

describe('summarise', () => {
  it('counts would-refuse records per board, role and operation, and ignores the rest', () => {
    const s = summarise([
      [
        '[feedback] listening on 8796',
        would('riverbend-notes', 'ws-harborlight', 'comment'),
        would('saltmarsh-plan', 'ws-harborlight', 'comment'),
        would('riverbend-notes', 'ws-harborlight', 'view'),
        would('riverbend-notes', 'ws-harborlight', 'view', 'threads'),
        refused('riverbend-notes', 'ws-harborlight', 'view'),
        '[roles] allowed a threads write on d-1 (board ws-harborlight, role owner)',
        '[roles] board ws-harborlight roles mode set to enforce',
      ],
    ]);
    expect(s.rows).toEqual([
      {
        board: 'ws-harborlight',
        role: 'comment',
        operation: 'role',
        count: 2,
        unplaced: 0,
        docs: 2,
      },
      { board: 'ws-harborlight', role: 'view', operation: 'role', count: 1, unplaced: 0, docs: 1 },
      {
        board: 'ws-harborlight',
        role: 'view',
        operation: 'threads',
        count: 1,
        unplaced: 0,
        docs: 1,
      },
    ]);
    expect(s.kept).toBe(0);
  });

  it('judges an older server’s lines by today’s rule: what the role allows is kept, not a row', () => {
    const s = summarise([
      [
        // Logged as would-refuse by the gate before roles were per-write.
        would('riverbend-notes', 'ws-harborlight', 'owner', 'threads'),
        would('riverbend-notes', 'ws-harborlight', 'owner', 'unresolved'),
        would('saltmarsh-plan', 'ws-harborlight', 'edit', 'threads'),
        would('saltmarsh-plan', 'ws-harborlight', 'comment', 'threads'),
        would('d-1', 'unknown', 'unknown', 'unresolved'),
        // Still refused today.
        would('saltmarsh-plan', 'ws-harborlight', 'comment', 'unresolved'),
      ],
    ]);
    expect(s.kept).toBe(5);
    expect(s.rows).toMatchObject([
      { board: 'ws-harborlight', role: 'comment', operation: 'unresolved', count: 1 },
    ]);
    expect(render(s)).toContain("5 record(s) an older gate logged that today's rule keeps");
  });

  it('adds a squelch summary’s repeats, and counts one cut before the board apart', () => {
    const line = would('riverbend-notes', 'ws-riverbend', 'view');
    const s = summarise([
      [
        line,
        `[log-squelch] …repeated 41 more times in 60s: ${line}`,
        `[log-squelch] …repeated 1 more time in 60s: ${line}`,
        `[log-squelch] …repeated 5 more times in 60s: ${line.slice(0, 40)}…`,
      ],
    ]);
    expect(s.rows).toEqual([
      { board: 'ws-riverbend', role: 'view', operation: 'role', count: 43, unplaced: 0, docs: 1 },
    ]);
    expect(s.truncated).toBe(5);
  });

  it('with a window, places a record by the stamp above it and counts the rest as unplaced', () => {
    const since = Date.parse('2026-11-10T00:00:00.000Z');
    const s = summarise(
      [
        [
          would('a', 'ws-harborlight', 'view'), // no stamp above: unplaced
          stamp('2026-11-01T09:00:00.000Z'),
          would('b', 'ws-harborlight', 'view'), // bound older than the window: unplaced
          stamp('2026-11-12T09:00:00.000Z'),
          would('c', 'ws-harborlight', 'view'), // inside
          `2026-11-13T09:00:00.000Z ${would('d', 'ws-harborlight', 'view')}`, // its own stamp
        ],
        // A second file: the first file's stamps do not carry over.
        [would('e', 'ws-harborlight', 'view')],
      ],
      { since },
    );
    expect(s.rows).toEqual([
      { board: 'ws-harborlight', role: 'view', operation: 'role', count: 2, unplaced: 3, docs: 5 },
    ]);
  });

  it('--refused counts the enforcing board’s refusals instead', () => {
    const s = summarise(
      [[would('a', 'ws-saltmarsh', 'view'), refused('a', 'ws-saltmarsh', 'comment')]],
      { verdict: 'refused' },
    );
    expect(s.rows).toMatchObject([{ board: 'ws-saltmarsh', role: 'comment', count: 1 }]);
  });
});

describe('render and parseArgs', () => {
  it('prints one row per board, role and operation, or says there were none', () => {
    const text = render(summarise([[would('a', 'ws-harborlight', 'comment')]]));
    expect(text).toContain('whole log');
    expect(text).toMatch(/ws-harborlight\s+comment\s+role\s+1\s+0\s+1/);
    expect(render(summarise([[]]))).toContain('no records');
  });

  it('reads the flags, and defaults to the server’s err.log', () => {
    expect(parseArgs(['--days', '14', '--json', 'a.log', 'b.log'])).toMatchObject({
      days: 14,
      json: true,
      verdict: 'would-refuse',
      files: ['a.log', 'b.log'],
    });
    expect(parseArgs([]).files[0]).toMatch(
      /Library\/Logs\/com\.fryanpan\.claude-workspaces\.err\.log$/,
    );
    expect(parseArgs(['--refused']).verdict).toBe('refused');
    expect(() => parseArgs(['--days', '0'])).toThrow();
    expect(() => parseArgs(['--since'])).toThrow();
  });
});
