/**
 * A bound file that comes back SHORT does not take the doc's words with it.
 *
 * The disk→doc arbitration has one arm — `apply` — that replaces the live
 * doc's blocks with the file's, and it is reached whenever the doc equals
 * what the server last wrote and the file has since changed. It cannot tell
 * WHY the file changed. A person editing in VS Code and a cloud-sync provider
 * handing back the revision it held an hour ago produce the same stat and the
 * same bytes; so does a materialization that answers with part of the file.
 *
 * So a meeting can write its notes into the doc tick after tick, the
 * write-back can land them on the file, and a single stale copy appearing on
 * that path afterwards removes the whole section from the doc AND from the
 * file, with the heading ids that addressed it going too. Before this, that
 * happened in silence: no backup (the arm made none), no `syncError`, and a
 * log line reporting how many blocks it APPLIED.
 *
 * `reparse_from_disk` is the same loss by the shortest route — it clears the
 * pending write-back and force-applies disk, so notes composed inside the
 * write-back window existed nowhere afterwards.
 *
 * Who wins is deliberately unchanged in both: the file is the source of truth
 * at rest, and nothing on a file says whether a person or a sync client
 * shortened it. What these tests pin is that the losing side is KEPT and
 * ANNOUNCED — and, as the negative controls below check, that an ordinary
 * external edit still costs nothing.
 *
 * The doc, the paths and the words here are invented.
 */
import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prose } from '@claude-workspaces/core';
import { DocStore } from '../src/doc-store.ts';
import { blocksDroppedByIncoming } from '../src/file-binding.ts';
import { SseBus } from '../src/sse.ts';
import { createWebhookDispatcher } from '../src/webhooks.ts';
import { waitFor, waitForFile } from './wait-for.ts';

/** What the writer had in the doc before the meeting started. */
const BEFORE = `# Harbour works

The slipway is the only item anyone raised before today.
`;

/** What one meeting's note-taker composed into it. */
const NOTES = `## Meeting notes

- The slipway quote came back at twice the budget.
- The harbourmaster owns the re-tender, by Friday.`;

interface Bound {
  docStore: DocStore;
  dataDir: string;
  path: string;
}

function bind(docId: string, seed = BEFORE): Bound {
  const dataDir = mkdtempSync(join(tmpdir(), 'cw-drop-'));
  const path = join(dataDir, 'harbour.md');
  writeFileSync(path, seed);
  const docStore = new DocStore({
    dataDir,
    sse: new SseBus(),
    webhooks: createWebhookDispatcher({ onLog: () => {} }),
    decorateDocMeta: (m) => ({ ...m, reviewUrl: `http://test/review/${m.docId}` }),
  });
  docStore.getOrCreate(docId, { type: 'markdown', sourceUrl: path });
  expect(docStore.attachFile(docId, path).ok).toBe(true);
  return { docStore, dataDir, path };
}

/** Compose a notes section into the doc the way a meeting tick does. */
function takeNotes(docStore: DocStore, docId: string, markdown = NOTES): void {
  const res = docStore.applyBlockEdits(docId, [{ op: 'insert_at_end', markdown }], {
    author: 'meeting-notes',
    authorName: 'Meeting Assistant',
  });
  expect(res).toMatchObject({ ok: true, applied: 1 });
}

/**
 * Wait until the notes have reached the file AND the binding has recorded
 * that they did.
 *
 * The file getting the bytes is not the whole of the flush: `lastWritten`
 * is claimed when the pool write RESOLVES, a turn after the rename, and an
 * external write landing in between reads as a conflict rather than as the
 * external change these tests are about. `in-sync` is the binding saying the
 * bookkeeping caught up.
 */
async function settled(docStore: DocStore, docId: string, path: string): Promise<void> {
  await waitForFile(path, (text) => text.includes('Meeting notes'));
  await waitFor(() => docStore.reconcileNow(docId) === 'in-sync', {
    describe: `${docId} write-back bookkeeping to catch up`,
  });
}

function live(docStore: DocStore, docId: string): string {
  return prose.serializeFragmentToMarkdown(prose.getProseFragment(docStore.get(docId)!.ydoc));
}

/** The copies the server kept of content it was about to lose. */
function backups(dataDir: string): string[] {
  const dir = join(dataDir, 'clobber-backups');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).map((name) => readFileSync(join(dir, name), 'utf8'));
}

