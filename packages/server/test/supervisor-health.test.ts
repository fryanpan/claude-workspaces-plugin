/**
 * The supervisor's health check, piece by piece: what one probe says, what a
 * verdict does to the watchdog's count, and how often the watchdog may act on
 * it. The wedged-server contrast against the old probe is its own file,
 * `supervisor-wedge.test.ts`, because it needs a child process.
 *
 * Each failure verdict gets its own server that produces exactly that
 * failure, because a restart keyed to the wrong one is worse than no check:
 * a 403 read as a dead server restarts a healthy one forever.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import { type Server as NetServer, createServer as createNetServer } from 'node:net';
import {
  type HealthProbeResult,
  type HealthVerdict,
  SUPERVISOR_PROBE_HEADER,
  SUPERVISOR_PROBE_PATH,
  type WatchdogTick,
  createHealthWatchdog,
  healthStep,
  probeHealth,
} from '../src/supervisor-health.ts';
import { memoryLedger } from './supervisor-ledger-stub.ts';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

interface Seen {
  method: string;
  path: string;
  host: string | null;
  marker: string | null;
}

function httpServer(status: number, seen?: Seen[]): number {
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      // Read here: a Request's fields are gone once its response is sent.
      seen?.push({
        method: req.method,
        path: new URL(req.url).pathname,
        host: req.headers.get('host'),
        marker: req.headers.get(SUPERVISOR_PROBE_HEADER),
      });
      return new Response('{}', { status });
    },
  });
  cleanups.push(() => server.stop(true));
  return server.port as number;
}

/** A TCP server that accepts and then does `onSocket` — never HTTP. */
async function rawServer(onSocket: (socket: import('node:net').Socket) => void): Promise<number> {
  const server: NetServer = createNetServer(onSocket);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const held: import('node:net').Socket[] = [];
  server.on('connection', (s) => held.push(s));
  cleanups.push(() => {
    for (const s of held) s.destroy();
    server.close();
  });
  return (server.address() as { port: number }).port;
}

describe('probeHealth: one request, and the verdict names what failed', () => {
  it('answering: a 2xx came back, and the request was the one the gate expects', async () => {
    const seen: Seen[] = [];
    const port = httpServer(200, seen);
    expect(await probeHealth(port)).toEqual({ verdict: 'answering', status: 200 });
    expect(seen).toEqual([
      { method: 'GET', path: SUPERVISOR_PROBE_PATH, host: `127.0.0.1:${port}`, marker: '1' },
    ]);
  });

  it('refused: a status line that is not a 2xx — the loop ran to write it', async () => {
    const port = httpServer(403);
    expect(await probeHealth(port)).toEqual({ verdict: 'refused', status: 403 });
  });

  it('not-listening: nothing is bound, so the connection never opens', async () => {
    const borrowed = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response() });
    const port = borrowed.port as number;
    borrowed.stop(true);
    expect((await probeHealth(port)).verdict).toBe('not-listening');
  });

  it('no-answer: the connection opens and nothing comes back', async () => {
    const port = await rawServer(() => {});
    const result = await probeHealth(port, { answerTimeoutMs: 200 });
    expect(result.verdict).toBe('no-answer');
    expect(result.detail).toContain('no reply within 200ms');
  });

  it('no-answer: the connection opens and is closed without a reply', async () => {
    const port = await rawServer((socket) => socket.end());
    expect(await probeHealth(port)).toEqual({
      verdict: 'no-answer',
      detail: 'closed without replying',
    });
  });

  it('no-answer: bytes that are not HTTP are not an answer', async () => {
    const port = await rawServer((socket) => socket.write('SSH-2.0-nope\r\n\r\n'));
    expect((await probeHealth(port)).verdict).toBe('no-answer');
  });

  it('no-answer: a 200 status line whose headers never end is not an answer', async () => {
    const port = await rawServer((socket) =>
      socket.write(`HTTP/1.1 200 OK\r\nx-filler: ${'a'.repeat(20 * 1024)}`),
    );
    expect(await probeHealth(port)).toEqual({
      verdict: 'no-answer',
      detail: 'the reply headers never ended',
    });
  });

  it('inconclusive: the host could not give the probe a socket', async () => {
    const fake = Object.assign(new EventEmitter(), { write: () => true, destroy: () => {} });
    const result = await probeHealth(8873, {
      connect: () => {
        queueMicrotask(() => {
          const err = new Error('connect ENOBUFS') as NodeJS.ErrnoException;
          err.code = 'ENOBUFS';
          fake.emit('error', err);
        });
        return fake;
      },
    });
    expect(result).toEqual({ verdict: 'inconclusive', detail: 'ENOBUFS' });
  });
});

