/**
 * The builder's closing report, driven directly.
 *
 * Three properties, and each one is the reason a part of the module exists:
 * a complete report is kept whole and read back whole; an incomplete one is
 * refused with a message naming the part that is missing, so a builder can fix
 * it without reading the source; and a SECOND report on the same build emits
 * nothing at all, so no attached session spends a turn on a repeat.
 *
 * The event sink is a plain array rather than a store — the property under
 * test is whether an event was built, not what any transport did with it.
 *
 * All fixtures are synthetic — invented names (Riverbend, Harborlight).
 * The repo is public.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type DispatchReportError,
  type DispatchReportInput,
  DispatchReportStore,
  type DoneWhenLineRef,
} from '../src/dispatch-reports.ts';
import type { TaskStoreEvent } from '../src/tasks.ts';

const TASK = 't-riverbend';
const COMMIT = '274ebd28002854a3c5ece616526f504e3169a12c';

const LINES: DoneWhenLineRef[] = [
  { id: 'd-first', text: 'the route answers' },
  { id: 'd-second', text: 'a repeat is silent' },
];

/** A report with every part present. Overrides replace one part at a time, so
 *  each refusal case differs from the passing case in exactly one field. */
function report(over: Partial<DispatchReportInput> = {}): DispatchReportInput {
  return {
    // Short on purpose: the leak gate reads a longer `w-…` as a real board id.
    workspaceId: 'w-board',
    taskId: TASK,
    prNumber: 1104,
    headCommit: COMMIT,
    checks: [
      { name: 'verify', status: 'pass', detail: '29 of 31' },
      { name: 'check:client-boot', status: 'held', detail: 'browser-gated off here' },
    ],
    doneWhen: [
      { id: 'd-first', verdict: 'met', note: 'route test sends one and reads it back' },
      { id: 'd-second', verdict: 'met', note: 'the repeat emits nothing' },
    ],
    agentName: 'harborlight-builder',
    ...over,
  };
}

