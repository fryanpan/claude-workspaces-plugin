/**
 * A board holding a `scratch/` doc is never shared.
 *
 * `scratch/` is where a project keeps what must never leave the machine:
 * outreach plans, research about individuals, private notes. Before this, a
 * scratch doc was kept private only because nobody had shared the board it
 * sat on, and one `share_workspace` call would have published it. So the
 * rule now holds in both directions:
 *
 *  - a share may not be minted for a board that holds a doc bound under a
 *    `scratch/` path segment (`scratchDocOn`, read by both mint routes);
 *  - a `scratch/` path may not be bound or filed onto a board that is
 *    already shared (`scratchBindRefusal`, read by every bind route).
 *
 * A folder bind opens its files lazily, so most of its files are not docs
 * until somebody opens one. Both directions therefore read the folder
 * listing as well as the doc metas: a mint scans every held set's root, a
 * folder bind onto a shared board scans before it binds, and a lazy open
 * through a shared board refuses a `scratch/` path (a file created after
 * the bind is first met there).
 *
 * "Shared" is the server's `boardIsShared`: any share link, member or share
 * row the board has ever had, live or not. That over-refuses a board whose
 * last share was revoked, which is the safe direction.
 *
 * Each refusal names the doc, so the caller knows exactly what to move: the
 * remedy is to file it on a private board or archive it, never to delete it.
 *
 * A SEGMENT, matched exactly: `/repo/scratch/plan.md` and
 * `scratch\notes.md` are scratch; `/repo/scratchpad/x.md` and
 * `/repo/my-scratch/x.md` are not. Case-folded, because macOS's default
 * volume treats `Scratch/` and `scratch/` as one folder.
 */

/** The path segment that marks a file as never-shareable. */
export const SCRATCH_SEGMENT = 'scratch';

/**
 * Does any directory segment of this path read `scratch`? A file's own name
 * is not a directory, so a file called `scratch` is not; pass `dir: true`
 * when the path names a folder, whose last segment counts.
 */
export function hasScratchSegment(
  path: string | undefined | null,
  opts: { dir?: boolean } = {},
): boolean {
  if (typeof path !== 'string' || path === '') return false;
  const segments = path.split(/[/\\]+/);
  if (!opts.dir) segments.pop();
  return segments.some((s) => s.toLowerCase() === SCRATCH_SEGMENT);
}

/** The fields of a doc's meta this gate reads. */
export interface ScratchDocMeta {
  docId: string;
  title?: string;
  sourceUrl?: string;
  relPath?: string;
  setId?: string;
  workspaceId?: string;
  /** A folder or diff set's root. Its files open lazily, so they are scanned. */
  workspaceRoot?: string;
}

/** A doc bound under `scratch/`, as a refusal names it. */
export interface ScratchHit {
  docId: string;
  title?: string;
  path: string;
}

/** The doc's bound path when it sits under `scratch/`, else null. */
export function scratchPathOf(meta: ScratchDocMeta): string | null {
  if (hasScratchSegment(meta.sourceUrl)) return meta.sourceUrl as string;
  if (hasScratchSegment(meta.relPath)) return meta.relPath as string;
  return null;
}

/**
 * The first doc on a board bound under `scratch/`. A board's `docIds` holds
 * docs and attachment sets (a folder bind, a diff review); a set's member
 * files are docs whose `setId` names it, so they are on the board too.
 *
 * A set's files are not all docs yet: a folder bind opens its files lazily,
 * so one nobody has opened has no meta to find. When `scan` is given, each
 * held set's root is listed with it (the same listing that decides which
 * files the set may open) and a scratch file there counts as held.
 */
export function scratchDocOn(
  boardDocIds: readonly string[],
  docs: Iterable<ScratchDocMeta>,
  scan?: (root: string) => readonly string[],
): ScratchHit | null {
  const held = new Set(boardDocIds);
  const roots = new Map<string, string>();
  for (const meta of docs) {
    const set = [meta.setId, meta.workspaceId].find((id) => id !== undefined && held.has(id));
    if (!held.has(meta.docId) && set === undefined) continue;
    const path = scratchPathOf(meta);
    if (path !== null) {
      return { docId: meta.docId, ...(meta.title ? { title: meta.title } : {}), path };
    }
    if (meta.workspaceRoot && !roots.has(meta.workspaceRoot)) {
      roots.set(meta.workspaceRoot, set ?? meta.docId);
    }
  }
  if (!scan) return null;
  for (const [root, setId] of roots) {
    if (hasScratchSegment(root, { dir: true })) return { docId: setId, path: root };
    const file = scratchFileIn(root, scan);
    if (file !== null) return { docId: setId, path: file };
  }
  return null;
}

/**
 * The first file under `root` whose path below it has a `scratch/` segment,
 * else null. Only the part below the root is read: a folder bound from inside
 * a scratch tree is caught by checking the root itself.
 */
export function scratchFileIn(
  root: string,
  scan: (root: string) => readonly string[],
): string | null {
  return scan(root).find((rel) => hasScratchSegment(rel)) ?? null;
}

/**
 * Where a folder about to be bound holds `scratch/`: the folder itself when
 * it sits in a scratch tree, else its first scratch file, else null. Read
 * BEFORE the bind, because the bind files nothing about a file it has not
 * opened yet.
 */
export function scratchInFolder(
  folder: string,
  scan: (root: string) => readonly string[],
): string | null {
  if (hasScratchSegment(folder, { dir: true })) return folder;
  const file = scratchFileIn(folder, scan);
  return file === null ? null : file;
}

/** What a share mint answers on a board holding a scratch doc. */
export function scratchShareRefusal(
  workspaceId: string,
  hit: ScratchHit,
): {
  error: 'board_holds_scratch_doc';
  workspaceId: string;
  docId: string;
  title?: string;
  path: string;
  hint: string;
} {
  return {
    error: 'board_holds_scratch_doc',
    workspaceId,
    docId: hit.docId,
    ...(hit.title ? { title: hit.title } : {}),
    path: hit.path,
    hint: `This board holds ${describe(hit)}, which is bound under a scratch/ folder, so it cannot be shared. File that doc on a private board or archive it here (archive_doc), then share again.`,
  };
}

/** What a bind answers when it would put a scratch path on a shared board. */
export function scratchBindRefusal(
  workspaceId: string,
  hit: ScratchHit,
): {
  error: 'scratch_doc_on_shared_board';
  workspaceId: string;
  docId: string;
  title?: string;
  path: string;
  hint: string;
} {
  return {
    error: 'scratch_doc_on_shared_board',
    workspaceId,
    docId: hit.docId,
    ...(hit.title ? { title: hit.title } : {}),
    path: hit.path,
    hint: `${capital(describe(hit))} is bound under a scratch/ folder, and this board is shared, so it cannot be put here. Bind it on a board that is not shared.`,
  };
}

function describe(hit: ScratchHit): string {
  return hit.title ? `the doc "${hit.title}" (${hit.docId})` : `the doc ${hit.docId}`;
}

function capital(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
