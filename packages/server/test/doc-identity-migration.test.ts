import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listThreads } from '@claude-workspaces/core';
import { applyPlan, liveIo, readJournal, revert } from '../src/doc-identity-migration.ts';
import { planMigration } from '../src/doc-identity-plan.ts';
import { docKeyForPath } from '../src/doc-key.ts';
import { DocStore } from '../src/doc-store.ts';
import { RepoRegistry } from '../src/repo-registry.ts';
import { SseBus } from '../src/sse.ts';
import { createWebhookDispatcher } from '../src/webhooks.ts';

/**
 * The migration against a real corpus: real `.ydoc` files written by a real
 * DocStore, a real git repo with a real rename, and the registry it files
 * claims into.
 *
 * The planner's decisions are covered by `doc-identity-plan.test.ts`. What is
 * here is everything that only shows up when it touches disk — the claims
 * landing, the conversations arriving, the thread-count parity, the second
 * run changing nothing, and the revert putting identity back.
 *
 * Fixtures are synthetic.
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

const AUTHOR = { id: 'u-tester', name: 'Tester', kind: 'known', color: '#336699' } as const;

describe('the doc-identity migration', () => {
  let tmp: string;
  let dataDir: string;
  let main: string;
  let wt: string;
  const rel = 'docs/plan.md';

  /**
   * Open a store over the data dir, do something, then flush and stop it.
   *
   * Flushing is what puts the `.ydoc` on disk, which is the only thing the
   * migration reads; stopping is what keeps a debounced save from firing
   * after the temp directory is gone and logging a failure into the next
   * test's output.
   */
  const withStore = async <T>(fn: (s: DocStore) => Promise<T> | T): Promise<T> => {
    const s = new DocStore({
      dataDir,
      sse: new SseBus(),
      webhooks: createWebhookDispatcher({ onLog: () => {} }),
      decorateDocMeta: (m) => ({ ...m }),
    });
    try {
      return await fn(s);
    } finally {
      s.flush();
      s.stop();
    }
  };

  /** The comment texts on a document, as the corpus holds them. */
  const commentsOn = (docId: string): Promise<string[]> =>
    withStore((s) =>
      listThreads(s.getOrCreate(docId, {}).ydoc).map((t) => t.comments[0]?.text ?? ''),
    );

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'cw-migrate-')));
    dataDir = join(tmp, 'data');
    mkdirSync(dataDir);
    main = join(tmp, 'repo');
    mkdirSync(main);
    git(main, 'init', '-b', 'main');
    git(main, 'remote', 'add', 'origin', 'git@github.com:example/widgets.git');
    mkdirSync(join(main, 'docs'));
    writeFileSync(join(main, rel), '# Plan\n\nThe cache is warmed at boot.\n');
    git(main, 'add', '.');
    git(main, 'commit', '-m', 'init');
    wt = join(tmp, 'wt-feature');
    git(main, 'worktree', 'add', wt, '-b', 'feature');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  /**
   * Write one pre-migration doc: bound to a path, with a thread on it, and
   * NO key claim — the state every doc in the corpus is in today. The
   * registry file is removed afterwards so nothing is carried in.
   */
  const seedDoc = async (
    docId: string,
    absPath: string,
    threadText: string,
    find: string,
  ): Promise<void> => {
    await withStore(async (s) => {
      s.getOrCreate(docId, { type: 'markdown', sourceUrl: absPath });
      await s.attachFileAsync(docId, absPath);
      const made = await s.createThreadByFind(docId, { find, occurrence: 1 }, AUTHOR, threadText);
      if (!made.ok) throw new Error(`fixture could not open a thread: ${made.error}`);
    });
  };

  it('claims a key for a doc that has none, and leaves its id and comments alone', async () => {
    await seedDoc('d-plan', join(main, rel), 'Why at boot?', 'cache is warmed');
    rmSync(join(dataDir, 'repos.json'), { force: true });

    const registry = new RepoRegistry(dataDir);
    const plan = planMigration(liveIo(dataDir));
    expect(plan.counts.prose).toBe(1);
    const applied = applyPlan(dataDir, plan, registry);
    expect(applied.claimed).toBe(1);

    const parts = docKeyForPath(join(main, rel));
    expect(new RepoRegistry(dataDir).docIdFor(parts?.docKey as string)).toBe('d-plan');
    // The document itself is untouched: same id, same conversation.
    expect(await commentsOn('d-plan')).toEqual(['Why at boot?']);
  });

  it('a migrated doc resolves its copies, without being rewritten to say so', async () => {
    // The point of the whole migration: after it, a doc minted before the
    // feature answers the copies question. It answers it through the
    // registry, because its own meta has no key and rewriting thousands of
    // documents to repeat what one table knows is not worth doing.
    await seedDoc('d-plan', join(main, rel), 'Why at boot?', 'cache is warmed');
    rmSync(join(dataDir, 'repos.json'), { force: true });
    await withStore((s) => {
      // CONTROL: with no claim filed, the doc cannot say where its copies are.
      expect(s.resolveLiveCopy('d-plan')).toEqual({ ok: false, error: 'no-key' });
    });

    applyPlan(dataDir, planMigration(liveIo(dataDir)), new RepoRegistry(dataDir));
    // Registering a checkout is the other half, and it is a person's action:
    // the migration files claims, it does not decide which checkouts on this
    // machine are in play.
    new RepoRegistry(dataDir).registerCheckout(main);

    await withStore((s) => {
      const verdict = s.resolveLiveCopy('d-plan');
      expect(verdict.ok).toBe(true);
      if (!verdict.ok) return;
      // Both checkouts hold the file, both are surveyed, and the copy it
      // will read and write is one of them. Which one is the copies layer's
      // call — here the two are byte-identical, so either is right.
      expect(verdict.survey.copies.map((c) => c.root).sort()).toEqual([main, wt].sort());
      expect(verdict.live).not.toBeNull();
      expect([join(main, rel), join(wt, rel)]).toContain(verdict.live as string);
    });
  });

  it('a second run changes nothing', async () => {
    await seedDoc('d-plan', join(main, rel), 'Why at boot?', 'cache is warmed');
    rmSync(join(dataDir, 'repos.json'), { force: true });
    const first = applyPlan(dataDir, planMigration(liveIo(dataDir)), new RepoRegistry(dataDir));
    expect(first.claimed).toBe(1);

    const second = applyPlan(dataDir, planMigration(liveIo(dataDir)), new RepoRegistry(dataDir));
    // Nothing new claimed, nothing repointed, no thread copied twice.
    expect(second.claimed).toBe(0);
    expect(second.alreadyHeld).toBe(1);
    expect(second.threadsCopied).toBe(0);
  });

  it('merges two checkouts of one file onto the newer doc, losing no thread', async () => {
    // The older doc's thread quotes a line the newer copy still has; the
    // second quotes one it does not, so both halves of ruling 2 are exercised
    // in one merge.
    writeFileSync(join(wt, rel), '# Plan\n\nThe cache is warmed at boot.\n\nRetired sentence.\n');
    await seedDoc('d-wt-a', join(wt, rel), 'Still true?', 'cache is warmed');
    await seedDoc('d-wt-b', join(wt, rel), 'And this one?', 'Retired sentence');
    // The main checkout's doc is the newer one, and its copy has dropped the
    // retired sentence.
    await seedDoc('d-main', join(main, rel), 'The live one', 'cache is warmed');
    rmSync(join(dataDir, 'repos.json'), { force: true });

    const plan = planMigration(liveIo(dataDir));
    expect(plan.merges).toHaveLength(1);
    const merge = plan.merges[0];
    expect(merge?.winner).toBe('d-main');
    expect(merge?.losers.sort()).toEqual(['d-wt-a', 'd-wt-b']);

    const applied = applyPlan(dataDir, plan, new RepoRegistry(dataDir));
    expect(applied.merged).toBe(1);
    expect(applied.threadsCopied).toBe(2);
    // One of the two had no text in the winner: it is an outdated comment,
    // not a lost one.
    expect(applied.threadsOrphaned).toBe(1);
    // PARITY: three threads existed, three are addressable in the winner.
    expect(applied.parity).toEqual([{ docKey: merge?.docKey as string, before: 3, after: 3 }]);

    expect((await commentsOn('d-main')).sort()).toEqual([
      'And this one?',
      'Still true?',
      'The live one',
    ]);
    // And the losers keep their own copies — nothing was moved, so a link
    // saved against either still opens a page with its comments on it.
    expect(await commentsOn('d-wt-a')).toEqual(['Still true?']);
  });

  it('refuses to finish a merge that lost a thread', async () => {
    // The parity assertion, driven by a merger that drops the conversation
    // instead of copying it. Nothing a later read could tell you: a run that
    // should have stopped leaves a corpus that looks perfectly consistent.
    writeFileSync(join(wt, rel), '# Plan\n\nThe cache is warmed at boot.\n');
    await seedDoc('d-wt-a', join(wt, rel), 'From the branch', 'cache is warmed');
    await seedDoc('d-main', join(main, rel), 'From main', 'cache is warmed');
    rmSync(join(dataDir, 'repos.json'), { force: true });
    const plan = planMigration(liveIo(dataDir));

    const losesEverything = () => ({
      seen: 1,
      copied: 0,
      reanchored: 0,
      orphaned: 0,
      skipped: 0,
    });
    expect(() => applyPlan(dataDir, plan, new RepoRegistry(dataDir), losesEverything)).toThrow(
      /parity failed/,
    );
    // CONTROL: the same plan through the real merger completes.
    const ok = applyPlan(dataDir, plan, new RepoRegistry(dataDir));
    expect(ok.merged).toBe(1);
  });

  it('follows a rename and keeps the old path resolving', async () => {
    await seedDoc('d-renamed', join(main, rel), 'Before the move', 'cache is warmed');
    rmSync(join(dataDir, 'repos.json'), { force: true });
    git(main, 'mv', rel, 'docs/roadmap.md');
    git(main, 'commit', '-m', 'rename');
    // The worktree still holds a copy at the old path; take it out of the
    // picture so this test is about the rename alone.
    rmSync(wt, { recursive: true, force: true });
    git(main, 'worktree', 'prune');

    const plan = planMigration(liveIo(dataDir));
    expect(plan.counts.byRename).toBe(1);
    applyPlan(dataDir, plan, new RepoRegistry(dataDir));

    const registry = new RepoRegistry(dataDir);
    const parts = docKeyForPath(join(main, 'docs/roadmap.md'));
    expect(registry.docIdFor(parts?.docKey as string)).toBe('d-renamed');
    // The old key still resolves — through the alias, not by chance.
    expect(registry.docIdFor(plan.claims[0]?.aliasKeys[0] as string)).toBe('d-renamed');
  });

  it('leaves a doc whose file is nowhere with its id and its comments', async () => {
    await seedDoc('d-gone', join(main, rel), 'Still worth reading', 'cache is warmed');
    rmSync(join(dataDir, 'repos.json'), { force: true });
    rmSync(join(main, rel));
    rmSync(join(wt, rel));

    const plan = planMigration(liveIo(dataDir));
    expect(plan.unresolved).toEqual(['d-gone']);
    applyPlan(dataDir, plan, new RepoRegistry(dataDir));
    expect(new RepoRegistry(dataDir).keysFor('d-gone')).toEqual([]);
    expect(await commentsOn('d-gone')).toEqual(['Still worth reading']);
  });

  it('reverts the claims, and says what it left behind', async () => {
    writeFileSync(join(wt, rel), '# Plan\n\nThe cache is warmed at boot.\n');
    await seedDoc('d-wt-a', join(wt, rel), 'From the branch', 'cache is warmed');
    await seedDoc('d-main', join(main, rel), 'From main', 'cache is warmed');
    rmSync(join(dataDir, 'repos.json'), { force: true });
    const plan = planMigration(liveIo(dataDir));
    applyPlan(dataDir, plan, new RepoRegistry(dataDir));
    const parts = docKeyForPath(join(main, rel));
    // Positive control: the claim IS there before the revert.
    expect(new RepoRegistry(dataDir).docIdFor(parts?.docKey as string)).toBeDefined();

    const res = revert(dataDir, new RepoRegistry(dataDir));
    expect(res.released).toBeGreaterThan(0);
    expect(new RepoRegistry(dataDir).docIdFor(parts?.docKey as string)).toBeUndefined();
    // The copied conversation stays: undoing a copy means deleting threads,
    // and by then somebody may have replied on one.
    expect(res.mergesLeftInPlace).toBe(1);
    expect(readJournal(dataDir).runs).toEqual([]);
    expect((await commentsOn('d-main')).sort()).toEqual(['From main', 'From the branch']);
  });

  it('leaves a claim it did not make, and merges into the doc that holds it', async () => {
    // The live server bound this file from the worktree while the corpus was
    // being read, so the key is already spoken for when the run starts. The
    // key does not move, the conversation goes to the doc the key opens, and
    // a revert afterwards must not take somebody else's identity with it.
    writeFileSync(join(wt, rel), '# Plan\n\nThe cache is warmed at boot.\n');
    await seedDoc('d-wt-a', join(wt, rel), 'From the branch', 'cache is warmed');
    await seedDoc('d-main', join(main, rel), 'From main', 'cache is warmed');
    rmSync(join(dataDir, 'repos.json'), { force: true });
    const plan = planMigration(liveIo(dataDir));
    // The plan picked the newer doc; the live server had already claimed the
    // key for the older one.
    expect(plan.claims[0]?.docId).toBe('d-main');
    const docKey = docKeyForPath(join(main, rel))?.docKey as string;
    const live = new RepoRegistry(dataDir);
    live.claim(docKey, 'd-wt-a');

    const applied = applyPlan(dataDir, plan, new RepoRegistry(dataDir));
    expect(applied.claimed).toBe(0);
    expect(applied.alreadyHeld).toBe(1);
    expect(applied.conflicts).toBe(1);
    // The key still opens the doc that held it, and that doc now carries both
    // conversations — the canonical document is never the one without them.
    expect(new RepoRegistry(dataDir).docIdFor(docKey)).toBe('d-wt-a');
    expect((await commentsOn('d-wt-a')).sort()).toEqual(['From main', 'From the branch']);

    const res = revert(dataDir, new RepoRegistry(dataDir));
    expect(res.released).toBe(0);
    // CONTROL: the pre-existing claim survived the revert. Releasing it would
    // leave the file with no identity, and the next bind would mint a second
    // document for it.
    expect(new RepoRegistry(dataDir).docIdFor(docKey)).toBe('d-wt-a');
  });

  it('merges into a holder the corpus walk never saw', async () => {
    // Same conflict, without a merge in the plan: one document for the key,
    // and a different document already holding it.
    await seedDoc('d-main', join(main, rel), 'From main', 'cache is warmed');
    await seedDoc('d-other', join(wt, rel), 'From elsewhere', 'cache is warmed');
    rmSync(join(dataDir, 'repos.json'), { force: true });
    rmSync(join(wt, rel));
    const plan = planMigration(liveIo(dataDir));
    expect(plan.merges).toEqual([]);
    expect(plan.claims.map((c) => c.docId)).toEqual(['d-main']);

    const docKey = docKeyForPath(join(main, rel))?.docKey as string;
    new RepoRegistry(dataDir).claim(docKey, 'd-other');
    const applied = applyPlan(dataDir, plan, new RepoRegistry(dataDir));
    expect(applied.conflicts).toBe(1);
    expect(applied.merged).toBe(1);
    expect((await commentsOn('d-other')).sort()).toEqual(['From elsewhere', 'From main']);
    expect(await commentsOn('d-main')).toEqual(['From main']);
  });

  it('refuses a rename alias when another doc already holds the new path', async () => {
    // The file moved, and something else has already claimed where it moved
    // to. Recording the alias would point every link saved against the old
    // path at that other document.
    await seedDoc('d-moved', join(main, rel), 'Before the move', 'cache is warmed');
    rmSync(join(dataDir, 'repos.json'), { force: true });
    git(main, 'mv', rel, 'docs/roadmap.md');
    git(main, 'commit', '-m', 'rename');
    rmSync(wt, { recursive: true, force: true });
    git(main, 'worktree', 'prune');

    const plan = planMigration(liveIo(dataDir));
    expect(plan.counts.byRename).toBe(1);
    const oldKey = plan.claims[0]?.aliasKeys[0] as string;
    const newKey = plan.claims[0]?.docKey as string;
    const registry = new RepoRegistry(dataDir);
    registry.claim(oldKey, 'd-occupant');

    const applied = applyPlan(dataDir, plan, new RepoRegistry(dataDir));
    expect(applied.aliasesRefused).toBe(1);
    expect(applied.aliased).toBe(0);
    // Both keys keep their own document. Nothing was silently repointed.
    const after = new RepoRegistry(dataDir);
    expect(after.docIdFor(oldKey)).toBe('d-occupant');
    expect(after.docIdFor(newKey)).toBe('d-moved');
  });

  it('records what it did, so a person can see it afterwards', async () => {
    await seedDoc('d-plan', join(main, rel), 'Why at boot?', 'cache is warmed');
    rmSync(join(dataDir, 'repos.json'), { force: true });
    applyPlan(dataDir, planMigration(liveIo(dataDir)), new RepoRegistry(dataDir));
    const journal = readJournal(dataDir);
    expect(journal.runs).toHaveLength(1);
    expect(journal.runs[0]?.claims.map((c) => c.docId)).toEqual(['d-plan']);
  });
});
