import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, posix } from 'node:path';
import type { DocMeta } from '@claude-workspaces/core';
import { attachmentIdOf } from '@claude-workspaces/core';
import { isReservedDocId } from './doc-ids.ts';
import { makeDocKey, parseDocKey } from './doc-key.ts';
import { scanFolderPaths } from './fs-scan.ts';

/**
 * A board's Library: the meetings and the files a person comes to the board to
 * open, newest first, each one tap from its page.
 *
 * The page answers "where is that doc?" without anybody knowing a repo path,
 * so the file list cannot stop at the docs somebody already bound: a file
 * nobody has opened yet is exactly the one a reader is hunting for (Bryan,
 * round 1 of the front-page mocks: "Every markdown file"). Three sources, one
 * list:
 *
 *   - the board's own docs — a meeting when it held one, a file otherwise;
 *   - every markdown file in the board's PROJECT repo that no doc of this
 *     board holds yet, which opens through `POST …/library/open`;
 *   - every other file in that project's mounted folders, which opens at its
 *     mount address.
 *
 * The project is the repo holding most of this board's docs. A board has no
 * repo field — it holds docs, and a doc knows its repo through its identity
 * key — so the answer is read off what the board is actually used for rather
 * than stored beside it, where it could drift.
 *
 * Everything here is a pure build over injected sources except the two
 * default readers at the bottom, so the rules can be tested without a server.
 */

export interface LibraryRow {
  /** The title a person knows it by: the doc's title, or the file's name. */
  name: string;
  /** Epoch ms — when the meeting was held, or when the file last changed. */
  at: number;
  /** Where the row opens: a doc's page on this board, or a mounted file. */
  href?: string;
  /** A project markdown file with no doc on this board yet: its path from the
   *  repo root. `POST /workspaces/<id>/library/open` binds it and answers the
   *  page to go to. Never a host path — the server resolves it against a
   *  root it chose. */
  open?: string;
}

export interface LibraryProject {
  name: string;
  /** Where the project lives on the box, `~`-abbreviated. */
  path: string;
}

export interface LibraryPayload {
  project: LibraryProject | null;
  meetings: LibraryRow[];
  files: LibraryRow[];
}

/** One file in the project, as a lister found it. */
export interface ProjectFile {
  /** POSIX, relative to the repo root. */
  relPath: string;
  mtimeMs: number;
}

/** One file in the project's mounted folders. */
export interface MountedProjectFile extends ProjectFile {
  fileId: string;
}

export interface LibrarySources {
  workspaceId: string;
  /** The docs filed on this board. */
  docs: readonly DocMeta[];
  /** A doc's repo+path identity (`doc-key.ts`), when it has one. */
  docKeyOf: (docId: string) => string | undefined;
  /** When the doc's most recent meeting started, or undefined if it never held one. */
  lastMeetingAt: (docId: string) => number | undefined;
  /** The checkout a project's files are read from, or null when none is left. */
  projectRoot: (repoKey: string) => string | null;
  /** The project's markdown files. */
  markdownFiles: (root: string) => readonly ProjectFile[];
  /** Every file in the project's mounted folders. */
  mountedFiles: (repoKey: string) => readonly MountedProjectFile[];
  /** The home directory, for abbreviating the project path. */
  home?: string;
}

const isMarkdownPath = (relPath: string): boolean => relPath.toLowerCase().endsWith('.md');

/** Most recent first; ties by name so the order is stable across loads. */
function byRecency(a: LibraryRow, b: LibraryRow): number {
  return b.at - a.at || a.name.localeCompare(b.name);
}

/**
 * The repo holding most of this board's docs, or null when none of them sits
 * in a repo. Ties go to the lexically first key so two loads cannot disagree.
 */
