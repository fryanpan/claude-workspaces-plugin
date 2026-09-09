import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DocStore } from '../src/doc-store.ts';
import { SseBus } from '../src/sse.ts';
import { createWebhookDispatcher } from '../src/webhooks.ts';

/**
 * AC1 and AC2, driven through the store rather than the registry: bind a file
 * from the main checkout, bind the SAME file from a linked worktree under a
 * different readable name, and assert one document with one set of comments —
 * then remove the worktree and assert the comments are still there.
 *
 * The comment is what makes this the real assertion. Two docs sharing an id
 * would be a bookkeeping detail; a comment that a reviewer can no longer find
 * is the thing the row is about.
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

function makeDocStore(dataDir: string): DocStore {
  return new DocStore({
    dataDir,
    sse: new SseBus(),
    webhooks: createWebhookDispatcher({ onLog: () => {} }),
    decorateDocMeta: (m) => ({ ...m, reviewUrl: `http://test/review/${m.docId}` }),
  });
}

describe('one doc per repo+path, across checkouts', () => {
  let tmp: string;
  let dataDir: string;
  let main: string;
  let wt: string;
  let store: DocStore;

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'cw-identity-')));
    dataDir = join(tmp, 'data');
    mkdirSync(dataDir);
    main = join(tmp, 'repo');
    mkdirSync(main);
    git(main, 'init', '-b', 'main');
    git(main, 'remote', 'add', 'origin', 'git@github.com:example/widgets.git');
    mkdirSync(join(main, 'docs'));
    writeFileSync(join(main, 'docs', 'plan.md'), '# Plan\n\nFirst paragraph.\n');
    git(main, 'add', '.');
    git(main, 'commit', '-m', 'init');
    wt = join(tmp, 'wt-feature');
    git(main, 'worktree', 'add', wt, '-b', 'feature');
    store = makeDocStore(dataDir);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const bind = (name: string, root: string) =>
    store.createForCaller(name, {
      type: 'markdown',
      sourceUrl: join(root, 'docs/plan.md'),
    });

  it('a bind from a second checkout attaches to the doc that already exists', () => {
    const first = bind('plan-from-main', main);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.minted).toBe(true);

    const second = bind('plan-from-worktree', wt);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.minted).toBe(false);
    expect(second.doc.docId).toBe(first.doc.docId);
  });

  it('CONTROL: a different file in the same repo still gets its own doc', () => {
    const first = bind('plan', main);
    writeFileSync(join(main, 'docs', 'other.md'), '# Other\n');
    const other = store.createForCaller('other', {
      type: 'markdown',
      sourceUrl: join(main, 'docs/other.md'),
    });
    expect(first.ok && other.ok).toBe(true);
    if (!first.ok || !other.ok) return;
    expect(other.minted).toBe(true);
    expect(other.doc.docId).not.toBe(first.doc.docId);
  });

  it('CONTROL: the same relative path in an UNRELATED repo gets its own doc', () => {
    // Repo+path, not path. Two projects both having `docs/plan.md` is the
    // ordinary case, and merging them would be worse than the bug being fixed.
    const other = join(tmp, 'other-repo');
    mkdirSync(other);
    git(other, 'init', '-b', 'main');
    git(other, 'remote', 'add', 'origin', 'git@github.com:example/gadgets.git');
    mkdirSync(join(other, 'docs'));
    writeFileSync(join(other, 'docs', 'plan.md'), '# Other plan\n');
    const a = bind('widgets-plan', main);
    const b = store.createForCaller('gadgets-plan', {
      type: 'markdown',
      sourceUrl: join(other, 'docs/plan.md'),
    });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(b.doc.docId).not.toBe(a.doc.docId);
  });

  it('a comment left in one checkout is there in the other, and after it is removed', async () => {
    const first = bind('plan-from-main', main);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const docId = first.doc.docId;
    // The route attaches the file after creating the doc; the comment has to
    // anchor into real content, so do what the route does.
    await store.attachFileAsync(docId, join(main, 'docs/plan.md'));
    await store.postComment(
      docId,
      null,
      { id: 'user-test', name: 'Reviewer', kind: 'known', color: '#000' },
      'Does this cover the rollback?',
      // A subject thread: a comment about the document rather than about a
      // phrase in it, which is the shape a review ask on a doc takes.
      { kind: 'subject' },
    );
    expect(store.listThreads(docId).length).toBe(1);

    const second = bind('plan-from-worktree', wt);
    if (!second.ok) return;
    expect(store.listThreads(second.doc.docId).length).toBe(1);

    store.repos.unregisterCheckout(wt);
    git(main, 'worktree', 'remove', wt, '--force');
    expect(existsSync(wt)).toBe(false);

    // Ten tries, as the row asks: a task link opens with its comments after
    // the worktree is gone. Re-binding is how a task link resolves the file.
    for (let i = 0; i < 10; i++) {
      const again = bind(`plan-retry-${i}`, main);
      expect(again.ok).toBe(true);
      if (!again.ok) return;
      expect(again.doc.docId).toBe(docId);
      expect(store.listThreads(again.doc.docId).length).toBe(1);
    }
  });

  it('records the key on the doc, and mints nothing for a file outside a repo', () => {
    const inRepo = bind('plan', main);
    if (!inRepo.ok) return;
    expect(inRepo.doc.meta.docKey).toContain('git:github.com/example/widgets');

    const loose = join(tmp, 'loose.md');
    writeFileSync(loose, '# Loose\n');
    const outside = store.createForCaller('loose', { type: 'markdown', sourceUrl: loose });
    if (!outside.ok) return;
    expect(outside.minted).toBe(true);
    expect(outside.doc.meta.docKey).toBeUndefined();
  });

  it('a purged doc gives its key up, so the next bind does not resurrect its address', () => {
    const first = bind('plan', main);
    if (!first.ok) return;
    const purgedId = first.doc.docId;
    store.purgePersisted(purgedId);
    const again = bind('plan-again', main);
    if (!again.ok) return;
    // Archiving keeps the key — that is what lets an unarchive land back where
    // every link points. A purge is the caller that asked for the bytes to be
    // gone, so re-binding the file must be a NEW document, not the old
    // address re-established over nothing.
    expect(again.doc.docId).not.toBe(purgedId);
    expect(again.minted).toBe(true);
  });

  it('survives a restart: a new store over the same data dir resolves the same doc', () => {
    const first = bind('plan', main);
    if (!first.ok) return;
    const reopened = makeDocStore(dataDir);
    const again = reopened.createForCaller('plan-again', {
      type: 'markdown',
      sourceUrl: join(wt, 'docs/plan.md'),
    });
    if (!again.ok) return;
    expect(again.doc.docId).toBe(first.doc.docId);
  });
});
