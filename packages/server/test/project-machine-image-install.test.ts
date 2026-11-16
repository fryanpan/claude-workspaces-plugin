/**
 * The project machine's image installs from bun.lock as committed. The build
 * stage copies a chosen set of paths and then runs `bun install
 * --frozen-lockfile`; a root workspace glob whose folder is not copied makes
 * bun see a different workspace set from the lockfile's, and it refuses the
 * build. That is how CI's first Fly deploy of MOI failed on 14 Nov, after
 * `templates/*` became a workspace and the Dockerfile never copied it.
 *
 * This lays out exactly what the Dockerfile's build-stage COPY lines name and
 * runs the same install in dry-run mode, which reads the lockfile and the
 * workspace manifests without fetching anything.
 */
import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const REPO = join(import.meta.dir, '../../..');

/** The build stage's `COPY <src...> <dest>` lines, sources relative to the repo. */
function buildStageCopies(dockerfile: string): string[] {
  const sources: string[] = [];
  let inBuild = false;
  for (const line of dockerfile.split('\n')) {
    if (/^FROM\b/.test(line)) inBuild = /\bAS build\b/.test(line);
    if (!inBuild) continue;
    const m = /^COPY\s+(?!--)(.+)$/.exec(line.trim());
    if (!m?.[1]) continue;
    const parts = m[1].split(/\s+/);
    sources.push(...parts.slice(0, -1));
  }
  return sources;
}

function layOut(sources: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'cw-image-install-'));
  for (const src of sources) {
    const from = join(REPO, src);
    const to = join(dir, src);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to, {
      recursive: statSync(from).isDirectory(),
      filter: (p) => !/[\\/](node_modules|dist|\.coverage)([\\/]|$)/.test(p),
    });
  }
  return dir;
}

function frozenInstall(dir: string): { status: number | null; out: string } {
  const r = spawnSync(process.execPath, ['install', '--frozen-lockfile', '--dry-run'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, BUN_INSTALL_CACHE_DIR: join(dir, '.bun-cache') },
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe('project machine image', () => {
  const sources = buildStageCopies(
    readFileSync(join(REPO, 'infra/project-machine/Dockerfile'), 'utf8'),
  );

  it('copies what a frozen install of bun.lock needs', () => {
    const dir = layOut(sources);
    try {
      const r = frozenInstall(dir);
      if (r.status !== 0) throw new Error(r.out);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('fails the same install when a workspace folder is left out (positive control)', () => {
    const dir = layOut(sources.filter((s) => s !== 'templates'));
    try {
      const r = frozenInstall(dir);
      expect(r.status).not.toBe(0);
      expect(r.out).toMatch(/lockfile had changes, but lockfile is frozen/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
