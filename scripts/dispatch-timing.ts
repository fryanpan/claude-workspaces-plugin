/**
 * Where a ticket's front half goes: planning, or queueing.
 *
 * The 2026-09-10 phase split found that 85% of a ticket's elapsed clock is the
 * wait between the row flipping to in-progress and its builder's first breath —
 * 18.4 minutes in week one, 79.8 in week three, with everything after the first
 * push flat. It could attribute none of it, because the board recorded the two
 * ENDS of that interval and nothing in the middle.
 *
 * This reads a board's `events.jsonl` and reports the interval split at the
 * marker `dispatch.requested` now writes:
 *
 *   flip → requested    planning, or a gate somebody had to answer
 *   requested → lane    queueing for a free slot
 *
 * **On history it can only report the whole.** Nothing recorded the lead's ask
 * before that event existed, so every episode older than it has one leg and a
 * gap, and the report says so rather than splitting the total on an assumption.
 * What history CAN separate is capacity PRESSURE: how many rows were in
 * progress on the same board at the moment each row flipped. An episode that
 * started with every slot already held waited on capacity whatever else was
 * true; one that started with slots free did not.
 *
 * Usage:
 *   bun run scripts/dispatch-timing.ts --data <dir> [--days 7] [--cap 4]
 *   bun run scripts/dispatch-timing.ts --data <dir> --board w-xxxx --json
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** One `events.jsonl` line, as loosely as the log actually types it. */
export interface EventRow {
  event?: unknown;
  ts?: unknown;
  taskId?: unknown;
  to?: unknown;
  actor?: { id?: unknown; name?: unknown } | undefined;
  outcome?: unknown;
  reason?: unknown;
}

/** One run at one row: it went in-progress, and then things did or did not
 *  happen. Absent legs are absent, never zero — a zero would average in. */
export interface Episode {
  taskId: string;
  /** `task.transitioned → in-progress`. */
  flipAt: number;
  /** Who moved it — the row `otherActorAt` is measured against. */
  flipActor: string;
  /** `dispatch.requested`, when one was written inside this episode. */
  requestedAt?: number;
  /** What that request answered — `cap-reached` is a slot that was not free. */
  requestedOutcome?: string;
  /**
   * The lane's first record: the first `task.noted` on the row after it
   * flipped.
   *
   * Any actor, deliberately. A builder is a subagent, and its Stop-hook note
   * is posted under the PARENT session's agent id — measured over a week of
   * the live corpus, 1,105 notes carried nine distinct actor ids, all of them
   * lead sessions. So "a note by somebody other than the lead" is not a
   * builder breathing; it is a second lead, and keying the lane on it found 6
   * episodes out of 240.
   */
  laneAt?: number;
  /** The first note by an actor OTHER than the one who flipped the row. Kept
   *  separately because it is a much smaller and much cleaner population. */
  otherActorAt?: number;
  /** Rows in progress on this board at `flipAt`, this one included. The
   *  capacity-pressure proxy history can answer and the event cannot. */
  inProgressAtFlip: number;
}

const IN_PROGRESS = 'in-progress';

/** Read one board's log into rows, skipping lines that do not parse. */
export function parseEventLog(text: string): EventRow[] {
  const rows: EventRow[] = [];
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      rows.push(JSON.parse(line) as EventRow);
    } catch {
      // A torn last line is normal on a log being appended to as it is read.
    }
  }
  return rows;
}

const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/**
 * Every in-progress run in the log, oldest first.
 *
 * An episode ends at the row's next status change, so a ticket worked twice
 * contributes two, and a marker written after the row left in-progress belongs
 * to neither.
 */
