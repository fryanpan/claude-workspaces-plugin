/**
 * The supervisor installs dependencies before anything boots, and a failed
 * install boots nothing.
 *
 * The manual deploy fallback — `git pull` plus `launchctl kickstart`, for when
 * the server is down — restarts `scripts/serve.ts --no-watch` without ever
 * reaching the deploy verb, which until now was the only thing that ran
 * `bun install`. A pull that added a package would boot into a missing-import
 * crash.
 *
 * Two layers. The runner is driven for real against a throwaway project whose
 * one dependency is a local `file:` package and whose registry is a dead
 * address, so it proves bun's own behaviour without touching the network. The
 * supervisor is then booted for real with a stand-in `bun` first on its PATH:
 * every child it spawns — the install, both client builds, the server — is
 * that stand-in, which records its argv and exits. So the order the log shows
 * is the order serve.ts ran them, and nothing heavier than one Bun process
 * starts.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import {
  chmodSync,
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
import { installBeforeBoot, spawnBunInstall } from '../src/dependency-install.ts';
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
let supervisor: Supervisor | null = null;

afterEach(() => {
  supervisor?.kill('SIGKILL');
  supervisor = null;
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('installBeforeBoot', () => {
  it('lets the server boot when the install succeeds, and says nothing', () => {
    const lines: string[] = [];
    expect(
      installBeforeBoot(
        () => ({ ok: true }),
        (l) => lines.push(l),
      ),
    ).toBe(true);
    expect(lines).toEqual([]);
  });

  it('refuses the boot on a failed install and names what bun said', () => {
    const lines: string[] = [];
    const ok = installBeforeBoot(
      () => ({ ok: false, detail: 'error: lockfile had changes, but lockfile is frozen' }),
      (l) => lines.push(l),
    );
    expect(ok).toBe(false);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('bun install --frozen-lockfile FAILED');
    expect(lines[0]).toContain('refusing to boot');
    expect(lines[0]).toContain('error: lockfile had changes, but lockfile is frozen');
  });
});

/**
 * A project bun can install with no network: one `file:` dependency, and a
 * bunfig pointing the registry at a port nothing listens on, so an attempt
 * to reach it would fail rather than quietly succeed.
 */
function offlineProject(): string {
  const dir = tempDir('dep-install-');
  for (const name of ['alpha-pkg', 'beta-pkg']) {
    mkdirSync(join(dir, name));
    writeFileSync(join(dir, name, 'package.json'), JSON.stringify({ name, version: '1.0.0' }));
  }
  writeFileSync(
    join(dir, 'bunfig.toml'),
    `[install]\nregistry = "http://127.0.0.1:9/"\n[install.cache]\ndir = "${join(dir, '.cache')}"\n`,
  );
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name: 'app',
      private: true,
      dependencies: { 'alpha-pkg': 'file:./alpha-pkg' },
    }),
  );
  // Write the lockfile the way a merge would carry it, then drop what it
  // installed: node_modules is now behind bun.lock.
  const locked = Bun.spawnSync(['bun', 'install'], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
  if (locked.exitCode !== 0) throw new Error(`fixture install failed: ${locked.stderr.toString()}`);
  rmSync(join(dir, 'node_modules'), { recursive: true, force: true });
  return dir;
}

describe('spawnBunInstall', () => {
  it('brings node_modules up to bun.lock', () => {
    const dir = offlineProject();
    expect(existsSync(join(dir, 'node_modules', 'alpha-pkg', 'package.json'))).toBe(false);

    expect(spawnBunInstall(dir)()).toEqual({ ok: true });
    expect(existsSync(join(dir, 'node_modules', 'alpha-pkg', 'package.json'))).toBe(true);
  });

  it('refuses a bun.lock that no longer matches package.json, and leaves it alone', () => {
    const dir = offlineProject();
    const lockBefore = readFileSync(join(dir, 'bun.lock'), 'utf8');
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'app',
        private: true,
        dependencies: { 'alpha-pkg': 'file:./alpha-pkg', 'beta-pkg': 'file:./beta-pkg' },
      }),
    );

    const result = spawnBunInstall(dir)();
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('lockfile is frozen');
    expect(readFileSync(join(dir, 'bun.lock'), 'utf8')).toBe(lockBefore);
  });
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

interface Booted {
  proc: Supervisor;
  calls: () => { cwd: string; argv: string }[];
  stderr: () => string;
  /** Resolves once the supervisor's stderr has been read to its end. */
  stderrClosed: Promise<void>;
  home: string;
  clientRoot: string;
}

function bootSupervisor(opts: { installFails: boolean }): Booted {
  const dir = tempDir('supervisor-install-');
  const shimDir = join(dir, 'bin');
  mkdirSync(shimDir);
  writeFileSync(join(shimDir, 'bun'), SHIM);
  chmodSync(join(shimDir, 'bun'), 0o755);
  const log = join(dir, 'calls.log');
  const home = join(dir, 'home');
  const clientRoot = join(dir, 'client');
  mkdirSync(home);

  const proc = Bun.spawn([process.execPath, SERVE, '--no-watch', '--port', '0'], {
    env: {
      ...process.env,
      PATH: `${shimDir}${delimiter}${process.env.PATH ?? ''}`,
      SHIM_LOG: log,
      ...(opts.installFails ? { SHIM_INSTALL_FAILS: '1' } : {}),
      // Everything the supervisor writes lands in this test's directory: the
      // discovery file under HOME, the corpus, and the client releases.
      HOME: home,
      CW_DATA_DIR: join(dir, 'data'),
      CW_CLIENT_ROOT: clientRoot,
      CW_PLUGIN_REFRESH_MINUTES: '0',
    },
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'pipe',
  });
  supervisor = proc;
  let err = '';
  const stderrClosed = (async () => {
    const reader = proc.stderr.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      err += decoder.decode(value, { stream: true });
    }
  })();
  return {
    proc,
    home,
    clientRoot,
    stderrClosed,
    stderr: () => err,
    calls: () =>
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

describe('scripts/serve.ts --no-watch', () => {
  it('installs in the deploy source before either build or the server starts', async () => {
    const s = bootSupervisor({ installFails: false });

    await waitFor(() => s.calls().some((c) => c.argv.includes('bin.ts')), {
      timeout: 20_000,
      describe: 'the supervisor to spawn its server',
    }).catch((e: Error) => {
      throw new Error(`${e.message}; stderr: ${s.stderr().slice(-1000)}`);
    });

    const calls = s.calls();
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

  it('boots nothing when the install fails, exits non-zero, and says why in its log', async () => {
    const s = bootSupervisor({ installFails: true });

    const code = await s.proc.exited;
    await s.stderrClosed;
    expect(code).toBe(1);

    // The install ran and nothing after it did.
    expect(s.calls().map((c) => c.argv)).toEqual(['install --frozen-lockfile']);

    const refusal = s
      .stderr()
      .split('\n')
      .find((l) => l.includes('bun install --frozen-lockfile FAILED'));
    expect(refusal).toBeDefined();
    // Dated like every supervisor diagnostic, and carrying bun's own reason.
    expect(refusal).toMatch(STAMP_PATTERN);
    expect(refusal).toContain('lockfile had changes, but lockfile is frozen');

    // No server was advertised and no client was published over it.
    expect(existsSync(join(s.home, '.claude', 'claude-workspaces', 'server.json'))).toBe(false);
    expect(existsSync(s.clientRoot)).toBe(false);
  }, 30_000);
});
