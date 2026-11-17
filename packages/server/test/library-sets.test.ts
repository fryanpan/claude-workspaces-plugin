/**
 * `library-sets.ts`: which attachment sets the Library lists, and the one row
 * each becomes. All fixtures synthetic.
 */
import { describe, expect, it } from 'bun:test';
import type { DocMeta } from '@claude-workspaces/core';
import { diffReviewsOn, setRow } from '../src/library-sets.ts';

const member = (docId: string, setId: string, extra: Partial<DocMeta> = {}): DocMeta =>
  ({
    docId,
    type: 'diff',
    setId,
    workspaceId: setId,
    relPath: `src/${docId}.ts`,
    createdAt: 1_000,
    ...extra,
  }) as DocMeta;

describe('diffReviewsOn', () => {
  it('folds a review’s members into one set, oldest created and newest activity', () => {
    const sets = diffReviewsOn(
      [
        member('a', 'riverbend-1', { createdAt: 3_000, lastActivityAt: 9_000 }),
        member('b', 'riverbend-1', { createdAt: 2_000, lastActivityAt: 5_000 }),
      ],
      () => true,
    );
    expect(sets).toEqual([
      { setId: 'riverbend-1', name: 'Diff: riverbend-1', created: 2_000, at: 9_000 },
    ]);
  });

  it('skips a set not on the board, a folder browse, and a plain doc', () => {
    const sets = diffReviewsOn(
      [
        member('a', 'elsewhere'),
        member('b', 'browse', { type: 'markdown' }),
        { docId: 'plain', type: 'markdown', createdAt: 1_000 } as DocMeta,
      ],
      (id) => id !== 'elsewhere',
    );
    expect(sets).toEqual([]);
  });
});

describe('setRow', () => {
  it('opens the review’s own address and carries its id as the row’s doc', () => {
    const row = setRow('w-test', {
      setId: 'saltmarsh-2',
      name: 'Diff: saltmarsh-2',
      created: 1_000,
    });
    expect(row).toEqual({
      name: 'Diff: saltmarsh-2',
      at: 1_000,
      created: 1_000,
      href: '/workspaces/w-test/attachments/saltmarsh-2',
      docId: 'saltmarsh-2',
    });
  });
});
