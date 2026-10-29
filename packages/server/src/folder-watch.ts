/**
 * An open folder review hears a file created, deleted or renamed on disk.
 *
 * A review's file list is a disk scan, and nothing told an open page that
 * the disk moved: a file an agent wrote, a `git checkout`, an editor's new
 * file reached the tree only when the window regained focus. This watches
 * the folder for exactly as long as a page holds the review's stream
 * (`ws~<setId>`), and on a settled burst re-reconciles the review the way a
 * refresh does (`refreshWorkspace`), whose `onSetRescanned` sends the
 * `attachments.changed` frame the page already re-reads on
 * (`page-nudges.ts`, `workspaces-app/src/set-live.ts`).
 *
 * The rules, each from a way this has gone wrong before:
 *
 *   - ONLY WHAT A PAGE HAS OPEN. A watch starts on a channel's first page
 *     stream and closes with its last. Agent streams do not count: an agent
 *     never draws a tree. One watch per folder however many pages hold it,
 *     and at most `MAX_WATCHED_FOLDERS` in all.
 *   - DIRECTORY ENTRIES, NEVER CONTENTS. The trigger is one recursive
 *     `fs.watch` on the root (FSEvents on macOS: one stream per folder, not
 *     a handle per file). What an event meant is decided from a LISTING —
 *     `git ls-files` as a child process, or outside a repo an async
 *     `readdir` walk — both names only, both off the main thread, inside a
 *     deadline. Nothing here opens a file, so an online-only cloud file
 *     cannot answer EDEADLK or hang a read here.
 *   - A BURST IS ONE PASS. Events only mark the folder dirty. A pass runs
 *     after `SETTLE_MS` of quiet or `MAX_WAIT_MS` since the first event,
 *     and a pass in flight makes the next wait for it, so a `git checkout`
 *     of hundreds of files is one listing and at most one refresh.
 *   - A SAVE IS NOT NEWS. Editors save by renaming a temp file over the old
 *     one, which a directory watch reports like a new file. So the pass
 *     compares its listing with the last pass's and refreshes only when they
 *     differ: a file created, deleted or renamed. The first pass after a
 *     watch starts always refreshes, because the listing it would compare
 *     against may already hold a file whose event had not yet arrived.
 *   - A DIFF REVIEW LISTS ITS DIFF. A review based on the working tree also
 *     draws each file's +/- counts, and a tracked file's first edit joins it
 *     without changing `git ls-files`. So its listing is the diff itself —
 *     `git diff --numstat` against the stored base, one entry per file with
 *     its status and counts — and a save that moves a count is news, while
 *     one that writes the same bytes is not. Still git as child processes,
 *     still names and numbers only, still inside the deadline.
 *   - A DIFF IS CHECKED WHEN A PAGE OPENS IT. Its rows are stored, so an
 *     edit made while nobody had it open would otherwise be drawn stale
 *     until the next event. Its watch starts from the listing the stored
 *     rows describe and runs one pass at once; it refreshes only if the
 *     diff moved.
 *
 *   - A RUNTIME THAT GOES DEAF GETS A CLOCK. Bun before 1.3.11 on Linux
 *     wedges every `fs.watch` in the process after one inotify read of more
 *     than 128 events (oven-sh/bun#27668): its reader replays that buffer's
 *     tail forever and no watch hears anything again. Deleting a directory
 *     of a few hundred files is such a read. There, the trigger is a timer
 *     every `POLL_MS` instead, and the pass's listing comparison is what
 *     keeps a quiet tick from refreshing anything. A folder that cannot be
 *     listed is news once, when it stops listing, not on every tick.
 *
 * `fs.watch` is the wrong tool for following one FILE's contents
 * (learnings.md, "fs.watch is the wrong primitive"); a recursive directory
 * watch that only asks "did the listing change" is the use it is good for.
 */
import { watch as fsWatch } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { attachmentIdOf } from '@claude-workspaces/core';
import type { DocMeta } from '@claude-workspaces/core';
import { isExcluded, normalizeExcludes } from './bind-meta.ts';
import { diffFilesAsync } from './git-diff.ts';
import { gitBarred, hardenedGitArgs, hardenedGitEnv } from './git-hardening.ts';

