import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { candidatesOf, surveyCopies } from '../src/doc-copies.ts';
import { docKeyForPath } from '../src/doc-key.ts';
import { RepoRegistry } from '../src/repo-registry.ts';

/**
 * The live-copy rule, the drift flag and the ambiguity refusal.
 *
 * Times are SET on the fixtures rather than measured, so nothing here asserts
 * how long the machine took — the behaviour under test is an ordering, and an
 * ordering is something a test can build exactly.
 *
 * All fixtures are synthetic.
 */

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))),
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.invalid',
    },
  });
}

/** Give a file an exact mtime, in seconds since the epoch. */
function setMtime(path: string, epochSeconds: number): void {
  utimesSync(path, epochSeconds, epochSeconds);
}

describe('surveyCopies', () => {
  let tmp: string;
  let main: string;
  let wt: string;
  let reg: RepoRegistry;
  let repoKey: string;
  let docKey: string;
  const rel = 'docs/plan.md';
  // A fixed clock for the fixtures: 2026-09-09T00:00:00Z, in seconds.
  const T0 = 1_788_912_000;

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'cw-copies-')));
    const dataDir = join(tmp, 'data');
    mkdirSync(dataDir);
    main = join(tmp, 'repo');
    mkdirSync(main);
    git(main, 'init', '-b', 'main');
    git(main, 'remote', 'add', 'origin', 'git@github.com:example/widgets.git');
    mkdirSync(join(main, 'docs'));
    writeFileSync(join(main, rel), '# Plan\n\nshared\n');
    git(main, 'add', '.');
    git(main, 'commit', '-m', 'init');
    wt = join(tmp, 'wt-feature');
    git(main, 'worktree', 'add', wt, '-b', 'feature');
    reg = new RepoRegistry(dataDir);
    reg.registerCheckout(main);
    reg.registerCheckout(wt);
    const parts = docKeyForPath(join(main, rel));
    repoKey = parts?.repoKey as string;
    docKey = parts?.docKey as string;
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const survey = (opts = {}) => surveyCopies(reg, repoKey, rel, docKey, opts);

  it('sees a copy in every checkout that holds the file', () => {
    const s = survey();
    expect(s.copies.map((c) => c.root).sort()).toEqual([main, wt].sort());
  });

  it('picks the copy edited most recently as live', () => {
    writeFileSync(join(wt, rel), '# Plan\n\nworktree edit\n');
    setMtime(join(main, rel), T0);
    setMtime(join(wt, rel), T0 + 600);
    expect(survey().live?.root).toBe(wt);

    // And the other way round on the same fixture, so the test cannot pass
    // against a function that always returns the second checkout.
    setMtime(join(main, rel), T0 + 1200);
    expect(survey().live?.root).toBe(main);
  });

  it('counts our own flush as an edit of the copy we wrote', () => {
    writeFileSync(join(wt, rel), '# Plan\n\nworktree edit\n');
    setMtime(join(main, rel), T0);
    setMtime(join(wt, rel), T0 + 600);
    expect(survey().live?.root).toBe(wt);
    // A `git checkout` in the worktree bumps an mtime without anybody having
    // edited anything; our own newer write-back to main must still win.
    const s = survey({ lastFlush: { root: main, at: (T0 + 900) * 1000 } });
    expect(s.live?.root).toBe(main);
  });

  it('flags a copy that differs from the live one, and does not flag one that matches', () => {
    // Identical bytes in both checkouts: no drift, whatever the mtimes are.
    setMtime(join(main, rel), T0 + 600);
    setMtime(join(wt, rel), T0);
    expect(survey().drift).toEqual([]);

    writeFileSync(join(wt, rel), '# Plan\n\nchanged on the branch\n');
    setMtime(join(wt, rel), T0);
    const s = survey();
    expect(s.live?.root).toBe(main);
    expect(s.drift.map((c) => c.root)).toEqual([wt]);
  });

  it('asks rather than guesses when two copies differ inside the window', () => {
    writeFileSync(join(wt, rel), '# Plan\n\ndifferent\n');
    setMtime(join(main, rel), T0);
    setMtime(join(wt, rel), T0 + 1);
    const s = survey();
    expect(s.ambiguous).toBe(true);
    expect(s.ambiguityReason).toBe('concurrent-edits');
  });

  it('does NOT ask when the two edits are far apart', () => {
    // The control for the case above: same fixture, same differing bytes,
    // only the gap changes. Without this an always-ambiguous survey passes.
    writeFileSync(join(wt, rel), '# Plan\n\ndifferent\n');
    setMtime(join(main, rel), T0);
    setMtime(join(wt, rel), T0 + 600);
    const s = survey();
    expect(s.ambiguous).toBe(false);
    expect(s.live?.root).toBe(wt);
  });

  it('does NOT ask when the two recent copies are byte-identical', () => {
    // A worktree freshly created from the same commit has two copies with
    // near-identical mtimes and no disagreement at all. Treating that as a
    // question would stop the ordinary case dead.
    setMtime(join(main, rel), T0);
    setMtime(join(wt, rel), T0 + 1);
    expect(survey().ambiguous).toBe(false);
  });

  it('says so when the file exists in no checkout at all', () => {
    rmSync(join(main, rel));
    rmSync(join(wt, rel));
    const s = survey();
    expect(s.live).toBeNull();
    expect(s.ambiguityReason).toBe('no-copy-anywhere');
  });

  it('builds a candidate table a person can choose from', () => {
    writeFileSync(join(wt, rel), '# Plan\n\nuncommitted on the branch\n');
    setMtime(join(main, rel), T0);
    setMtime(join(wt, rel), T0 + 1);
    const rows = candidatesOf(survey({ withGitStatus: true }));
    expect(rows.length).toBe(2);
    // Newest first, so the row a person is most likely to want is on top.
    expect(rows[0]?.root).toBe(wt);
    expect(rows.map((r) => r.branch).sort()).toEqual(['feature', 'main']);
    expect(rows[0]?.uncommitted).toBe(true);
    expect(rows[1]?.uncommitted).toBe(false);
    // A short digest, not the whole hash — enough to tell two copies apart.
    expect(rows[0]?.sha).not.toBe(rows[1]?.sha as string | null);
    expect(rows[0]?.sha?.length).toBe(12);
  });

  it('leaves uncommitted UNKNOWN when git cannot answer, rather than saying clean', () => {
    // A checkout the registry still lists whose git metadata has gone. On a
    // screen asking somebody which copy to keep, "we did not find out" and
    // "there are no local changes" are different sentences.
    rmSync(join(wt, '.git'), { recursive: true, force: true });
    const rows = candidatesOf(survey({ withGitStatus: true }));
    const stranded = rows.find((r) => r.root === wt);
    expect(stranded).toBeDefined();
    expect(stranded?.uncommitted).toBeUndefined();
    // Positive control on the same call: the healthy checkout still answers.
    expect(rows.find((r) => r.root === main)?.uncommitted).toBe(false);
  });

  it('omits uncommitted entirely when it was not asked for', () => {
    // "We did not look" and "it is clean" must not be the same value on a
    // screen that asks somebody to choose.
    const rows = candidatesOf(survey());
    expect(rows[0]?.uncommitted).toBeUndefined();
  });
});
