/**
 * Mounts over a walled lead's project. The lead can write inside its roots,
 * so a mounted folder there may be swapped for a link between the check and
 * the serve, and the conventions index may be a FIFO or a link. A covered
 * folder is refused as a mount and serves nothing; the conventions read never
 * blocks and never follows a link out.
 *
 * Fixtures are synthetic. The FIFO case runs in a bun child with a hard
 * timeout, so a regression to a blocking read fails instead of hanging.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { PathGuards } from '../src/bound-path-guard.ts';
import { MountStore } from '../src/mount-store.ts';
import { RepoRegistry } from '../src/repo-registry.ts';
import { makeFifo } from './fifo.ts';

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, {
    cwd,
    env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))),
  });
}

let tmp: string;
let repo: string;
let dataDir: string;
let repos: RepoRegistry;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'cw-mount-walled-')));
  dataDir = join(tmp, 'data');
  mkdirSync(dataDir);
  repos = new RepoRegistry(dataDir);
  repo = join(tmp, 'harborlight');
  mkdirSync(join(repo, 'docs', 'mocks'), { recursive: true });
  git(repo, 'init', '-b', 'main');
  git(repo, 'remote', 'add', 'origin', 'git@github.example:example/harborlight.git');
  writeFileSync(join(repo, 'docs', 'mocks', 'home.png'), 'bytes');
  mkdirSync(join(tmp, 'riverbend'));
  writeFileSync(join(tmp, 'riverbend', 'notes.md'), 'outside the project\n');
});

afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function guardsCovering(root: string): PathGuards {
  const guards = new PathGuards();
  guards.add({
    covers: (p) => p === root || p.startsWith(`${root}${sep}`),
    admits: () => true,
    landsInside: (_p, real) => real === root || real.startsWith(`${root}${sep}`),
  });
  return guards;
}

describe('a mount inside a walled lead’s root', () => {
  it('is refused, and a mount made before the wall serves nothing', () => {
    const open = new MountStore(dataDir, repos);
    const made = open.mount(join(repo, 'docs', 'mocks'));
    expect(made.ok).toBe(true);
    const repoKey = open.locate(repo)?.repoKey ?? '';
    const fileId = open.listFiles(repoKey).files[0]?.fileId ?? '';
    expect(open.resolveFile(fileId)?.file.relPath).toBe('docs/mocks/home.png');

    const walled = new MountStore(dataDir, repos, {
      guards: guardsCovering(repo),
    });
    expect(walled.mount(join(repo, 'docs', 'mocks'))).toEqual({
      ok: false,
      error: 'refused-path',
    });
    expect(walled.resolveFile(fileId)).toBeNull();
    // Unseen, not deleted: the address survives for when the wall comes down.
    expect(walled.listFiles(repoKey).files).toEqual([]);
    expect(open.resolveFile(fileId)?.file.relPath).toBe('docs/mocks/home.png');
  });
});

describe('a meetings folder inside a walled lead’s root', () => {
  it('is no home, so a meeting files under the data dir instead', () => {
    const open = new MountStore(dataDir, repos);
    open.mount(join(repo, 'docs', 'mocks'));
    const repoKey = open.locate(repo)?.repoKey ?? '';
    mkdirSync(join(repo, 'docs', 'meetings'));
    open.setMeetings(repoKey, {
      relPath: 'docs/meetings',
      retention: 'transcripts',
      gitignore: false,
    });
    expect(open.meetingHome(repoKey)?.abs).toBe(join(repo, 'docs', 'meetings'));
    const walled = new MountStore(dataDir, repos, { guards: guardsCovering(repo) });
    expect(walled.meetingHome(repoKey)).toBeNull();
    expect(walled.refuses(join(repo, 'docs', 'meetings'))).toBe(true);
    expect(walled.refuses(join(tmp, 'riverbend'))).toBe(false);
  });
});

describe('the conventions index', () => {
  it('does not follow a link out of a walled root', () => {
    const store = new MountStore(dataDir, repos, {
      guards: guardsCovering(repo),
    });
    new MountStore(dataDir, repos).mount(join(repo, 'docs', 'mocks'));
    const repoKey = store.locate(repo)?.repoKey ?? '';
    symlinkSync(join(tmp, 'riverbend', 'notes.md'), join(repo, 'WORKSPACES.md'));
    expect(store.conventions(repoKey).text).toBeNull();
  });

  it('reads a plain index under a walled root (control)', () => {
    const store = new MountStore(dataDir, repos, {
      guards: guardsCovering(repo),
    });
    new MountStore(dataDir, repos).mount(join(repo, 'docs', 'mocks'));
    const repoKey = store.locate(repo)?.repoKey ?? '';
    writeFileSync(join(repo, 'WORKSPACES.md'), 'Plans go in docs/plans.\n');
    expect(store.conventions(repoKey).text).toBe('Plans go in docs/plans.\n');
  });

  it('answers no text for a FIFO instead of blocking', () => {
    const store = new MountStore(dataDir, repos);
    store.mount(join(repo, 'docs', 'mocks'));
    const repoKey = store.locate(repo)?.repoKey ?? '';
    makeFifo(join(repo, 'WORKSPACES.md'));
    const STORE = resolve(__dirname, '../src/mount-store.ts');
    const REPOS = resolve(__dirname, '../src/repo-registry.ts');
    const res = spawnSync(
      'bun',
      [
        '-e',
        `const { MountStore } = await import(${JSON.stringify(STORE)});
         const { RepoRegistry } = await import(${JSON.stringify(REPOS)});
         const d = ${JSON.stringify(dataDir)};
         const s = new MountStore(d, new RepoRegistry(d));
         console.log(JSON.stringify(s.conventions(${JSON.stringify(repoKey)}).text));`,
      ],
      { timeout: 5_000, encoding: 'utf8' },
    );
    expect(res.signal).toBe(null);
    expect(res.stdout.trim()).toBe('null');
  }, 15_000);
});
