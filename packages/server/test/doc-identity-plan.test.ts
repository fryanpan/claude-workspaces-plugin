import { describe, expect, it } from 'bun:test';
import { type DocRow, type PlanIo, planMigration } from '../src/doc-identity-plan.ts';
import { makeDocKey } from '../src/doc-key.ts';

/**
 * What the migration decides, with the filesystem and git replaced by
 * answers a test can dictate.
 *
 * Every one of these is a case the corpus actually contains: a file still
 * where it was, a file git renamed, a checkout that is gone, two documents
 * bound to two checkouts of one file, and four thousand diff documents that
 * must NOT be collapsed onto one key.
 *
 * Fixtures are fictional.
 */

const REPO = 'git:github.com/example/widgets';
const key = (rel: string) => makeDocKey(REPO, rel);

function io(rows: DocRow[], over: Partial<PlanIo> = {}): PlanIo {
  return {
    rows: () => rows,
    keyFor: (abs) => {
      const m = abs.match(/^\/checkouts\/[^/]+\/(.+)$/);
      return m?.[1] ? { repoKey: REPO, relPath: m[1], docKey: key(m[1]) } : null;
    },
    exists: () => true,
    renamedTo: () => null,
    ...over,
  };
}

const row = (over: Partial<DocRow> & { docId: string }): DocRow => ({
  type: 'markdown',
  lastActivityAt: 1,
  threads: 0,
  ...over,
});

describe('planMigration', () => {
  it('claims a key for a prose doc whose file is still there', () => {
    const plan = planMigration(
      io([row({ docId: 'd-one', sourceUrl: '/checkouts/main/docs/plan.md' })]),
    );
    expect(plan.claims).toEqual([
      { docKey: key('docs/plan.md'), docId: 'd-one', aliasKeys: [], via: 'sourceUrl' },
    ]);
    expect(plan.counts.bySourceUrl).toBe(1);
    expect(plan.merges).toEqual([]);
  });

  it('puts two checkouts of one file on one key, newest first', () => {
    const plan = planMigration(
      io([
        row({ docId: 'd-old', sourceUrl: '/checkouts/main/docs/plan.md', lastActivityAt: 100 }),
        row({ docId: 'd-new', sourceUrl: '/checkouts/wt/docs/plan.md', lastActivityAt: 900 }),
      ]),
    );
    expect(plan.claims.map((c) => c.docId)).toEqual(['d-new']);
    expect(plan.merges).toEqual([
      { docKey: key('docs/plan.md'), winner: 'd-new', losers: ['d-old'] },
    ]);
    expect(plan.counts.duplicateKeys).toBe(1);
    expect(plan.counts.docsInMerges).toBe(2);
  });

  it('CONTROL: two docs on different paths are not a merge', () => {
    // Without this, a planner that merged everything into one bucket would
    // pass the case above.
    const plan = planMigration(
      io([
        row({ docId: 'd-a', sourceUrl: '/checkouts/main/docs/plan.md' }),
        row({ docId: 'd-b', sourceUrl: '/checkouts/main/docs/other.md' }),
      ]),
    );
    expect(plan.merges).toEqual([]);
    expect(plan.claims).toHaveLength(2);
  });

  it('follows a rename, and keeps the old key as an alias', () => {
    const plan = planMigration(
      io([row({ docId: 'd-moved', sourceUrl: '/checkouts/main/docs/old-name.md' })], {
        exists: () => false,
        renamedTo: () => 'docs/new-name.md',
      }),
    );
    expect(plan.claims).toEqual([
      {
        docKey: key('docs/new-name.md'),
        docId: 'd-moved',
        // The link somebody saved was against the old path; forgetting it
        // would be the whole feature failing quietly.
        aliasKeys: [key('docs/old-name.md')],
        via: 'rename',
      },
    ]);
    expect(plan.counts.byRename).toBe(1);
    expect(plan.counts.bySourceUrl).toBe(0);
  });

  it('leaves a doc unresolved when the file is gone and git cannot say where', () => {
    const plan = planMigration(
      io([row({ docId: 'd-lost', sourceUrl: '/checkouts/main/docs/vanished.md' })], {
        exists: () => false,
      }),
    );
    // Keeps its id and its comments; claims nothing.
    expect(plan.claims).toEqual([]);
    expect(plan.unresolved).toEqual(['d-lost']);
    expect(plan.counts.unresolved).toBe(1);
  });

  it('leaves a doc unresolved when its checkout is not a repo any more', () => {
    const plan = planMigration(
      io([row({ docId: 'd-orphan', sourceUrl: '/somewhere/else/notes.md' })], {
        keyFor: () => null,
      }),
    );
    expect(plan.unresolved).toEqual(['d-orphan']);
  });

  it('never collapses the diff documents of one file onto one key', () => {
    // Twenty reviews of a file are twenty documents on purpose. This is the
    // case that makes the migration narrower than "every doc with a
    // sourceUrl", and getting it wrong would destroy nineteen reviews.
    const plan = planMigration(
      io([
        row({ docId: 'd-r1', type: 'diff', sourceUrl: '/checkouts/main/src/app.ts' }),
        row({ docId: 'd-r2', type: 'diff', sourceUrl: '/checkouts/main/src/app.ts' }),
        row({ docId: 'd-mock', type: 'mockup', sourceUrl: '/checkouts/main/mock.html' }),
        // POSITIVE CONTROL in the same corpus: the prose doc for that same
        // file DOES claim, so this is not a planner that skips everything.
        row({ docId: 'd-prose', sourceUrl: '/checkouts/main/src/app.ts' }),
      ]),
    );
    expect(plan.merges).toEqual([]);
    expect(plan.claims.map((c) => c.docId)).toEqual(['d-prose']);
    expect(plan.counts.setAddressed).toBe(3);
    expect(plan.counts.prose).toBe(1);
  });

  it('ignores a doc with no source at all', () => {
    const plan = planMigration(io([row({ docId: 'd-board', type: 'workspace' })]));
    expect(plan.counts.withSourceUrl).toBe(0);
    expect(plan.claims).toEqual([]);
    expect(plan.unresolved).toEqual([]);
  });

  it('reports the classes it saw, because they do not add up to one number', () => {
    const plan = planMigration(
      io([
        row({ docId: 'd-1', sourceUrl: '/checkouts/main/a.md' }),
        row({ docId: 'd-2', type: 'diff', sourceUrl: '/checkouts/main/a.md' }),
        row({ docId: 'd-3' }),
      ]),
    );
    expect(plan.counts).toMatchObject({
      rows: 3,
      withSourceUrl: 2,
      prose: 1,
      setAddressed: 1,
      distinctKeys: 1,
    });
  });
});
