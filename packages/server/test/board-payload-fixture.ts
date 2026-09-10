/**
 * A board of a fixed, realistic shape — the subject the payload budget is
 * measured against.
 *
 * Every value here is invented. The register is the repo's usual
 * `jordan@partner.example` one: no real person, agent, goal or ticket title
 * appears, because the repo is public and this file is a fixture, not a
 * capture.
 *
 * The SHAPE, though, is measured. On 2026-09-10 the live board's projected
 * `tasks` map held 774 rows — 133 open, 641 closed — and the distribution of
 * the expensive optional fields across them was:
 *
 *   body            135 rows   ~976 bytes each on the open ones
 *   transitions     774 rows   ~171 bytes on a closed row, ~73 on an open one
 *   effortEstimate  422 rows   ~197 bytes
 *   reviews          12 rows   ~7,554 bytes
 *   notes            27 rows   ~2,553 bytes
 *   quote            46 rows   ~828 bytes
 *
 * The generator below reproduces those proportions at 500 rows rather than
 * copying that board's contents, so the budget tracks the shape of a busy
 * board without the fixture having to be refreshed every time a real ticket
 * moves.
 *
 * Deterministic by construction: one seeded LCG, no clock read, no crypto.
 * `boardFixture()` called twice returns two structurally identical boards,
 * which is what lets the budget be a byte count rather than a range.
 */
import type { Task, TaskNote, TaskTransition } from '@claude-workspaces/core';
import type { GoalRow } from '../src/tasks.ts';

/** The instant every fixture row is dated against. Fixed so the trim's
 *  fresh-window decision is a property of the fixture, not of the day the
 *  suite runs. */
export const FIXTURE_NOW = 1_800_000_000_000;

const DAY = 24 * 60 * 60 * 1000;

/** One row in five is open, which is the live board's 133-of-774 rounded to
 *  a ratio a reader can hold. */
export const FIXTURE_ROWS = 500;

/** Seeded LCG (Numerical Recipes constants). Deterministic across engines —
 *  32-bit integer arithmetic only, so no float rounding enters the fixture. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

const PERSONAS = ['Reviewer', 'Agent', 'Collaborator', 'Owner'] as const;
const VERBS = [
  'open the board on a slow link',
  'answer a held review item from the queue',
  'see which rows a goal band still owes',
  'restore a row archived by mistake',
  'read the trail of a ticket that closed last week',
  'hand a row to the session that has capacity',
] as const;
const GOALS_TEXT = [
  'the first list paint stays under the product bar',
  'nothing they filed goes unanswered',
  'the band tells them what is left',
  'no decision is lost to a stray tap',
] as const;
const AGENTS = ['Ada Lint', 'Bo Refactor', 'Cy Ratchet', 'Dee Probe', 'Eli Budget'] as const;
const GOAL_IDS = ['g-payload', 'g-queue', 'g-bands', 'g-restore'] as const;

const PROSE =
  'The board hands a fresh tab every row it holds in one frame, so the cost ' +
  'of opening it is the size of everything it carries rather than the size ' +
  'of the list on screen. ';

/** Deterministic filler of a requested length, built from real sentences so
 *  the encoder sees text with the entropy prose actually has. */
function filler(chars: number): string {
  let out = '';
  while (out.length < chars) out += PROSE;
  return out.slice(0, chars);
}

function trail(rand: () => number, stops: number, closed: boolean): TaskTransition[] {
  const states = ['triage', 'todo', 'in-progress', 'done'] as const;
  const out: TaskTransition[] = [];
  for (let i = 0; i < stops; i += 1) {
    const idx = Math.floor(rand() * AGENTS.length);
    const from = states[Math.min(i, states.length - 2)] ?? 'todo';
    const to = states[Math.min(i + 1, states.length - (closed ? 1 : 2))] ?? 'in-progress';
    out.push({
      ts: FIXTURE_NOW - Math.floor(rand() * 60 * DAY),
      from,
      to,
      // The STORED actor carries an id; `projectTask` narrows it to name and
      // kind on the way to the wire. The fixture has to hold the wide shape
      // or it would be measuring a projection that had less to drop.
      by: { id: `agent-${idx}`, name: AGENTS[idx] ?? 'Ada Lint', kind: 'agent' },
      // The prose the trim drops. Present on the fixture so the control can
      // show what carrying it would cost.
      note: filler(110),
    });
  }
  return out;
}

