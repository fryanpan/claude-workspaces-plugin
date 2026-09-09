/**
 * The lock is only worth having if it actually excludes, so this drives real
 * concurrent processes rather than calling the module twice in one of them.
 *
 * Each child appends `enter <id>` when it takes the lock and `exit <id>` when
 * it lets go, with a hold long enough that an unlocked run would certainly
 * overlap. Only the holder ever writes, so the file's line order IS the order
 * events happened — no clock comparison, and nothing to go flaky on a loaded
 * machine. Exclusion then reads as a shape: enter/exit strictly alternate, and
 * every exit names the id of the enter above it. Delete the acquire and the
 * lines interleave.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { acquireProbeLock, probeLockPath } from './probe-lock.ts';

const MODULE = resolve(dirname(fileURLToPath(import.meta.url)), 'probe-lock.ts');

let dir: string | undefined;
let scope: string | undefined;

afterEach(() => {
  if (scope) rmSync(probeLockPath('contend', scope), { force: true });
  if (dir) rmSync(dir, { force: true, recursive: true });
  dir = undefined;
  scope = undefined;
});

/** A child that takes the lock, records the window it held, and lets go. */
const CHILD = `
import { appendFileSync } from 'node:fs';
import { acquireProbeLock } from ${JSON.stringify(MODULE)};

const [scope, log, id] = process.argv.slice(2);
const lock = await acquireProbeLock('contend', scope);
appendFileSync(log, 'enter ' + id + '\\n');
await new Promise((r) => setTimeout(r, 150));
appendFileSync(log, 'exit ' + id + '\\n');
lock.release();
`;

function runChild(script: string, args: string[]): Promise<number | null> {
  return new Promise((done) => {
    const child = spawn('bun', [script, ...args], { stdio: 'inherit' });
    child.on('close', (code) => done(code));
  });
}

describe('the probe lock excludes concurrent runs', () => {
  it('never lets two processes hold it at once', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cw-probe-lock-test-'));
    scope = dir;
    const script = join(dir, 'child.ts');
    const log = join(dir, 'events.log');
    writeFileSync(script, CHILD);
    writeFileSync(log, '');

    const ids = ['a', 'b', 'c', 'd'];
    const codes = await Promise.all(ids.map((id) => runChild(script, [dir as string, log, id])));
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

  it('reclaims a lock whose holder died rather than wedging the suite', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cw-probe-lock-test-'));
    scope = dir;
    const path = probeLockPath('contend', dir);
    writeFileSync(path, 'a run that never released');
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(path, old, old);

    // A short deadline: if the stale file were honoured this would throw.
    const lock = await acquireProbeLock('contend', dir, { timeoutMs: 2_000 });
    expect(readFileSync(path, 'utf8')).toContain(`${process.pid}:`);
    lock.release();
    expect(existsSync(path)).toBe(false);
  });

  it('refuses to release a lock another run has since taken', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cw-probe-lock-test-'));
    scope = dir;
    const lock = await acquireProbeLock('contend', dir, { timeoutMs: 2_000 });

    // Stand in for a stale-reclaim that handed the lock on while we held it.
    writeFileSync(lock.path, 'somebody else');
    lock.release();

    expect(existsSync(lock.path)).toBe(true);
    expect(readFileSync(lock.path, 'utf8')).toBe('somebody else');
  });
});
