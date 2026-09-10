/**
 * Every conditional branch in the board's row projector has a fixture row
 * that takes it.
 *
 * This exists because a byte budget cannot police itself. A branch with no
 * input emits no bytes, so growth inside one is invisible to
 * `board-payload-budget.test.ts` however tight its bands — and when that test
 * was first written, `boardFixture` populated seven of `projectTask`'s
 * roughly twenty conditional spreads. Thirteen branches plus
 * `projectDecisionState` could have doubled in size and moved the budget by
 * nothing at all. The same shape as the workspace map's hole, one level in.
 *
 * So the budget's claim is only as good as this list, and this is the test
 * that keeps the list true. It asserts presence, never bytes: which branches
 * are exercised is a property of the fixture, and what they weigh is the
 * budget's business.
 *
 * The limit is worth stating because it is not obvious. This can only check
 * branches that EXIST. A field added behind a NEW condition that no fixture
 * row satisfies passes here and passes the budget, and the only thing that
 * catches it is the author adding a row — which is what the failure message
 * below asks for.
 *
 * Read over the UNTRIMMED projection, deliberately. `slimTaskRow` drops
 * `reviews`, `quote` and (bar an open decision) `body` from every row, so a
 * fixture that took those branches would show none of them here once trimmed
 * — and the failure message would ask an author to add a row that cannot
 * change the answer. Growth inside a trimmed branch costs the board's payload
 * nothing, which is the whole point of the trim; it still reaches the detail
 * route, which projects in full and has no budget over it. So: this test says
 * the fixture exercises `projectTask`, and the budget next door says what
 * survives the trim weighs.
 */
import { describe, expect, it } from 'bun:test';
import { projectTask } from '../src/task-row.ts';
import { boardFixture } from './board-payload-fixture.ts';

/**
 * Every key `projectTask` emits conditionally — the ones that vanish when the
 * stored task does not carry the field they read.
 *
 * Unconditional keys (`id`, `title`, `status`, `transitions`, …) are
 * deliberately absent: they cannot be unrepresented, so listing them would
 * pad this into something nobody reads.
 */
const CONDITIONAL_KEYS = [
  'afterEnforce',
  'answer',
  'archiveReason',
  'archivedAt',
  'archivedBy',
  'assigneeId',
  'body',
  'bodyTruncated',
  'commentCount',
  'createdBy',
  'decisionState',
  'dueAt',
  'effortEstimate',
  'infoRequests',
  'needs',
  'notes',
  'options',
  'origin',
  'ownerKind',
  'planHold',
  'possiblyStale',
  'quote',
  'readingTime',
  'recurrenceOf',
  'reviews',
  'schedule',
  'triagedAgainst',
  'unplacedSince',
  'untitled',
] as const;

describe('the payload fixture exercises the whole projector', () => {
  const { tasks } = boardFixture();
  // A non-zero comment count on some rows, because `commentCount` is itself
  // one of the conditional keys and a fixture that always passed 0 would
  // leave that branch dark.
  const rows = tasks.map((t) => projectTask(t, t.order % 3, 'agent', t.assigneeId));

  it('takes every conditional branch at least once', () => {
    const seen = new Set<string>();
    for (const row of rows) for (const key of Object.keys(row)) seen.add(key);
    const missing = CONDITIONAL_KEYS.filter((key) => !seen.has(key));
    if (missing.length > 0) {
      throw new Error(
        `no fixture row takes these branches of projectTask: ${missing.join(', ')}. ` +
          'A branch with no input emits no bytes, so the payload budget cannot see growth ' +
          'inside it. Add a row to boardFixture that carries the stored field each one ' +
          'reads — weighted the way the live board carries it, not one row per key.',
      );
    }
    expect(missing).toEqual([]);
  });

  it('keeps the rare branches rare, so the budget still measures a real board', () => {
    // The counterweight to the test above: satisfying it by putting every
    // field on every row would pass, and would turn the budget into a
    // measurement of a board nobody has. These four are single-digit on the
    // live board and must stay single-digit here.
    const count = (key: string) => rows.filter((row) => row[key] !== undefined).length;
    for (const key of ['schedule', 'recurrenceOf', 'planHold', 'dueAt']) {
      expect(count(key)).toBeGreaterThan(0);
      expect(count(key)).toBeLessThan(10);
    }
  });
});
