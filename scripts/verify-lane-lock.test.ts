/**
 * THE LANE ACTUALLY EXCLUDES, and says something useful while it does.
 *
 * The exclusion cases drive REAL concurrent processes rather than calling the
 * module twice inside one of them: a mutex that only excludes its own caller
 * excludes nothing, and an in-process test cannot tell the difference. Each
 * child appends `enter <id>` when it takes the lane and `exit <id>` when it
 * lets go, holding long enough that two unserialised runs would certainly
 * overlap. Only the holder ever writes, so the file's line ORDER is the order
 * things happened — no clock comparison, so nothing here goes flaky on a
 * loaded machine. Exclusion reads as a shape: enter/exit strictly alternate.
 *
 * The kill case is the one that matters most in practice. A run killed with
 * SIGKILL runs no handler, so anything that had to be cleaned up to free the
 * lane would wedge every gate run on the machine until a person noticed. The
 * lane is a listening socket precisely so the kernel frees it instead.
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { probeLockPort } from './probe-lock.ts';
import {
  HEAVY_MEMBERS,
  LANE_KEY,
  gitCommonDir,
  humanSecs,
  needsLane,
  readLaneNote,
  waitingLine,
} from './verify-lane-lock.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROBE_MODULE = resolve(HERE, 'probe-lock.ts');

let dir: string | undefined;
const strays: Array<{ kill(sig?: NodeJS.Signals): void }> = [];

afterEach(() => {
  for (const child of strays.splice(0)) {
    try {
      child.kill('SIGKILL');
    } catch {
      // Already gone.
    }
  }
  if (dir) rmSync(dir, { force: true, recursive: true });
  dir = undefined;
});

function scratch(): string {
  dir = mkdtempSync(join(tmpdir(), 'cw-verify-lane-test-'));
  return dir;
}

/**
 * A child that takes the lane under `scope`, records its window, and holds.
 *
 * It takes the probe lock directly rather than going through `enterLane`,
 * because `enterLane` ends by installing exit handlers and handing back a
 * `process.exit` — which is right for the command and unusable from a test
 * harness. What is under test here is the exclusion, and both paths take the
 * same lock with the same key and scope.
 */
function holder(scope: string, log: string, id: string, holdMs: number) {
  const src = `
    import { acquireProbeLock } from ${JSON.stringify(PROBE_MODULE)};
    import { appendFileSync } from 'node:fs';
    const lock = await acquireProbeLock(${JSON.stringify(LANE_KEY)}, ${JSON.stringify(scope)}, { timeoutMs: 30000 });
    appendFileSync(${JSON.stringify(log)}, 'enter ${id}\\n');
    process.on('SIGTERM', () => process.exit(0));
    await Bun.sleep(${holdMs});
    appendFileSync(${JSON.stringify(log)}, 'exit ${id}\\n');
    lock.release();
  `;
  const child = spawn('bun', ['-e', src], { stdio: ['ignore', 'ignore', 'inherit'] });
  strays.push(child);
  return child;
}