export function episodes(rows: EventRow[], since = 0): Episode[] {
  const ordered = rows
    .filter((r) => num(r.ts) !== undefined && str(r.event) !== undefined)
    .sort((a, b) => (num(a.ts) ?? 0) - (num(b.ts) ?? 0));
  /** taskId → the episode still open on it. */
  const open = new Map<string, Episode>();
  const done: Episode[] = [];
  const close = (taskId: string): void => {
    const ep = open.get(taskId);
    if (!ep) return;
    open.delete(taskId);
    if (ep.flipAt >= since) done.push(ep);
  };
  for (const row of ordered) {
    const ts = num(row.ts) ?? 0;
    const taskId = str(row.taskId);
    if (taskId === undefined) continue;
    const event = str(row.event);
    if (event === 'task.transitioned') {
      close(taskId);
      if (str(row.to) === IN_PROGRESS) {
        open.set(taskId, {
          taskId,
          flipAt: ts,
          flipActor: str(row.actor?.id) ?? str(row.actor?.name) ?? '',
          // Counted BEFORE this row joins the set, then plus itself.
          inProgressAtFlip: open.size + 1,
        });
      }
      continue;
    }
    const ep = open.get(taskId);
    if (!ep) continue;
    if (event === 'dispatch.requested') {
      // The FIRST ask in the episode is the moment the lead decided; a retry
      // after the cap refused one is the queue, not a second decision.
      if (ep.requestedAt === undefined) {
        ep.requestedAt = ts;
        ep.requestedOutcome = str(row.outcome);
      }
      continue;
    }
    if (event === 'task.noted') {
      if (ep.laneAt === undefined) ep.laneAt = ts;
      const who = str(row.actor?.id) ?? str(row.actor?.name) ?? '';
      if (ep.otherActorAt === undefined && who !== ep.flipActor) ep.otherActorAt = ts;
    }
  }
  for (const taskId of [...open.keys()]) close(taskId);
  return done.sort((a, b) => a.flipAt - b.flipAt);
}

export interface Leg {
  /** How many episodes could supply this number. */
  count: number;
  medianMs: number;
  p90Ms: number;
  meanMs: number;
}

/** Order statistics over a leg. An empty population answers zeroes with a
 *  count of zero, so a caller cannot read one as a measurement. */
export function leg(values: number[]): Leg {
  if (values.length === 0) return { count: 0, medianMs: 0, p90Ms: 0, meanMs: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    count: sorted.length,
    medianMs: at(0.5),
    p90Ms: at(0.9),
    meanMs: Math.round(sum / sorted.length),
  };
}

export interface TimingReport {
  episodes: number;
  /** flip → the lead's ask. Planning, or a gate. */
  planning: Leg;
  /** the lead's ask → the lane's first record. Queueing for capacity. */
  queueing: Leg;
  /** flip → the lane's first record, undivided. The number history can answer
   *  for every episode, and the one the phase split reported. */
  whole: Leg;
  /** The same whole interval for episodes that began with `atCapacity` or more
   *  rows already in progress, and for those that began with fewer. */
  underPressure: Leg;
  withSlotsFree: Leg;
  /** How many episodes were refused a slot outright. Zero on any history older
   *  than the event. */
  capRefusals: number;
  /**
   * Episodes that carry an ask but no lane record yet — a request still queued
   * behind the cap, or simply one made minutes ago.
   *
   * Reported rather than dropped, because it is the number that says how much
   * of the window is still in flight, and because it is exactly the population
   * that must NOT feed the split (see `report`).
   */
  stillOpen: number;
  /** `planning`, `queueing`, or `unsplit` when nothing carried the marker. */
  dominant: 'planning' | 'queueing' | 'unsplit';
}

/**
 * Fold episodes into the report. `atCapacity` is the parallelism cap the boards
 * were running under; it decides only the pressure split.
 *
 * **The two split legs are drawn from ONE cohort: episodes holding both an ask
 * and a lane record.** The whole output of this tool is a comparison between
 * those two medians, so measuring them over different populations would let the
 * verdict move without any duration changing. It did: planning used to take
 * every episode that carried an ask, queueing only those that also had a lane,
 * so a tail of requests still waiting at the cap — long planning legs, no queue
 * leg at all — could drag the planning median up and make the tool report
 * `planning` on nothing but unfinished work. Refusing to name a leg when the
 * marker is missing is worth nothing if the cohorts silently diverge instead.
 *
 * The excluded episodes are counted as `stillOpen` rather than dropped.
 */
