import type { Stats } from 'node:fs';
import { join } from 'node:path';
import { scanFolderPaths } from './fs-scan.ts';
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

/** How long one repo walk is reused. A Library load is a page view, and a
 *  person flipping between the page and a doc should not re-walk the repo. */
const SCAN_TTL_MS = 10_000;

/**
 * The project's markdown files, from `git ls-files --cached --others
 * --exclude-standard` — the listing the all-files tree already trusts, with
 * its credential-name floor — plus each file's mtime.
 *
 * `statSync` rather than a read: a stat never materializes a cloud-synced
 * file, so an online-only file costs a syscall, not a download.
 */
export function createMarkdownLister(
  now: () => number = Date.now,
): (root: string) => readonly ProjectFile[] {
  const cache = new Map<string, { at: number; files: ProjectFile[] }>();
  return (root) => {
    const hit = cache.get(root);
    if (hit && now() - hit.at < SCAN_TTL_MS) return hit.files;
    const files: ProjectFile[] = [];
    for (const relPath of scanFolderPaths(root)) {
      if (!relPath.toLowerCase().endsWith('.md')) continue;
      // Missing, now a file (ENOTDIR) or unreadable (EACCES): one bad path
      // drops its own row, and the page owes the reader every other file.
      let st: Stats;
      try {
        // Guarded: a plain stat follows a link out of a walled lead's project.
        st = boundFiles.guards.statSync(join(root, relPath));
      } catch {
        continue;
      }
      if (st.isFile()) files.push({ relPath, mtimeMs: st.mtimeMs, ...birthOf(st) });
    }
    cache.set(root, { at: now(), files });
    return files;
  };
}