describe('healthStep: only an unanswered probe counts', () => {
  for (const verdict of ['no-answer', 'not-listening'] as const) {
    it(`${verdict} counts toward a restart at maxFails`, () => {
      const first = healthStep(0, verdict, 2);
      expect(first).toEqual({ fails: 1, action: 'wait' });
      expect(healthStep(first.fails, verdict, 2)).toEqual({ fails: 2, action: 'restart' });
    });
  }

  it('refused never restarts, however many arrive, and clears the count', () => {
    let fails = 1;
    for (let i = 0; i < 20; i++) {
      const step = healthStep(fails, 'refused', 2);
      expect(step).toEqual({ fails: 0, action: 'ok' });
      fails = step.fails;
    }
  });

  it('inconclusive holds the count: neither reset nor incremented', () => {
    let fails = 1;
    for (let i = 0; i < 20; i++) {
      const step = healthStep(fails, 'inconclusive', 2);
      expect(step.action).toBe('wait');
      fails = step.fails;
    }
    expect(fails).toBe(1);
    expect(healthStep(fails, 'no-answer', 2)).toEqual({ fails: 2, action: 'restart' });
  });

  it('answering clears the count', () => {
    expect(healthStep(1, 'answering', 2)).toEqual({ fails: 0, action: 'ok' });
  });
});

const MIN = 60_000;
const POLICY = { max: 3, windowMs: 60 * MIN };

function scripted(verdicts: HealthVerdict[]): () => Promise<HealthProbeResult> {
  let i = 0;
  return async () => ({ verdict: verdicts[Math.min(i++, verdicts.length - 1)] as HealthVerdict });
}

