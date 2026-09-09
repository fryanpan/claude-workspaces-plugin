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
 * The other three tests are about how the lock is let go, which is the half a
 * lock file got wrong: a holder that is killed outright has to free it as
 * completely as one that returns, or the suite needs the stale-reclaim logic
 * that could not be made race-free.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { acquireProbeLock, probeLockPort } from './probe-lock.ts';

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

  it('hands the same port to the same key and checkout, and a different one otherwise', async () => {
    const work = scratch();
    expect(probeLockPort('contend', work)).toBe(probeLockPort('contend', work));
    // Two keys, or two checkouts, must not queue behind each other. Held at the
    // same time rather than merely compared, so the ports are proved distinct
    // by the kernel and not only by the hash.
    const a = await acquireProbeLock('one', work, { timeoutMs: 2_000 });
    const b = await acquireProbeLock('two', work, { timeoutMs: 2_000 });
    const c = await acquireProbeLock('one', `${work}-elsewhere`, { timeoutMs: 2_000 });
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

  it('keeps the lock while that holder is still alive', async () => {
    const work = scratch();
    const script = join(work, 'squatter.ts');
    const ready = join(work, 'ready');
    writeFileSync(script, SQUATTER);

    await startSquatter(script, work, ready);

    // The control for the test above. Without it, "the killed holder let me in"
    // could just as well mean the lock never excluded anybody.
    await expect(acquireProbeLock('squat', work, { timeoutMs: 1_000 })).rejects.toThrow(
      /still held after 1000ms/,
    );
  }, 30_000);
});