/** Quiet time that closes a burst. */
export const SETTLE_MS = 150;
/** The longest a burst may gather before its pass runs anyway. */
export const MAX_WAIT_MS = 500;
/** Folders watched at once, server-wide. */
export const MAX_WATCHED_FOLDERS = 32;

/** Path segments whose churn never changes what a review lists. */
const IGNORED_SEGMENTS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'coverage']);

export type WatchFn = ((
  root: string,
  onEvent: (relPath: string | null) => void,
) => { close(): void }) & {
  /** Fires on a clock, not on the disk, so a folder that cannot be listed
   *  is news once, when it stops listing, rather than on every tick. */
  timed?: boolean;
};

/** What a watched set lists from: a folder, and for a diff review its base. */
export interface LiveSource {
  root: string;
  /** A working-tree diff review's base commit; its listing is the diff. */
  diffBase?: string;
  /** Paths the review was bound to leave out. */
  exclude?: readonly string[];
  /** A diff review's stored rows, as `diffListing` would list them. */
  stored?: Set<string>;
}

export interface FolderWatchHost {
  /** What a set lists from disk, or undefined when it has nothing to
   *  follow: a board channel, a pinned diff, a set with no root. */
  sourceOf(setId: string): LiveSource | undefined;
  /** Re-reconcile the set against disk; its success sends the page frame. */
  refresh(setId: string): Promise<unknown>;
}

export interface FolderWatchOptions {
  watch?: WatchFn;
  /** The entries a listing shows, or null when there is no listing. */
  listPaths?: (source: LiveSource) => Promise<Set<string> | null>;
  settleMs?: number;
  maxWaitMs?: number;
  maxFolders?: number;
}

export interface FolderWatches {
  /** A channel's page-stream count changed; hold or release its folder. */
  sync(setId: string, pages: number): void;
  /** Folders watched right now. */
  size(): number;
  dispose(): void;
}

/** The source of a set whose file list follows the working tree. */
export function liveSourceOf(metas: readonly DocMeta[], setId: string): LiveSource | undefined {
  let root: string | undefined;
  let diffBase: string | undefined;
  let exclude: string[] | undefined;
  const stored = new Set<string>();
  for (const m of metas) {
    if (attachmentIdOf(m) !== setId) continue;
    // A pinned diff's files are a commit: the disk is not its source.
    if (m.type === 'diff' && m.diffTarget) return undefined;
    root ??= m.workspaceRoot;
    exclude ??= m.workspaceExclude;
    if (m.type !== 'diff') continue;
    diffBase ??= m.diffBase;
    if (m.relPath && !m.stale) {
      stored.add(
        diffEntryKey({
          relPath: m.relPath,
          status: m.diffStatus,
          oldPath: m.diffOldPath,
          additions: m.diffAdditions,
          deletions: m.diffDeletions,
          whitespaceOnly: m.diffWhitespaceOnly,
        }),
      );
    }
  }
  if (!root) return undefined;
  if (!diffBase) return { root, ...(exclude ? { exclude } : {}) };
  if (!exclude) return { root, diffBase, stored };
  // A narrowed review keeps its newly excluded members; the diff skips them.
  const excludes = normalizeExcludes(exclude);
  const shown = [...stored].filter((k) => !isExcluded(k.split('\t')[0] ?? '', excludes));
  return { root, diffBase, exclude, stored: new Set(shown) };
}

/** One diff row as a listing entry: path, status and counts. */
function diffEntryKey(f: {
  relPath: string;
  status?: string;
  oldPath?: string;
  additions?: number;
  deletions?: number;
  whitespaceOnly?: boolean;
}): string {
  return [
    f.relPath,
    f.status ?? '',
    f.oldPath ?? '',
    f.additions ?? '',
    f.deletions ?? '',
    f.whitespaceOnly ? 'w' : '',
  ].join('\t');
}

/** Whether an event path can change a review's listing at all. */
export function isWatchedPath(relPath: string): boolean {
  return !relPath.split('/').some((seg) => IGNORED_SEGMENTS.has(seg));
}

/** How often a watch that is a timer asks for a pass. */
export const POLL_MS = 1_000;

