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
 *
 * The third piece — whether a restart is allowed yet, and how long the next
 * boot gets before one may be asked for — is `supervisor-restarts.ts`, which
 * reads a ledger that outlives the process (a restart ends the supervisor, so
 * only a file can remember the last one).
 *
 * And one rule that cuts across them: A BOOT IN PROGRESS IS NOT A DEAD
 * SERVER. `createServer` hydrates every persisted document BEFORE it binds,
 * so between the spawn and the first bind there is a live, healthy process
 * with nothing on the port. The watchdog used to read that as
 * alive-but-unbound and restart it — on 2026-09-16 it killed two boots at
 * 76.0s and 75.5s, neither of which had written a `servingAt`, and the
 * survivor bound in 25.2s. Each restart re-ran two client builds and a full
 * hydration on an already-loaded machine. So the FIRST bind of a
 * supervisor's life gets `FIRST_BIND_GRACE_MS` before an unopened connection
 * counts against it; a bound server that stops answering is untouched.
 *
 * And because one grace does not fix a machine on which NO boot finishes,
 * this file also classifies the restart it asks for: a never-bound restart is
 * written into the ledger's `unbound` list, and the next supervisor doubles
 * its grace for each one inside the window (`firstBindGraceFor`). The
 * classification is the whole content of the distinction — a restart of a
 * server that had bound and stopped answering must never lengthen anything.
 *
 * `createHealthWatchdog` composes them against an injected probe, clock and
 * ledger; `scripts/serve.ts` only schedules its ticks.
 */
import { connect as netConnect } from 'node:net';
import { classifyConnectError } from './port-bind.ts';
import {
  FIRST_BIND_GRACE_MS,
  type RestartLedger,
  type RestartPolicy,
  WATCHDOG_RESTART_POLICY,
  firstBindGraceFor,
  restartDecision,
} from './supervisor-restarts.ts';

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
  action: 'ok' | 'wait' | 'booting' | 'restart';
}

/** Context a verdict is read in. Only `not-listening` consults it. */
export interface HealthStepContext {
  /**
   * Nothing has bound the port yet in this supervisor's life AND the
   * first-bind grace has not run out — so an unopened connection is a boot
   * still hydrating, not a server that lost its port.
   */
  bootingFirstBind?: boolean;
}

/**
 * Fold one verdict into the watchdog's count. Any status line clears it,
 * `refused` included, because the loop ran to write it. An inconclusive probe
 * holds the count where it is: not reset, so an unbound server masked by a
 * socket shortage is still caught by the next readable probe, and not
 * incremented, because the probe said nothing about the server.
 *
 * `not-listening` during the first-bind grace holds the count the same way,
 * for the same reason: the probe is evidence about a boot, not about a
 * server. `no-answer` never reads the grace — a reply that did not come back
 * still required a completed handshake, so something IS bound, and the two
 * conditions cannot both hold. Gating on the verdict therefore costs nothing
 * and keeps the wedge this module exists to catch on its old budget.
 */
export function healthStep(
  fails: number,
  verdict: HealthVerdict,
  maxFails: number,
  ctx: HealthStepContext = {},
): HealthStep {
  if (verdict === 'answering' || verdict === 'refused') return { fails: 0, action: 'ok' };
  if (verdict === 'inconclusive') return { fails, action: 'wait' };
  if (verdict === 'not-listening' && ctx.bootingFirstBind) return { fails, action: 'booting' };
  const next = fails + 1;
  return { fails: next, action: next >= maxFails ? 'restart' : 'wait' };
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
  /**
   * The BASE first-bind grace — what a supervisor gets with no never-bound
   * restart behind it. Defaults to `FIRST_BIND_GRACE_MS`; 0 turns the grace
   * off, and stays off however bad the history is.
   */
  firstBindGraceMs?: number;
  /** The ceiling the backoff doubles up to. Defaults to
   *  `FIRST_BIND_GRACE_MAX_MS`. */
  firstBindGraceMaxMs?: number;
}

