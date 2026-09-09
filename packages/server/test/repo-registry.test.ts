import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { docKeyForPath } from '../src/doc-key.ts';
import { REPO_REGISTRY_FILE, RepoRegistry } from '../src/repo-registry.ts';

/**
 * The registry has to answer one question correctly after the checkout that
 * asked it is gone: which doc is this file. So the load-bearing test here
 * removes a real worktree with the real git CLI and asks again.
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

describe('RepoRegistry', () => {
  let tmp: string;
  let dataDir: string;
  let main: string;
  let wt: string;
  let reg: RepoRegistry;

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'cw-registry-')));
    dataDir = join(tmp, 'data');
    mkdirSync(dataDir);
    main = join(tmp, 'repo');
    mkdirSync(main);
    git(main, 'init', '-b', 'main');
    git(main, 'remote', 'add', 'origin', 'git@github.com:example/widgets.git');
    mkdirSync(join(main, 'docs'));
    writeFileSync(join(main, 'docs', 'plan.md'), '# plan\n');
    git(main, 'add', '.');
    git(main, 'commit', '-m', 'init');
    wt = join(tmp, 'wt-feature');
    git(main, 'worktree', 'add', wt, '-b', 'feature');
    reg = new RepoRegistry(dataDir);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const keyIn = (root: string): string =>
    docKeyForPath(join(root, 'docs/plan.md'))?.docKey as string;

  it('resolves a bind from a second checkout to the doc the first one claimed', () => {
    const claim = reg.claim(keyIn(main), 'd-first');
    expect(claim.claimed).toBe(true);
    // The whole feature, in one line: standing in the worktree finds the doc.
    expect(reg.docIdForPath(join(wt, 'docs/plan.md'))).toBe('d-first');
  });

  it('CONTROL: a different file in the same repo does NOT resolve to that doc', () => {
    reg.claim(keyIn(main), 'd-first');
    writeFileSync(join(main, 'docs', 'other.md'), '# other\n');
    expect(reg.docIdForPath(join(main, 'docs/other.md'))).toBeUndefined();
  });

  it('never repoints a claimed key, and hands the caller the doc that holds it', () => {
    reg.claim(keyIn(main), 'd-first');
    const second = reg.claim(keyIn(wt), 'd-second');
    expect(second.claimed).toBe(false);
    expect(second.docId).toBe('d-first');
    expect(reg.docIdFor(keyIn(main))).toBe('d-first');
  });

  it('a rename keeps the old key resolving to the same doc', () => {
    const before = keyIn(main);
    reg.claim(before, 'd-first');
    git(main, 'mv', 'docs/plan.md', 'docs/roadmap.md');
    const after = docKeyForPath(join(main, 'docs/roadmap.md'))?.docKey as string;
    expect(after).not.toBe(before);
    reg.aliasKey(before, after);
    expect(reg.docIdFor(after)).toBe('d-first');
    // A link written before the rename still opens the same document.
    expect(reg.docIdFor(before)).toBe('d-first');
    expect(reg.keysFor('d-first')).toContain(before);
  });

  it('resolves a key that exists ONLY as an alias, through a chain of them', () => {
    // The rename case above claims the old key first, so it would answer
    // without ever following an alias. This is the shape that cannot: a key
    // nobody claimed, pointing through two hops at one that somebody did.
    const current = keyIn(main);
    reg.claim(current, 'd-first');
    reg.aliasKey('git:github.com/example/widgets\u0000docs/ancient.md', 'mid-key');
    reg.aliasKey('mid-key', current);
    expect(reg.docIdFor('git:github.com/example/widgets\u0000docs/ancient.md')).toBe('d-first');
  });

  it('drops a registered checkout from the live list once its directory is gone', () => {
    // Not the unregister path: this is a clone deleted without telling us,
    // which git's own worktree list cannot report because it never knew it.
    const clone = join(tmp, 'clone');
    git(tmp, 'clone', main, clone);
    // A second clone of the SAME remote — which is what makes it the same
    // repo. Cloned from a local path, git records that path as origin, so
    // point it where the original points.
    git(clone, 'remote', 'set-url', 'origin', 'git@github.com:example/widgets.git');
    reg.registerCheckout(clone);
    const key = 'git:github.com/example/widgets';
    expect(reg.checkoutsFor(key)).toContain(clone);
    rmSync(clone, { recursive: true, force: true });
    expect(reg.checkoutsFor(key)).not.toContain(clone);
  });

  it('keeps the doc resolvable after the worktree it was bound in is removed', () => {
    reg.registerCheckout(wt);
    reg.claim(keyIn(wt), 'd-first');
    expect(reg.checkoutsFor('git:github.com/example/widgets')).toContain(wt);

    reg.unregisterCheckout(wt);
    git(main, 'worktree', 'remove', wt, '--force');
    expect(existsSync(wt)).toBe(false);

    // Ten tries, because AC2 asks for ten: the answer must not depend on a
    // cache that happens to still be warm on the first one.
    for (let i = 0; i < 10; i++) {
      expect(reg.docIdForPath(join(main, 'docs/plan.md'))).toBe('d-first');
    }
    expect(reg.checkoutsFor('git:github.com/example/widgets')).not.toContain(wt);
    // Soft: the row survives with a removal stamp rather than disappearing.
    const row = reg.checkoutRows('git:github.com/example/widgets').find((c) => c.root === wt);
    expect(row?.removedAt).toBeGreaterThan(0);
  });

  it('registering is idempotent and un-retires a checkout', () => {
    const register = (): boolean => {
      const res = reg.registerCheckout(wt);
      if (!res.ok) throw new Error(`expected the worktree to register: ${res.error}`);
      return res.alreadyKnown;
    };
    expect(register()).toBe(false);
    expect(register()).toBe(true);
    reg.unregisterCheckout(wt);
    expect(register()).toBe(false);
    const row = reg.checkoutRows('git:github.com/example/widgets').find((c) => c.root === wt);
    expect(row?.removedAt).toBeUndefined();
    expect(row?.registered).toBe(true);
  });

  it('refuses to register something that is not a repo', () => {
    const res = reg.registerCheckout(join(tmp, 'data'));
    expect(res.ok).toBe(false);
  });

  it('a bind teaches the registry a checkout without vouching for it', () => {
    reg.noteCheckout(join(wt, 'docs/plan.md'));
    const row = reg.checkoutRows('git:github.com/example/widgets').find((c) => c.root === wt);
    expect(row).toBeDefined();
    expect(row?.registered).toBe(false);
  });

  it('survives a restart: a fresh registry over the same data dir answers the same', () => {
    reg.registerCheckout(wt);
    reg.claim(keyIn(main), 'd-first');
    const reopened = new RepoRegistry(dataDir);
    expect(reopened.docIdForPath(join(wt, 'docs/plan.md'))).toBe('d-first');
    expect(reopened.checkoutRows('git:github.com/example/widgets').length).toBeGreaterThan(0);
  });

  it('writes the file 600, because it is a map of the host filesystem', () => {
    reg.claim(keyIn(main), 'd-first');
    const mode = statSync(join(dataDir, REPO_REGISTRY_FILE)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('keeps a corrupt registry beside the new one instead of discarding it', () => {
    writeFileSync(join(dataDir, REPO_REGISTRY_FILE), '{ not json');
    const reopened = new RepoRegistry(dataDir);
    expect(reopened.snapshot().docKeys).toEqual({});
    const kept = readdirSync(dataDir).filter((f) => f.includes('.corrupt-'));
    expect(kept.length).toBe(1);
  });

  it('batches a migration into one write', () => {
    reg.beginBatch();
    reg.claim(keyIn(main), 'd-first');
    expect(existsSync(join(dataDir, REPO_REGISTRY_FILE))).toBe(false);
    reg.endBatch();
    expect(new RepoRegistry(dataDir).docIdFor(keyIn(main))).toBe('d-first');
  });

  it('releaseKey undoes a claim, for the migration revert and nothing else', () => {
    reg.claim(keyIn(main), 'd-first');
    reg.releaseKey(keyIn(main));
    expect(reg.docIdFor(keyIn(main))).toBeUndefined();
  });
});
