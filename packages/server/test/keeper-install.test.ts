/**
 * scripts/keeper-install.sh builds the keeper's release with `git archive`,
 * which carries no node_modules. With none, bun auto-installs imports from its
 * global cache, and `@noble/hashes` cannot resolve its own `@noble/hashes/crypto`
 * from there: the keeper's check died with ENOENT on the Mac at 444a6c8c4.
 *
 * This sources the script's own functions and runs them on a throwaway tree:
 * a release built from this repository's HEAD, a fresh HOME and an empty bun
 * cache, then the same `keeper check` step 5 runs. Only `as_relay` is
 * replaced, so nothing runs as another user. The install needs the npm
 * registry. Skipped where zsh is absent (CI's Linux runners): the keeper is
 * macOS-only.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ZSH = '/bin/zsh';
const SCRIPT = join(import.meta.dir, '../../../scripts/keeper-install.sh');
const REPO = join(import.meta.dir, '../../..');
const tmp = mkdtempSync(join(tmpdir(), 'keeper-install-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const head = spawnSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
const SHA = head.stdout.trim();

/** A keeper root laid out as step 1 makes it, with bun and the clone linked in. */
function keeperRoot(name: string): string {
  const k = join(tmp, name);
  for (const d of ['bin', 'releases', 'run', 'state'])
    mkdirSync(join(k, d), { recursive: true, mode: 0o700 });
  symlinkSync(process.execPath, join(k, 'bin', 'bun'));
  symlinkSync(REPO, join(k, 'src'));
  return k;
}

/** Source the script's functions, point K at a throwaway root, then run `body`. */
function zsh(k: string, body: string) {
  const home = join(tmp, `${k.split('/').at(-1)}-home`);
  mkdirSync(home, { recursive: true });
  const r = spawnSync(
    ZSH,
    [
      '-f',
      '-c',
      `KEEPER_INSTALL_SOURCE_ONLY=1 source "$1"; K=$2; SHA=$3; as_relay() { "$@"; }; ${body}`,
      'zsh',
      SCRIPT,
      k,
      SHA,
    ],
    {
      encoding: 'utf8',
      env: {
        PATH: '/usr/bin:/bin',
        HOME: home,
        BUN_INSTALL: join(home, '.bun'),
        BUN_INSTALL_CACHE_DIR: join(home, 'bun-cache'),
      },
      timeout: 170_000,
    },
  );
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe.skipIf(!existsSync(ZSH) || !SHA)('keeper-install.sh release', () => {
  it('builds a release whose keeper check resolves every import, with no node_modules to start from', () => {
    const k = keeperRoot('fresh');
    const r = zsh(
      k,
      'build_release "$SHA" || { print -r -- "build failed"; exit 9 }; ln -sfn "$K/releases/$SHA" "$K/app"; keeper check',
    );
    expect(r.out).not.toContain('ENOENT while resolving');
    expect(r.out).not.toContain('build failed');
    // The guard refuses before printing store: ok on a machine whose bun sits
    // where others can write; reaching it still proves every import resolved.
    const last = r.out.trim().split('\n').at(-1) ?? '';
    if (!r.out.includes('unsafe:')) expect(last).toMatch(/^store: ok/);
  }, 180_000);

  // The Mac already holds a release of 444a6c8c4 marked complete with no
  // node_modules. A rerun must rebuild that one, and skip a ready one.
  it('rebuilds a release made before dependencies were installed, and a rerun skips the ready one', () => {
    const k = keeperRoot('rerun');
    const old = join(k, 'releases', SHA);
    mkdirSync(old);
    writeFileSync(join(old, '.keeper-release-complete'), '');
    const step4 =
      'if release_ready "$SHA"; then print -r -- "already ready"; else build_release "$SHA" || exit 9; fi';
    const first = zsh(k, step4);
    expect(first.status).toBe(0);
    expect(first.out).toContain('moved an unfinished release aside');
    expect(existsSync(join(old, 'packages/server/node_modules/@noble/hashes'))).toBe(true);
    const asides = readdirSync(join(k, 'releases')).filter((n) => n.startsWith('.unfinished-'));
    expect(asides).toHaveLength(1);
    const second = zsh(k, step4);
    expect(second.status).toBe(0);
    expect(second.out.trim()).toBe('already ready');
  }, 180_000);
});