function git(args: string[], cwd: string): void {
  const out = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
  });
  if (out.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${out.stderr}`);
}

function lines(log: string): string[] {
  return existsSync(log)
    ? readFileSync(log, 'utf8')
        .split('\n')
        .filter((l) => l !== '')
    : [];
}

async function until(check: () => boolean, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition never held');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('the verify lane excludes', () => {
  it('makes the second of two concurrent runs wait for the first', async () => {
    const scope = scratch();
    const log = join(scope, 'window.log');

    const a = holder(scope, log, 'a', 1_500);
    // Let A get in first, so the assertion is about B waiting rather than
    // about which of two simultaneous starts happened to win.
    await until(() => lines(log).includes('enter a'));
    const b = holder(scope, log, 'b', 200);

    await until(() => lines(log).length === 4, 40_000);
    a.kill('SIGTERM');
    b.kill('SIGTERM');

    // Strict alternation IS the exclusion: nobody entered while somebody was
    // inside. Without the lock, B's enter lands between A's enter and exit.
    expect(lines(log)).toEqual(['enter a', 'exit a', 'enter b', 'exit b']);
  }, 60_000);

  it('frees the lane when a holder is SIGKILLed, with no cleanup of any kind', async () => {
    const scope = scratch();
    const log = join(scope, 'window.log');

    const a = holder(scope, log, 'a', 60_000);
    await until(() => lines(log).includes('enter a'));

    // SIGKILL: no handler runs, nothing is released, nothing is unlinked.
    a.kill('SIGKILL');

    holder(scope, log, 'b', 50);
    await until(() => lines(log).includes('exit b'), 30_000);
    expect(lines(log)).toEqual(['enter a', 'enter b', 'exit b']);
  }, 60_000);

  it('gives two different repos two different lanes', () => {
    const one = probeLockPort(LANE_KEY, '/tmp/repo-one/.git');
    const two = probeLockPort(LANE_KEY, '/tmp/repo-two/.git');
    expect(one).not.toBe(two);
  });

  it('gives one repo ONE lane however many worktrees ask for it', () => {
    // THE CASE THE WHOLE DESIGN TURNS ON, driven over a real git repo and a
    // real linked worktree rather than asserted about two string literals.
    // Every builder runs in its own worktree, so a lane scoped to the working
    // DIRECTORY would hand each of them a private lane and serialise nothing
    // — the exact failure this exists to stop, wearing a green light.
    const root = scratch();
    const main = join(root, 'repo');
    const side = join(root, 'side');
    git(['init', '-q', '-b', 'main', main], root);
    git(['config', 'user.email', 'test@example.com'], main);
    git(['config', 'user.name', 'Test'], main);
    writeFileSync(join(main, 'a.txt'), 'hello\n');
    git(['add', '-A'], main);
    git(['commit', '-qm', 'first'], main);
    git(['worktree', 'add', '-q', '-b', 'side', side], main);

    const fromMain = gitCommonDir(main);
    const fromSide = gitCommonDir(side);
    expect(fromMain).not.toBeNull();
    expect(fromSide).not.toBeNull();
    // Same shared git dir from both, so the same port from both.
    expect(realpathSync(fromSide as string)).toBe(realpathSync(fromMain as string));
    expect(probeLockPort(LANE_KEY, realpathSync(fromSide as string))).toBe(
      probeLockPort(LANE_KEY, realpathSync(fromMain as string)),
    );
    // And the control for that claim: scoping to the working directory, which
    // is what the naive version would have done, gives them two lanes.
    expect(probeLockPort(LANE_KEY, side)).not.toBe(probeLockPort(LANE_KEY, main));
  }, 30_000);

  it('answers null where there is no repo to scope a lane to', () => {
    // A tarball rather than a checkout. The command runs unserialised there
    // rather than refusing: no repo means no second worktree to collide with.
    expect(gitCommonDir(scratch())).toBeNull();
  });
});

describe('which runs take the lane', () => {
  it('takes it for a full run', () => {
    expect(needsLane(['parity', 'lint', 'typecheck', 'test:server', 'coverage'])).toBe(true);
  });

  it('takes it for a narrowed run that still asks for a suite', () => {
    expect(needsLane(['test:vitest'])).toBe(true);
    expect(needsLane(['check:meeting-smoke'])).toBe(true);
  });

  it('leaves cheap narrowed runs unserialised', () => {
    expect(needsLane(['lint', 'typecheck'])).toBe(false);
    expect(needsLane(['loc:audit'])).toBe(false);
    expect(needsLane([])).toBe(false);
  });

  it('names every heavy member that exists in the command', async () => {
    // A member renamed in verify.ts and not here would silently stop taking
    // the lane, which is the failure this whole file exists to prevent — and
    // it would look exactly like a pass.
    const { MEMBERS } = await import('./verify.ts');
    const ids = new Set(MEMBERS.map((m) => m.id));
    for (const heavy of HEAVY_MEMBERS) expect(ids.has(heavy)).toBe(true);
  });
});

describe('a waiting run says what it is waiting for', () => {
  it('names the holder and how long it has been running', () => {
    const note = { pid: 4242, startedAt: 1_000_000, cwd: '/w/rerun-harness' };
    const line = waitingLine(note, 1_000_000 + 185_000, 9001);
    expect(line).toContain('pid 4242');
    expect(line).toContain('/w/rerun-harness');
    expect(line).toContain('3m 5s');
  });

  it('still says something useful when the note is missing', () => {
    // The note is advisory. Losing it must cost detail, never the wait.
    const line = waitingLine(null, 1_000_000, 9001);
    expect(line).toContain('waiting for the verify lane');
    expect(line).toContain('9001');
  });

  it('reads a note a holder wrote', () => {
    const scope = scratch();
    const path = join(scope, 'note');
    writeFileSync(path, JSON.stringify({ pid: 7, startedAt: 123, cwd: '/x' }));
    expect(readLaneNote(path)).toEqual({ pid: 7, startedAt: 123, cwd: '/x' });
  });

  it('treats a truncated or absent note as no note rather than as a holder', () => {
    const scope = scratch();
    const path = join(scope, 'note');
    writeFileSync(path, '{"pid":7,"start');
    expect(readLaneNote(path)).toBeNull();
    expect(readLaneNote(join(scope, 'nothing-here'))).toBeNull();
  });

  it('renders a sub-minute wait without a minutes part', () => {
    expect(humanSecs(45_000)).toBe('45s');
    expect(humanSecs(65_000)).toBe('1m 5s');
  });
});
