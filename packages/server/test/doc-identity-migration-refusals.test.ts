/**
 * The migration's refusals: every state where it must write NOTHING.
 *
 * Split out of `doc-identity-migration.test.ts` when that file crossed 500
 * lines, and it is a real seam rather than a slice — the other file asserts
 * what a run does, and this one asserts what a run refuses to do when a
 * document cannot be read, a merge fails parity, or the record cannot be
 * written. It carries the same fixture, because the subject is the same
 * corpus.
 *
 * Fixtures are synthetic.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listThreads } from '@claude-workspaces/core';
import { readJournal, revert } from '../src/doc-identity-journal.ts';
import { applyPlan, liveIo, reportLines } from '../src/doc-identity-migration.ts';
import { planMigration } from '../src/doc-identity-plan.ts';
import { readDocIndex } from '../src/doc-index.ts';
import { DocStore } from '../src/doc-store.ts';
import { RepoRegistry } from '../src/repo-registry.ts';
import { SseBus } from '../src/sse.ts';
import { createWebhookDispatcher } from '../src/webhooks.ts';

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

describe('what the doc-identity migration refuses to do', () => {
  let tmp: string;
  let dataDir: string;
  let main: string;
  let wt: string;
  const rel = 'docs/plan.md';

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
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'cw-migrate-refuse-')));
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

  /** One pre-migration doc: bound to a path, with a thread, and no claim. */
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

  it('a refused run files no key and journals nothing', async () => {
    // The claims used to be persisted the moment they were filed, so a merge
    // that failed parity left the registry holding keys the journal never
    // recorded: filed, unrevertable, and pointing at documents whose
    // conversations had not been copied. The whole run commits or none of it
    // does.
    writeFileSync(join(wt, rel), '# Plan\n\nThe cache is warmed at boot.\n');
    await seedDoc('d-wt-a', join(wt, rel), 'From the branch', 'cache is warmed');
    await seedDoc('d-main', join(main, rel), 'From main', 'cache is warmed');
    rmSync(join(dataDir, 'repos.json'), { force: true });
    const plan = planMigration(liveIo(dataDir));
    const docKey = plan.claims[0]?.docKey as string;
    const losesEverything = () => ({ seen: 1, copied: 0, reanchored: 0, orphaned: 0, skipped: 0 });

    const registry = new RepoRegistry(dataDir);
    expect(() => applyPlan(dataDir, plan, registry, losesEverything)).toThrow(/parity failed/);
    expect(registry.docIdFor(docKey)).toBeUndefined();
    // On disk too — a registry reopened over the same data dir is what the
    // next server boot reads.
    expect(new RepoRegistry(dataDir).docIdFor(docKey)).toBeUndefined();
    expect(readJournal(dataDir).runs).toEqual([]);

    // CONTROL: the same plan through the real merger commits both records.
    const ok = applyPlan(dataDir, plan, new RepoRegistry(dataDir));
    expect(ok.merged).toBe(1);
    expect(new RepoRegistry(dataDir).docIdFor(docKey)).toBe('d-main');
    expect(readJournal(dataDir).runs).toHaveLength(1);
  });

  it('rolls the claims back when the journal cannot be written', async () => {
    // The record and the claims commit together. A run whose journal write
    // fails must leave no key filed, because a filed key with no journal
    // entry is one `--revert` can never give back.
    await seedDoc('d-plan', join(main, rel), 'Why at boot?', 'cache is warmed');
    rmSync(join(dataDir, 'repos.json'), { force: true });
    const plan = planMigration(liveIo(dataDir));
    const docKey = plan.claims[0]?.docKey as string;
    // A directory where the journal's TEMP file goes: the write throws while
    // the read still answers "no journal yet", which is the state this is
    // about. Nothing in the corpus had to be broken to make it.
    mkdirSync(join(dataDir, 'doc-identity-migration.json.tmp'));

    const registry = new RepoRegistry(dataDir);
    expect(() => applyPlan(dataDir, plan, registry)).toThrow();
    expect(registry.docIdFor(docKey)).toBeUndefined();
    expect(new RepoRegistry(dataDir).docIdFor(docKey)).toBeUndefined();
  });

  it('refuses to run over a journal it cannot read, and leaves it alone', async () => {
    // The journal is the only record of what earlier runs filed. Reading a
    // damaged one as empty is how the next apply overwrites it, and the keys
    // those runs claimed are then filed with nothing able to release them.
    await seedDoc('d-plan', join(main, rel), 'Why at boot?', 'cache is warmed');
    rmSync(join(dataDir, 'repos.json'), { force: true });
    const plan = planMigration(liveIo(dataDir));
    const docKey = plan.claims[0]?.docKey as string;
    const journalPath = join(dataDir, 'doc-identity-migration.json');
    const damaged = '{"version":1,"runs":[{"ranAt":1,"keysFiled":["a b';
    writeFileSync(journalPath, damaged);

    const registry = new RepoRegistry(dataDir);
    expect(() => applyPlan(dataDir, plan, registry)).toThrow(/did not parse/);
    // Nothing filed, and the record is byte-for-byte what it was.
    expect(registry.docIdFor(docKey)).toBeUndefined();
    expect(readFileSync(journalPath, 'utf8')).toBe(damaged);
    // A revert refuses for the same reason: the file it cannot read is the
    // list of what it would be allowed to release.
    expect(() => revert(dataDir, new RepoRegistry(dataDir))).toThrow(/did not parse/);

    // CONTROL: with the damaged file moved aside, the same plan runs.
    rmSync(journalPath);
    expect(applyPlan(dataDir, plan, new RepoRegistry(dataDir)).claimed).toBe(1);
  });

  it('rolls the journal entry back when the registry cannot be written', async () => {
    // The other half of one commit point: a run that journals its claims and
    // then fails to file them would report success and lose them at the next
    // restart.
    await seedDoc('d-plan', join(main, rel), 'Why at boot?', 'cache is warmed');
    rmSync(join(dataDir, 'repos.json'), { force: true });
    const plan = planMigration(liveIo(dataDir));
    const docKey = plan.claims[0]?.docKey as string;
    // A directory where the registry's temp file goes: the batch commit
    // fails, and nothing about the corpus had to be broken to arrange it.
    mkdirSync(join(dataDir, 'repos.json.tmp'));

    expect(() => applyPlan(dataDir, plan, new RepoRegistry(dataDir))).toThrow(
      /could not write|not committed/,
    );
    expect(new RepoRegistry(dataDir).docIdFor(docKey)).toBeUndefined();
    // And the record does not claim a run that did not happen.
    expect(readJournal(dataDir).runs).toEqual([]);
  });

  it('files no claim for a document it cannot read, and says which', async () => {
    // A key is a promise that it opens a document. Filing one for a corrupt
    // `.ydoc` makes a dead end that first-writer-wins never lets go of, so
    // the claim is refused before the registry is touched at all.
    await seedDoc('d-plan', join(main, rel), 'Why at boot?', 'cache is warmed');
    rmSync(join(dataDir, 'repos.json'), { force: true });
    const plan = planMigration(liveIo(dataDir));
    expect(plan.claims).toHaveLength(1);
    const docKey = plan.claims[0]?.docKey as string;
    writeFileSync(join(dataDir, 'd-plan.ydoc'), Buffer.from([0xff, 0xff, 0xff, 0xff]));

    const registry = new RepoRegistry(dataDir);
    const applied = applyPlan(dataDir, plan, registry);
    expect(applied.claimed).toBe(0);
    expect(applied.refusedClaims).toEqual([{ docKey, docId: 'd-plan' }]);
    // The registry is untouched, so the key is still free for the document
    // that can actually be read once somebody restores it.
    expect(registry.docIdFor(docKey)).toBeUndefined();
    expect(reportLines(plan, applied).join('\n')).toContain('claims refused, doc unreadable 1');
  });

  it('CONTROL: the same plan over a readable document files its claim', async () => {
    // Without this, the refusal above would pass against an applyPlan that
    // had simply stopped claiming anything.
    await seedDoc('d-plan', join(main, rel), 'Why at boot?', 'cache is warmed');
    rmSync(join(dataDir, 'repos.json'), { force: true });
    const plan = planMigration(liveIo(dataDir));
    const registry = new RepoRegistry(dataDir);
    const applied = applyPlan(dataDir, plan, registry);
    expect(applied.claimed).toBe(1);
    expect(applied.refusedClaims).toEqual([]);
    expect(registry.docIdFor(plan.claims[0]?.docKey as string)).toBe('d-plan');
  });

  it('leaves a merge undone rather than pointing a key at an unreadable winner', async () => {
    writeFileSync(join(wt, rel), '# Plan\n\nThe cache is warmed at boot.\n');
    await seedDoc('d-wt-a', join(wt, rel), 'From the branch', 'cache is warmed');
    await seedDoc('d-main', join(main, rel), 'From main', 'cache is warmed');
    rmSync(join(dataDir, 'repos.json'), { force: true });
    const plan = planMigration(liveIo(dataDir));
    expect(plan.merges[0]?.winner).toBe('d-main');
    writeFileSync(join(dataDir, 'd-main.ydoc'), Buffer.from([0x00, 0x01]));

    const applied = applyPlan(dataDir, plan, new RepoRegistry(dataDir));
    expect(applied.merged).toBe(0);
    expect(applied.refusedClaims.map((r) => r.docId)).toEqual(['d-main']);
    // The loser keeps every thread it had: nothing was copied into a document
    // nobody can open, and nothing was thrown away trying.
    expect(await commentsOn('d-wt-a')).toEqual(['From the branch']);
  });

  it('leaves the winner index row reporting what the .ydoc now holds', async () => {
    // The row is what the board's badges and a lazy boot read. A winner that
    // gained a conversation used to keep reporting its old total until an
    // unrelated write, which for a document nobody opens is never.
    writeFileSync(join(wt, rel), '# Plan\n\nThe cache is warmed at boot.\n');
    await seedDoc('d-wt-a', join(wt, rel), 'From the branch', 'cache is warmed');
    await seedDoc('d-main', join(main, rel), 'From main', 'cache is warmed');
    rmSync(join(dataDir, 'repos.json'), { force: true });
    const before = readDocIndex(dataDir, 'd-main');
    expect(before?.threads.total).toBe(1);

    const applied = applyPlan(dataDir, planMigration(liveIo(dataDir)), new RepoRegistry(dataDir));
    expect(applied.threadsCopied).toBe(1);
    expect(applied.indexRowsRefreshed).toBe(1);
    const after = readDocIndex(dataDir, 'd-main');
    expect(after?.threads.total).toBe(2);
    expect(after?.threads.open).toBe(2);
    // The row's own server-side fields survive the refresh — it is repaired,
    // not rebuilt from the CRDT meta, which does not carry them.
    expect(after?.meta.sourceUrl).toBe(before?.meta.sourceUrl as string);
    // CONTROL: the loser was not merged INTO, so its row is untouched.
    expect(readDocIndex(dataDir, 'd-wt-a')?.threads.total).toBe(1);
  });
  it('leaves no half-written record behind: the journal and the winner are renamed into place', async () => {
    // Both writers used to put the bytes in a temp file and then COPY them
    // over the real one, which is a window where the journal is half a file
    // and the winner's `.ydoc` is a truncated document — the one record in
    // this run that cannot be rebuilt from anywhere else. A rename leaves
    // nothing beside the target, which is what this reads.
    writeFileSync(join(wt, rel), '# Plan\n\nThe cache is warmed at boot.\n');
    await seedDoc('d-wt-a', join(wt, rel), 'From the branch', 'cache is warmed');
    await seedDoc('d-main', join(main, rel), 'From main', 'cache is warmed');
    rmSync(join(dataDir, 'repos.json'), { force: true });

    const applied = applyPlan(dataDir, planMigration(liveIo(dataDir)), new RepoRegistry(dataDir));
    expect(applied.merged).toBe(1);
    const leftovers = readdirSync(dataDir).filter(
      (f) => f.endsWith('.tmp') || f.endsWith('.migrating'),
    );
    expect(leftovers).toEqual([]);
    // CONTROL: the files those temps would have been named after are there,
    // so an empty list is a clean rename and not an empty data dir.
    expect(readdirSync(dataDir)).toContain('doc-identity-migration.json');
    expect(readdirSync(dataDir)).toContain('d-main.ydoc');
  });
});
