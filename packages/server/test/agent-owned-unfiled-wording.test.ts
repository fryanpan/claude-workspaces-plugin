/**
 * An agent-owned row is not woken about as though the BOARD said a person
 * were waiting on it.
 *
 * ── What actually happened, and what did not ────────────────────────────────
 *
 * A keep-moving wake named an agent-assigned row, sitting under an ordinary
 * dispatched goal with no threads on it, as "waiting on a person with NO
 * question filed". Three explanations were offered and this file rules on all
 * three, because each one would have called for a different fix:
 *
 *  1. *The row lost its owner kind on the way in.* FALSE, both ways. The stall
 *     loop reads `taskProjection.ownerKindReader` (`stall-wiring.ts`), which
 *     passes the task's own `assigneeKind`, so the classifier sees `'agent'`.
 *     And `resolveOwnerKind` has no path to `'person'` for a named, non-
 *     reserved assignee whatever the stored kind is — with it absent the
 *     answer is `'unknown'`. `owner-kind-never-person` below drives both.
 *  2. *The owner band caught it by goal.* FALSE for this row. `ownerBand` is
 *     the goals matching `/decision/i`, and the row's goal matches nothing.
 *     `not-in-the-owner-band` pins that the row reaches the finding with an
 *     EMPTY owner band, so no goal rule is involved.
 *  3. *The parallelism cap used to hold it.* TRUE, and it is the "why now"
 *     rather than the "why at all" — covered by
 *     `waiting-unfiled-beyond-cap.test.ts`, which this file does not repeat.
 *
 * The cause is a fourth thing. The row came in through the OTHER door into
 * `unfiled`: `row.waitingUnfiled`, the reading `waiting-unfiled.ts` takes over
 * the row's own closing NOTE with `detectAsk`. A note that reports a wait and
 * names a person is read as an ask, and with nothing filed on that row the
 * gate names it — correctly, under its own bucket word.
 *
 * What was wrong is the SENTENCE. `stall-escalation.ts` has carried two
 * wordings for the two buckets since it was written; `stalledLine` had one,
 * and `stalledRowClause` drops the bucket on purpose, so a reader could not
 * tell a board fact from a regex over an agent's prose. A reader who learns
 * the notice overclaims stops acting on the true rows too.
 *
 * Driven end to end — the real `evaluateStalls` over a real board, then the
 * real renderer over its verdict — because the defect lives in the join.
 *
 * All fixtures are synthetic: invented names on a made-up board. The repo is
 * public.
 */
import { describe, expect, it } from 'bun:test';
import { type StallPayload, stalledLine } from '../../mcp/src/nudge-line.ts';
import type { TaskRow } from '../src/keep-moving.ts';
import { OWNER_UNFILED_BUCKET, evaluateStalls } from '../src/stall-gate.ts';
import { resolveOwnerKind } from '../src/task-owner.ts';
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

/** An ordinary dispatched band. Nothing in it matches `/decision/i`, which is
 *  what `ownerBand` is built from — see premise 2 in the header. */
const GOAL = 'g-doc-homes';
/** The agent that holds the row, and the person it names in its note. */
const AGENT = 'Riverbend';
const PERSON = 'Harborlight';

/** The row's only note, shaped like the real one: a status report whose last
 *  clause reports a wait and names a person. `detectAsk`'s deferral for
 *  "waits on" fires, and the person's name in the same sentence is what makes
 *  it read as addressed. */
const REPORTING_NOTE =
  'Built: the branch is green and the bundle is cut. ' +
  `Merge waits on the classifier block on ${PERSON}'s queue; after counts follow deploy.`;

/**
 * A transition by the person, which is the ONLY reason the board knows their
 * name: `ownerNamesFrom` reads whoever has moved a row on it as a person, so
 * that no deployment's owner is baked into a public repo. Without it
 * `detectAsk` sees no second-person pronoun in the note and reads nothing —
 * which is itself worth knowing, and `no-owner-names-no-reading` pins it.
 */
const MOVED_BY_PERSON = [{ ts: CREATED, to: 'in-progress', by: { kind: 'person', name: PERSON } }];

/** The row as `stall-wiring.ts` builds it: agent-owned, in a dispatched band,
 *  in-progress, one note, nothing filed. */
