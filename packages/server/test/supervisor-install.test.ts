/**
 * The supervisor installs dependencies before anything boots; a failed
 * install boots nothing, and a relaunch does not re-run it.
 *
 * The manual deploy fallback — `git pull` plus `launchctl kickstart`, for when
 * the server is down — restarts `scripts/serve.ts --no-watch` without ever
 * reaching the deploy verb, which until now was the only thing that ran
 * `bun install`. A pull that added a package would boot into a missing-import
 * crash.
 *
 * The supervisor is booted for real with a stand-in `bun` first on its PATH:
 * every child it spawns — the install, both client builds, the server — is
 * that stand-in, which records its argv and exits. So the order the log shows
 * is the order serve.ts ran them, and nothing heavier than one Bun process
 * starts. The gate's arithmetic is `dependency-install.test.ts`; this is the
 * wiring, end to end.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { installLedgerPath } from '../src/dependency-install.ts';
import { STAMP_PATTERN } from '../src/log-stamp.ts';
import { waitFor } from './wait-for.ts';

const repoRoot = join(import.meta.dir, '..', '..', '..');
const SERVE = join(repoRoot, 'scripts', 'serve.ts');

const scratch: string[] = [];
function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
}

type Supervisor = ReturnType<typeof Bun.spawn<'ignore', 'ignore', 'pipe'>>;
const running: Supervisor[] = [];

afterEach(() => {
  for (const p of running.splice(0)) p.kill('SIGKILL');
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * Stand-in for `bun`. Records the directory and argv of every call. An
 * install fails when `SHIM_INSTALL_FAILS` is set; everything else — the
 * builds, the server — exits 0 at once without doing anything.
 */
const SHIM = `#!/bin/sh
printf '%s|%s\\n' "$(pwd -P)" "$*" >> "$SHIM_LOG"
if [ "$1" = install ] && [ -n "$SHIM_INSTALL_FAILS" ]; then
  echo 'error: lockfile had changes, but lockfile is frozen' >&2
  exit 1
fi
exit 0
`;

/** One machine's worth of supervisor state: the stand-in, its call log, and
 *  the data dir, home and client root every boot on it shares. */
function machine(installFails: boolean) {
  const dir = tempDir('supervisor-install-');
  const shimDir = join(dir, 'bin');
  mkdirSync(shimDir);
  writeFileSync(join(shimDir, 'bun'), SHIM);
  chmodSync(join(shimDir, 'bun'), 0o755);
  mkdirSync(join(dir, 'home'));
  const log = join(dir, 'calls.log');
  return {
    dataDir: join(dir, 'data'),
    home: join(dir, 'home'),
    clientRoot: join(dir, 'client'),
    env: {
      ...process.env,
      PATH: `${shimDir}${delimiter}${process.env.PATH ?? ''}`,
      SHIM_LOG: log,
      ...(installFails ? { SHIM_INSTALL_FAILS: '1' } : {}),
      // Everything the supervisor writes lands in this test's directory: the
      // discovery file under HOME, the corpus, and the client releases.
      HOME: join(dir, 'home'),
      CW_DATA_DIR: join(dir, 'data'),
      CW_CLIENT_ROOT: join(dir, 'client'),
      CW_PLUGIN_REFRESH_MINUTES: '0',
    },
    calls: (): { cwd: string; argv: string }[] =>
      existsSync(log)
        ? readFileSync(log, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((line) => {
              const bar = line.indexOf('|');
              return { cwd: line.slice(0, bar), argv: line.slice(bar + 1) };
            })
        : [],
  };
}

/** Boot `scripts/serve.ts --no-watch` on `m`, reading its stderr as it comes. */
function boot(m: ReturnType<typeof machine>, serve = SERVE) {
  const proc = Bun.spawn([process.execPath, serve, '--no-watch', '--port', '0'], {
    env: m.env,
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'pipe',
  });
  running.push(proc);
  let err = '';
  void (async () => {
    const reader = proc.stderr.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      err += decoder.decode(value, { stream: true });
    }
  })();
  const line = (needle: string) =>
    waitFor(() => err.split('\n').find((l) => l.includes(needle)), {
      timeout: 20_000,
      describe: `a supervisor line containing "${needle}"`,
    }).catch((e: Error) => {
      throw new Error(`${e.message}; stderr: ${err.slice(-1000)}`);
    });
  return { proc, line };
}

