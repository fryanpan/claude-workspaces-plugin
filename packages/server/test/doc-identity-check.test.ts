/**
 * The after-the-fact check on a finished migration.
 *
 * The subject is what a lost write looks like from outside the run: the
 * journal says a merge happened, the loser still holds the threads it was
 * merged from, and the winner does not hold them any more. Nothing inside the
 * run can see that, because whatever overwrote the winner did it later.
 *
 * Fixtures are synthetic documents with fictional authors.
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createThread } from '@claude-workspaces/core';
import * as Y from 'yjs';
import { checkLines, checkMerges } from '../src/doc-identity-check.ts';
import type { Journal } from '../src/doc-identity-journal.ts';

const AUTHOR = { id: 'u-rin', name: 'Rin Adeyemi', kind: 'known' as const, color: '#4f7' };

function writeDoc(dataDir: string, docId: string, threadIds: string[]): void {
  const doc = new Y.Doc();
  for (const id of threadIds) {
    createThread(doc, {
      threadId: id,
      anchor: { kind: 'subject' },
      createdBy: AUTHOR,
      firstComment: { id: `c-${id}`, text: 'a comment' },
    });
  }
  writeFileSync(join(dataDir, `${docId}.ydoc`), Y.encodeStateAsUpdate(doc));
}

function writeJournalWith(
  dataDir: string,
  merges: Array<{ winner: string; losers: string[] }>,
): void {
  const journal: Journal = {
    version: 1,
    runs: [
      {
        ranAt: 1,
        claims: [],
        keysFiled: [],
        merges: merges.map((m) => ({
          docKey: 'git:example.test/plan docs/plan.md',
          winner: m.winner,
          losers: m.losers,
          copied: 0,
          reanchored: 0,
          orphaned: 0,
          skipped: 0,
        })),
        unresolved: [],
      },
    ],
  };
  writeFileSync(join(dataDir, 'doc-identity-migration.json'), JSON.stringify(journal));
}

function withDataDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'cw-idcheck-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('checkMerges', () => {
  it('passes when every thread a loser holds is in the winner', () => {
    withDataDir((dir) => {
      writeDoc(dir, 'd-winner', ['t-own', 't-from-a', 't-from-b']);
      writeDoc(dir, 'd-loser-a', ['t-from-a']);
      writeDoc(dir, 'd-loser-b', ['t-from-b']);
      writeJournalWith(dir, [{ winner: 'd-winner', losers: ['d-loser-a', 'd-loser-b'] }]);

      const res = checkMerges(dir);
      expect(res.ok).toBe(true);
      expect(res.expected).toBe(2);
      expect(res.present).toBe(2);
      // The winner's OWN thread is not expected of it: the losers are the
      // question, and counting the winner's own would pass vacuously.
      expect(res.winners[0]?.missing).toEqual([]);
    });
  });

  it('names the threads a winner lost after the run', () => {
    withDataDir((dir) => {
      // The state this exists for: the merge happened, then something wrote
      // an older copy of the winner back over it.
      writeDoc(dir, 'd-winner', ['t-own']);
      writeDoc(dir, 'd-loser-a', ['t-from-a', 't-from-b']);
      writeJournalWith(dir, [{ winner: 'd-winner', losers: ['d-loser-a'] }]);

      const res = checkMerges(dir);
      expect(res.ok).toBe(false);
      expect(res.expected).toBe(2);
      expect(res.present).toBe(0);
      expect(res.winners[0]?.missing.sort()).toEqual(['t-from-a', 't-from-b']);
      // The report says which winner and which threads, and nothing else.
      const text = checkLines(res).join('\n');
      expect(text).toContain('MISSING');
      expect(text).toContain('t-from-a');
      expect(text).not.toContain('a comment');
    });
  });

  it('reports an unreadable .ydoc rather than concluding from it', () => {
    withDataDir((dir) => {
      writeDoc(dir, 'd-winner', ['t-own']);
      writeFileSync(join(dir, 'd-loser-a.ydoc'), Buffer.from([0x00, 0x01]));
      writeJournalWith(dir, [{ winner: 'd-winner', losers: ['d-loser-a'] }]);

      const res = checkMerges(dir);
      // An unopenable loser proves nothing about the winner, so it is not
      // counted as a missing thread, but it does deny the run a pass.
      expect(res.winners[0]?.missing).toEqual([]);
      expect(res.winners[0]?.unreadable).toEqual(['d-loser-a']);
      expect(res.ok).toBe(false);
    });
  });

  it('says nothing happened when no run has been journalled', () => {
    withDataDir((dir) => {
      // CONTROL: an empty answer comes from an empty journal, not from a
      // check that cannot see anything. The failing case above proves it can.
      const res = checkMerges(dir);
      expect(res).toMatchObject({ runs: 0, expected: 0, present: 0, ok: true });
      expect(checkLines(res)[0]).toBe('0 merged winner(s) across 0 run(s).');
    });
  });
});