describe('the watchdog, on an injected clock', () => {
  it('never restarts a server that is slow but still answers between misses', async () => {
    const restarts: number[] = [];
    let clock = 0;
    const pattern: HealthVerdict[] = [];
    for (let i = 0; i < 40; i++) pattern.push(i % 2 === 0 ? 'no-answer' : 'answering');
    const dog = createHealthWatchdog({
      probe: scripted(pattern),
      maxFails: 2,
      ledger: memoryLedger(),
      policy: POLICY,
      now: () => clock,
      log: () => {},
      restart: () => restarts.push(clock),
      label: ':8873',
    });
    for (let i = 0; i < 40; i++) {
      expect(['ok', 'wait']).toContain(await dog.tick());
      clock += 30_000;
    }
    expect(restarts).toEqual([]);
  });

  it('restarts a wedge at most three times an hour across supervisor lifetimes', async () => {
    // Each lifetime is a new supervisor — a restart ends the old one — so
    // the only thing they share is the ledger, exactly as in prod.
    const ledger = memoryLedger();
    const restarts: number[] = [];
    const lines: string[] = [];
    let clock = 0;
    const lifetime = () =>
      createHealthWatchdog({
        probe: scripted(['no-answer']),
        maxFails: 2,
        ledger,
        policy: POLICY,
        now: () => clock,
        log: (l) => lines.push(l),
        restart: () => restarts.push(clock),
        label: ':8873',
      });

    for (let n = 0; n < 3; n++) {
      const dog = lifetime();
      expect(await dog.tick()).toBe('wait');
      clock += 30_000;
      expect(await dog.tick()).toBe('restart');
      // A restarted supervisor probes no further.
      expect(await dog.tick()).toBe('skipped');
      clock += 90_000;
    }
    expect(restarts).toEqual([30_000, 150_000, 270_000]);
    // Every one of them was a wedge, not a boot: nothing lengthens.
    expect(ledger.history.unbound).toEqual([]);

    // The fourth lifetime holds, and says so once rather than every tick.
    const fourth = lifetime();
    await fourth.tick();
    clock += 30_000;
    while (clock < 30_000 + POLICY.windowMs) {
      expect(await fourth.tick()).toBe('held');
      clock += 30_000;
    }
    expect(restarts).toHaveLength(3);
    expect(lines.filter((l) => l.includes('NOT restarting'))).toHaveLength(1);

    // The first restart has aged out of the window: one more is allowed.
    expect(await fourth.tick()).toBe('restart');
    expect(restarts).toHaveLength(4);
  });

  it('logs a refusal when it starts and when its status changes, not every tick', async () => {
    const lines: string[] = [];
    const statuses = [403, 403, 403, 501, 501];
    let i = 0;
    const dog = createHealthWatchdog({
      probe: async () => ({ verdict: 'refused', status: statuses[i++] }),
      maxFails: 2,
      ledger: memoryLedger(),
      log: (l) => lines.push(l),
      restart: () => {
        throw new Error('a refusal must never restart');
      },
      label: ':8873',
    });
    for (let n = 0; n < statuses.length; n++) expect(await dog.tick()).toBe('ok');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('HTTP 403');
    expect(lines[1]).toContain('HTTP 501');
  });

  it('skips a tick while the previous probe is still in flight', async () => {
    let release: (r: HealthProbeResult) => void = () => {};
    const dog = createHealthWatchdog({
      probe: () =>
        new Promise((r) => {
          release = r;
        }),
      maxFails: 2,
      ledger: memoryLedger(),
      log: () => {},
      restart: () => {},
      label: ':8873',
    });
    const first = dog.tick();
    expect(await dog.tick()).toBe('skipped');
    release({ verdict: 'answering', status: 200 });
    expect(await first).toBe('ok');
  });
});

describe('healthStep: a boot in progress is not a dead server', () => {
  it('holds the count for not-listening during the first-bind grace', () => {
    let fails = 0;
    for (let i = 0; i < 20; i++) {
      const step = healthStep(fails, 'not-listening', 2, { bootingFirstBind: true });
      expect(step.action).toBe('booting');
      fails = step.fails;
    }
    expect(fails).toBe(0);
  });

  it('counts not-listening the moment the grace is over', () => {
    const held = healthStep(0, 'not-listening', 2, { bootingFirstBind: true });
    expect(held).toEqual({ fails: 0, action: 'booting' });
    const first = healthStep(held.fails, 'not-listening', 2, { bootingFirstBind: false });
    expect(first).toEqual({ fails: 1, action: 'wait' });
    expect(healthStep(first.fails, 'not-listening', 2)).toEqual({ fails: 2, action: 'restart' });
  });

  it('never delays no-answer: a reply that did not come back still had a handshake', () => {
    const first = healthStep(0, 'no-answer', 2, { bootingFirstBind: true });
    expect(first).toEqual({ fails: 1, action: 'wait' });
    expect(healthStep(first.fails, 'no-answer', 2, { bootingFirstBind: true })).toEqual({
      fails: 2,
      action: 'restart',
    });
  });
});

