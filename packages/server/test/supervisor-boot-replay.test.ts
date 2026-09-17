/**
 * The 16 September 23:12Z outage, replayed across supervisor generations.
 *
 * One grace protects one boot. It does not protect a machine so loaded that
 * no boot finishes — which is what happened that night, and what the backoff
 * is for. Both halves are measured here by COUNTING RESTARTS, because "the
 * grace is longer" is a statement about a constant and not about behaviour.
 *
 * A restart ends a supervisor and launchd arms a fresh one, so nothing here
 * can be shown inside one watchdog's life: the loop below runs successive
 * generations over one ledger and one injected clock, which is the only thing
 * that crosses between them in prod. Nothing sleeps — an hour of supervisor
 * costs what the arithmetic costs.
 *
 * The verdict-by-verdict behaviour of one watchdog is
 * `supervisor-health.test.ts`; the ledger and the backoff arithmetic are
 * `supervisor-restarts.test.ts`. Timestamps are that night's, as the log
 * recorded them; nothing else here is real.
 */
import { describe, expect, it } from 'bun:test';
import type { HealthVerdict } from '../src/supervisor-health.ts';
import { createHealthWatchdog } from '../src/supervisor-health.ts';
import { FIRST_BIND_GRACE_MS } from '../src/supervisor-restarts.ts';
import { memoryLedger } from './supervisor-ledger-stub.ts';

const MIN = 60_000;
const POLICY = { max: 3, windowMs: 60 * MIN };

