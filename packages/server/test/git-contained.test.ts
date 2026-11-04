/**
 * `git-contained.ts`: git in a walled lead's repository runs nothing the
 * repository names, reads nothing outside the root, sees none of the
 * server's environment and is bounded in time.
 *
 * Each planted setting has a control arm: the same git command run plainly
 * (as an owner's shell would, `GIT_CONFIG_NOSYSTEM` and nothing else), which
 * shows the planted program runs or the outside file is read. Where a case
 * says so, one layer is turned off to show the other holds alone. Markers
 * are written both inside the root and outside it, so a refusal cannot be
 * the lead's wall rather than the server's profile (review L4). macOS only,
 * under the real `sandbox-exec`. Fixtures synthetic, temp dirs only.
 */
import { afterAll, afterEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BoardSocketRoots, boardSocketRootsPath } from '../src/board-socket-roots.ts';
import {
  NEUTRALISED,
  containedGit,
  containedGitEnv,
  driverOverrides,
  setContainedGitLayersForTest,
  setContainedGitSeamForTest,
  setContainedGitTimeoutForTest,
} from '../src/git-contained.ts';
import { boundFiles } from '../src/slow-fs.ts';
import { makeFifo } from './fifo.ts';

const DARWIN = process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec');
const top = realpathSync(mkdtempSync(join(tmpdir(), 'git-contained-')));
const roots = new BoardSocketRoots(boardSocketRootsPath(join(top, 'data')), undefined, undefined, {
  home: join(top, 'home'),
  uid: 4242,
  realpath: (p) => realpathSync.native(p),
});
const remove = boundFiles.guards.add(roots);
afterAll(() => {
  remove();
  rmSync(top, { recursive: true, force: true });
});
afterEach(() => {
  setContainedGitLayersForTest(null);
  setContainedGitSeamForTest(null);
  setContainedGitTimeoutForTest(null);
});

/** Plain git, as an owner's shell runs it: the control arm. */
function plainGit(cwd: string, ...args: string[]) {
  return spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: {
      PATH: '/usr/bin:/bin:/opt/homebrew/bin',
      HOME: join(top, 'home'),
      GIT_CONFIG_NOSYSTEM: '1',
    },
  });
}

let n = 0;
/** A fresh root holding a committed repository, and an outside folder. */
function fixture(): { root: string; outside: string; marker: (where: string) => string } {
  n += 1;
  const root = join(top, `harborlight-${n}`);
  const outside = join(top, `riverbend-${n}`);
  mkdirSync(join(root, 'docs'), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(root, 'docs', 'plan.md'), '# plan\n');
  plainGit(root, 'init', '-q');
  plainGit(root, 'add', '.');
  plainGit(
    root,
    '-c',
    'user.name=Alice',
    '-c',
    'user.email=alice@example.invalid',
    'commit',
    '-qm',
    's',
  );
  expect(roots.set(`w-${n}`, [root]).ok).toBe(true);
  // A script that leaves one marker inside the root and one outside it.
  const script = join(outside, 'planted.sh');
  writeFileSync(
    script,
    `#!/bin/sh\necho ran > "${root}/marker-in"\necho ran > "${outside}/marker-out"\n`,
  );
  chmodSync(script, 0o755);
  return { root, outside, marker: () => script };
}

const ran = (f: { root: string; outside: string }) =>
  existsSync(join(f.root, 'marker-in')) || existsSync(join(f.outside, 'marker-out'));
const clearMarkers = (f: { root: string; outside: string }) => {
  rmSync(join(f.root, 'marker-in'), { force: true });
  rmSync(join(f.outside, 'marker-out'), { force: true });
};
const gitConfig = (root: string, key: string, value: string) =>
  spawnSync('git', ['-C', root, 'config', key, value], { encoding: 'utf8' });

