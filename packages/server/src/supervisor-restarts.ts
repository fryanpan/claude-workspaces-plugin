/**
 * What the supervisor's restart HISTORY buys the next boot: the rate limit,
 * the ledger that carries it across processes, and the first-bind grace the
 * ledger lengthens.
 *
 * Split out of `supervisor-health.ts` — that file is the health CHECK (one
 * probe, one verdict, one fail count) and this one is the memory the check
 * consults. They were one file until the backoff needed writing down, and the
 * seam was already there: nothing here takes a probe result, and nothing
 * there reads a clock older than its own process.
 *
 * A restart ends the supervisor and launchd starts a fresh one, so every fact
 * a decision needs from the PREVIOUS generation has to live in a file. That
 * file is `supervisor-restarts.json`, and it now records two things rather
 * than one:
 *
 *   restarts  — every watchdog restart, for the 3-per-hour limit
 *   unbound   — the subset that killed a boot which had never bound the port
 *
 * The subset is what the backoff runs on, and keeping it a subset rather than
 * a second ledger is deliberate: a reader who opens the file sees at a glance
 * how many of the hour's restarts were the expensive kind.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// ---------------------------------------------------------------------------
// Rate limit. A restart exits the supervisor and launchd starts a new one, so
// the limit has to survive the process: the ledger is a file of timestamps.
//
// Why a limit at all: a server that is slow under load, rather than stuck,
// can miss two probes in a row. Restarting it drops every client, and every
// client reconnecting at once is more load — the 2026-09-04 socket shortage
// had exactly that shape. And a wedge a restart cannot cure (a boot parked on
// a consent dialog) would otherwise become a restart every ~75s.
// ---------------------------------------------------------------------------

export interface RestartPolicy {
  /** Restarts allowed inside any `windowMs`. */
  max: number;
  windowMs: number;
}

/** At most three watchdog restarts in any rolling hour. */
export const WATCHDOG_RESTART_POLICY: RestartPolicy = { max: 3, windowMs: 60 * 60_000 };

export type RestartDecision =
  | { allowed: true; history: number[] }
  | { allowed: false; recent: number; retryAt: number };

/**
 * May the watchdog restart at `now`, given when it last did? On `allowed`,
 * `history` is the ledger to write back: the window's entries plus this one.
 * Entries outside the window, or in the future (a clock that stepped back),
 * are dropped rather than trusted.
 */
export function restartDecision(
  history: readonly number[],
  now: number,
  policy: RestartPolicy = WATCHDOG_RESTART_POLICY,
): RestartDecision {
  const recent = history
    .filter((t) => Number.isFinite(t) && t > now - policy.windowMs && t <= now)
    .sort((a, b) => a - b);
  if (recent.length < policy.max) return { allowed: true, history: [...recent, now] };
  const oldestCounted = recent[recent.length - policy.max];
  return { allowed: false, recent: recent.length, retryAt: oldestCounted + policy.windowMs };
}

/**
 * The two timestamp lists the ledger carries. `unbound` is a SUBSET of
 * `restarts` — every entry in it is also in there — so a reader who only
 * knows about `restarts` still counts every restart correctly. That is what
 * makes the field safe to add to a file prod is already writing.
 */
export interface RestartHistory {
  restarts: number[];
  /** The restarts that killed a boot which had never bound the port. */
  unbound: number[];
}

export interface RestartLedger {
  load(): RestartHistory;
  save(history: RestartHistory): void;
}

export function restartLedgerPath(dataDir: string): string {
  return join(dataDir, 'supervisor-restarts.json');
}

const numbers = (v: unknown): number[] =>
  Array.isArray(v) ? v.filter((t): t is number => typeof t === 'number') : [];

/**
 * The ledger as a JSON file. A missing or unreadable file reads as empty —
 * the watchdog fails OPEN, because a limit that cannot be read must not
 * become a watchdog that can never act. Written via rename so a crash
 * mid-write leaves the old ledger, not half a new one.
 *
 * A file written before `unbound` existed reads as "no unbound restarts",
 * which starts the backoff at its base. That is the right reading: it is what
 * the file would say if the boots it recorded had all been the cheap kind,
 * and the backoff's job is to lengthen a grace, never to shorten one.
 */
export function fileRestartLedger(path: string): RestartLedger {
  return {
    load() {
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
          restarts?: unknown;
          unbound?: unknown;
        };
        const restarts = numbers(parsed.restarts);
        // Never trust `unbound` to name a restart `restarts` does not — the
        // subset invariant is what the count means.
        const unbound = numbers(parsed.unbound).filter((t) => restarts.includes(t));
        return { restarts, unbound };
      } catch {
        return { restarts: [], unbound: [] };
      }
    },
    save(history) {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      writeFileSync(
        tmp,
        `${JSON.stringify({ restarts: history.restarts, unbound: history.unbound })}\n`,
      );
      renameSync(tmp, path);
    },
  };
}

