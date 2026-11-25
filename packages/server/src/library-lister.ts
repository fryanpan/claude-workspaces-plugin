import type { Stats } from 'node:fs';
import { join } from 'node:path';
import { mapSliced } from './fs-scan-contained.ts';
import { GitListingFailed, scanFolderPaths, scanFolderPathsAsync } from './fs-scan.ts';
import { boundFiles } from './slow-fs.ts';

/**
 * The project's markdown files, as the Library lists them: the repo walk and
 * the stat behind each row's two clocks. Split out of `library.ts`, which
 * re-exports all three names, so the build there stays a pure function over
 * injected sources.
 */

/** One file in the project, as a lister found it. */
export interface ProjectFile {
  /** POSIX, relative to the repo root. */
  relPath: string;
  mtimeMs: number;
  /** Birth time, when the filesystem reports one. */
  createdMs?: number;
}

/** A stat's birth time, when the filesystem keeps one (0 or less means it
 *  does not). */
export function birthOf(st: { birthtimeMs: number }): { createdMs?: number } {
  return st.birthtimeMs > 0 ? { createdMs: st.birthtimeMs } : {};
}

/**
 * When a board doc was made: the EARLIER of its record and its file's birth.
 * Each clock alone reads late. A `git pull` that changes a file writes a new
 * one, so the birth moves with every edit that arrives that way (which is
 * how Recently Created came to read as Recently Modified); and opening an
 * old project file from the Library, or attaching it, makes the record now.
 * An agent's doc counts as made as much as a person's.
 */
export function madeAt(recordAt: number, fileBirth: number | undefined): number {
  return fileBirth === undefined ? recordAt : Math.min(recordAt, fileBirth);
}

/** How long one repo walk is reused. A Library load is a page view, and a
 *  person flipping between the page and a doc should not re-walk the repo. */
const SCAN_TTL_MS = 10_000;

/**
 * The lister the Library page reads with. Called directly it answers on the
 * spot, walking the repo synchronously when its cache is cold or stale, as
 * the run-output reader wants. `ready` is the Library load's way in: the
 * walk runs with the event loop free (`scanFolderPathsAsync`), and a stale
 * listing is answered at once while a fresh one is built behind it. A
 * Library load on a 200k-entry tree used to hold the whole server 5.7s.
 */
export interface MarkdownLister {
  (root: string): readonly ProjectFile[];
  ready?: (root: string) => Promise<readonly ProjectFile[]>;
}

/**
 * The project's markdown files, from `git ls-files --cached --others
 * --exclude-standard` — the listing the all-files tree already trusts, with
 * its credential-name floor — plus each file's mtime.
 *
 * `statSync` rather than a read: a stat never materializes a cloud-synced
 * file, so an online-only file costs a syscall, not a download.
 */
export function createMarkdownLister(now: () => number = Date.now): MarkdownLister {
  // `at` is when the listing landed, so its freshness window starts then: a
  // rebuild slower than the window, stamped with its start, would arrive
  // already stale and every load after it would start another. `started` is
  // when it was asked for, so an older build never replaces a newer one.
  const cache = new Map<string, { at: number; started: number; files: ProjectFile[] }>();
  const building = new Map<string, Promise<ProjectFile[]>>();
  const store = (root: string, started: number, files: ProjectFile[]): ProjectFile[] => {
    const held = cache.get(root);
    if (!held || held.started <= started) cache.set(root, { at: now(), started, files });
    return files;
  };
  const build = (root: string): Promise<ProjectFile[]> => {
    const running = building.get(root);
    if (running) return running;
    const started = now();
    const next = scanFolderPathsAsync(root)
      .catch((err: unknown) => {
        // Fail closed, as the synchronous scan does: a repo git could not
        // list shows nothing rather than a walk past its ignore rules.
        if (!(err instanceof GitListingFailed)) throw err;
        console.error(`[library] ${err.message}`);
        return [];
      })
      .then((rels) => statSliced(root, rels))
      .then((files) => store(root, started, files))
      .finally(() => building.delete(root));
    building.set(root, next);
    return next;
  };
  const list = (root: string): readonly ProjectFile[] => {
    const hit = cache.get(root);
    if (hit && now() - hit.at < SCAN_TTL_MS) return hit.files;
    const started = now();
    return store(root, started, statAll(root, scanFolderPaths(root)));
  };
  const ready = async (root: string): Promise<readonly ProjectFile[]> => {
    const hit = cache.get(root);
    if (!hit) return build(root);
    if (now() - hit.at >= SCAN_TTL_MS) {
      build(root).catch((err: unknown) =>
        console.error('[library] background listing failed', err),
      );
    }
    return hit.files;
  };
  return Object.assign(list, { ready });
}

/** The markdown file `relPath` names, with its two clocks, or null. */
function statOne(root: string, relPath: string): ProjectFile | null {
  if (!relPath.toLowerCase().endsWith('.md')) return null;
  // Missing, now a file (ENOTDIR) or unreadable (EACCES): one bad path
  // drops its own row, and the page owes the reader every other file.
  let st: Stats;
  try {
    // Guarded: a plain stat follows a link out of a walled lead's project.
    st = boundFiles.guards.statSync(join(root, relPath));
  } catch {
    return null;
  }
  return st.isFile() ? { relPath, mtimeMs: st.mtimeMs, ...birthOf(st) } : null;
}

function statAll(root: string, rels: readonly string[]): ProjectFile[] {
  const files: ProjectFile[] = [];
  for (const rel of rels) {
    const f = statOne(root, rel);
    if (f) files.push(f);
  }
  return files;
}

/** `statAll`, giving the event loop a turn between slices of the walk's size. */
function statSliced(root: string, rels: readonly string[]): Promise<ProjectFile[]> {
  return mapSliced(rels, (rel) => statOne(root, rel));
}