describe('scripts/serve.ts --no-watch', () => {
  it('installs in the deploy source before either build or the server starts', async () => {
    const m = machine(false);
    boot(m);

    await waitFor(() => m.calls().some((c) => c.argv.includes('bin.ts')), {
      timeout: 20_000,
      describe: 'the supervisor to spawn its server',
    });

    const calls = m.calls();
    const at = (match: (argv: string) => boolean) => calls.findIndex((c) => match(c.argv));
    const install = at((a) => a === 'install --frozen-lockfile');
    const firstBuild = at((a) => a.includes('build.ts'));
    const server = at((a) => a.includes('bin.ts'));

    expect(install).toBe(0);
    expect(firstBuild).toBeGreaterThan(install);
    expect(server).toBeGreaterThan(firstBuild);
    // In the checkout the supervisor serves from, which is what a pull moved.
    expect(calls[install]?.cwd).toBe(realpathSync(repoRoot));
    // Exactly once: the no-op case is the common one, on every restart.
    expect(calls.filter((c) => c.argv.startsWith('install')).length).toBe(1);
  }, 30_000);

  it('boots nothing over a failed install, and a relaunch does not re-run it', async () => {
    const m = machine(true);

    const first = boot(m);
    const refusal = await first.line('bun install --frozen-lockfile FAILED');
    // Dated like every supervisor diagnostic, and carrying bun's own reason.
    expect(refusal).toMatch(STAMP_PATTERN);
    expect(refusal).toContain('lockfile had changes, but lockfile is frozen');
    expect(existsSync(installLedgerPath(m.dataDir))).toBe(true);
    // Still running — holding on its backoff, not exiting into a relaunch.
    expect(first.proc.exitCode).toBeNull();

    // What launchd or a second `kickstart -k` does next: a fresh supervisor
    // over the same checkout and the same data dir.
    first.proc.kill('SIGKILL');
    await first.proc.exited;
    const second = boot(m);
    const holding = await second.line('not re-running bun install yet');
    expect(holding).toMatch(STAMP_PATTERN);
    expect(holding).toContain('failed 1 time(s) against this exact bun.lock');

    // One install across both boots, and nothing after it: no build, no
    // server, no advertised port, no published client.
    expect(m.calls().map((c) => c.argv)).toEqual(['install --frozen-lockfile']);
    expect(existsSync(join(m.home, '.claude', 'claude-workspaces', 'server.json'))).toBe(false);
    expect(existsSync(m.clientRoot)).toBe(false);
  }, 30_000);

  it('reaches the install from a checkout whose node_modules holds nothing', async () => {
    // The crash this prevents is an import of a package a pull added and
    // nobody installed. If the supervisor itself imported through
    // node_modules before installing, a new package anywhere in that graph
    // would be the same crash one step earlier, with no install ever run. So
    // boot a copy of the code whose node_modules is empty: it must still get
    // as far as the install.
    const copy = tempDir('supervisor-bare-');
    for (const rel of ['scripts', 'packages/core/src', 'packages/server/src', 'package.json']) {
      cpSync(join(repoRoot, rel), join(copy, rel), { recursive: true });
    }
    // Empty rather than absent: with none at all, Bun would auto-install.
    mkdirSync(join(copy, 'node_modules'));
    const m = machine(true);

    const refusal = await boot(m, join(copy, 'scripts', 'serve.ts')).line(
      'bun install --frozen-lockfile FAILED',
    );
    expect(refusal).toContain('lockfile had changes, but lockfile is frozen');
    expect(m.calls()).toEqual([{ cwd: copy, argv: 'install --frozen-lockfile' }]);
  }, 30_000);
});
