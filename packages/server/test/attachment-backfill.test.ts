import { describe, expect, it } from 'bun:test';
import type { DocMeta } from '@claude-workspaces/core';
import {
  attachmentIdsNeedingFiling,
  backfillAttachmentFiling,
  docIdsNeedingFiling,
} from '../src/attachment-backfill.ts';

const doc = (over: Partial<DocMeta>): DocMeta => ({
  docId: over.docId ?? 'd',
  type: 'markdown',
  createdAt: 0,
  ...over,
});

describe('attachmentIdsNeedingFiling', () => {
  it('names each attachment set exactly once, however many members it has', () => {
    const ids = attachmentIdsNeedingFiling(
      [
        doc({ docId: 'r:a', setId: 'r', relPath: 'a.ts' }),
        doc({ docId: 'r:b', setId: 'r', relPath: 'b.ts' }),
        doc({ docId: 'r:c', setId: 'r', relPath: 'c.ts' }),
      ],
      () => false,
    );
    expect(ids).toEqual(['r']);
  });

  it('skips an attachment set already filed on a workspace', () => {
    const docs = [doc({ docId: 'r:a', setId: 'r', relPath: 'a.ts' })];
    expect(attachmentIdsNeedingFiling(docs, (id) => id === 'r')).toEqual([]);
  });

  it('skips a batch-registered set, which is not an attachment set', () => {
    // setId without relPath: docs registered together for one sidebar. Filing
    // them would put rows on a board for things that are not attachment sets.
    const docs = [doc({ docId: 'n1', setId: 'notes' }), doc({ docId: 'n2', setId: 'notes' })];
    expect(attachmentIdsNeedingFiling(docs, () => false)).toEqual([]);
  });

  it('skips standalone docs', () => {
    expect(attachmentIdsNeedingFiling([doc({ docId: 'plain' })], () => false)).toEqual([]);
  });

  it('finds a member that carries only the deprecated field', () => {
    const docs = [doc({ docId: 'r:a', workspaceId: 'r', relPath: 'a.ts' })];
    expect(attachmentIdsNeedingFiling(docs, () => false)).toEqual(['r']);
  });

  it('returns ids in a stable order so two boots agree', () => {
    const docs = [
      doc({ docId: 'z:a', setId: 'zeta', relPath: 'a.ts' }),
      doc({ docId: 'a:a', setId: 'alpha', relPath: 'a.ts' }),
      doc({ docId: 'm:a', setId: 'mu', relPath: 'a.ts' }),
    ];
    expect(attachmentIdsNeedingFiling(docs, () => false)).toEqual(['alpha', 'mu', 'zeta']);
  });
});

describe('docIdsNeedingFiling — a doc that holds content has a board', () => {
  it('names a standalone markdown doc no board holds', () => {
    expect(docIdsNeedingFiling([doc({ docId: 'plain' })], () => false)).toEqual(['plain']);
  });

  it('names a batch-registered member whose setId no board holds either', () => {
    // The 14 live cases: `setId` without `relPath` is not an attachment set,
    // so the set pass skips it, and nothing held the set — no address at all.
    const docs = [doc({ docId: 'n1', setId: 'notes' }), doc({ docId: 'n2', setId: 'notes' })];
    expect(docIdsNeedingFiling(docs, () => false)).toEqual(['n1', 'n2']);
  });

  it('leaves a batch member alone when a board holds its setId', () => {
    // `shareWorkspacesOf` reads the same field, so the doc IS addressed.
    const docs = [doc({ docId: 'n1', setId: 'notes' })];
    expect(docIdsNeedingFiling(docs, (id) => id === 'notes')).toEqual([]);
  });

  it('leaves an attachment member to the set pass', () => {
    const docs = [doc({ docId: 'r:a', setId: 'r', relPath: 'a.ts' })];
    expect(docIdsNeedingFiling(docs, () => false)).toEqual([]);
  });

  it('skips a mockup with no source — it has no page whichever board held it', () => {
    expect(docIdsNeedingFiling([doc({ docId: 'm', type: 'mockup' })], () => false)).toEqual([]);
    expect(
      docIdsNeedingFiling([doc({ docId: 'm', type: 'mockup', sourceUrl: '/x.html' })], () => false),
    ).toEqual(['m']);
  });

  it("skips a board's own docs — they are addressed by their row", () => {
    const docs = [doc({ docId: 'ws:w-1', type: 'workspace' }), doc({ docId: 'task:t-1' })];
    expect(docIdsNeedingFiling(docs, () => false)).toEqual([]);
  });

  it('skips a doc already filed', () => {
    expect(docIdsNeedingFiling([doc({ docId: 'plain' })], (id) => id === 'plain')).toEqual([]);
  });
});

describe('backfillAttachmentFiling', () => {
  it('files a standalone doc by its own id, after the sets', () => {
    const res = backfillAttachmentFiling({
      docs: () => [doc({ docId: 'plain' }), doc({ docId: 'r:a', setId: 'r', relPath: 'a.ts' })],
      isFiled: () => false,
      file: () => 'w-default',
    });
    expect(res.filed).toEqual([
      { attachmentId: 'r', workspaceId: 'w-default' },
      { attachmentId: 'plain', workspaceId: 'w-default' },
    ]);
  });

  it('files an orphan attachment set and reports where it went', () => {
    const filed: Array<[string, string]> = [];
    const res = backfillAttachmentFiling({
      docs: () => [doc({ docId: 'r:a', setId: 'r', relPath: 'a.ts' })],
      isFiled: () => false,
      file: (id) => {
        filed.push([id, 'w-default']);
        return 'w-default';
      },
    });
    expect(filed).toEqual([['r', 'w-default']]);
    expect(res.filed).toEqual([{ attachmentId: 'r', workspaceId: 'w-default' }]);
  });

  it('is a no-op on the second boot — the whole point, since it runs at every start', () => {
    const store = new Set<string>();
    const docs = () => [doc({ docId: 'r:a', setId: 'r', relPath: 'a.ts' })];
    const deps = {
      docs,
      isFiled: (id: string) => store.has(id),
      file: (id: string) => {
        store.add(id);
        return 'w-default';
      },
    };
    const first = backfillAttachmentFiling(deps);
    const second = backfillAttachmentFiling(deps);
    expect(first.filed).toHaveLength(1);
    expect(second.filed).toHaveLength(0);
    expect(store.size).toBe(1);
  });

  it('never writes when everything is already filed', () => {
    let writes = 0;
    const res = backfillAttachmentFiling({
      docs: () => [doc({ docId: 'r:a', setId: 'r', relPath: 'a.ts' })],
      isFiled: () => true,
      file: () => {
        writes += 1;
        return 'w';
      },
    });
    expect(writes).toBe(0);
    expect(res.filed).toEqual([]);
  });

  it('keeps going when one attachment set fails to file', () => {
    // A single bad attachment set must not stop the boot or strand the rest.
    const res = backfillAttachmentFiling({
      docs: () => [
        doc({ docId: 'a:x', setId: 'a', relPath: 'x.ts' }),
        doc({ docId: 'b:x', setId: 'b', relPath: 'x.ts' }),
      ],
      isFiled: () => false,
      file: (id) => {
        if (id === 'a') throw new Error('store unavailable');
        return 'w';
      },
    });
    expect(res.filed).toEqual([{ attachmentId: 'b', workspaceId: 'w' }]);
    expect(res.failed).toEqual(['a']);
  });
});
