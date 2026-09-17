import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TaskRow } from '../src/keep-moving.ts';
import { STALL_ESCALATION_ACTOR } from '../src/stall-escalation.ts';
/**
 * A `waiting-unfiled` row that the board's parallelism cap puts out of reach
 * is never named, so it never ages and never escalates.
 *
 * `waiting-unfiled-escalation.test.ts` hands the escalation a snapshot it
 * built by hand, with the row already carrying `WAITING_UNFILED_BUCKET`. That
 * asserts the aging, the shape and the ladder, and it cannot see whether the
 * gate ever puts such a row on a snapshot in the first place. This drives the
 * REAL gate over a real board and then hands its verdict to the escalation, so
 * the two halves are judged joined the way the server joins them
 * (`stall-wiring.ts`: `evaluateStalls` → `StallSnapshot` → `onTick`).
 *
 * The board is the ordinary one: more runnable rows than the cap allows —
 * five rows against the default cap of four — with the row whose agent said
 * it is waiting on a person ranked last. `evaluateStalls` walks
 * `priorityOrder`, spends its slots on the first four runnable rows and
 * `continue`s past the fifth BEFORE it reads `row.waitingUnfiled`
 * (`stall-gate.ts`), so the finding is dropped by the capacity rule that
 * `unfiled` is documented to be exempt from.
 *
 * Every assertion has its control: the same board, the same tick, the same
 * note, with the cap raised to cover the row.
 *
 * All fixtures are synthetic — invented names on a made-up board. The repo is
 * public.
 */
import { evaluateStalls } from '../src/stall-gate.ts';
import type { StallSnapshot } from '../src/stall-nudge.ts';
import { TaskStore } from '../src/tasks.ts';
import { WaitingUnfiledEscalations } from '../src/waiting-unfiled-escalation.ts';
import {
  WAITING_UNFILED_BUCKET,
  noteClocks as buildNoteClocks,
  ownerNamesFrom,
} from '../src/waiting-unfiled.ts';

const MIN = 60_000;
const QUIET = 30 * MIN;
const NOW = 20_000_000;
/** Older than the quiet window by a margin no rounding can close. */
const CREATED = NOW - 6 * 60 * MIN;
const GOAL = 'g-release';
const LEAD = { id: 'agent-cartographer', name: 'Cartographer', kind: 'agent' as const };

const TITLES = [
  'Cut the release branch',
  'Draft the rollout note',
  'Rank results by recency',
  'Retire the old importer',
  'Pick the launch date',
] as const;
/** The row whose agent said, in its closing words, that it is waiting on a
 *  person — ranked last, so a cap of four leaves it out of reach. */
const WAITER = TITLES.length - 1;

describe('a waiting-unfiled row ranked past the parallelism cap', () => {
  let dir = '';
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  /** Five open rows on one board, the last carrying an asking note. Returns
   *  the store (so the escalation can file on a real ticket) and the gate
   *  rows built the way `stall-wiring.ts` builds them. */
  function board(): { store: TaskStore; ws: string; ids: string[]; rows: TaskRow[] } {
    dir = dir || mkdtempSync(join(tmpdir(), 'wu-cap-'));
    const store = new TaskStore({ dataDir: dir });
    const ws = store.createWorkspace('release-train', { leadAgentId: LEAD.id }).id;
    const ids = TITLES.map((title) => {
      const res = store.createTask(ws, {
        title,
        body: `Agent can ${title.toLowerCase()} so that the train leaves on time.`,
        assignee: LEAD.name,
        assigneeKind: 'agent',
      });
      if (!res.ok) throw new Error(`could not create ${title}`);
      return res.task.id;
    });
    const rows: TaskRow[] = ids.map((id, i) => ({
      id,
      title: TITLES[i] as string,
      status: 'in-progress',
      goal: GOAL,
      createdAt: CREATED,
      updatedAt: CREATED,
      ownerKind: 'agent',
      ...(i === WAITER
        ? {
            notes: [
              {
                ts: NOW - 5 * MIN,
                kind: 'status',
                agent: LEAD.name,
                text: 'Held the branch cut. Waiting on your decision about the date.',
              },
            ],
          }
        : {}),
    }));
    return { store, ws, ids, rows };
  }

  /** The gate, run the way the server runs it. `parallelismCap` undefined
   *  means no cap was given and every row is judged. */
  function judge(rows: readonly TaskRow[], ids: readonly string[], cap: number | undefined) {
    return evaluateStalls({
      tasks: rows,
      events: rows.flatMap((r) =>
        typeof r.updatedAt === 'number' ? [{ taskId: r.id, ts: r.updatedAt }] : [],
      ),
      reviewItems: [],
      bands: { dispatchable: new Set([GOAL]), ownerBand: new Set<string>() },
      now: NOW,
      quietMs: QUIET,
      noteClocks: buildNoteClocks(rows, ownerNamesFrom(rows)),
      priorityOrder: [...ids],
      ...(cap === undefined ? {} : { parallelismCap: cap }),
    });
  }

  const snapshotOf = (
    ws: string,
    verdict: { unfiled: StallSnapshot['unfiled'] },
  ): StallSnapshot => ({
    workspaceId: ws,
    leadAgentId: LEAD.id,
    retired: false,
    stalled: [],
    unfiled: verdict.unfiled,
    considered: TITLES.length,
    undetermined: [],
  });

  it('is named by the gate when the cap covers it, and not when it does not', () => {
    const { ids, rows } = board();
    const waiter = ids[WAITER] as string;

    // Control: the same board, the same tick, the same note — with no cap,
    // the gate names the row. This is what says the fixture really does
    // produce the finding.
    const uncapped = judge(rows, ids, undefined);
    expect(uncapped.unfiled.map((r) => r.id)).toContain(waiter);
    expect(uncapped.unfiled.find((r) => r.id === waiter)?.bucket).toBe(WAITING_UNFILED_BUCKET);

    // Second control, isolating the SIZE of the cap from its presence: a cap
    // that reaches the fifth row still names it.
    const covered = judge(rows, ids, TITLES.length);
    expect(covered.beyondCapacity).toBe(0);
    expect(covered.unfiled.map((r) => r.id)).toContain(waiter);

    // The board's own default cap of four, with the waiting row ranked fifth.
    const capped = judge(rows, ids, 4);
    expect(capped.beyondCapacity).toBe(1);
    expect(capped.unfiled.map((r) => r.id)).toContain(waiter);
  });

  it('reaches the owner through the real gate, cap and all', () => {
    const { store, ws, ids, rows } = board();
    const escalations = new WaitingUnfiledEscalations({ store, agingMs: QUIET });

    const capped = judge(rows, ids, 4);
    escalations.onTick([snapshotOf(ws, capped)], NOW);
    escalations.onTick([snapshotOf(ws, capped)], NOW + QUIET);

    const filed = store
      .listTasks(ws)
      .flatMap((t) => store.listReviewItems(t.id))
      .filter((i) => i.createdBy === STALL_ESCALATION_ACTOR.name);
    expect(filed).toHaveLength(1);
    expect(escalations.filedCount()).toBe(1);
  });
});
