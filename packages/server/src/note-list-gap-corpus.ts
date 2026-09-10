/**
 * The corpus half of the note-list-gap repair: files, backups and a report.
 *
 * `note-list-gap-repair.ts` holds the repair itself and never touches a
 * filesystem — read its header for what the move does to block ids,
 * authorship and comment anchors, and for what a gap site does NOT prove.
 * This module is what walks a data directory, and it exists as a separate
 * file for the reason `doc-identity-plan.ts` and `doc-identity-migration.ts`
 * are separate: the decision and the disk are worth reasoning about apart.
 *
 * ## Read this before running it against live data
 *
 * The server is the only writer of a `.ydoc`, and it writes a full snapshot
 * of whatever it holds in memory. Repairing a file a server has open is
 * therefore undone by that server's next flush — silently, with no error
 * anywhere. `scripts/repair-note-list-gaps.ts` is where that check lives,
 * because the discovery slot is a fact about this machine rather than about
 * a corpus, and it is the only caller that names a real data directory — the
 * rule the doc-identity migration set, and the reason a test run and a stray
 * import cannot rewrite one.
 *
 * ## Nothing is destroyed
 *
 * A document about to be rewritten is copied to `<id>.ydoc.pre-list-repair`
 * first; an existing copy is never overwritten, and a copy that cannot be
 * taken stops the rewrite rather than proceeding without one. Reverting one
 * document is a `mv` of that copy back, with the server stopped.
 */
import {
  copyFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import * as Y from 'yjs';
import { findGapSites, repairNoteListGaps } from './note-list-gap-repair.ts';

/** Suffix of the copy taken before a document is rewritten. */
export const BACKUP_SUFFIX = '.pre-list-repair';

export interface DataDirOptions {
  /** Write the repairs. Without it nothing is opened for writing at all. */
  apply?: boolean;
  /** Only these doc ids, rather than every `.ydoc` in the directory. */
  docIds?: readonly string[];
  /** Where a line of the report goes. */
  log?: (line: string) => void;
}

export interface DataDirResult {
  /** Documents carrying at least one site, whether or not they were written. */
  docsWithSites: number;
  sitesFound: number;
  docsRepaired: number;
  sitesRepaired: number;
  itemsMoved: number;
  anchorsRebuilt: number;
  anchorsUnverified: number;
}

function loadYdoc(path: string): Y.Doc | null {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, new Uint8Array(readFileSync(path)));
  } catch {
    return null;
  }
  return doc;
}

/**
 * Write temp-then-rename.
 *
 * The write-over-the-original version of this in the doc-identity migration
 * had a window where a failure left a TRUNCATED `.ydoc` — the durable record
 * of somebody's document, the one thing here that nothing rebuilds. A rename
 * is atomic: the file is either the document as it was or the repaired one.
 */
function saveYdoc(path: string, doc: Y.Doc): void {
  const tmp = `${path}.repairing`;
  writeFileSync(tmp, Y.encodeStateAsUpdate(doc));
  renameSync(tmp, path);
}

/**
 * Copy `path` to `backup`, via a temporary name.
 *
 * A plain `copyFileSync` that dies partway — a full disk is the ordinary
 * way — leaves a truncated file at the backup path, and the NEXT run sees a
 * backup already there, skips taking one, and rewrites the document. The
 * rename makes the backup either absent or complete.
 */
function takeBackup(path: string, backup: string): void {
  const tmp = `${backup}.partial`;
  try {
    copyFileSync(path, tmp);
    renameSync(tmp, backup);
  } catch (err) {
    // Leaving a half-written `.partial` behind would make the next run's
    // failure harder to read than this one's.
    try {
      rmSync(tmp, { force: true });
    } catch {
      // Nothing to do about it, and it is not the failure worth reporting.
    }
    throw err;
  }
}

/** Is there a regular file at `path`? A directory or a broken link is not. */
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Report — and with `apply`, repair — every gap site in a data directory.
 *
 * Nothing is destroyed: a document about to be rewritten is copied to
 * `<id>.ydoc.pre-list-repair` first, and an EXISTING copy is never
 * overwritten, so a second run cannot turn the backup into a copy of the
 * repaired file. Reverting one document is a `mv` of that copy back.
 */
export function repairDataDir(dataDir: string, opts: DataDirOptions = {}): DataDirResult {
  const log = opts.log ?? ((line: string) => console.log(line));
  const result: DataDirResult = {
    docsWithSites: 0,
    sitesFound: 0,
    docsRepaired: 0,
    sitesRepaired: 0,
    itemsMoved: 0,
    anchorsRebuilt: 0,
    anchorsUnverified: 0,
  };

  const ids =
    opts.docIds && opts.docIds.length > 0
      ? [...opts.docIds]
      : readdirSync(dataDir)
          .filter((name) => name.endsWith('.ydoc'))
          .map((name) => name.slice(0, -'.ydoc'.length))
          .sort();

  for (const id of ids) {
    const path = join(dataDir, `${id}.ydoc`);
    if (!existsSync(path)) {
      log(`${id}: no .ydoc — skipped`);
      continue;
    }
    const doc = loadYdoc(path);
    if (!doc) {
      log(`${id}: unreadable — skipped`);
      continue;
    }
    const sites = findGapSites(doc);
    if (sites.length === 0) continue;
    result.docsWithSites++;
    result.sitesFound += sites.length;
    log(
      `${id}: ${sites.length} site(s) — ` +
        sites
          .map(
            (s) =>
              `${s.items} item(s) behind ${s.paragraphs} blank` +
              (s.authored ? ', agent-written' : ', authorship unknown'),
          )
          .join('; '),
    );
    if (!opts.apply) continue;

    const backup = `${path}${BACKUP_SUFFIX}`;
    // `existsSync` alone is not the question. Anything at that path that is
    // not a regular file — a directory, a dangling symlink — would read as a
    // backup already taken and let the document be rewritten with nothing
    // behind it. Only a file counts.
    if (!isFile(backup)) {
      try {
        takeBackup(path, backup);
      } catch (err) {
        // No copy, no rewrite. The document stays as it is and the run says
        // so: replacing the only valid copy of somebody's document because
        // the backup could not be written is the one outcome worth refusing.
        log(`${id}: could not take a backup (${(err as Error).message}) — left alone`);
        continue;
      }
    }
    const report = repairNoteListGaps(doc);
    saveYdoc(path, doc);
    result.docsRepaired++;
    result.sitesRepaired += report.sites;
    result.itemsMoved += report.itemsMoved;
    result.anchorsRebuilt += report.anchorsRebuilt;
    result.anchorsUnverified += report.anchorsUnverified;
    log(
      `  repaired: ${report.sites} site(s), ${report.itemsMoved} item(s) moved, ` +
        `anchors ${report.anchorsRebuilt}/${report.anchorsChecked} rebuilt` +
        (report.anchorsUnverified > 0 ? `, ${report.anchorsUnverified} left alone` : ''),
    );
  }
  return result;
}
