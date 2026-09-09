/**
 * The lock is only worth having if it actually excludes, so this drives real
 * concurrent processes rather than calling the module twice in one of them.
 *
 * Each child appends `enter <id>` when it takes the lock and `exit <id>` when
 * it lets go, with a hold long enough that an unlocked run would certainly
 * overlap. Only the holder ever writes, so the file's line order IS the order
 * events happened - no clock comparison, and nothing to go flaky on a loaded
 * machine. Exclusion then reads as a shape: enter/exit strictly alternate, and
 * every exit names the id of the enter above it. Point the bind at a random
 * port instead of the shared one and the lines interleave.
 *
 * The rest is about how the lock is let go, which is the half that keeps
 * getting it wrong: a holder that is killed outright has to free it as
 * completely as one that returns, a holder must not still be inside its own
 * cleanup when the next run is let in, and waiting on a lock your own process
 * holds has to fail as a deadlock rather than as a five-minute timeout.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { acquireProbeLock, exclusiveWindow, probeLockPort } from './probe-lock.ts';

const MODULE = resolve(dirname(fileURLToPath(import.meta.url)), 'probe-lock.ts');

/** Everything a test allocates, torn down whether it passed or threw. */
let dir: string | undefined;
const strays: Array<{ kill(): void }> = [];

afterEach(() => {
  for (const child of strays.splice(0)) child.kill();
  if (dir) rmSync(dir, { force: true, recursive: true });
  dir = undefined;
});

function scratch(): string {
  dir = mkdtempSync(join(tmpdir(), 'cw-probe-lock-test-'));
  return dir;
}

/**
 * `count` scopes that provably hash to different ports.
 *
 * Picked rather than assumed: twenty thousand ports make a collision between
 * three arbitrary scopes unlikely, and a test that is unlikely to fail is still
 * a test that fails. What the caller wants is distinct ports, so it asks for
 * distinct ports instead of hoping.
 */
function distinctScopes(key: string, base: string, count: number): string[] {
  const chosen: string[] = [];
  const ports = new Set<number>();
  // Bounded, so a hash that ignored the scope would fail here rather than spin
  // forever and take the whole suite's timeout with it.
  for (let i = 0; chosen.length < count; i += 1) {
    if (i > count * 20) throw new Error(`no ${count} distinct ports for ${key} under ${base}`);
    const scope = `${base}-${i}`;
    const port = probeLockPort(key, scope);
    if (ports.has(port)) continue;
    ports.add(port);
    chosen.push(scope);
  }
  return chosen;
}

/** A child that takes the lock, records the window it held, and lets go. */
const TURN_TAKER = `
import { appendFileSync } from 'node:fs';
import { acquireProbeLock } from ${JSON.stringify(MODULE)};

const [scope, log, id] = process.argv.slice(2);
const lock = await acquireProbeLock('contend', scope);
appendFileSync(log, 'enter ' + id + '\\n');
await new Promise((r) => setTimeout(r, 150));
appendFileSync(log, 'exit ' + id + '\\n');
lock.release();
`;

/** A child that takes the lock, says so, and then never lets go on its own. */
const SQUATTER = `
import { writeFileSync } from 'node:fs';
import { acquireProbeLock } from ${JSON.stringify(MODULE)};

const [scope, ready] = process.argv.slice(2);
const lock = await acquireProbeLock('squat', scope);
writeFileSync(ready, String(lock.port));
// Held until somebody kills us. The lock must go when the process does.
await new Promise(() => {});
`;

function runChild(script: string, args: string[]): Promise<number | null> {
  return new Promise((done) => {
    const child = spawn('bun', [script, ...args], { stdio: 'inherit' });
    child.on('close', (code) => done(code));
  });
}

/** Starts a child and waits for it to report that it holds the lock. */
async function startSquatter(script: string, scope: string, ready: string) {
  const child = spawn('bun', [script, scope, ready], { stdio: 'inherit' });
  strays.push(child);
  for (let i = 0; i < 200 && !existsSync(ready); i += 1) {
    await new Promise((r) => setTimeout(r, 50));
  }
  if (!existsSync(ready)) throw new Error('the squatter never took the lock');
  return child;
}