function notes(rand: () => number, count: number): TaskNote[] {
  return Array.from({ length: count }, (_, i) => ({
    ts: FIXTURE_NOW - i * 90_000,
    kind: 'turn' as const,
    text: filler(120 + Math.floor(rand() * 80)),
    agent: AGENTS[i % AGENTS.length] ?? 'Ada Lint',
  }));
}

function reviews(index: number, count: number): Task['reviews'] {
  return Array.from({ length: count }, (_, i) => ({
    id: `r-${index}-${i}`,
    review: {
      shape: 'decision' as const,
      headline: `Which way should row ${index} settle its ${i}th open question?`,
      detail: filler(900),
      options: [
        { id: 'a', label: 'Keep the current rule and record why' },
        { id: 'b', label: 'Narrow the rule to the case that bit us' },
      ],
    },
    createdAt: FIXTURE_NOW - 3 * DAY,
    createdBy: AGENTS[i % AGENTS.length] ?? 'Ada Lint',
  }));
}

/**
 * The board, as `Task` rows the real projection can be driven over.
 *
 * Returns tasks plus the workspace record's projected half, because the
 * `ws:` doc carries both maps in the same frame and a budget that measured
 * only the rows would miss a goal list that grew.
 */
/**
 * The board record's own fields, as the STORE holds them — the input half of
 * `projectWorkspaceFields`. Deliberately not the projected shape: the point
 * of handing this to the real projector is that the fixture never states what
 * comes out.
 */
export interface FixtureWorkspace {
  id: string;
  name: string;
  goals: Array<{ id: string; title: string; order: number }>;
  docIds: string[];
  createdAt: number;
  leadAgentId: string;
  leadAgentSince: number;
}