describe('a boot that never binds does not get restarted on the same interval', () => {
  const TICK = 30_000;
  /** `scripts/serve.ts`: `setTimeout(GRACE_MS)` before the interval arms. */
  const ARM = 15_000;
  /** The log's own figure: SIGTERM 23:13:21, SIGKILL 23:13:26. */
  const RESPAWN = 5_000;

  interface Generation {
    at: number;
    generation: number;
  }

  /**
   * Successive supervisors on ONE ledger and ONE injected clock, which is
   * what launchd gives prod: a restart ends a supervisor, a fresh one arms
   * with no memory but the file, and the file is the only thing that crosses.
   *
   * Nothing here sleeps — the clock is a number this loop advances — so the
   * whole hour costs what the arithmetic costs.
   */
  async function replay(opts: {
    /** What the port says during generation `n`. */
    verdict: (generation: number) => HealthVerdict;
    untilMs: number;
    firstBindGraceMs?: number;
    firstBindGraceMaxMs?: number;
    /** Defaults to the production three-per-hour. Raised where the point
     *  being measured is the SPACING of restarts rather than their count. */
    policy?: { max: number; windowMs: number };
  }): Promise<{
    restarts: Generation[];
    ledger: ReturnType<typeof memoryLedger>;
    /** Stamped, so a case can read the log over the window it is about. */
    lines: { at: number; line: string }[];
  }> {
    const ledger = memoryLedger();
    const restarts: Generation[] = [];
    const lines: { at: number; line: string }[] = [];
    let clock = 0;
    let generation = 0;
    while (clock < opts.untilMs) {
      generation += 1;
      const armedAt = clock;
      const verdict = opts.verdict(generation);
      let restarted = false;
      const dog = createHealthWatchdog({
        probe: async () => ({ verdict }),
        maxFails: 2,
        ledger,
        policy: opts.policy ?? POLICY,
        now: () => clock,
        log: (line) => lines.push({ at: clock, line }),
        restart: () => {
          restarts.push({ at: clock, generation });
          restarted = true;
        },
        label: ':8787',
        ...(opts.firstBindGraceMs === undefined ? {} : { firstBindGraceMs: opts.firstBindGraceMs }),
        ...(opts.firstBindGraceMaxMs === undefined
          ? {}
          : { firstBindGraceMaxMs: opts.firstBindGraceMaxMs }),
      });
      clock = armedAt + ARM;
      while (!restarted && clock < opts.untilMs) {
        clock += TICK;
        await dog.tick();
      }
      if (!restarted) break;
      clock += RESPAWN;
    }
    return { restarts, ledger, lines };
  }

  /**
   * That night's shape: the first supervisor's server had bound and stopped
   * answering (`no-answer` — a wedge, and a fair restart), and every boot
   * after it held the port UNBOUND, which is the state the watchdog was
   * misreading. `not-listening` for good is "holds the port unbound past the
   * current window" — the window being 75s, so every generation below runs
   * far past it.
   */
  const THAT_NIGHT = (generation: number): HealthVerdict =>
    generation === 1 ? 'no-answer' : 'not-listening';

  /**
   * 23:13:21 (the first restart) → 23:17:34 (the third) is 253s, and the log
   * ends there. Measuring inside the window the log covers is what makes
   * "one restart rather than three" a comparison rather than a claim about
   * where a longer run happens to stop.
   */
  const LOGGED_SPAN_MS = 253_000;

  it('CONTROL: without the grace, that night is three restarts and then the limiter', async () => {
    const { restarts } = await replay({
      verdict: THAT_NIGHT,
      untilMs: 4 * LOGGED_SPAN_MS,
      firstBindGraceMs: 0,
    });
    const firstRestart = restarts[0]?.at ?? 0;
    const inWindow = restarts.filter((r) => r.at <= firstRestart + LOGGED_SPAN_MS);
    // Exactly the log: one wedge restart, two boots killed, then the
    // three-per-hour limiter refusing a fourth — which is how prod recovered.
    expect(inWindow).toHaveLength(3);
    expect(inWindow.map((r) => r.generation)).toEqual([1, 2, 3]);
    expect(restarts).toHaveLength(3);
  });

  it('reads as ONE restart across the window the 23:12Z log covers', async () => {
    const { restarts, lines } = await replay({
      verdict: THAT_NIGHT,
      untilMs: 4 * LOGGED_SPAN_MS,
    });
    const firstRestart = restarts[0]?.at ?? 0;
    const inWindow = restarts.filter((r) => r.at <= firstRestart + LOGGED_SPAN_MS);
    expect(inWindow).toHaveLength(1);
    // And it is the wedge, not a boot: the one restart that night was right.
    expect(inWindow[0]?.generation).toBe(1);
    const inLog = lines.filter((l) => l.at <= firstRestart + LOGGED_SPAN_MS);
    expect(inLog.some((l) => l.line.includes('server alive but not answering'))).toBe(true);
    // The two the old code made are the two that are gone: no line inside the
    // window the log covers says a boot was killed for never binding.
    expect(inLog.filter((l) => l.line.includes('it never bound'))).toHaveLength(0);
    // What the reader sees instead, over and over: a boot being waited on.
    expect(inLog.filter((l) => l.line.includes('boot in progress')).length).toBeGreaterThan(3);
  });

  /**
   * The three-per-hour limiter is raised for the two cases below, because
   * what they measure is the SPACING between restarts of a port that never
   * binds, and with the production limit only two such restarts fit in an
   * hour — one gap, which cannot show a trend either way. The limiter's own
   * behaviour is measured with the production number above.
   */
  const MANY = { max: 10, windowMs: 60 * MIN };
  const HOUR = 60 * MIN;
  const gapsBetween = (times: number[]): number[] =>
    times.slice(1).map((at, i) => at - (times[i] as number));

  it('backs off: each never-bound restart buys the next boot a longer window', async () => {
    const { restarts, ledger } = await replay({
      verdict: THAT_NIGHT,
      untilMs: HOUR,
      policy: MANY,
    });
    // The first is the wedge; the rest are boots that ran out of grace.
    const unbound = restarts.filter((r) => r.generation > 1).map((r) => r.at);
    const gaps = gapsBetween(unbound);
    expect(gaps.length).toBeGreaterThanOrEqual(3);
    // Never shorter than the one before it, and longer than the first by the
    // end: the gap grows while the doubling has room and then holds, which is
    // the ceiling doing its job rather than the backoff failing.
    for (const [i, gap] of gaps.entries()) {
      if (i > 0) expect(gap).toBeGreaterThanOrEqual(gaps[i - 1] as number);
    }
    expect(gaps.at(-1) as number).toBeGreaterThan(gaps[0] as number);
    expect(gaps.at(-1)).toBe(gaps.at(-2) as number);
    // Only the never-bound ones were written down. The wedge was not.
    expect(ledger.history.unbound).toEqual(unbound);
    expect(ledger.history.restarts).toContain(restarts[0]?.at);
  });

  it('CONTROL: with the backoff capped at the base, the gaps stop growing', async () => {
    // The grace is still on — this isolates the BACKOFF. A suite that passes
    // with the doubling removed is not testing it.
    const { restarts } = await replay({
      verdict: THAT_NIGHT,
      untilMs: HOUR,
      policy: MANY,
      firstBindGraceMaxMs: FIRST_BIND_GRACE_MS,
    });
    const unbound = restarts.filter((r) => r.generation > 1).map((r) => r.at);
    const gaps = gapsBetween(unbound);
    expect(gaps.length).toBeGreaterThanOrEqual(3);
    expect(new Set(gaps).size).toBe(1);
  });

  it('CONTROL: a wedge that keeps recurring never lengthens anything', async () => {
    // The distinction the backoff lives or dies on. Every generation here has
    // a server that BOUND and stopped answering, so no restart may be
    // recorded as never-bound and no grace may grow. Recording every restart
    // as unbound — the obvious simplification — turns this red.
    const { restarts, ledger } = await replay({
      verdict: () => 'no-answer',
      untilMs: HOUR,
      policy: MANY,
    });
    expect(ledger.history.unbound).toEqual([]);
    const gaps = gapsBetween(restarts.map((r) => r.at));
    expect(gaps.length).toBeGreaterThanOrEqual(3);
    expect(new Set(gaps).size).toBe(1);
  });

  it('a supervisor arming after two wedge restarts still gets only the base grace', async () => {
    // The same distinction, read off the watchdog rather than the ledger: a
    // seeded history of BOUND-then-silent restarts must buy a boot nothing.
    const seeded = memoryLedger({ restarts: [-2 * MIN, -MIN], unbound: [] });
    const restarts: number[] = [];
    let clock = 0;
    const dog = createHealthWatchdog({
      probe: async () => ({ verdict: 'not-listening' }),
      maxFails: 2,
      ledger: seeded,
      policy: POLICY,
      now: () => clock,
      log: () => {},
      restart: () => restarts.push(clock),
      label: ':8787',
    });
    // One tick past the base grace is where a boot stops being given credit.
    for (let t = TICK; t <= FIRST_BIND_GRACE_MS + 2 * TICK; t += TICK) {
      clock = t;
      await dog.tick();
    }
    expect(restarts).toEqual([FIRST_BIND_GRACE_MS + TICK]);
  });
});