describe.skipIf(!DARWIN)('git in a walled lead’s repository', () => {
  it('answers outside every root with null, so the caller’s own rules apply', () => {
    expect(containedGit(join(top, 'nowhere'), ['status'])).toBeNull();
  });

  it('runs a read and answers it (positive control)', async () => {
    const f = fixture();
    const got = await containedGit(f.root, ['ls-files', '-z']);
    expect(got?.ok).toBe(true);
    expect(got?.stdout.split('\0')).toContain('docs/plan.md');
  });

  it('10: a core.fsmonitor program does not run, from the profile alone', async () => {
    const f = fixture();
    gitConfig(f.root, 'core.fsmonitor', f.marker(''));
    plainGit(f.root, 'status', '--porcelain');
    expect(ran(f)).toBe(true);
    clearMarkers(f);
    // Both layers off: the same call through this module runs the program.
    setContainedGitLayersForTest({ sandbox: false, settings: false });
    await containedGit(f.root, ['status', '--porcelain']);
    expect(ran(f)).toBe(true);
    clearMarkers(f);
    setContainedGitLayersForTest({ sandbox: true, settings: false });
    const got = await containedGit(f.root, ['status', '--porcelain']);
    expect(ran(f)).toBe(false);
    setContainedGitLayersForTest(null);
    expect((await containedGit(f.root, ['status', '--porcelain']))?.ok).toBe(true);
    expect(ran(f)).toBe(false);
    expect(got).not.toBeNull();
  });

  it('11: a clean filter does not run, from either layer alone', async () => {
    const f = fixture();
    for (const name of ['x', 'a=b']) {
      clearMarkers(f);
      writeFileSync(join(f.root, '.gitattributes'), `*.md filter=${name}\n`);
      gitConfig(f.root, `filter.${name}.clean`, f.marker(''));
      writeFileSync(join(f.root, 'docs', 'plan.md'), `# plan ${name}\n`);
      plainGit(f.root, 'diff');
      expect(ran(f)).toBe(true);
      clearMarkers(f);
      setContainedGitLayersForTest({ sandbox: true, settings: false });
      await containedGit(f.root, ['diff']);
      expect(ran(f)).toBe(false);
      setContainedGitLayersForTest({ sandbox: false, settings: true });
      await containedGit(f.root, ['diff']);
      expect(ran(f)).toBe(false);
      setContainedGitLayersForTest(null);
      const full = await containedGit(f.root, ['diff']);
      expect(full?.stderr).toBe('');
      expect(full?.ok).toBe(true);
      expect(ran(f)).toBe(false);
    }
  });

  it('12: a textconv, a !sh alias, gpg.program and core.pager do not run', async () => {
    const f = fixture();
    writeFileSync(join(f.root, '.gitattributes'), '*.md diff=t\n');
    gitConfig(f.root, 'diff.t.textconv', f.marker(''));
    gitConfig(f.root, 'alias.boom', `!${f.marker('')}`);
    gitConfig(f.root, 'gpg.program', f.marker(''));
    gitConfig(f.root, 'log.showSignature', 'true');
    gitConfig(f.root, 'core.pager', f.marker(''));
    writeFileSync(join(f.root, 'docs', 'plan.md'), '# changed\n');
    plainGit(f.root, 'diff');
    expect(ran(f)).toBe(true);
    clearMarkers(f);
    plainGit(f.root, 'boom');
    expect(ran(f)).toBe(true);
    clearMarkers(f);
    setContainedGitLayersForTest({ sandbox: true, settings: false });
    for (const args of [['diff'], ['boom'], ['log', '-n', '1']]) await containedGit(f.root, args);
    expect(ran(f)).toBe(false);
    setContainedGitLayersForTest(null);
    for (const args of [['diff'], ['boom'], ['log', '-n', '1']]) await containedGit(f.root, args);
    expect(ran(f)).toBe(false);
  });

  it('13: an include.path outside the root is not read', async () => {
    const f = fixture();
    const inc = join(f.outside, 'extra.gitconfig');
    writeFileSync(inc, '[riverbend]\n\tleak = yes\n');
    gitConfig(f.root, 'include.path', inc);
    expect(plainGit(f.root, 'config', 'riverbend.leak').stdout.trim()).toBe('yes');
    const got = await containedGit(f.root, ['config', 'riverbend.leak']);
    expect(got?.stdout.trim()).toBe('');
  });

  it('14: objects through an alternates file outside the root are missing', async () => {
    const f = fixture();
    const other = join(f.outside, 'repo');
    mkdirSync(other);
    plainGit(other, 'init', '-q');
    const oid = spawnSync('git', ['-C', other, 'hash-object', '-w', '--stdin'], {
      input: 'riverbend-secret\n',
      encoding: 'utf8',
    }).stdout.trim();
    writeFileSync(
      join(f.root, '.git', 'objects', 'info', 'alternates'),
      `${join(other, '.git', 'objects')}\n`,
    );
    expect(plainGit(f.root, 'cat-file', '-p', oid).stdout).toBe('riverbend-secret\n');
    const got = await containedGit(f.root, ['cat-file', '-p', oid]);
    expect(got?.ok).toBe(false);
    expect(got?.stdout).toBe('');
  });

  it('15: a working folder swapped for a link to another repository reads nothing', async () => {
    const f = fixture();
    const other = join(f.outside, 'repo');
    mkdirSync(other);
    writeFileSync(join(other, 'riverbend.md'), 'x\n');
    plainGit(other, 'init', '-q');
    plainGit(other, 'add', '.');
    const docs = join(f.root, 'docs');
    setContainedGitSeamForTest(() => {
      renameSync(docs, join(f.root, 'docs-moved'));
      symlinkSync(other, docs);
    });
    const got = await containedGit(docs, ['ls-files']);
    expect(got?.stdout ?? '').not.toContain('riverbend.md');
    // The control: the same command through the swapped link, run plainly.
    expect(plainGit(docs, 'ls-files').stdout).toContain('riverbend.md');
  });

  it('16: none of the server’s environment reaches git', async () => {
    const f = fixture();
    const other = join(f.outside, 'repo');
    mkdirSync(other);
    writeFileSync(join(other, 'riverbend.md'), 'x\n');
    plainGit(other, 'init', '-q');
    plainGit(other, 'add', '.');
    const saved = { dir: process.env.GIT_DIR, params: process.env.GIT_CONFIG_PARAMETERS };
    process.env.GIT_DIR = join(other, '.git');
    process.env.GIT_CONFIG_PARAMETERS = "'riverbend.leak'='yes'";
    try {
      const listed = await containedGit(f.root, ['ls-files']);
      expect(listed?.stdout).toContain('docs/plan.md');
      expect(listed?.stdout).not.toContain('riverbend.md');
      expect((await containedGit(f.root, ['config', 'riverbend.leak']))?.stdout.trim()).toBe('');
    } finally {
      if (saved.dir === undefined) Reflect.deleteProperty(process.env, 'GIT_DIR');
      else process.env.GIT_DIR = saved.dir;
      if (saved.params === undefined) Reflect.deleteProperty(process.env, 'GIT_CONFIG_PARAMETERS');
      else process.env.GIT_CONFIG_PARAMETERS = saved.params;
    }
    const env = containedGitEnv(f.root, NEUTRALISED);
    expect(
      Object.keys(env)
        .filter((k) => !k.startsWith('GIT_CONFIG_'))
        .sort(),
    ).toEqual([
      'GIT_ATTR_NOSYSTEM',
      'GIT_CEILING_DIRECTORIES',
      'GIT_NO_LAZY_FETCH',
      'GIT_OPTIONAL_LOCKS',
      'GIT_TERMINAL_PROMPT',
      'HOME',
      'LANG',
      'PATH',
      'XDG_CONFIG_HOME',
    ]);
  });

  it('17: a git that never finishes is killed, and the event loop runs meanwhile', async () => {
    const f = fixture();
    makeFifo(join(f.root, 'docs', 'pipe'));
    setContainedGitTimeoutForTest(300);
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 20);
    const got = await containedGit(f.root, ['hash-object', 'docs/pipe']);
    clearInterval(timer);
    expect(got?.ok).toBe(false);
    expect(ticks).toBeGreaterThan(0);
  });

  it('18: a .git link, a gitdir pointing out of the root, and no .git inside are “cannot tell”', async () => {
    const linked = fixture();
    renameSync(join(linked.root, '.git'), join(linked.outside, 'dotgit'));
    symlinkSync(join(linked.outside, 'dotgit'), join(linked.root, '.git'));
    expect((await containedGit(linked.root, ['ls-files']))?.ok).toBe(false);

    const pointer = fixture();
    renameSync(join(pointer.root, '.git'), join(pointer.outside, 'dotgit'));
    writeFileSync(join(pointer.root, '.git'), `gitdir: ${join(pointer.outside, 'dotgit')}\n`);
    expect((await containedGit(pointer.root, ['ls-files']))?.ok).toBe(false);

    n += 1;
    const outer = join(top, `saltmarsh-${n}`);
    const inner = join(outer, 'inner');
    mkdirSync(inner, { recursive: true });
    writeFileSync(join(inner, 'a.md'), 'a\n');
    plainGit(outer, 'init', '-q');
    plainGit(outer, 'add', '.');
    expect(roots.set(`w-${n}`, [inner]).ok).toBe(true);
    expect(plainGit(inner, 'ls-files').stdout).toContain('a.md');
    expect((await containedGit(inner, ['ls-files']))?.ok).toBe(false);
  });
});

describe('the driver overrides', () => {
  it('give each named filter an empty command, whatever its name holds', () => {
    const got = driverOverrides(['filter.a=b.clean', 'filter.a=b.smudge', 'filter.x.process']);
    expect(got).toEqual([
      ['filter.a=b.clean', ''],
      ['filter.a=b.smudge', ''],
      ['filter.a=b.process', ''],
      ['filter.a=b.required', 'false'],
      ['filter.x.clean', ''],
      ['filter.x.smudge', ''],
      ['filter.x.process', ''],
      ['filter.x.required', 'false'],
    ]);
  });
});

describe.skipIf(process.platform === 'darwin')('off macOS', () => {
  it('git in a root stays “cannot tell”', async () => {
    const root = join(top, 'harborlight-linux');
    mkdirSync(root, { recursive: true });
    expect(roots.set('w-linux', [root]).ok).toBe(true);
    const got = await containedGit(root, ['status']);
    expect(got?.ok ?? false).toBe(false);
  });
});