export function projectRepoKey(
  docs: readonly DocMeta[],
  docKeyOf: (docId: string) => string | undefined,
): string | null {
  const counts = new Map<string, number>();
  for (const meta of docs) {
    const key = docKeyOf(meta.docId);
    const repoKey = key ? parseDocKey(key)?.repoKey : undefined;
    if (repoKey) counts.set(repoKey, (counts.get(repoKey) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [repoKey, n] of counts) {
    if (n > bestCount || (n === bestCount && best !== null && repoKey < best)) {
      best = repoKey;
      bestCount = n;
    }
  }
  return best;
}

/** `git:host/owner/name` → `name`; anything else → the checkout's folder. */
export function projectName(repoKey: string, root: string): string {
  if (repoKey.startsWith('git:')) {
    const last = repoKey
      .split('/')
      .pop()
      ?.replace(/\.git$/, '');
    if (last) return last;
  }
  return basename(root);
}

/** `/Users/x/dev/p` → `~/dev/p` when it sits under the home directory. */
export function abbreviateHome(path: string, home: string): string {
  if (home && (path === home || path.startsWith(`${home}/`))) return `~${path.slice(home.length)}`;
  return path;
}

/**
 * File names as a reader tells them apart. A bare `README.md` is ambiguous in
 * any repo with more than one, so a name that occurs twice in the list takes
 * its folder in front of it — and only then, because a path on every row is
 * the thing this page exists to spare the reader.
 */
export function displayNames(relPaths: readonly string[]): Map<string, string> {
  const seen = new Map<string, number>();
  for (const rel of relPaths) {
    const name = posix.basename(rel);
    seen.set(name, (seen.get(name) ?? 0) + 1);
  }
  const out = new Map<string, string>();
  for (const rel of relPaths) {
    const name = posix.basename(rel);
    const parent = posix.basename(posix.dirname(rel));
    out.set(
      rel,
      (seen.get(name) ?? 0) > 1 && parent && parent !== '.' ? `${parent}/${name}` : name,
    );
  }
  return out;
}

/** A board doc's page on THIS board, or undefined when it has none to open. */
function docHref(workspaceId: string, meta: DocMeta): string | undefined {
  const base = `/workspaces/${encodeURIComponent(workspaceId)}`;
  const id = encodeURIComponent(meta.docId);
  if (meta.type === 'markdown') return `${base}/docs/${id}`;
  if (meta.type === 'mockup' && meta.sourceUrl) return `${base}/mockups/${id}`;
  return undefined;
}

/** Build the Library for one board. */
export function buildLibrary(src: LibrarySources): LibraryPayload {
  const meetings: LibraryRow[] = [];
  const files: LibraryRow[] = [];
  // Every file a board doc already covers — the repo listing below must not
  // offer a second row, and a second bind, for the same file.
  const covered = new Set<string>();

  for (const meta of src.docs) {
    // A review's member (a diff file, a folder bind's opened file) belongs to
    // that review's own page, and a task's description is the task. Neither
    // is a document somebody files on a board.
    if (attachmentIdOf(meta) || isReservedDocId(meta.docId)) continue;
    const key = src.docKeyOf(meta.docId);
    if (key) covered.add(key);
    const heldAt = src.lastMeetingAt(meta.docId);
    const discussion = meta.huddle === true && meta.huddleKind !== 'plan';
    const keyRel = key ? parseDocKey(key)?.relPath : undefined;
    const name = meta.title?.trim() || (keyRel ? posix.basename(keyRel) : meta.docId);
    if (heldAt !== undefined || discussion) {
      const href = docHref(src.workspaceId, meta);
      if (href) meetings.push({ name, at: heldAt ?? meta.createdAt, href });
      continue;
    }
    const href = docHref(src.workspaceId, meta);
    if (href) files.push({ name, at: meta.lastActivityAt ?? meta.createdAt, href });
  }

  const repoKey = projectRepoKey(src.docs, src.docKeyOf);
  const root = repoKey ? src.projectRoot(repoKey) : null;
  let project: LibraryProject | null = null;
  if (repoKey && root) {
    project = {
      name: projectName(repoKey, root),
      path: abbreviateHome(root, src.home ?? homedir()),
    };
    const loose: Array<ProjectFile & { fileId?: string }> = [];
    const listed = new Set<string>();
    for (const f of src.markdownFiles(root)) {
      if (covered.has(makeDocKey(repoKey, f.relPath))) continue;
      listed.add(f.relPath);
      loose.push(f);
    }
    for (const f of src.mountedFiles(repoKey)) {
      if (listed.has(f.relPath) || covered.has(makeDocKey(repoKey, f.relPath))) continue;
      listed.add(f.relPath);
      loose.push(f);
    }
    const names = displayNames(loose.map((f) => f.relPath));
    for (const f of loose) {
      const name = names.get(f.relPath) ?? f.relPath;
      if (isMarkdownPath(f.relPath)) files.push({ name, at: f.mtimeMs, open: f.relPath });
      else if (f.fileId) {
        files.push({ name, at: f.mtimeMs, href: `/mounts/${encodeURIComponent(f.fileId)}/raw` });
      }
    }
  }

  meetings.sort(byRecency);
  files.sort(byRecency);
  return { project, meetings, files };
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
      if (!isMarkdownPath(relPath)) continue;
      const st = statSync(join(root, relPath), { throwIfNoEntry: false });
      if (st?.isFile()) files.push({ relPath, mtimeMs: st.mtimeMs });
    }
    cache.set(root, { at: now(), files });
    return files;
  };
}
