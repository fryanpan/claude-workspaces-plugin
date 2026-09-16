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
 * ANNOUNCED.
 *
 * Two triggers, because the two actions cost different things
 * (`blockDelta` carries the measurements behind both):
 *
 *   - a COPY when a SECTION left — its heading went with it — or the file
 *     came back shorter. The heading is what makes the swap case catchable:
 *     a revision that replaces the notes with a comparable amount of other
 *     text leaves every block count at zero net, and is the loudest possible
 *     loss;
 *   - the `syncError` only when the file came back SHORTER, because it
 *     reaches get_doc, every edit response and every watching session, and an
 *     ordinary external save must not light it up.
 *
 * So the negative controls below come in two kinds: an ordinary save must
 * raise no sync error, and an edit that takes no section and leaves the file
 * no shorter must not even keep a copy — including the ones that look like
 * removals to a block diff, a reworded paragraph and an appended bullet.
 *
 * The doc, the paths and the words here are invented.
 */
import { describe, expect, it, spyOn } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prose } from '@claude-workspaces/core';
import { DocStore } from '../src/doc-store.ts';
import { boundFiles } from '../src/slow-fs.ts';
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

/** A section of the same size that is not the notes — what a revision
 *  holding a DIFFERENT afternoon's work looks like. */
const OTHER_SECTION = `## Site visit

- The east wall is sound.
- The gate needs a new hinge.`;

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
  try {
    await waitFor(() => docStore.reconcileNow(docId) === 'in-sync', {
      describe: `${docId} write-back bookkeeping to catch up`,
    });
  } catch (err) {
    // A quarantined path cannot answer a reconcile at all, and the backoff
    // (6s under the test scale) outlasts bun's per-test budget — so no wait
    // here can recover from one. Say so: a loaded runner missing the 300ms
    // bound-read deadline reads as "the bookkeeping never caught up", and
    // that sentence sent one CI failure looking for a cause in the
    // write-back that was in the pool.
    if (boundFiles.quarantined(path)) {
      throw new Error(
        `${docId}: the bound path was QUARANTINED by slow-fs — the runner missed the bound-read deadline, and nothing the doc does can answer until the backoff lapses`,
        { cause: err },
      );
    }
    throw err;
  }
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