describe('a bound file that comes back short', () => {
  it("keeps the doc's copy of a notes section the file no longer holds", async () => {
    const { docStore, dataDir, path } = bind('d-short');
    takeNotes(docStore, 'd-short');
    await settled(docStore, 'd-short', path);

    // The provider hands back the revision it held before the meeting. The
    // doc is clean (the write-back landed), so this is an external change.
    writeFileSync(path, BEFORE);
    expect(docStore.reconcileNow('d-short')).toBe('apply');

    // Disk still wins — that part of the contract is unchanged.
    expect(live(docStore, 'd-short')).not.toContain('Meeting notes');

    // But the words are somewhere, and somebody is told where.
    const kept = backups(dataDir);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toContain('The harbourmaster owns the re-tender, by Friday.');
    const err = docStore.getSyncError('d-short');
    expect(err?.message).toContain('no longer holds');
    expect(err?.message).toContain('clobber-backups');
  });

  it('brings the section back when the backup is restored over the file', async () => {
    const { docStore, dataDir, path } = bind('d-restore');
    takeNotes(docStore, 'd-restore');
    await settled(docStore, 'd-restore', path);
    writeFileSync(path, BEFORE);
    expect(docStore.reconcileNow('d-restore')).toBe('apply');
    expect(live(docStore, 'd-restore')).not.toContain('Meeting notes');

    // The recovery the syncError names, run end to end.
    const kept = backups(dataDir);
    expect(kept).toHaveLength(1);
    writeFileSync(path, kept[0]);
    expect(docStore.reparseFromDisk('d-restore').ok).toBe(true);
    expect(live(docStore, 'd-restore')).toContain(
      'The harbourmaster owns the re-tender, by Friday.',
    );
  });

  it('keeps the copy when reparse_from_disk force-pulls over un-flushed notes', () => {
    const { docStore, dataDir, path } = bind('d-reparse');
    // No wait: the write-back is still pending, so these words have never
    // been on the file. An agent calls the documented recovery verb.
    takeNotes(docStore, 'd-reparse');
    expect(docStore.reparseFromDisk('d-reparse').ok).toBe(true);

    expect(live(docStore, 'd-reparse')).not.toContain('Meeting notes');
    expect(readFileSync(path, 'utf8')).not.toContain('Meeting notes');
    const kept = backups(dataDir);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toContain('The slipway quote came back at twice the budget.');
    expect(docStore.getSyncError('d-reparse')?.message).toContain('no longer holds');
  });
});

describe('an ordinary external edit costs nothing', () => {
  it('keeps no backup when a paragraph is rewritten on disk', async () => {
    const { docStore, dataDir, path } = bind('d-edit');
    takeNotes(docStore, 'd-edit');
    await settled(docStore, 'd-edit', path);

    // A person opens the file and reworks one line. Nothing is lost: the
    // block is replaced, not removed.
    writeFileSync(
      path,
      readFileSync(path, 'utf8').replace(
        'The slipway is the only item anyone raised before today.',
        'The slipway and the pontoon were both raised before today.',
      ),
    );
    expect(docStore.reconcileNow('d-edit')).toBe('apply');

    expect(live(docStore, 'd-edit')).toContain('the pontoon were both raised');
    expect(live(docStore, 'd-edit')).toContain('Meeting notes');
    expect(backups(dataDir)).toHaveLength(0);
    expect(docStore.getSyncError('d-edit')).toBeUndefined();
  });

  it('keeps no backup when the edit only adds', async () => {
    const { docStore, dataDir, path } = bind('d-add');
    takeNotes(docStore, 'd-add');
    await settled(docStore, 'd-add', path);

    writeFileSync(path, `${readFileSync(path, 'utf8')}\n- And the pontoon needs a survey.\n`);
    expect(docStore.reconcileNow('d-add')).toBe('apply');

    expect(live(docStore, 'd-add')).toContain('the pontoon needs a survey');
    expect(backups(dataDir)).toHaveLength(0);
    expect(docStore.getSyncError('d-add')).toBeUndefined();
  });

  it('keeps no backup when a reparse changes nothing', async () => {
    const { docStore, dataDir, path } = bind('d-noop');
    takeNotes(docStore, 'd-noop');
    await settled(docStore, 'd-noop', path);

    expect(docStore.reparseFromDisk('d-noop').ok).toBe(true);
    expect(live(docStore, 'd-noop')).toContain('Meeting notes');
    expect(backups(dataDir)).toHaveLength(0);
    expect(docStore.getSyncError('d-noop')).toBeUndefined();
  });
});

describe('blocksDroppedByIncoming', () => {
  it('counts nothing for a rewrite, because one block replaced another', () => {
    expect(blocksDroppedByIncoming(['a', 'b', 'c'], ['a', 'B!', 'c'])).toBe(0);
  });

  it('counts nothing for an addition', () => {
    expect(blocksDroppedByIncoming(['a', 'b'], ['a', 'b', 'c'])).toBe(0);
  });

  it('counts the blocks a shortened copy takes away', () => {
    expect(blocksDroppedByIncoming(['a', 'b', 'c', 'd'], ['a', 'b'])).toBe(2);
  });

  it('counts the net when a copy both deletes and rewrites', () => {
    expect(blocksDroppedByIncoming(['a', 'b', 'c', 'd'], ['a', 'B!'])).toBe(2);
  });

  it('counts a duplicate that came back once, which a set would miss', () => {
    expect(blocksDroppedByIncoming(['a', 'a'], ['a'])).toBe(1);
  });

  it('counts nothing for identical content', () => {
    expect(blocksDroppedByIncoming(['a', 'b'], ['b', 'a'])).toBe(0);
  });
});