describe('DispatchReportStore', () => {
  let dataDir: string;
  let emitted: TaskStoreEvent[];
  let store: DispatchReportStore;

  const build = (opts: { lines?: readonly DoneWhenLineRef[] } = {}): DispatchReportStore =>
    new DispatchReportStore({
      dataDir,
      sink: { emit: (ev) => void emitted.push(ev) },
      doneWhenLinesOf: () => opts.lines ?? LINES,
    });

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'dispatch-reports-'));
    emitted = [];
    store = build();
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('keeps every part of one report and reads all five back', () => {
    const res = store.submit(report());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const kept = store.forTask(TASK)[0];
    expect(kept).toBeDefined();
    if (!kept) return;
    expect(kept.taskId).toBe(TASK);
    expect(kept.prNumber).toBe(1104);
    expect(kept.headCommit).toBe(COMMIT);
    expect(kept.checks.map((c) => `${c.name}:${c.status}`)).toEqual([
      'verify:pass',
      'check:client-boot:held',
    ]);
    expect(kept.doneWhen.map((v) => `${v.id}:${v.verdict}`)).toEqual([
      'd-first:met',
      'd-second:met',
    ]);
    expect(kept.attempt).toBe(1);
  });

  it('lowercases the commit, so two spellings of one build are one build', () => {
    expect(store.submit(report({ headCommit: COMMIT.toUpperCase() })).ok).toBe(true);
    const second = store.submit(report());
    expect(second.ok && second.repeat).toBe(true);
  });

  describe('refuses a report missing a part, naming the part', () => {
    const cases: Array<{
      what: string;
      over: Partial<DispatchReportInput>;
      error: DispatchReportError;
      says: string;
    }> = [
      {
        what: 'the PR number',
        over: { prNumber: undefined },
        error: 'missing-pr-number',
        says: 'prNumber',
      },
      {
        what: 'a non-integer PR number',
        over: { prNumber: 'eleven' },
        error: 'missing-pr-number',
        says: 'prNumber',
      },
      {
        what: 'the commit',
        over: { headCommit: undefined },
        error: 'missing-head-commit',
        says: 'headCommit',
      },
      {
        what: 'a commit that is not one',
        over: { headCommit: 'the tip of main' },
        error: 'missing-head-commit',
        says: 'headCommit',
      },
      { what: 'the checks', over: { checks: [] }, error: 'missing-checks', says: 'checks' },
      {
        what: 'a check status',
        over: { checks: [{ name: 'verify' }] },
        error: 'bad-check',
        says: 'verify',
      },
      {
        what: 'the done-when list',
        over: { doneWhen: [] },
        error: 'missing-done-when',
        says: 'doneWhen',
      },
      {
        what: 'a verdict word',
        over: { doneWhen: [{ id: 'd-first', verdict: 'fine', note: 'looks ok' }] },
        error: 'bad-done-when-verdict',
        says: 'd-first',
      },
      {
        what: "a verdict's note",
        over: { doneWhen: [{ id: 'd-first', verdict: 'unchecked' }] },
        error: 'missing-done-when-note',
        says: 'd-first',
      },
    ];
    for (const c of cases) {
      it(`without ${c.what}`, () => {
        const res = store.submit(report(c.over));
        expect(res.ok).toBe(false);
        if (res.ok) return;
        expect(res.error).toBe(c.error);
        expect(res.message).toContain(c.says);
        // Refused means NOT kept and NOT announced — a report that reached the
        // record while being called invalid would be the worst of both.
        expect(store.forTask(TASK)).toHaveLength(0);
        expect(emitted).toHaveLength(0);
      });
    }
  });

  it('names the done-when line nobody gave a verdict on', () => {
    const res = store.submit(
      report({ doneWhen: [{ id: 'd-first', verdict: 'met', note: 'the route answers' }] }),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('missing-done-when-line');
    // The id AND the words, because "which one" is the only question left.
    expect(res.message).toContain('d-second');
    expect(res.message).toContain('a repeat is silent');
  });

  it('refuses a verdict on a line the task does not have', () => {
    const res = store.submit(
      report({
        doneWhen: [
          { id: 'd-first', verdict: 'met', note: 'yes' },
          { id: 'd-second', verdict: 'met', note: 'yes' },
          { id: 'd-invented', verdict: 'met', note: 'yes' },
        ],
      }),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('unknown-done-when-line');
    expect(res.message).toContain('d-invented');
  });

  it('takes any non-empty list when the task carries no done-when lines', () => {
    // A row with no lines cannot have a missing one, and refusing the report
    // would leave the lead nothing at all.
    const bare = build({ lines: [] });
    expect(
      bare.submit(report({ doneWhen: [{ id: 'd-x', verdict: 'met', note: 'shipped' }] })).ok,
    ).toBe(true);
  });

  describe('a repeat on the same build', () => {
    it('is marked a repeat and emits nothing, while the first emits once', () => {
      const first = store.submit(report());
      expect(first.ok && first.repeat).toBe(false);
      expect(emitted.map((e) => e.type)).toEqual(['dispatch.reported']);

      const second = store.submit(report());
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      expect(second.repeat).toBe(true);
      expect(second.report.attempt).toBe(2);
      // The whole point: nothing new reached the sink, so nothing can reach
      // the fan-out and no session spends a turn.
      expect(emitted.map((e) => e.type)).toEqual(['dispatch.reported']);
      // …and it is still kept, because the second telling is often the
      // clearer one and the lead reads the record.
      expect(store.forTask(TASK)).toHaveLength(2);
    });

    it('is still a repeat after a restart, because the set is persisted', () => {
      expect(store.submit(report()).ok).toBe(true);
      emitted = [];
      const revived = build();
      const again = revived.submit(report());
      expect(again.ok && again.repeat).toBe(true);
      expect(emitted).toHaveLength(0);
    });

    it('does NOT silence a rework — a new commit is a new build', () => {
      expect(store.submit(report()).ok).toBe(true);
      const reworked = store.submit(report({ headCommit: 'abc1234' }));
      expect(reworked.ok && reworked.repeat).toBe(false);
      expect(emitted).toHaveLength(2);
    });
  });

  it('carries the counts a wake line needs', () => {
    store.submit(
      report({
        checks: [
          { name: 'lint', status: 'pass' },
          { name: 'test:server', status: 'fail', detail: '1 failing' },
          { name: 'check:meeting-smoke', status: 'held' },
        ],
        doneWhen: [
          { id: 'd-first', verdict: 'met', note: 'measured' },
          { id: 'd-second', verdict: 'unchecked', note: 'needs a deploy the builder cannot do' },
        ],
      }),
    );
    const ev = emitted[0];
    expect(ev?.type).toBe('dispatch.reported');
    if (ev?.type !== 'dispatch.reported') return;
    expect(ev.checksTotal).toBe(3);
    expect(ev.checksFailed).toBe(1);
    expect(ev.checksHeld).toBe(1);
    expect(ev.doneWhenTotal).toBe(2);
    expect(ev.doneWhenMet).toBe(1);
    expect(ev.prNumber).toBe(1104);
    expect(ev.agentName).toBe('harborlight-builder');
  });

  it('keeps the report when the sink throws, so the builder does not resend', () => {
    // A resend would be a repeat, and a repeat is silent — so a wake that
    // failed the submission would cost the lead the report entirely.
    const angry = new DispatchReportStore({
      dataDir,
      sink: {
        emit: () => {
          throw new Error('no listeners');
        },
      },
      doneWhenLinesOf: () => LINES,
    });
    expect(angry.submit(report()).ok).toBe(true);
    expect(angry.forTask(TASK)).toHaveLength(1);
  });
});