// ---------------------------------------------------------------------------
// The first-bind grace, and the backoff on it.
// ---------------------------------------------------------------------------

/**
 * How long the FIRST bind of a supervisor's life gets before an unbound port
 * counts against it. A boot in progress is not a dead server.
 *
 * Measured, not chosen. `server-starts.ts` records `startedAt` (the child's
 * time origin) and `servingAt` (port bound, documents hydrated) for every
 * boot, and that pair is exactly the window this has to cover — the two
 * client builds finish before the child is spawned, so they are outside it.
 * Over 171 served boots in prod's record (2026-09-11 → 2026-09-17): p50 2.9s,
 * p90 4.0s, p95 8.8s, p99 35.6s, largest 109.9s.
 *
 * **That 109.9s is right-censored, and the censoring is the argument for the
 * margin.** It is the largest boot that COMPLETED. Three more were killed by
 * this very watchdog at ~75s with no `servingAt` ever written, so how long
 * they would have taken is unobserved — the distribution above 75s was
 * truncated by the mechanism this constant exists to change. 109.9s is
 * therefore a floor on the maximum, not the maximum, which is why the margin
 * is 2.2x rather than the 1.5x a reader who took 109.9s for the true maximum
 * would think sufficient. Do not tighten this without a record gathered while
 * the grace was in force. 240_000 is also exactly 8 check intervals, so the
 * grace expires on a tick boundary rather than mid-interval.
 */
export const FIRST_BIND_GRACE_MS = 240_000;

/**
 * The ceiling the backoff doubles up to: 4x the base, so it saturates after
 * two never-bound restarts (240s → 480s → 960s → 960s …).
 *
 * Why a ceiling at all, given the 3-per-hour limit already bounds how often
 * this can happen: without one, a machine that spent a bad hour restarting
 * would carry an hours-long grace into the next generation, and the watchdog
 * would stop being able to act on a boot that really is dead. 960_000 is 16
 * minutes, and 240 + 480 + 960 = 28 minutes of grace across the three
 * generations the limiter allows inside its hour — the limiter stays the
 * outer bound, which is the ordering that keeps its own worked example (16
 * September, the 109.9s boot the limiter saved) still true. It is also 32
 * check intervals, so like the base it expires on a tick boundary.
 */
export const FIRST_BIND_GRACE_MAX_MS = 960_000;

export interface FirstBindGrace {
  graceMs: number;
  /** Never-bound restarts already inside the window when this armed. */
  priorUnboundRestarts: number;
}

/**
 * The grace THIS supervisor's first bind gets, given the never-bound restarts
 * already on the ledger.
 *
 * The backoff is the second half of "a boot in progress is not a dead
 * server". The base grace stops one 240s boot being killed; it does not stop
 * a machine so loaded that no boot finishes from being restarted on a fixed
 * cadence forever, each restart re-running a full hydration and leaving the
 * next boot less machine to finish in. So each never-bound restart inside the
 * window doubles what the next generation gets before it may act.
 *
 * **Only never-bound restarts count.** A restart of a server that HAD bound
 * and stopped answering is the wedge the watchdog was built for; it is cured
 * by restarting, it says nothing about how long a boot takes, and feeding it
 * into this would slowly blind the watchdog to the fault it exists to catch.
 * `supervisor-health.ts` is what classifies a restart, and it writes only the
 * never-bound ones into `unbound`.
 *
 * `base` of 0 stays 0 — turning the grace off must not be undone by history.
 */
export function firstBindGraceFor(
  unbound: readonly number[],
  now: number,
  opts: { base?: number; maxMs?: number; windowMs?: number } = {},
): FirstBindGrace {
  const base = opts.base ?? FIRST_BIND_GRACE_MS;
  const maxMs = opts.maxMs ?? FIRST_BIND_GRACE_MAX_MS;
  const windowMs = opts.windowMs ?? WATCHDOG_RESTART_POLICY.windowMs;
  const prior = unbound.filter((t) => Number.isFinite(t) && t > now - windowMs && t <= now).length;
  // Clamped before the shift so a corrupt ledger cannot reach Infinity; the
  // Math.min against the ceiling is what actually decides the answer. A base
  // of 0 needs no branch of its own — the doubling leaves it 0, which is what
  // "the grace is off" has to keep meaning however bad the history is, and
  // `firstBindGraceFor: keeps a grace of 0 at 0` is the case that says so.
  const doubled = base * 2 ** Math.min(prior, 20);
  // `Math.max` and not the bare ceiling: a ceiling misconfigured BELOW the
  // base would otherwise shorten the grace, the one direction this must never
  // move.
  return { graceMs: Math.min(doubled, Math.max(base, maxMs)), priorUnboundRestarts: prior };
}
