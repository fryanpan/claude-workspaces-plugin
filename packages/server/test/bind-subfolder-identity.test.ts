import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveWorkspaceId } from '../src/bind-meta.ts';
import { DocStore } from '../src/doc-store.ts';
import { SseBus } from '../src/sse.ts';
import { createWebhookDispatcher } from '../src/webhooks.ts';

/**
 * Which FOLDER a browse or diff review is about, now that a review id is
 * derived from the canonical checkout rather than the caller's path.
 *
 * Canonicalising is what makes one repo browsed through two worktrees land on
 * one review. Canonicalising the WHOLE path instead of just the checkout half
 * would collapse every folder in the repo onto that one review: browsing
 * `packages/alpha` and `packages/beta` would open the same workspace, and
 * every file in the second would be a member doc of the first. So both halves
 * are asserted here, on one fixture, and each is the other's control.
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

describe('a review id names the folder, not just the repo', () => {
  let tmp: string;
  let dataDir: string;
  let main: string;
  let wt: string;
  let store: DocStore;

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'cw-subfolder-')));
    dataDir = join(tmp, 'data');
    mkdirSync(dataDir);
    main = join(tmp, 'repo');
    mkdirSync(join(main, 'packages', 'alpha'), { recursive: true });
    mkdirSync(join(main, 'packages', 'beta'), { recursive: true });
    git(main, 'init', '-b', 'main');
    git(main, 'remote', 'add', 'origin', 'git@github.com:example/widgets.git');
    writeFileSync(join(main, 'packages', 'alpha', 'README.md'), '# Alpha\n\nfirst\n');
    writeFileSync(join(main, 'packages', 'beta', 'README.md'), '# Beta\n\nsecond\n');
    git(main, 'add', '.');
    git(main, 'commit', '-m', 'init');
    wt = join(tmp, 'wt-feature');
    git(main, 'worktree', 'add', wt, '-b', 'feature');
    store = new DocStore({
      dataDir,
      sse: new SseBus(),
      webhooks: createWebhookDispatcher({ onLog: () => {} }),
      decorateDocMeta: (m) => ({ ...m, reviewUrl: `http://test/review/${m.docId}` }),
    });
  });

  afterEach(async () => {
    // Flush before the temp dir goes: a debounced persist that fires after
    // the rmSync throws ENOENT into the run for no reason.
    await store.flush();
    store.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  const browse = async (folderPath: string): Promise<string> => {
    const res = await store.bindFolder({ folderPath });
    expect(res.ok).toBe(true);
    return res.ok ? res.workspaceId : '';
  };

  it('CONTROL: the two checkouts are genuinely different places on disk', () => {
    // Without this, "the worktree matches" would pass against a derivation
    // that returned a constant — which is exactly the failure being tested
    // for below.
    expect(main).not.toBe(wt);
    expect(deriveWorkspaceId(join(main, 'packages/alpha'))).not.toBe(
      deriveWorkspaceId(join(wt, 'packages/alpha')),
    );
  });

  it('gives two subfolders of one repo two different browse workspaces', async () => {
    const alpha = await browse(join(main, 'packages/alpha'));
    const beta = await browse(join(main, 'packages/beta'));
    expect(alpha).not.toBe('');
    expect(beta).not.toBe(alpha);
  });

  it('gives the SAME subfolder in two checkouts one browse workspace', async () => {
    const fromMain = await browse(join(main, 'packages/alpha'));
    const fromWorktree = await browse(join(wt, 'packages/alpha'));
    expect(fromWorktree).toBe(fromMain);
  });

  it('gives the repo root a workspace of its own, distinct from any subfolder', async () => {
    const root = await browse(main);
    const alpha = await browse(join(main, 'packages/alpha'));
    expect(root).not.toBe(alpha);
  });

  it('diff reviews follow the same rule: same folder matches, different folders do not', async () => {
    // A real range, so the ids under test are actually minted.
    writeFileSync(join(main, 'packages', 'alpha', 'README.md'), '# Alpha\n\nfirst edited\n');
    writeFileSync(join(main, 'packages', 'beta', 'README.md'), '# Beta\n\nsecond edited\n');
    git(main, 'add', '.');
    git(main, 'commit', '-m', 'edit both');
    const head = git(main, 'rev-parse', 'HEAD').trim();
    const prev = git(main, 'rev-parse', 'HEAD~1').trim();
    const idFor = async (root: string): Promise<string> => {
      const res = await store.bindDiff({ repoPath: root, base: prev, target: head });
      expect(res.ok).toBe(true);
      return res.ok ? res.reviewId : '';
    };
    const alphaMain = await idFor(join(main, 'packages/alpha'));
    const betaMain = await idFor(join(main, 'packages/beta'));
    expect(alphaMain).not.toBe('');
    expect(betaMain).not.toBe(alphaMain);
  });
});
