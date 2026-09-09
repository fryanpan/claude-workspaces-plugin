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

  it('refuses a rename alias when the two keys belong to different docs', () => {
    // Both keys are spoken for — one document bound before the rename, one
    // after. Writing the alias would point every link saved against the old
    // key at the other document, which is the silent repoint `claim` refuses.
    const before = keyIn(main);
    reg.claim(before, 'd-first');
    git(main, 'mv', 'docs/plan.md', 'docs/roadmap.md');
    const after = docKeyForPath(join(main, 'docs/roadmap.md'))?.docKey as string;
    reg.claim(after, 'd-second');

    const res = reg.aliasKey(before, after);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res).toMatchObject({ error: 'held-by-other', docId: 'd-second', otherDocId: 'd-first' });
    // Nothing moved: each key still opens the document that claimed it.
    expect(reg.docIdFor(before)).toBe('d-first');
    expect(reg.docIdFor(after)).toBe('d-second');
  });

  it('records the alias when the new key is free — the case the refusal must not eat', () => {
    // CONTROL for the refusal above. Without it, a registry that refused
    // every alias would pass that test and break every rename.
    const before = keyIn(main);
    reg.claim(before, 'd-first');
    git(main, 'mv', 'docs/plan.md', 'docs/roadmap.md');
    const after = docKeyForPath(join(main, 'docs/roadmap.md'))?.docKey as string;
    expect(reg.aliasKey(before, after)).toEqual({ ok: true, aliased: true });
    expect(reg.docIdFor(before)).toBe('d-first');
    expect(reg.docIdFor(after)).toBe('d-first');
  });

  it('a changed origin re-keys the repo it already had, and its docs follow', () => {
    // Every component of a repoKey is mutable, which is why keys are a lookup
    // table rather than an address. A `git remote set-url` used to produce a
    // SECOND repo record with no path from the old key to the new one, and
    // the next bind of a file that already had a document minted another.
    reg.registerCheckout(main);
    reg.claim(keyIn(main), 'd-first');
    const oldKey = keyIn(main);

    git(main, 'remote', 'set-url', 'origin', 'git@github.com:example/gadgets.git');
    reg.registerCheckout(main);
    const newKey = keyIn(main);
    expect(newKey).not.toBe(oldKey);

    // One record, re-keyed, with the old spelling kept.
    const repos = reg.listRepos();
    expect(repos).toHaveLength(1);
    expect(repos[0]?.repoKey).toBe('git:github.com/example/gadgets');
    expect(repos[0]?.aliasKeys).toContain('git:github.com/example/widgets');
    // And the document is reachable under BOTH spellings, which is what stops
    // the next bind minting a duplicate.
    expect(reg.docIdFor(newKey)).toBe('d-first');
    expect(reg.docIdFor(oldKey)).toBe('d-first');
    // The doc now holds both spellings, and the one it reports is the current
    // one — a status surface that printed the retired key would send a person
    // looking for a remote that no longer exists.
    expect(reg.primaryKeyFor('d-first')).toBe(newKey);
    expect(reg.docIdForPath(join(main, 'docs/plan.md'))).toBe('d-first');
    // The worktree resolves through the re-key too — it is the same repo.
    expect(reg.docIdForPath(join(wt, 'docs/plan.md'))).toBe('d-first');
  });

  it('CONTROL: a genuinely different repo still gets its own record', () => {
    // Without this, "always reuse the record" would pass by merging every
    // repository on the machine into one.
    reg.registerCheckout(main);
    const other = join(tmp, 'other-repo');
    mkdirSync(other);
    git(other, 'init', '-b', 'main');
    git(other, 'remote', 'add', 'origin', 'git@github.com:example/gadgets.git');
    reg.registerCheckout(other);
    expect(reg.listRepos()).toHaveLength(2);
  });

  it('a re-key that swings back does not build an alias cycle', () => {
    // A cycle makes `resolveKey` answer whichever end it was asked from, and
    // this is the way one gets written: a remote changed and changed back.
    // The record has to exist under the FIRST spelling, or there is nothing
    // for the swing back to alias against.
    reg.registerCheckout(main);
    reg.claim(keyIn(main), 'd-first');
    const widgets = keyIn(main);
    git(main, 'remote', 'set-url', 'origin', 'git@github.com:example/gadgets.git');
    reg.noteCheckout(join(main, 'docs/plan.md'));
    git(main, 'remote', 'set-url', 'origin', 'git@github.com:example/widgets.git');
    reg.noteCheckout(join(main, 'docs/plan.md'));
    expect(reg.docIdFor(widgets)).toBe('d-first');
    expect(reg.docIdForPath(join(main, 'docs/plan.md'))).toBe('d-first');
    expect(reg.listRepos()[0]?.aliasKeys).not.toContain('git:github.com/example/widgets');
    // The alias graph still terminates. A cycle answers whichever end it was
    // asked from and only shows up as a "chain too deep" line in a log
    // nobody is reading, so it is asserted on the table itself.
    const aliases = reg.snapshot().docKeyAliases;
    for (const start of Object.keys(aliases)) {
      const seen = new Set<string>();
      let key: string | undefined = start;
      while (key !== undefined && aliases[key] !== undefined) {
        expect(seen.has(key)).toBe(false);
        seen.add(key);
        key = aliases[key];
      }
    }
  });

  it('restore throws away everything a batch changed, without writing', () => {
    // The rollback the migration commits through: a run refused halfway must
    // leave no filed key behind, on disk or in memory.
    reg.claim(keyIn(main), 'd-first');
    const snapshot = reg.snapshot();
    reg.beginBatch();
    reg.claim(`${keyIn(main)}-other`, 'd-second');
    reg.restore(snapshot);
    expect(reg.docIdFor(`${keyIn(main)}-other`)).toBeUndefined();
    // The claim that was already committed is untouched, and a fresh registry
    // over the same file reads exactly that.
    expect(reg.docIdFor(keyIn(main))).toBe('d-first');
    const reopened = new RepoRegistry(dataDir);
    expect(reopened.docIdFor(keyIn(main))).toBe('d-first');
    expect(reopened.docIdFor(`${keyIn(main)}-other`)).toBeUndefined();
  });

  it('keysFor follows a chain to the end, not one hop', () => {
    // A rename recorded before the doc existed, then another rename. The
    // middle key holds no doc of its own, so a one-hop scan drops the OLDEST
    // spelling — the one most likely to be in somebody's saved link — and
    // whether it does depends on the order the table happens to be in.
    const first = keyIn(main);
    git(main, 'mv', 'docs/plan.md', 'docs/interim.md');
    const middle = docKeyForPath(join(main, 'docs/interim.md'))?.docKey as string;
    reg.aliasKey(first, middle);
    git(main, 'mv', 'docs/interim.md', 'docs/final.md');
    const last = docKeyForPath(join(main, 'docs/final.md'))?.docKey as string;
    reg.claim(last, 'd-first');
    reg.aliasKey(middle, last);

    expect(reg.keysFor('d-first').sort()).toEqual([first, middle, last].sort());
    // CONTROL: a key that leads nowhere near this doc is not swept in.
    expect(reg.keysFor('d-first')).not.toContain(`${first}-unrelated`);
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