/** Their filenames, oldest first — the stamp in the name is the age order. */
function backupNames(dataDir: string): string[] {
  const dir = join(dataDir, 'clobber-backups');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort();
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

  it('keeps the copy when the section is SWAPPED rather than removed', async () => {
    const { docStore, dataDir, path } = bind('d-swap');
    takeNotes(docStore, 'd-swap');
    await settled(docStore, 'd-swap', path);

    // The file comes back the same LENGTH, holding somebody else's section
    // where the notes were. Net zero blocks — the case a count-the-shortfall
    // rule reports nothing for, and the loudest loss there is.
    writeFileSync(path, `${BEFORE}\n${OTHER_SECTION}\n`);
    expect(docStore.reconcileNow('d-swap')).toBe('apply');
    expect(live(docStore, 'd-swap')).not.toContain('Meeting notes');
    expect(live(docStore, 'd-swap')).toContain('Site visit');

    const kept = backups(dataDir);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toContain('The harbourmaster owns the re-tender, by Friday.');
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

  it('never refuses reparse_from_disk, whatever it drops', () => {
    // The verb documents the caller as declaring disk the winner, and is one
    // of two recovery routes for a doc parked at hydrate. It reports the
    // loss; it must not become a way for that recovery to fail.
    const { docStore, path } = bind('d-declared');
    takeNotes(docStore, 'd-declared');
    expect(docStore.reparseFromDisk('d-declared')).toEqual({ ok: true });
    expect(readFileSync(path, 'utf8')).toContain('The slipway is the only item');
  });

  it('rotates the oldest copies out rather than growing without bound', async () => {
    // The cap, driven for real: a directory already full of this doc's own
    // copies, then one more drop. Seeded rather than looped, so the bound is
    // measured without paying twenty write-backs for it.
    const docId = 'd-cap';
    const { docStore, dataDir, path } = bind(docId);
    const dir = join(dataDir, 'clobber-backups');
    mkdirSync(dir, { recursive: true });
    // Names built from the id rather than spelled out: a stamped backup name
    // written as one literal reads to the leak scanner as a doc id.
    const seeded = (n: number) => `${docId}-live-1000000000${String(n).padStart(3, '0')}.md`;
    for (let i = 0; i < 25; i++) writeFileSync(join(dir, seeded(i)), `old ${i}`);

    takeNotes(docStore, docId);
    await settled(docStore, docId, path);
    writeFileSync(path, BEFORE);
    expect(docStore.reconcileNow(docId)).toBe('apply');

    const names = backupNames(dataDir);
    expect(names).toHaveLength(20);
    // The one just written survived; the oldest seeded ones went.
    expect(readFileSync(join(dir, names[names.length - 1]), 'utf8')).toContain(
      'The harbourmaster owns the re-tender, by Friday.',
    );
    expect(names).not.toContain(seeded(0));
    expect(names).toContain(seeded(24));
  });

  it('keeps one copy, not two, when the same content is dropped twice', async () => {
    const { docStore, dataDir, path } = bind('d-twice');
    takeNotes(docStore, 'd-twice');
    await settled(docStore, 'd-twice', path);

    writeFileSync(path, BEFORE);
    expect(docStore.reconcileNow('d-twice')).toBe('apply');
    // The doc is back to BEFORE, so a second round has the same content to
    // keep. Nothing new is worth a second file.
    takeNotes(docStore, 'd-twice');
    await settled(docStore, 'd-twice', path);
    writeFileSync(path, BEFORE);
    expect(docStore.reconcileNow('d-twice')).toBe('apply');

    expect(backups(dataDir)).toHaveLength(1);
  });
});

describe('an ordinary external edit raises no alarm', () => {
  it('raises no sync error when a paragraph is rewritten on disk', async () => {
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
    // Nothing is kept. Rewriting a paragraph under a heading takes no heading
    // and leaves the file no shorter, which is the whole reason the trigger is
    // not a block count: this is the shape an ordinary external save has.
    expect(backups(dataDir)).toHaveLength(0);
    // And nothing is raised at the person either.
    expect(docStore.getSyncError('d-edit')).toBeUndefined();
    expect(docStore.getDocStatus('d-edit')?.syncError).toBeUndefined();
  });

  it('keeps nothing at all when the edit adds a whole new block', async () => {
    const { docStore, dataDir, path } = bind('d-add');
    takeNotes(docStore, 'd-add');
    await settled(docStore, 'd-add', path);

    // A new PARAGRAPH: every block the doc held is still there word for word,
    // so nothing was removed and there is nothing to keep.
    writeFileSync(path, `${readFileSync(path, 'utf8')}\nThe pontoon needs a survey.\n`);
    expect(docStore.reconcileNow('d-add')).toBe('apply');

    expect(live(docStore, 'd-add')).toContain('The pontoon needs a survey');
    expect(backups(dataDir)).toHaveLength(0);
    expect(docStore.getSyncError('d-add')).toBeUndefined();
  });

  it('keeps nothing when a bullet is appended, though that rewrites the list block', async () => {
    // Worth pinning because comparing BLOCKS makes this a removal: a list is
    // one block, so growing it retires the old one. `removed` is 1 here and
    // the doc lost nothing — the clearest case for why `removed` is not what
    // decides whether a copy is kept.
    const { docStore, dataDir, path } = bind('d-bullet');
    takeNotes(docStore, 'd-bullet');
    await settled(docStore, 'd-bullet', path);

    writeFileSync(path, `${readFileSync(path, 'utf8')}- And the pontoon needs a survey.\n`);
    expect(docStore.reconcileNow('d-bullet')).toBe('apply');

    expect(live(docStore, 'd-bullet')).toContain('the pontoon needs a survey');
    expect(backups(dataDir)).toHaveLength(0);
    expect(docStore.getSyncError('d-bullet')).toBeUndefined();
  });

  it('keeps nothing at all when a reparse changes nothing', async () => {
    const { docStore, dataDir, path } = bind('d-noop');
    takeNotes(docStore, 'd-noop');
    await settled(docStore, 'd-noop', path);

    expect(docStore.reparseFromDisk('d-noop').ok).toBe(true);
    expect(live(docStore, 'd-noop')).toContain('Meeting notes');
    expect(backups(dataDir)).toHaveLength(0);
    expect(docStore.getSyncError('d-noop')).toBeUndefined();
  });
});

describe('keeping a copy does not cost another', () => {
  it('clears a stale sync error when a later reparse leaves the file no shorter', async () => {
    const { docStore, path } = bind('d-stale');
    takeNotes(docStore, 'd-stale');
    await settled(docStore, 'd-stale', path);

    // First the loss, which raises the alarm.
    writeFileSync(path, BEFORE);
    expect(docStore.reconcileNow('d-stale')).toBe('apply');
    expect(docStore.getSyncError('d-stale')?.message).toContain('no longer holds');

    // Now the doc gets a section again, and a force-pull SWAPS it for another
    // of the same size. A heading left, so a copy is kept; nothing is missing
    // from the file, so no new alarm is raised. The old alarm described a
    // file that no longer exists and must not outlive it — and it would, if
    // the clear sat in an `else` the copy branch skips past.
    takeNotes(docStore, 'd-stale');
    writeFileSync(path, `${BEFORE}\n${OTHER_SECTION}\n`);
    expect(docStore.reparseFromDisk('d-stale')).toEqual({ ok: true });

    expect(live(docStore, 'd-stale')).toContain('The gate needs a new hinge');
    expect(live(docStore, 'd-stale')).not.toContain('Meeting notes');
    expect(docStore.getSyncError('d-stale')).toBeUndefined();
    expect(docStore.getDocStatus('d-stale')?.syncError).toBeUndefined();
  });

  it('never lets one recovery copy overwrite another written the same millisecond', async () => {
    const { docStore, dataDir, path } = bind('d-collide');
    takeNotes(docStore, 'd-collide');
    await settled(docStore, 'd-collide', path);

    // The clock is HELD, not raced. Two real reparses happen to take more
    // than a millisecond on this machine, which would make a timing test pass
    // whether or not the names collide; freezing `Date.now` makes the
    // collision certain, which is the only way this pins anything.
    const clock = spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    try {
      // Two force-pulls, each dropping DIFFERENT words.
      writeFileSync(path, `${BEFORE}\n${OTHER_SECTION}\n`);
      expect(docStore.reparseFromDisk('d-collide')).toEqual({ ok: true });
      writeFileSync(path, BEFORE);
      expect(docStore.reparseFromDisk('d-collide')).toEqual({ ok: true });
    } finally {
      clock.mockRestore();
    }

    const kept = backups(dataDir);
    expect(kept).toHaveLength(2);
    // Both losses are readable: the notes from the first, the swap from the second.
    expect(kept.some((t) => t.includes('The harbourmaster owns the re-tender'))).toBe(true);
    expect(kept.some((t) => t.includes('The gate needs a new hinge'))).toBe(true);
    // And the names still sort oldest-first, which the rotation relies on.
    expect(backupNames(dataDir)).toEqual([...backupNames(dataDir)].sort());
  });

  it('forgets a doc\u2019s de-dup entry when the doc is let go', async () => {
    const { docStore, dataDir, path } = bind('d-forget');
    takeNotes(docStore, 'd-forget');
    await settled(docStore, 'd-forget', path);
    writeFileSync(path, BEFORE);
    expect(docStore.reconcileNow('d-forget')).toBe('apply');
    expect(backups(dataDir)).toHaveLength(1);

    // The doc is evicted and comes back — a fresh binding, the same id, and
    // the same content lost again. The de-dup must not answer for a run that
    // is over, or the second loss keeps nothing.
    docStore.evictDoc('d-forget');
    docStore.getOrCreate('d-forget', { type: 'markdown', sourceUrl: path });
    takeNotes(docStore, 'd-forget');
    expect(docStore.attachFile('d-forget', path).ok).toBe(true);
    await settled(docStore, 'd-forget', path);
    // Counted here, because the re-attach arbitrates the file against the
    // rehydrated doc and may keep its own copy — that path is not what this
    // test is about. What matters is that the DROP below adds one.
    const beforeSecondDrop = backups(dataDir).length;
    writeFileSync(path, BEFORE);
    expect(docStore.reconcileNow('d-forget')).toBe('apply');

    expect(backups(dataDir)).toHaveLength(beforeSecondDrop + 1);
  });
});