export function boardFixture(): {
  tasks: Task[];
  workspace: FixtureWorkspace;
  goalRows: GoalRow[];
} {
  const rand = lcg(20_260_910);
  const tasks: Task[] = [];
  for (let i = 0; i < FIXTURE_ROWS; i += 1) {
    const open = i % 5 === 0;
    const archived = !open && i % 5 === 1;
    const id = `t-fixture${String(i).padStart(4, '0')}`;
    /** Which open row this is, so the detail-field weights below can be
     *  stated against open rows rather than against every fifth index. */
    const nth = Math.floor(i / 5);
    // Closed rows are dated well outside the trim's fresh window, except one
    // in forty which is inside it — the live board had 16 of 641 there, and a
    // fixture with none would not notice the window widening.
    const fresh = !open && i % 40 === 3;
    const updatedAt = open
      ? FIXTURE_NOW - Math.floor(rand() * 5 * DAY)
      : fresh
        ? FIXTURE_NOW - Math.floor(rand() * (DAY / 2))
        : FIXTURE_NOW - (5 + Math.floor(rand() * 90)) * DAY;
    const task: Task = {
      id,
      workspaceId: 'w-fixture',
      title:
        `${PERSONAS[i % PERSONAS.length]} can ${VERBS[i % VERBS.length]} ` +
        `so that ${GOALS_TEXT[i % GOALS_TEXT.length]}`,
      status: open ? (i % 10 === 0 ? 'in-progress' : 'todo') : 'done',
      assignee: AGENTS[i % AGENTS.length] ?? 'Ada Lint',
      assigneeId: `agent-${(AGENTS[i % AGENTS.length] ?? 'ada lint').toLowerCase().replace(' ', '-')}`,
      goal: GOAL_IDS[i % GOAL_IDS.length] ?? 'g-payload',
      order: i,
      after: i % 7 === 0 ? [`t-fixture${String(Math.max(0, i - 3)).padStart(4, '0')}`] : [],
      links:
        i % 6 === 0
          ? [{ kind: 'task', taskId: `t-fixture${String(i % 97).padStart(4, '0')}` }]
          : [],
      transitions: trail(rand, open ? 1 : 2 + (i % 3), !open),
      createdAt: FIXTURE_NOW - (10 + (i % 120)) * DAY,
      createdBy: AGENTS[(i + 2) % AGENTS.length] ?? 'Bo Refactor',
      updatedAt,
      // 55% of rows carry an estimate, matching the live board's 422/774.
      ...(i % 20 < 11
        ? {
            effortEstimate: {
              status: 'ok' as const,
              handsOnSeconds: 1_200 + i,
              wallClockSeconds: 259_200,
              model: 'a-model-id-of-realistic-length',
              promptVersion: 2,
              estimatedAt: FIXTURE_NOW - 2 * DAY,
              forTitleWrittenAt: FIXTURE_NOW - 30 * DAY,
              forGoal: GOAL_IDS[i % GOAL_IDS.length] ?? 'g-payload',
              forWordsRevision: 0,
            },
          }
        : {}),
      ...(i % 5 === 0 ? { readingTime: { totalSeconds: 90 + i, readers: 2 } } : {}),
      // Bodies: every open row plus the fresh-window closed ones, which is
      // the live board's 135 of 774. One in ten is over the projection cap,
      // so the truncation path is exercised rather than assumed.
      // THE DETAIL FIELDS ARE ON CLOSED ROWS TOO, and that is the point.
      //
      // The store keeps every one of them forever — a ticket that closed in
      // March still holds its body, its notes, its review items and the prose
      // on every transition, and before PR 848 the board shipped all of it:
      // 3.22 MB of the live board's 3.58 MB of content belonged to rows the
      // default view does not draw. `slimClosedRow` is what stops that
      // reaching the wire. A fixture whose closed rows were empty would
      // measure a board where the trim has nothing to do, and its control
      // would prove nothing.
      //
      // So closed rows here carry what a real closed row carries, and the
      // trimmed measurement is low because the trim WORKS, not because the
      // fixture was thin. The untrimmed control reads the same rows with the
      // trim skipped, which is the shape the regression would restore.
      ...{ body: filler(i % 25 === 0 ? 5_200 : 450 + (i % 600)) },
      ...(open
        ? nth % 5 === 0
          ? { notes: notes(rand, 14 + (i % 10)) }
          : {}
        : i % 4 === 2
          ? { notes: notes(rand, 12 + (i % 14)) }
          : {}),
      ...(open
        ? nth % 12 === 0
          ? { reviews: reviews(i, 3 + (i % 4)) }
          : {}
        : i % 8 === 3
          ? { reviews: reviews(i, 2 + (i % 3)) }
          : {}),
      ...(open
        ? nth % 3 === 0
          ? { quote: filler(700) }
          : {}
        : i % 3 === 1
          ? { quote: filler(700) }
          : {}),
      ...(i % 9 === 0
        ? {
            triagedAgainst: {
              goalId: GOAL_IDS[i % GOAL_IDS.length] ?? 'g-payload',
              ts: FIXTURE_NOW - 40 * DAY,
            },
          }
        : {}),
      ...(archived
        ? {
            archivedAt: updatedAt,
            archivedBy: AGENTS[(i + 1) % AGENTS.length] ?? 'Cy Ratchet',
            archiveReason: 'Folded into the covering ticket it duplicated',
          }
        : {}),
    } as Task;
    tasks.push(task);
  }
  return {
    tasks,
    workspace: {
      id: 'w-fixture',
      name: 'payload-budget',
      goals: GOAL_IDS.map((gid, i) => ({
        id: gid,
        title: `${GOALS_TEXT[i % GOALS_TEXT.length]}`,
        order: i,
      })),
      // Deliberately NOT spelled like a real doc id: the leak gate's denylist
      // matches `d-` plus ten or more characters, and it is right to — a
      // fixture that looks exactly like production data is how real ids reach
      // a public repo. Same length, so the array weighs what a real one does.
      docIds: Array.from({ length: 120 }, (_, i) => `fixture-doc-${String(i).padStart(4, '0')}`),
      createdAt: FIXTURE_NOW - 400 * DAY,
      leadAgentId: 'agent-ada-lint',
      leadAgentSince: FIXTURE_NOW - 9 * DAY,
    },
    // The STORED goal rows. `projectGoalMeta` derives the rest of each
    // `goals` entry from these, and the projection is what merges the two —
    // so the fixture states what the store holds and nothing about what comes
    // out the far side.
    goalRows: GOAL_IDS.map((gid, i) => ({
      id: gid,
      workspaceId: 'w-fixture',
      kind: 'goal',
      title: `${GOALS_TEXT[i % GOALS_TEXT.length]}`,
      body: filler(2_400),
      status: 'in-progress',
      assignee: AGENTS[i % AGENTS.length] ?? 'Ada Lint',
      goal: gid,
      order: i,
      after: [],
      links: [],
      transitions: [],
      createdAt: FIXTURE_NOW - 400 * DAY,
      updatedAt: FIXTURE_NOW - 3 * DAY,
    })) as GoalRow[],
  };
}
