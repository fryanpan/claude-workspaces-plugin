/**
 * The supervisor's health check: is the server ANSWERING, not merely bound?
 *
 * The probe this replaces opened a TCP socket and called the server healthy
 * on the `connect` event. The kernel completes that handshake from the listen
 * backlog whether or not the process is running JavaScript, so a server whose
 * main thread was stuck — the 2026-09-04 reboot parked it for ~20 minutes in
 * a synchronous open of a cloud-synced file — passed every check while
 * answering nobody. `test/supervisor-wedge.test.ts` shows it: the old probe
 * says `listening` to a server whose loop is blocked, and this one does not.
 *
 * So the probe sends one HTTP request and reads the status line back. Nothing
 * writes a status line until the server's own fetch handler has returned a
 * Response, which only happens when the event loop runs.
 *
 * Three pieces, each testable without the others:
 *
 *   probeHealth        — one request, one of five verdicts
 *   healthStep         — what one verdict does to the consecutive-fail count
 *   restartDecision    — whether a restart is allowed yet, from a ledger that
 *                        outlives the process (a restart ends the supervisor,
 *                        so only a file can remember the last one)
 *
 * `createHealthWatchdog` composes them against an injected probe, clock and
 * ledger; `scripts/serve.ts` only schedules its ticks.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { connect as netConnect } from 'node:net';
import { dirname, join } from 'node:path';
import { classifyConnectError } from './port-bind.ts';

/**
 * The route the supervisor asks. `GET /api/deploy` because it is cheap and
 * exists wherever the watchdog runs: prod always passes `--deploy`, and the
 * read is the deployer's in-memory last result (one small file read, only
 * while a deploy's verification is pending). `/api/metrics` was the obvious
 * pick and the wrong one — it walks the meetings tree on every request, which
 * is fine once a day and not 2,880 times. The gate is unchanged:
 * trusted-local, and the probe arrives from loopback with a loopback Host.
 */
export const SUPERVISOR_PROBE_PATH = '/api/deploy';

/**
 * Marks a request as the supervisor's own probe, so the server does not open
 * a Sentry transaction for it (see `withRouteSpan`). It skips telemetry and
 * nothing else — no gate reads it — so a caller who forges it hides one span
 * of their own and gains no access.
 */
export const SUPERVISOR_PROBE_HEADER = 'x-cw-supervisor-probe';

/** The old probe's whole budget, kept for the connect phase alone. */
export const PROBE_CONNECT_TIMEOUT_MS = 2_000;
/**
 * How long a connected server gets to answer a trivial GET. Generous on
 * purpose: a restart costs two client builds and a full hydration, so this
 * should only lose to a server that is stuck, not to one that is busy.
 */
export const PROBE_ANSWER_TIMEOUT_MS = 10_000;
/** A reply whose header block has not ended by here is not an answer. */
const MAX_HEAD_BYTES = 16 * 1024;

/**
 * - `answering`: a 2xx status line came back. The loop runs.
 * - `refused`: a status line came back, but not a 2xx — a 403 from a gate, a
 *   501, a 500. The loop ran to produce it, so this is NOT a reason to
 *   restart; a restart would come back up refusing the same way, forever.
 * - `no-answer`: the connection opened and nothing HTTP came back — timed out,
 *   closed, or reset. The wedge this module exists to catch.
 * - `not-listening`: the connection never opened — refused, or no handshake
 *   inside the connect budget. The alive-but-unbound case.
 * - `inconclusive`: this host could not give the probe a socket at all
 *   (`classifyConnectError`). Evidence about the machine, none about the
 *   server.
 */
export type HealthVerdict =
  | 'answering'
  | 'refused'
  | 'no-answer'
  | 'not-listening'
  | 'inconclusive';

export interface HealthProbeResult {
  verdict: HealthVerdict;
  /** The HTTP status, when one was read. */
  status?: number;
  /** One phrase for the log line: why this verdict. */
  detail?: string;
}

/** The slice of `net.Socket` the probe uses, so a test can hand it a fake. */
export interface ProbeSocket {
  once(event: 'connect' | 'end' | 'close', listener: () => void): unknown;
  once(event: 'error', listener: (err: Error) => void): unknown;
  on(event: 'data', listener: (chunk: Buffer) => void): unknown;
  write(data: string): unknown;
  destroy(): unknown;
}