describe('the probe lock excludes concurrent runs', () => {
  it('never lets two processes hold it at once', async () => {
    const work = scratch();
    const script = join(work, 'child.ts');
    const log = join(work, 'events.log');
    writeFileSync(script, TURN_TAKER);
    writeFileSync(log, '');

    const ids = ['a', 'b', 'c', 'd'];
    const codes = await Promise.all(ids.map((id) => runChild(script, [work, log, id])));
    expect(codes).toEqual([0, 0, 0, 0]);

    const lines = readFileSync(log, 'utf8').trim().split('\n');
    // Every child got a turn, so this is not vacuously ordered.
    expect(lines).toHaveLength(ids.length * 2);
    expect(lines.filter((l) => l.startsWith('enter')).length).toBe(ids.length);

    // The shape exclusion produces, and the shape it does not.
    let held: string | null = null;
    for (const line of lines) {
      const [event, id] = line.split(' ');
      if (event === 'enter') {
        expect(held, `two holders at once: ${held} and ${id}\n${lines.join('\n')}`).toBe(null);
        held = id ?? null;
      } else {
        expect(held, `exit without a matching enter\n${lines.join('\n')}`).toBe(id);
        held = null;
      }
    }
    expect(held).toBe(null);
  }, 60_000);

  it('hands the same port to the same key and checkout, and spreads every other', () => {
    const work = scratch();
    expect(probeLockPort('contend', work)).toBe(probeLockPort('contend', work));
    expect(probeLockPort('contend', work)).not.toBe(probeLockPort('other', work));

    // Both halves of the identity have to reach the port. Twenty checkouts over
    // twenty thousand ports land almost everywhere; a hash that dropped the
    // scope would put all twenty on one. The bar is loose enough that an
    // ordinary collision or two cannot fail it, and far below what ignoring the
    // scope would produce.
    const spread = new Set(
      Array.from({ length: 20 }, (_, i) => probeLockPort('contend', `${work}/w${i}`)),
    );
    expect(spread.size).toBeGreaterThan(15);
  });

  it('holds locks on different ports independently', async () => {
    const work = scratch();
    // Scopes chosen for distinct ports rather than assumed to have them, so
    // this proves independence and never doubles as a hash-collision lottery.
    const [one, two, three] = distinctScopes('sep', work, 3) as [string, string, string];
    const a = await acquireProbeLock('sep', one, { timeoutMs: 2_000 });
    const b = await acquireProbeLock('sep', two, { timeoutMs: 2_000 });
    const c = await acquireProbeLock('sep', three, { timeoutMs: 2_000 });
    expect(new Set([a.port, b.port, c.port]).size).toBe(3);
    a.release();
    b.release();
    c.release();
  });

  it('frees the port when the holder releases', async () => {
    const work = scratch();
    const first = await acquireProbeLock('release', work, { timeoutMs: 2_000 });
    first.release();
    // A short deadline: if release did not free it, this throws rather than
    // quietly waiting out the default five minutes.
    const second = await acquireProbeLock('release', work, { timeoutMs: 2_000 });
    expect(second.port).toBe(first.port);
    second.release();
  });

  it('fails fast instead of waiting on a lock this process already holds', async () => {
    const work = scratch();
    const held = await acquireProbeLock('self', work, { timeoutMs: 2_000 });
    // Waiting could never succeed, so it must not look like contention. Without
    // this the same-process case reads as a five-minute stall with no cause.
    await expect(acquireProbeLock('self', work)).rejects.toThrow(/already held by this process/);
    held.release();
    // And the guard lifts with the lock, rather than poisoning the key.
    const again = await acquireProbeLock('self', work, { timeoutMs: 2_000 });
    again.release();
  });
});

describe('a holder that dies frees the lock', () => {
  it('lets the next run in as soon as the holder is killed', async () => {
    const work = scratch();
    const script = join(work, 'squatter.ts');
    const ready = join(work, 'ready');
    writeFileSync(script, SQUATTER);

    const child = await startSquatter(script, work, ready);
    expect(Number(readFileSync(ready, 'utf8'))).toBe(probeLockPort('squat', work));

    // No cleanup, no release, no chance to run an exit handler.
    child.kill('SIGKILL');

    // Well inside any staleness timeout a lock file would have needed, because
    // there is no staleness timeout: the kernel drops the bind with the process.
    const lock = await acquireProbeLock('squat', work, { timeoutMs: 5_000 });
    expect(lock.port).toBe(probeLockPort('squat', work));
    lock.release();
  }, 30_000);

  it('keeps the lock while that holder is still alive, and says who has it', async () => {
    const work = scratch();
    const script = join(work, 'squatter.ts');
    const ready = join(work, 'ready');
    writeFileSync(script, SQUATTER);

    await startSquatter(script, work, ready);

    // The control for the test above. Without it, "the killed holder let me in"
    // could just as well mean the lock never excluded anybody. The holder's own
    // name in the message is the difference between a diagnosable stall and
    // "something is listening on a port".
    await expect(acquireProbeLock('squat', work, { timeoutMs: 1_000 })).rejects.toThrow(
      /still held after 1000ms by the lock squat/,
    );
  }, 30_000);
});

describe('the guarded window closes before the lock does', () => {
  it('is still held while the closing step runs, and free once it returns', async () => {
    const work = scratch();
    let lockedDuringLeave: boolean | undefined;

    const guarded = exclusiveWindow(
      'order',
      work,
      {
        leave: async () => {
          // Taking it from inside the closing step must fail. A suite that
          // released first would let a competing process in here, while this
          // one is still deleting its probes.
          lockedDuringLeave = await acquireProbeLock('order', work, { timeoutMs: 200 }).then(
            (lock) => {
              lock.release();
              return false;
            },
            () => true,
          );
        },
      },
      { timeoutMs: 2_000 },
    );

    await guarded.open();
    await guarded.close();

    expect(lockedDuringLeave).toBe(true);
    // The positive control: it really does come free afterwards, so the
    // assertion above means "held during", not "never obtainable".
    const after = await acquireProbeLock('order', work, { timeoutMs: 2_000 });
    after.release();
  });

  it('releases even when the closing step throws', async () => {
    const work = scratch();
    const guarded = exclusiveWindow(
      'throwing',
      work,
      {
        leave: () => {
          throw new Error('cleanup blew up');
        },
      },
      { timeoutMs: 2_000 },
    );

    await guarded.open();
    await expect(guarded.close()).rejects.toThrow('cleanup blew up');

    // A cleanup that throws must not wedge every later run behind it.
    const after = await acquireProbeLock('throwing', work, { timeoutMs: 2_000 });
    after.release();
  });
});