export function report(eps: Episode[], atCapacity: number): TimingReport {
  const planningValues: number[] = [];
  const queueValues: number[] = [];
  const wholeValues: number[] = [];
  const pressured: number[] = [];
  const free: number[] = [];
  let capRefusals = 0;
  let stillOpen = 0;
  for (const ep of eps) {
    if (ep.requestedOutcome === 'cap-reached') capRefusals += 1;
    if (ep.requestedAt !== undefined && ep.laneAt === undefined) stillOpen += 1;
    if (ep.laneAt === undefined) continue;
    const whole = ep.laneAt - ep.flipAt;
    wholeValues.push(whole);
    if (ep.requestedAt !== undefined) {
      // Both legs, or neither. One `if` on purpose: two would be two chances
      // for the cohorts to come apart again.
      planningValues.push(ep.requestedAt - ep.flipAt);
      queueValues.push(ep.laneAt - ep.requestedAt);
    }
    (ep.inProgressAtFlip >= atCapacity ? pressured : free).push(whole);
  }
  const planning = leg(planningValues);
  const queueing = leg(queueValues);
  const dominant =
    planning.count === 0 || queueing.count === 0
      ? ('unsplit' as const)
      : planning.medianMs >= queueing.medianMs
        ? ('planning' as const)
        : ('queueing' as const);
  return {
    episodes: eps.length,
    planning,
    queueing,
    whole: leg(wholeValues),
    underPressure: leg(pressured),
    withSlotsFree: leg(free),
    capRefusals,
    stillOpen,
    dominant,
  };
}

const minutes = (ms: number): string => (ms / 60_000).toFixed(1);

function printLeg(label: string, l: Leg): void {
  if (l.count === 0) {
    console.log(`  ${label.padEnd(26)} —        (0 episodes)`);
    return;
  }
  console.log(
    `  ${label.padEnd(26)} median ${minutes(l.medianMs).padStart(6)}m  p90 ${minutes(
      l.p90Ms,
    ).padStart(6)}m  mean ${minutes(l.meanMs).padStart(6)}m   (${l.count} episodes)`,
  );
}

function main(): void {
  const argv = process.argv.slice(2);
  const arg = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const dataDir = arg('data');
  if (dataDir === undefined) {
    console.error('usage: dispatch-timing.ts --data <dir> [--days 7] [--cap 4] [--board <id>]');
    process.exit(2);
  }
  const days = Number(arg('days') ?? '7');
  const atCapacity = Number(arg('cap') ?? '4');
  const onlyBoard = arg('board');
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  const dir = join(dataDir, 'workspaces');
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.events.jsonl'))
    .filter((f) => onlyBoard === undefined || f.startsWith(`${onlyBoard}.`));
  const all: Episode[] = [];
  const perBoard: Array<{ board: string; report: TimingReport }> = [];
  for (const file of files) {
    const board = file.replace('.events.jsonl', '');
    const eps = episodes(parseEventLog(readFileSync(join(dir, file), 'utf8')), since);
    if (eps.length === 0) continue;
    all.push(...eps);
    perBoard.push({ board, report: report(eps, atCapacity) });
  }
  const whole = report(all, atCapacity);
  if (argv.includes('--json')) {
    console.log(JSON.stringify({ since, days, atCapacity, whole, perBoard }, null, 2));
    return;
  }
  console.log(`\n${days} days of ${files.length} board log(s) — ${all.length} in-progress runs\n`);
  printLeg('flip → requested', whole.planning);
  printLeg('requested → lane', whole.queueing);
  printLeg('flip → lane (undivided)', whole.whole);
  console.log('');
  printLeg(`flip → lane, ≥${atCapacity} running`, whole.underPressure);
  printLeg(`flip → lane, <${atCapacity} running`, whole.withSlotsFree);
  console.log(`\n  dispatches the cap refused: ${whole.capRefusals}`);
  console.log(`  asked but no lane record yet: ${whole.stillOpen} (excluded from the split)`);
  console.log(`  dominant leg: ${whole.dominant}`);
  if (whole.dominant === 'unsplit') {
    console.log(
      '  (no episode carried a dispatch.requested marker — the interval is ONE\n' +
        '   number here and stays that way until the event has accrued. The two\n' +
        '   pressure rows above are what history can separate on its own.)',
    );
  }
  console.log('');
  for (const { board, report: r } of perBoard.sort(
    (a, b) => b.report.episodes - a.report.episodes,
  )) {
    console.log(
      `  ${board.padEnd(18)} ${String(r.episodes).padStart(4)} runs   ` +
        `undivided median ${minutes(r.whole.medianMs).padStart(6)}m over ${r.whole.count}`,
    );
  }
  console.log('');
}

if (import.meta.main) main();