function agentOwnedRow(): TaskRow {
  return {
    id: 't-verbs',
    title: 'Agent learns what a verb can do from the verb’s own answer',
    status: 'in-progress',
    goal: GOAL,
    createdAt: CREATED,
    updatedAt: CREATED,
    transitions: MOVED_BY_PERSON,
    ownerKind: 'agent',
    assignee: AGENT,
    notes: [{ ts: NOW - 5 * MIN, kind: 'status', agent: AGENT, text: REPORTING_NOTE }],
  };
}

/**
 * A frame row under the board-declared bucket, built rather than judged.
 *
 * It used to be a `TaskRow` driven through `evaluateStalls`, which put it on
 * `unfiled` as a finding. The gate stopped doing that on 2026-09-22 — nobody
 * can act on such a row, so it is a record on `awaitingPerson` and reaches no
 * frame this server sends (`person-owned-quiet.test.ts`).
 *
 * The RENDERER still has to draw it, which is why the control stays. A frame
 * is written by one server and read by another session's MCP child, and a
 * child on a new bundle still receives frames from a server that has not
 * restarted. Drawing an arriving row correctly is the child's job whatever
 * this server has stopped sending.
 */
function personOwnedFrameRow(): { id: string; title: string; bucket: string } {
  return { id: 't-date', title: 'Pick the launch date', bucket: OWNER_UNFILED_BUCKET };
}

/** The gate, run the way the server runs it. No cap, so capacity plays no
 *  part in any verdict here (premise 3 has its own file). `owners` is the
 *  seam the `no-owner-names-no-reading` control moves. */
function judge(rows: readonly TaskRow[], owners: readonly string[] = ownerNamesFrom(rows)) {
  return evaluateStalls({
    tasks: [...rows],
    events: rows.flatMap((r) =>
      typeof r.updatedAt === 'number' ? [{ taskId: r.id, ts: r.updatedAt }] : [],
    ),
    reviewItems: [],
    // EMPTY on purpose: premise 2 says a goal rule caught the row. With no
    // goal in the band at all there is no rule to catch it.
    bands: { dispatchable: new Set([GOAL]), ownerBand: new Set<string>() },
    now: NOW,
    quietMs: QUIET,
    noteClocks: buildNoteClocks(rows, owners),
  });
}

/** The wake's own line over a verdict, as `stall-nudge.ts` sends it. */
function render(verdict: ReturnType<typeof judge>): string {
  const payload: StallPayload = {
    consideredCount: verdict.considered,
    stalledCount: verdict.stalled.length,
    rows: verdict.stalled,
    unfiled: verdict.unfiled,
  };
  return stalledLine(payload);
}

describe('which premise actually holds', () => {
  it('owner-kind-never-person: an agent assignee resolves to agent, and to unknown at worst', () => {
    const never = () => false;
    // The projection's call: the stored kind travels.
    expect(resolveOwnerKind(AGENT, 'agent', never)).toBe('agent');
    // The other caller's call, with the stored kind dropped. `unknown`, and
    // `boardSaysOwnerWaits` tests for `'person'`, so neither reading reaches
    // the owner band by this route.
    expect(resolveOwnerKind(AGENT, undefined, never)).toBe('unknown');
  });

  it('not-in-the-owner-band: the row is named with an empty owner band', () => {
    const verdict = judge([agentOwnedRow()]);
    const named = verdict.unfiled.find((r) => r.id === 't-verbs');
    expect(named).toBeDefined();
    // Under the NOTE bucket, not the board's. This is the whole finding: the
    // row's own words put it here, and no owner rule did.
    expect(named?.bucket).toBe(WAITING_UNFILED_BUCKET);
  });

  /**
   * The control that proves the reading really is the NOTE'S and not the
   * row's shape. Same row, same band, same everything — with the board's
   * owner names withheld, `detectAsk` finds nothing addressed in the note and
   * the row is not named at all. So nothing about an agent-owned row in a
   * dispatched band produces this finding; only the prose does.
   */
  it('no-owner-names-no-reading: withhold the names and the row is not named', () => {
    const verdict = judge([agentOwnedRow()], []);
    expect(verdict.unfiled).toHaveLength(0);
  });
});