/** Whether this runtime's recursive `fs.watch` can go deaf process-wide. */
export function watchCanWedge(
  platform: string = process.platform,
  // Undefined under node: scripts tested there import this module.
  version: string | undefined = typeof Bun === 'undefined' ? undefined : Bun.version,
): boolean {
  if (platform !== 'linux' || !version) return false;
  const [major = 0, minor = 0, patch = 0] = version.split('.').map((n) => Number.parseInt(n, 10));
  return major < 1 || (major === 1 && (minor < 3 || (minor === 3 && patch < 11)));
}

/** A watch that is a timer: every tick is an event of unknown path. */
export function timerWatch(ms: number): WatchFn {
  const watch: WatchFn = (_root, onEvent) => {
    const timer = setInterval(() => onEvent(null), ms);
    (timer as { unref?: () => void }).unref?.();
    return { close: () => clearInterval(timer) };
  };
  watch.timed = true;
  return watch;
}

export const pollWatch = timerWatch(POLL_MS);

/** Recursive directory watch; null filename means "something, unknown". */
const fsDirectoryWatch: WatchFn = (root, onEvent) => {
  const w = fsWatch(root, { recursive: true }, (_type, name) => {
    onEvent(typeof name === 'string' ? name.split('\\').join('/') : null);
  });
  w.on('error', () => w.close());
  return w;
};

/** Entries a listing walk reads before giving up on a folder. */
const MAX_WALK_ENTRIES = 20_000;
/** How long a listing may take before the watch does without one. */
const LISTING_DEADLINE_MS = 3_000;

/** `git ls-files` as a child process; null outside a repo or on failure. */
async function gitListing(root: string): Promise<Set<string> | null> {
  if (gitBarred(root)) return null;
  try {
    const proc = Bun.spawn(
      [
        'git',
        ...hardenedGitArgs(['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard']),
      ],
      { stdout: 'pipe', stderr: 'ignore', env: hardenedGitEnv() },
    );
    const [text, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (code !== 0) return null;
    return new Set(text.split('\n').filter((l) => l.length > 0));
  } catch {
    return null;
  }
}

/**
 * Outside a repo: the folder's entries, read directory by directory off the
 * main thread. Names only — `readdir` never opens a file. Null when the walk
 * is too big or a directory will not answer.
 */
async function walkListing(root: string): Promise<Set<string> | null> {
  const out = new Set<string>();
  const dirs = [''];
  let seen = 0;
  while (dirs.length > 0) {
    const rel = dirs.pop() ?? '';
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(join(root, rel), { withFileTypes: true });
    } catch {
      return null;
    }
    for (const e of entries) {
      if (++seen > MAX_WALK_ENTRIES) return null;
      const path = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!IGNORED_SEGMENTS.has(e.name)) dirs.push(path);
      } else out.add(path);
    }
  }
  return out;
}