describe('the first bind gets a grace, and only the first', () => {
  const GRACE = 240_000;
  const TICK = 30_000;
  const SLOW_BOOT: HealthVerdict[] = [
    'not-listening',
    'not-listening',
    'not-listening',
    'not-listening',
    'not-listening',
    'answering',
  ];

  /**
   * Runs `ticks` probes a TICK apart, starting a TICK after the watchdog
   * armed, and reports what happened. The clock is injected, so nothing here
   * reads a wall clock or sleeps.
   */
  async function run(
    verdicts: HealthVerdict[],
    ticks: number,
    firstBindGraceMs?: number,
  ): Promise<{ outcomes: WatchdogTick[]; restarts: number[]; lines: string[] }> {
    const restarts: number[] = [];
    const lines: string[] = [];
    const outcomes: WatchdogTick[] = [];
    let clock = 0;
    const dog = createHealthWatchdog({
      probe: scripted(verdicts),
      maxFails: 2,
      ledger: memoryLedger(),
      policy: POLICY,
      now: () => clock,
      log: (l) => lines.push(l),
      restart: () => restarts.push(clock),
      label: ':8873',
      ...(firstBindGraceMs === undefined ? {} : { firstBindGraceMs }),
    });
    for (let i = 0; i < ticks; i++) {
      clock += TICK;
      outcomes.push(await dog.tick());
    }
    return { outcomes, restarts, lines };
  }

  it('does not restart a boot that is still hydrating and then binds', async () => {
    const { outcomes, restarts } = await run(SLOW_BOOT, 8, GRACE);
    expect(restarts).toEqual([]);
    expect(outcomes.slice(0, 5)).toEqual(Array(5).fill('booting'));
    expect(outcomes.slice(5)).toEqual(['ok', 'ok', 'ok']);
  });

  it('CONTROL: the same boot is killed when the grace is not there', async () => {
    const { outcomes, restarts } = await run(SLOW_BOOT, 8, 0);
    expect(restarts).toEqual([2 * TICK]);
    expect(outcomes.slice(0, 2)).toEqual(['wait', 'restart']);
  });

  it('names the elapsed boot seconds on every tick it waits', async () => {
    const { lines } = await run(['not-listening'], 3, GRACE);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('30s into boot');
    expect(lines[1]).toContain('60s into boot');
    expect(lines[2]).toContain('90s into boot');
  });

  it('restarts once the grace runs out, and says the first bind never arrived', async () => {
    const { outcomes, restarts, lines } = await run(['not-listening'], 10, GRACE);
    // Ticks at 30s..210s sit inside the grace; 240s is the first that counts.
    expect(outcomes.slice(0, 7)).toEqual(Array(7).fill('booting'));
    expect(outcomes.slice(7)).toEqual(['wait', 'restart', 'skipped']);
    expect(restarts).toEqual([GRACE + TICK]);
    expect(lines.at(-1)).toContain('never bound');
  });

  it('still catches a server that bound and then LOST its port, inside the window', async () => {
    // The outage this watchdog was built for. `answering` flips the
    // first-bind state, so the grace is spent while the clock still has most
    // of it left — the flag gates on the bind, not on elapsed time.
    const { outcomes, restarts } = await run(['answering', 'not-listening'], 4, GRACE);
    expect(outcomes).toEqual(['ok', 'wait', 'restart', 'skipped']);
    expect(restarts).toEqual([3 * TICK]);
    expect(restarts[0]).toBeLessThan(GRACE);
  });

  it('never delays a wedge: no-answer restarts at maxFails inside the grace', async () => {
    const { outcomes, restarts } = await run(['no-answer'], 3, GRACE);
    expect(outcomes).toEqual(['wait', 'restart', 'skipped']);
    expect(restarts).toEqual([2 * TICK]);
    expect(restarts[0]).toBeLessThan(GRACE);
  });

  it('applies the production grace when the caller names none', async () => {
    // What prod runs with. A default of 0 would restart at the second tick.
    const { outcomes, restarts } = await run(['not-listening'], 5);
    expect(restarts).toEqual([]);
    expect(outcomes).toEqual(Array(5).fill('booting'));
  });
});