export type WatchdogTick = 'ok' | 'wait' | 'booting' | 'held' | 'restart' | 'skipped';

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
  const policy = opts.policy ?? WATCHDOG_RESTART_POLICY;
  // When this supervisor armed. The grace is measured from here, so it covers
  // the child it spawned and nothing else.
  const armedAt = now();
  // The backoff, read ONCE at arm time rather than per tick: the answer is a
  // property of the generations before this one, and a ledger that changed
  // under a running watchdog would mean some other supervisor is alive on the
  // same box — not a case to give a longer grace to.
  const grace = firstBindGraceFor(ledger.load().unbound, armedAt, {
    base: opts.firstBindGraceMs ?? FIRST_BIND_GRACE_MS,
    ...(opts.firstBindGraceMaxMs === undefined ? {} : { maxMs: opts.firstBindGraceMaxMs }),
    windowMs: policy.windowMs,
  });
  const firstBindGraceMs = grace.graceMs;
  if (grace.priorUnboundRestarts > 0 && firstBindGraceMs > 0) {
    // Said at arm time, not at the restart it prevents, because this is the
    // line that explains why the NEXT 240s of not-listening logs are silence
    // rather than a restart. Without it the backoff is invisible in the log
    // that a person reads after an outage.
    log(
      `[supervisor] health: ${grace.priorUnboundRestarts} restart(s) in the last ` +
        `${Math.round(policy.windowMs / 60_000)}min killed a boot that had never bound ${label}, ` +
        `so this boot gets ${Math.round(firstBindGraceMs / 1000)}s of first-bind grace rather ` +
        'than the usual — restarting a boot that is still hydrating is what made the last one slow',
    );
  }
  let fails = 0;
  let inFlight = false;
  let done = false;
  /**
   * Has anything ever bound the port while THIS supervisor watched? Kept in
   * memory on purpose. A restart ends this process and launchd spawns a fresh
   * supervisor whose child is genuinely booting again, so the fact has to
   * reset with it — a persisted "it bound once" would deny the grace to
   * precisely the boot that the old code killed.
   */
  let everBound = false;
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
    const sinceArmed = now() - armedAt;
    const bootingFirstBind = !everBound && sinceArmed < firstBindGraceMs;
    // Every verdict but `not-listening` reached a listening socket, so any of
    // them ends the grace for good — including `no-answer`, where the reply
    // never came but the handshake did.
    if (result.verdict !== 'not-listening' && result.verdict !== 'inconclusive') everBound = true;
    const step = healthStep(fails, result.verdict, maxFails, { bootingFirstBind });
    fails = step.fails;

    if (step.action === 'booting') {
      // Logged every tick, not once: the elapsed seconds are the diagnostic,
      // and they are what says afterwards whether the grace was generous or
      // barely enough. Bounded by the grace itself — eight lines at the base
      // grace, thirty-two at the backoff's ceiling (960s over a 30s tick).
      log(
        `[supervisor] health: ${label} not listening ${Math.round(sinceArmed / 1000)}s into ` +
          `boot — nothing has bound in this supervisor's life yet, so this is a boot in ` +
          `progress, not a dead server; it has ${Math.round(firstBindGraceMs / 1000)}s of grace`,
      );
      return 'booting';
    }

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
    const history = ledger.load();
    const decision = restartDecision(history.restarts, at, policy);
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
    // THE classification the backoff runs on, and the only place it is made.
    // A never-bound restart is one that ends a boot which has not yet put
    // anything on the port in this supervisor's life. `everBound` is what
    // separates it from the wedge the watchdog was built for — a server that
    // bound, answered, and then stopped — and only the first kind may
    // lengthen the next generation's grace. Widening this to every restart
    // would let a repeating wedge talk the watchdog out of catching it.
    const neverBound = result.verdict === 'not-listening' && !everBound;
    try {
      ledger.save({
        restarts: decision.history,
        unbound: neverBound
          ? [...history.unbound.filter((t) => decision.history.includes(t)), at]
          : history.unbound.filter((t) => decision.history.includes(t)),
      });
    } catch (err) {
      log(`[supervisor] health: could not record this restart (${codeOf(err)}); restarting anyway`);
    }
    done = true;
    // An unbound port means two different faults, and the log should say
    // which: a server that bound and then LOST the port (the --watch reload
    // wedge this watchdog was built for), or a first bind that never arrived
    // inside the whole grace. Only the second is a boot, and it is the one
    // worth measuring against `server-starts.json` afterwards.
    //
    // Both keep the words `alive-but-unbound`, because that phrase is what
    // the 24h restart criterion counts (see the note in `scripts/serve.ts`).
    // Splitting the message into two strings without a shared stem would have
    // made the more serious of the two faults invisible to the grep that
    // measures it.
    log(
      result.verdict === 'no-answer'
        ? '[supervisor] server alive but not answering — restarting via launchd'
        : everBound
          ? '[supervisor] server alive-but-unbound — it was listening earlier and is not now — ' +
            'restarting via launchd'
          : '[supervisor] server alive-but-unbound — it never bound ' +
            `${label} in ${Math.round(sinceArmed / 1000)}s, past the first-bind grace — ` +
            'restarting via launchd',
    );
    opts.restart();
    return 'restart';
  }

  return { tick };
}