/** A listing, or null once `LISTING_DEADLINE_MS` has passed without one. */
async function inDeadline(listed: Promise<Set<string> | null>): Promise<Set<string> | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), LISTING_DEADLINE_MS);
    (timer as { unref?: () => void }).unref?.();
  });
  try {
    return await Promise.race([listed, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** The repo's listing, else the walk, either inside a deadline. */
export function folderListing(root: string): Promise<Set<string> | null> {
  return inDeadline((async () => (await gitListing(root)) ?? (await walkListing(root)))());
}

/**
 * A working-tree diff as the sidebar draws it: one entry per listed file,
 * its path, status and counts. Excluded paths are left out, so churn the
 * review never shows is not news. Null when git cannot answer in time.
 */
export function diffListing(
  root: string,
  base: string,
  exclude: readonly string[] = [],
): Promise<Set<string> | null> {
  const excludes = normalizeExcludes([...exclude]);
  return inDeadline(
    (async () => {
      const res = await diffFilesAsync(root, base, null);
      if (!res.ok) return null;
      const out = new Set<string>();
      for (const f of res.files) {
        if (isExcluded(f.relPath, excludes)) continue;
        out.add(diffEntryKey(f));
      }
      return out;
    })(),
  );
}

/** The listing a set's watch compares from pass to pass. */
export function liveListing(source: LiveSource): Promise<Set<string> | null> {
  return source.diffBase
    ? diffListing(source.root, source.diffBase, source.exclude)
    : folderListing(source.root);
}

/** Whether two listings name the same paths. */
export function sameListing(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const p of a) if (!b.has(p)) return false;
  return true;
}

interface Watch {
  source: LiveSource;
  handle: { close(): void };
  /** The listing the last pass compared against: a diff's stored rows at
   *  first, a folder's null until its first pass. */
  listed: Set<string> | null;
  /** The first burst refreshes whatever the listing says: a file written
   *  while the first listing ran may be in it before its event arrives. */
  first: boolean;
  dirty: boolean;
  firstAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
  closed: boolean;
}

export function createFolderWatches(
  host: FolderWatchHost,
  opts: FolderWatchOptions = {},
): FolderWatches {
  const watchFn = opts.watch ?? (watchCanWedge() ? pollWatch : fsDirectoryWatch);
  const listPaths = opts.listPaths ?? liveListing;
  const settleMs = opts.settleMs ?? SETTLE_MS;
  const maxWaitMs = opts.maxWaitMs ?? MAX_WAIT_MS;
  const maxFolders = opts.maxFolders ?? MAX_WATCHED_FOLDERS;
  const watches = new Map<string, Watch>();
  /** Channels already found to have no folder, until their pages leave. */
  const noFolder = new Set<string>();

  const run = async (setId: string, w: Watch): Promise<void> => {
    w.timer = null;
    if (w.closed) return;
    w.dirty = false;
    w.running = true;
    try {
      // Listed AFTER the burst's events arrived, so it already holds what
      // they did; a save leaves it unchanged.
      const now = await listPaths(w.source);
      const nullIsNews = watchFn.timed ? w.listed !== null : true;
      const news = w.first || (!now ? nullIsNews : !w.listed || !sameListing(now, w.listed));
      w.first = false;
      w.listed = now;
      if (news && !w.closed) await host.refresh(setId);
    } catch (err) {
      console.error('[folder-watch] pass failed:', err);
    } finally {
      w.running = false;
    }
    if (!w.closed && w.dirty) schedule(setId, w);
  };

  const schedule = (setId: string, w: Watch): void => {
    if (w.running || w.closed) return;
    if (w.timer) clearTimeout(w.timer);
    const waited = Date.now() - w.firstAt;
    const delay = Math.max(0, Math.min(settleMs, maxWaitMs - waited));
    w.timer = setTimeout(() => void run(setId, w), delay);
    (w.timer as { unref?: () => void }).unref?.();
  };

  const onEvent = (setId: string, w: Watch, rel: string | null): void => {
    if (w.closed) return;
    if (rel !== null && !isWatchedPath(rel)) return;
    if (!w.dirty && !w.timer) w.firstAt = Date.now();
    w.dirty = true;
    schedule(setId, w);
  };

  const start = (setId: string): void => {
    if (watches.size >= maxFolders) return;
    const source = host.sourceOf(setId);
    if (!source) {
      noFolder.add(setId);
      return;
    }
    const w: Watch = {
      source,
      handle: { close() {} },
      // A diff starts from the rows it has stored, so its first pass is a
      // comparison like any other.
      listed: source.stored ?? null,
      first: !source.stored,
      dirty: false,
      firstAt: 0,
      timer: null,
      running: false,
      closed: false,
    };
    try {
      w.handle = watchFn(source.root, (rel) => onEvent(setId, w, rel));
    } catch {
      // The root is gone or unreadable; the page keeps its focus re-read.
      noFolder.add(setId);
      return;
    }
    watches.set(setId, w);
    // Check a stored diff against the disk now: it may have moved while no
    // page held it.
    if (source.stored) onEvent(setId, w, null);
  };

  const stop = (setId: string): void => {
    noFolder.delete(setId);
    const w = watches.get(setId);
    if (!w) return;
    watches.delete(setId);
    w.closed = true;
    if (w.timer) clearTimeout(w.timer);
    w.handle.close();
  };

  return {
    sync(setId, pages) {
      if (pages === 0) stop(setId);
      else if (!watches.has(setId) && !noFolder.has(setId)) start(setId);
    },
    size: () => watches.size,
    dispose() {
      for (const id of [...watches.keys()]) stop(id);
      noFolder.clear();
    },
  };
}