export interface HealthProbeOptions {
  host?: string;
  path?: string;
  connectTimeoutMs?: number;
  answerTimeoutMs?: number;
  connect?: (target: { port: number; host: string }) => ProbeSocket;
}

function codeOf(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' ? code : String((err as Error | null)?.message ?? err);
}

/** One request, one verdict. Never rejects. */
export function probeHealth(
  port: number,
  opts: HealthProbeOptions = {},
): Promise<HealthProbeResult> {
  const host = opts.host ?? '127.0.0.1';
  const path = opts.path ?? SUPERVISOR_PROBE_PATH;
  const connectTimeoutMs = opts.connectTimeoutMs ?? PROBE_CONNECT_TIMEOUT_MS;
  const answerTimeoutMs = opts.answerTimeoutMs ?? PROBE_ANSWER_TIMEOUT_MS;
  const open = opts.connect ?? ((target) => netConnect(target));

  return new Promise((resolve) => {
    let settled = false;
    let connected = false;
    let head = '';
    const socket = open({ port, host });
    const done = (result: HealthProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    let timer = setTimeout(
      () => done({ verdict: 'not-listening', detail: `no handshake within ${connectTimeoutMs}ms` }),
      connectTimeoutMs,
    );

    socket.once('connect', () => {
      connected = true;
      clearTimeout(timer);
      timer = setTimeout(
        () =>
          done({ verdict: 'no-answer', detail: `connected, no reply within ${answerTimeoutMs}ms` }),
        answerTimeoutMs,
      );
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: ${host}:${port}\r\nUser-Agent: claude-workspaces-supervisor\r\n` +
          `${SUPERVISOR_PROBE_HEADER}: 1\r\nAccept: application/json\r\nConnection: close\r\n\r\n`,
      );
    });
    socket.on('data', (chunk) => {
      head += chunk.toString('latin1');
      if (!head.includes('\r\n\r\n')) {
        if (head.length < MAX_HEAD_BYTES) return;
        // A status line with no end to its headers is a reply that stalled
        // halfway, and a 200 at the top of it proves nothing.
        return done({ verdict: 'no-answer', detail: 'the reply headers never ended' });
      }
      const match = /^HTTP\/1\.[01] (\d{3})[ \r]/.exec(head);
      if (!match) return done({ verdict: 'no-answer', detail: 'the reply was not HTTP' });
      const status = Number(match[1]);
      done({ verdict: status >= 200 && status < 300 ? 'answering' : 'refused', status });
    });
    // `close` follows `error`, and `done` is idempotent, so an error's
    // classification is the one that lands.
    socket.once('error', (err) =>
      done(
        connected
          ? { verdict: 'no-answer', detail: `connection failed after opening (${codeOf(err)})` }
          : { verdict: classifyConnectError(err), detail: codeOf(err) },
      ),
    );
    socket.once('close', () =>
      done(
        connected
          ? { verdict: 'no-answer', detail: 'closed without replying' }
          : { verdict: 'not-listening', detail: 'closed before the handshake' },
      ),
    );
  });
}

/** What the watchdog does with one probe result. */
export interface HealthStep {
  /** The consecutive-failure count after this probe. */
  fails: number;
  /** `restart` asks for one — `restartDecision` still has to allow it. */
  action: 'ok' | 'wait' | 'restart';
}

/**
 * Fold one verdict into the watchdog's count. Any status line clears it,
 * `refused` included, because the loop ran to write it. An inconclusive probe
 * holds the count where it is: not reset, so an unbound server masked by a
 * socket shortage is still caught by the next readable probe, and not
 * incremented, because the probe said nothing about the server.
 */
export function healthStep(fails: number, verdict: HealthVerdict, maxFails: number): HealthStep {
  if (verdict === 'answering' || verdict === 'refused') return { fails: 0, action: 'ok' };
  if (verdict === 'inconclusive') return { fails, action: 'wait' };
  const next = fails + 1;
  return { fails: next, action: next >= maxFails ? 'restart' : 'wait' };
}

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

export interface RestartLedger {
  load(): number[];
  save(history: number[]): void;
}

export function restartLedgerPath(dataDir: string): string {
  return join(dataDir, 'supervisor-restarts.json');
}

/**
 * The ledger as a JSON file. A missing or unreadable file reads as empty —
 * the watchdog fails OPEN, because a limit that cannot be read must not
 * become a watchdog that can never act. Written via rename so a crash
 * mid-write leaves the old ledger, not half a new one.
 */
export function fileRestartLedger(path: string): RestartLedger {
  return {
    load() {
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as { restarts?: unknown };
        return Array.isArray(parsed.restarts)
          ? parsed.restarts.filter((t): t is number => typeof t === 'number')
          : [];
      } catch {
        return [];
      }
    },
    save(history) {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, `${JSON.stringify({ restarts: history })}\n`);
      renameSync(tmp, path);
    },
  };
}

export interface HealthWatchdogOptions {
  probe: () => Promise<HealthProbeResult>;
  maxFails: number;
  ledger: RestartLedger;
  policy?: RestartPolicy;
  now?: () => number;
  log: (line: string) => void;
  /** Ends the supervisor non-zero so launchd starts a fresh one. */
  restart: () => void;
  /** How log lines name the server, e.g. `:8787`. */
  label: string;
}

export type WatchdogTick = 'ok' | 'wait' | 'held' | 'restart' | 'skipped';

function describe(result: HealthProbeResult): string {
  const why = result.detail ? ` (${result.detail})` : '';
  return result.verdict === 'no-answer' ? `not answering${why}` : `not listening${why}`;
}

/**
 * The watchdog's state between ticks. One tick is one probe; ticks that
 * overlap a probe still in flight are skipped rather than queued.
 */
export function createHealthWatchdog(opts: HealthWatchdogOptions): {
  tick(): Promise<WatchdogTick>;
} {
  const { maxFails, ledger, log, label } = opts;
  const now = opts.now ?? Date.now;
  let fails = 0;
  let inFlight = false;
  let done = false;
  // Each is logged when it changes, not on every 30s tick it persists.
  let refusedStatus: number | null = null;
  let heldUntil: number | null = null;

  async function tick(): Promise<WatchdogTick> {
    if (done || inFlight) return 'skipped';
    inFlight = true;
    let result: HealthProbeResult;
    try {
      result = await opts.probe();
    } finally {
      inFlight = false;
    }
    const step = healthStep(fails, result.verdict, maxFails);
    fails = step.fails;

    if (result.verdict === 'answering' || result.verdict === 'refused') {
      heldUntil = null;
      if (result.verdict === 'answering') refusedStatus = null;
      else if (result.status !== refusedStatus) {
        refusedStatus = result.status ?? null;
        log(
          `[supervisor] health: ${label} answered HTTP ${result.status} to the probe — the server ` +
            'is running, so this is not a restart; the probe route or its gate needs a look',
        );
      }
      return 'ok';
    }
    if (result.verdict === 'inconclusive') {
      // Said out loud: this branch used to be counted as an unbound server,
      // and the line is how the next socket shortage gets diagnosed as one.
      log(
        `[supervisor] health: cannot open a socket to probe ${label} — this host is out of ` +
          `network resources, which says nothing about the server; not counting it (${fails}/${maxFails})`,
      );
      return 'wait';
    }
    log(`[supervisor] health: ${label} ${describe(result)} (${fails}/${maxFails})`);
    if (step.action !== 'restart') return 'wait';

    const at = now();
    const decision = restartDecision(ledger.load(), at, opts.policy);
    if (!decision.allowed) {
      if (heldUntil !== decision.retryAt) {
        heldUntil = decision.retryAt;
        log(
          `[supervisor] health: NOT restarting — ${decision.recent} watchdog restarts inside the ` +
            `limit window already; the next is allowed at ${new Date(decision.retryAt).toISOString()}. ` +
            'A server that keeps failing right after a restart is not one a restart cures.',
        );
      }
      return 'held';
    }
    try {
      ledger.save(decision.history);
    } catch (err) {
      log(`[supervisor] health: could not record this restart (${codeOf(err)}); restarting anyway`);
    }
    done = true;
    log(
      result.verdict === 'no-answer'
        ? '[supervisor] server alive but not answering — restarting via launchd'
        : '[supervisor] server alive-but-unbound — restarting via launchd',
    );
    opts.restart();
    return 'restart';
  }

  return { tick };
}