describe('the wake line says which of the two doors a row came through', () => {
  it('does not tell the reader a person is waiting when only the agent said so', () => {
    const line = render(judge([agentOwnedRow()]));
    // The board said nothing of the kind, so the line may not say it did.
    expect(line).not.toContain('waiting on a person with NO question filed');
    // What it says instead: whose words this reading came from, and that the
    // reading is a guess the reader should check.
    expect(line).toContain('closing note');
    expect(line).toContain('a regex over the agent');
    expect(line).toContain('t-verbs');
  });

  /**
   * THE MUTATION CONTROL. A row under the board-declared bucket still gets
   * the original sentence. Drop the bucket split from `stalledLine` and this
   * case keeps passing while the one above goes red — which is what says the
   * change narrowed the wording rather than switching the finding off.
   */
  it('still tells the reader plainly when the BOARD says a person is waiting', () => {
    const line = stalledLine({ unfiled: [personOwnedFrameRow()] });
    expect(line).toContain('waiting on a person with NO question filed');
    expect(line).toContain('t-date');
    // And it is NOT dressed as a guess — no hedge borrowed from the other
    // sentence, because for this row there is nothing to hedge.
    expect(line).not.toContain('a regex over the agent');
    expect(line).not.toContain('closing note');
  });

  /**
   * A frame from a server too old to send `bucket` renders the ORIGINAL
   * sentence, byte for byte. That default is right rather than merely
   * tolerable: `bucket` has been on `StalledRow` since the frame's inception
   * (#404) and a row could only reach `unfiled` through the note door from
   * #1050, so a server old enough to omit the field can only ever have
   * carried board-declared rows.
   */
  it('renders an old frame with no bucket as the board-declared sentence', () => {
    const line = stalledLine({ unfiled: [{ id: 't-old', title: 'Old frame row' }] });
    expect(line).toContain('1 task is waiting on a person with NO question filed');
    expect(line).toContain('File the ask where they will see it, or the wait is invisible.');
    expect(line).not.toContain('closing note');
  });

  /** Every clause agrees in number with its subject. A plural subject wearing
   *  "an ask" / "the row" / "the note" tells the reader the sentence was not
   *  proof-read, on the one line whose job is to be believed. */
  it('agrees in number when several rows came through the note door', () => {
    const line = stalledLine({
      unfiled: [
        { id: 't-a', title: 'One', bucket: WAITING_UNFILED_BUCKET },
        { id: 't-b', title: 'Two', bucket: WAITING_UNFILED_BUCKET },
        { id: 't-c', title: 'Three', bucket: WAITING_UNFILED_BUCKET },
      ],
    });
    expect(line).toContain('3 tasks’ own closing notes read as asks to a person');
    expect(line).toContain('with nothing filed on those rows');
    expect(line).toContain('a person owns those rows');
    expect(line).toContain('Read each note');
    // The singular forms must not survive into the plural sentence.
    expect(line).not.toContain('as an ask to a person');
    expect(line).not.toContain('Read the note');
  });

  /** Both on one frame: two sentences, each naming only its own rows, and the
   *  count in each is that sentence's count rather than the list's length. */
  it('keeps the two apart on a frame carrying both', () => {
    const judged = judge([agentOwnedRow()]);
    expect(judged.unfiled).toHaveLength(1);
    const line = stalledLine({
      consideredCount: judged.considered,
      stalledCount: judged.stalled.length,
      rows: judged.stalled,
      unfiled: [...judged.unfiled, personOwnedFrameRow()],
    });
    expect(line).toContain('1 task is waiting on a person with NO question filed');
    expect(line).toContain('t-date');
    expect(line).toContain('t-verbs');
    expect(line).toContain('closing note');
    // Neither sentence claims the other's row: "2 tasks" would be the flat
    // reading this change exists to end.
    expect(line).not.toContain('2 tasks are waiting on a person');
  });

  /** No error rate is quoted. There are two measured ones and both were taken
   *  over end-of-turn NOTES, while these rows also survived the quiet clock —
   *  so any figure here would be an extrapolation onto another population,
   *  and a precise-sounding wrong number on a calibration line is the failure
   *  this whole split exists to end. See `docs/architecture/unfiled-ask.md`. */
  it('quotes no error rate at all', () => {
    const line = render(judge([agentOwnedRow()]));
    expect(line).not.toMatch(/one (?:message )?in (?:six|seven|ten|seventeen)/i);
    expect(line).not.toMatch(/\d+%/);
  });
});
