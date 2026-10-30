import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { makeDocKey, parseDocKey } from '../doc-key.ts';
import type { DocStore } from '../doc-store.ts';
import {
  type LibrarySources,
  type ProjectFile,
  birthOf,
  buildLibrary,
  createMarkdownLister,
  openableFiles,
  projectName,
  projectRepoKey,
} from '../library.ts';
import { listMeetings } from '../meetings.ts';
import { type ShareTarget, isLoopbackAddress } from '../middleware/host-guard.ts';
import { type WorkspaceScope, restIs } from '../middleware/workspace-scope.ts';
import type { MountStore } from '../mount-store.ts';
import { isWithinRoot } from '../safe-path.ts';
import { boundFiles } from '../slow-fs.ts';
import type { TaskProjection } from '../task-projection.ts';
import type { RunOutputSource } from '../task-run-output.ts';
import type { BoardWorkspace, TaskStore } from '../tasks.ts';

/**
 * The board's Library over HTTP: the list behind the Library page, and the
 * one verb that opens a project file nobody has bound yet.
 *
 *   GET  /workspaces/<id>/library/items — meetings and files, newest first
 *   POST /workspaces/<id>/library/open  — `{ path }` → `{ docId, href }`
 *
 * The list is on `shareScopeAllows`, and a share visitor's list is a
 * different build: only what is FILED on the board — its docs, mocks, apps
 * and meetings, each opening at an address on the board — with no project,
 * no repo file nobody filed and no mount, because those name files on this
 * machine rather than content on the board (`visitorSources`). Before this, a
 * member who opened the Library tab was refused its data and read "The
 * library could not load". `open` is not on the allowlist and refuses a share
 * visitor itself as well: it binds a file on this machine.
 *
 * **What `open` may bind.** A page may not name a host path — binding is an
 * agent action for exactly that reason (`browserCannotBindBody`). This verb
 * takes a path RELATIVE to a root the server chose, and binds it only when the
 * server's own Library listing for this board offers it: a markdown file that
 * `git ls-files --cached --others --exclude-standard` lists, or a markdown file
 * in the project's mounts. Anything else is `not-listed`, whether or not it
 * exists, because whether a hidden file exists is itself what must not be told.
 * A symlink inside the root that points outside it is refused after the
 * lexical check, the way `openContextFile` refuses one.
 *
 * A path the listing found through a MOUNT resolves through that mount
 * (`resolveFile`), never by joining it to the project root: a mount records
 * the checkout its bytes came from, which may be a worktree the root is not,
 * and the same relative path in the other checkout is a different file.
 */

export interface LibraryRoutesContext {
  docStore: DocStore;
  taskStore: TaskStore;
  taskProjection: TaskProjection;
  mounts: MountStore;
  dataDir: string;
  j: (status: number, body: unknown) => Response;
  safeJson: (req: Request) => Promise<Record<string, unknown> | null>;
  /** Take a doc filed here out of the default holding board. */
  unfileFromDefault: (attachmentId: string, keptBoardWorkspaceId: string) => void;
  /** The project's markdown files — cached, see `createMarkdownLister`. */
  markdownFiles: (root: string) => readonly ProjectFile[];
  /** The request's SOCKET address, never a header. */
  requestAddress: (req: Request) => string | undefined;
  /** Whether an attachment set keeps its files on this machine
   *  (`attachment-privacy.ts`). Absent reads every set as shareable, which is
   *  what a set was before sets had a privacy. */
  isLocalOnlySet?: (setId: string | undefined) => boolean;
  /** A reader opened this project file here (`noteOutputOpened`). */
  onOpened?: (workspaceId: string, relPath: string) => void;
}

export interface LibraryRouteRequest {
  scope?: WorkspaceScope<BoardWorkspace>;
  req: Request;
  visitor: ShareTarget | null;
}

/**
 * Is `relPath` inside the mounted folder `dir`?
 *
 * Both are repo-relative and POSIX. The empty string is the repo root, which
 * every path is inside. The separator is required, so `docs/riverbend-notes`
 * is not inside `docs/riverbend`.
 */
function under(relPath: string, dir: string): boolean {
  return dir === '' || relPath === dir || relPath.startsWith(`${dir}/`);
}

/** A relative path longer than this is not one a repo listing produced. */
const MAX_PATH_CHARS = 1024;

/** Mounted files past this many are not offered — the page lists, it does not index. */
const MAX_MOUNTED_FILES = 1000;

/** Answers the two routes above, or `undefined` when the path is neither. */
export async function handleLibraryRoutes(
  ctx: LibraryRoutesContext,
  rq: LibraryRouteRequest,
): Promise<Response | undefined> {
  const { scope, req, visitor } = rq;
  const { j } = ctx;
  const items = restIs(scope, 'library/items');
  const open = restIs(scope, 'library/open');
  if (!scope || (!items && !open)) return undefined;
  if (items && req.method === 'GET') {
    const onBox = !visitor && isOnBox(ctx, req);
    const src = sourcesFor(ctx, scope, onBox);
    return j(200, buildLibrary(visitor ? visitorSources(src) : src));
  }
  if (visitor) return j(403, { error: 'the library is not available to share visitors' });
  if (open && req.method === 'POST') return openFile(ctx, scope, req);
  return j(405, { error: 'method not allowed' });
}

/**
 * A share visitor's Library: the board's own filed content and nothing that
 * names the machine. No project root means no project path, no repo listing
 * and no file to bind; no mounts and no `placing` means no folder names and
 * no storage phrases. Every row left opens at an address on the board, which
 * the membership gate judges again when it is opened.
 */
function visitorSources(src: LibrarySources): LibrarySources {
  const { placing: _placing, ...rest } = src;
  return { ...rest, projectRoot: () => null, markdownFiles: () => [], mountedFiles: () => [] };
}

/** Did this request come from this machine, unproxied? */
function isOnBox(ctx: LibraryRoutesContext, req: Request): boolean {
  if (req.headers.has('cf-ray')) return false;
  return isLoopbackAddress(ctx.requestAddress(req));
}

/** What the Library of this board is built from, as seen on the box or off it. */
function sourcesFor(
  ctx: LibraryRoutesContext,
  scope: Pick<WorkspaceScope<BoardWorkspace>, 'workspaceId' | 'board'>,
  onBox: boolean,
  /** The lister to read the project's markdown with. Defaults to the page's
   *  short-lived cache; the run-output reader passes a fresh one. It is taken
   *  HERE rather than swapped onto the result, because the hidden-folder
   *  filter below wraps whichever lister is used — a caller that replaced the
   *  wrapped function afterwards would have unwrapped the filter with it. */
  lister: (root: string) => readonly ProjectFile[] = ctx.markdownFiles,
): LibrarySources {
  const { docStore, mounts, dataDir } = ctx;
  const ids = new Set(scope.board.docIds);
  // A file of a local-only attachment set is not listed off the box: its
  // name is the first thing that would leave, the same rule `hidden` below
  // applies to a local-only project.
  const setHidden = (m: { setId?: string; workspaceId?: string }): boolean =>
    !onBox && (ctx.isLocalOnlySet?.(m.setId ?? m.workspaceId) ?? false);
  const docs = docStore.list().filter((m) => ids.has(m.docId) && !setHidden(m));
  const boundPaths = new Map(docs.map((m) => [m.docId, m.sourceUrl]));
  // One stat per bound doc per load, shared by both of its clocks.
  const stats = new Map<string, { mtimeMs: number; birthtimeMs: number } | undefined>();
  const statOf = (docId: string) => {
    if (stats.has(docId)) return stats.get(docId);
    const st = statBound(boundPaths.get(docId));
    stats.set(docId, st);
    return st;
  };
  // A local-only project's files must not leave the machine, and their NAMES
  // are the first thing that would: off the box, such a project lists only
  // the docs already filed on the board, exactly as `/mounts/<id>` refuses
  // its bytes.
  const hidden = (repoKey: string): boolean => mounts.privacyOf(repoKey) === 'local-only' && !onBox;
  // The same rule one folder at a time. A project may be open while one of
  // its mounts is not, and off the box that mount's files are not listed and
  // its folder is not named — the listing is where a name would leave the
  // machine first, and `openableFiles` is built from it, so a path that is
  // not offered is a path `library/open` refuses to bind.
  const mountHidden = (repoKey: string, mountId: string): boolean =>
    mounts.mountPrivacyOf(repoKey, mountId) === 'local-only' && !onBox;
  const projectKey = projectRepoKey(docs, (docId) => docStore.repos.primaryKeyFor(docId));
  const hiddenFolders = projectKey
    ? mounts.registry
        .liveMounts(projectKey)
        .filter((m) => mountHidden(projectKey, m.mountId))
        .map((m) => m.relPath)
    : [];
  return {
    workspaceId: scope.workspaceId,
    docs,
    docKeyOf: (docId) => docStore.repos.primaryKeyFor(docId),
    lastMeeting: (docId) => {
      let latest: { startedAt: number; endedAt: number | null } | undefined;
      for (const m of listMeetings(dataDir, docId)) {
        if (latest === undefined || m.startedAt > latest.startedAt) {
          latest = { startedAt: m.startedAt, endedAt: m.endedAt };
        }
      }
      return latest;
    },
    // Read off the metas already in hand, never `docStore.get`: hydrating
    // every doc on the board to draw a list of them is the wrong price for a
    // page view.
    fileMtime: (docId) => statOf(docId)?.mtimeMs,
    fileBirth: (docId) => birthOf(statOf(docId) ?? { birthtimeMs: 0 }).createdMs,
    projectRoot: (repoKey) => (hidden(repoKey) ? null : mounts.rootFor(repoKey)),
    // The project's own git listing is a SECOND way a hidden folder's names
    // could leave: a markdown file under a local-only mount is listed by
    // `git ls-files` whether or not the mount offers it. So the same folders
    // are dropped here too, and the two sources agree.
    markdownFiles: (root) =>
      hiddenFolders.length === 0
        ? lister(root)
        : lister(root).filter((f) => !hiddenFolders.some((d) => under(f.relPath, d))),
    mountedFiles: (repoKey) => {
      // Each file's birth time is read in the checkout its MOUNT was made
      // from, which may be a worktree the project root is not.
      const roots = new Map<string, string | null>();
      const rootOf = (mountId: string): string | null => {
        if (!roots.has(mountId)) {
          const mount = mounts.registry.mountById(repoKey, mountId);
          roots.set(mountId, mount ? mounts.checkoutRootOf(repoKey, mount) : null);
        }
        return roots.get(mountId) ?? null;
      };
      const files = mounts
        .listFiles(repoKey, { limit: MAX_MOUNTED_FILES })
        .files.filter((f) => !mountHidden(repoKey, f.mountId));
      return files.map((f) => {
        const root = rootOf(f.mountId);
        const st = root ? statBound(join(root, f.relPath)) : undefined;
        const born = st ? birthOf(st) : {};
        return { fileId: f.fileId, relPath: f.relPath, mtimeMs: f.mtimeMs, ...born };
      });
    },
    // Where each doc lives. Folders are repo-relative and storage is a
    // phrase; the data dir is only compared against, never named.
    placing: {
      storageRoots: storageRootsOf(dataDir),
      meetingsFolder: projectKey ? mounts.meetingsOf(projectKey)?.relPath : undefined,
      mountFolders: projectKey
        ? mounts.registry
            .liveMounts(projectKey)
            .filter((m) => !mountHidden(projectKey, m.mountId))
            .map((m) => m.relPath)
        : [],
      projectNameOf: (repoKey) => {
        if (hidden(repoKey)) return null;
        const root = mounts.rootFor(repoKey);
        return root ? projectName(repoKey, root) : null;
      },
    },
  };
}

/**
 * A bound path's stat, or undefined when there is no file there to read.
 *
 * `throwIfNoEntry` covers only ENOENT. A path whose parent turned into a file
 * (ENOTDIR), one a permission change put out of reach (EACCES), a symlink
 * loop — each still throws, and an unreadable file is the ordinary reason a
 * row has no time to show. Failing the whole page over one of them would
 * blank the Library instead. `statSync` never materializes a cloud-synced
 * file, so an online-only file costs a syscall rather than a download.
 */
function statBound(path: string | undefined): { mtimeMs: number; birthtimeMs: number } | undefined {
  if (path === undefined || !path.startsWith('/')) return undefined;
  try {
    // Through the bound-file guard, which never stats a link for where it
    // points under a walled lead's project.
    const st = boundFiles.guards.statSync(path);
    return st.isFile() ? { mtimeMs: st.mtimeMs, birthtimeMs: st.birthtimeMs } : undefined;
  } catch {
    return undefined;
  }
}

/** The data dir as given and as the filesystem resolves it — a bound path may
 *  carry either spelling (`/var` against `/private/var` on macOS). */
function storageRootsOf(dataDir: string): string[] {
  try {
    const real = realpathSync(dataDir);
    return real === dataDir ? [dataDir] : [dataDir, real];
  } catch {
    return [dataDir];
  }
}

/**
 * Bind a listed project file and file it on this board, then answer the page
 * it opens at. A file some doc already holds — on this board or another — is
 * that doc: the repo registry keys a document by repo and path, so opening it
 * here reuses its threads rather than minting a second copy beside them.
 */
async function openFile(
  ctx: LibraryRoutesContext,
  scope: WorkspaceScope<BoardWorkspace>,
  req: Request,
): Promise<Response> {
  const { docStore, taskStore, taskProjection, j } = ctx;
  const body = await ctx.safeJson(req);
  const relPath = body?.path;
  if (typeof relPath !== 'string' || relPath === '' || relPath.length > MAX_PATH_CHARS) {
    return j(400, { error: 'path required' });
  }
  const src = sourcesFor(ctx, scope, isOnBox(ctx, req));
  const repoKey = projectRepoKey(src.docs, src.docKeyOf);
  const root = repoKey ? src.projectRoot(repoKey) : null;
  if (!repoKey || !root) return j(404, { error: 'not-listed' });
  // The file is open at `docId`: that is a reader's open, then its page.
  const opened = (docId: string): Response => {
    ctx.onOpened?.(scope.workspaceId, relPath);
    const href = `/workspaces/${encodeURIComponent(scope.workspaceId)}/docs/${encodeURIComponent(docId)}`;
    return j(200, { docId, href });
  };
  // A file this board already holds opens at its doc. The listing stops
  // offering a path once it is bound, so a link written before the bind — a
  // run-output item's, or a second tap — would otherwise go dead. Nothing is
  // told that the board's own Files list does not already show.
  const onBoard = heldOnBoard(ctx, scope.board, repoKey, relPath);
  if (onBoard) return opened(onBoard);
  // The listing is the rule: the path opens only if this board's Library
  // offers it, which is what keeps an ignored or hidden file shut.
  const offered = openableFiles(src);
  if (!offered.has(relPath)) return j(404, { error: 'not-listed' });
  const fileId = offered.get(relPath) ?? null;
  let abs: string;
  if (fileId) {
    // Through the mount, so the bytes come from the checkout the mount
    // recorded. `resolveFile` re-checks the whole address — recorded, live
    // mount, servable spelling, and inside that mount after symlinks.
    const resolved = ctx.mounts.resolveFile(fileId);
    if (!resolved || resolved.repoKey !== repoKey || resolved.file.relPath !== relPath) {
      return j(404, { error: 'not-listed' });
    }
    abs = resolved.abs;
  } else {
    abs = join(root, relPath);
    if (!isWithinRoot(root, abs)) return j(400, { error: 'bad-path' });
  }

  const fileHere = (docId: string): void => {
    if (scope.board.docIds.includes(docId)) return;
    taskStore.attachDoc(scope.workspaceId, docId);
    taskProjection.ensureWorkspace(scope.workspaceId);
    ctx.unfileFromDefault(docId, scope.workspaceId);
  };

  // Already a doc (filed on another board): link it here and open it. Its
  // binding is that doc's own business — re-binding it from a page view would
  // repoint a live doc somebody else is working in.
  const held = docStore.repos.docIdFor(makeDocKey(repoKey, relPath));
  if (held && docStore.get(held)) {
    fileHere(held);
    return opened(held);
  }
  // A fresh random name, never a readable one: `createForCaller` REPOINTS a
  // doc its name already resolves to, so a name like the file's could land
  // this bind on some unrelated doc that happened to be called that.
  const created = docStore.createForCaller(`library-${randomUUID()}`, {
    type: 'markdown',
    sourceUrl: abs,
  });
  if (!created.ok) return j(400, { error: created.error });
  const docId = created.doc.docId;
  // Filed BEFORE the attach, as the create route does: a failed attach must
  // not leave the one doc this verb made stranded off every board.
  fileHere(docId);
  let sourceUrl = abs;
  const verdict = docStore.resolveLiveCopy(docId, { withGitStatus: true });
  if (!verdict.ok && verdict.error === 'ambiguous-copy') {
    return j(409, { error: 'ambiguous-copy', docId });
  }
  if (verdict.ok && verdict.live) {
    sourceUrl = verdict.live;
    docStore.noteBoundCopy(docId, verdict.live);
  }
  const attached = await docStore.attachFileAsync(docId, sourceUrl);
  if (!attached.ok) return j(409, { error: 'attach_failed', docId });
  return opened(docId);
}

/** The doc of this board that holds the project file at `relPath`, if any. */
function heldOnBoard(
  ctx: Pick<LibraryRoutesContext, 'docStore'>,
  board: BoardWorkspace,
  repoKey: string,
  relPath: string,
): string | undefined {
  const held = ctx.docStore.repos.docIdFor(makeDocKey(repoKey, relPath));
  return held !== undefined && board.docIds.includes(held) ? held : undefined;
}

/**
 * The Library's listing as the scheduler reads it, for a run's output
 * (`task-run-output.ts`): the project's markdown files with their mtimes,
 * the ones this board would offer to open and the ones its docs hold, and
 * which project file a doc of the board holds. Read as a member on the box
 * sees it, because the item lands on the board's own queue — except that a local-only
 * project's files, and a local-only mount's, are never offered, so their
 * names never reach an item a share visitor can read. It walks the project afresh rather than reading the
 * page's short-lived cache: a scan taken just before a late write would hide
 * that file, and a run is looked at only once.
 */
export function libraryRunOutputSource(
  ctx: LibraryRoutesContext,
  boardOf: (workspaceId: string) => BoardWorkspace | undefined,
): RunOutputSource & {
  /** The project file a doc of this board holds, for its page's open. */
  fileOf(workspaceId: string, docId: string): string | undefined;
} {
  const scopeOf = (workspaceId: string) => {
    const board = boardOf(workspaceId);
    return board ? { workspaceId, board } : undefined;
  };
  return {
    files: (workspaceId) => {
      const scope = scopeOf(workspaceId);
      if (!scope) return null;
      const src = sourcesFor(ctx, scope, false, createMarkdownLister());
      const repoKey = projectRepoKey(src.docs, src.docKeyOf);
      if (!repoKey || !src.projectRoot(repoKey)) return null;
      const byPath = new Map<string, number | undefined>();
      for (const meta of src.docs) {
        const key = parseDocKey(src.docKeyOf(meta.docId) ?? '');
        if (key?.repoKey === repoKey && key.relPath.toLowerCase().endsWith('.md')) {
          byPath.set(key.relPath, src.fileMtime(meta.docId));
        }
      }
      for (const f of buildLibrary(src).files) if (f.open !== undefined) byPath.set(f.open, f.at);
      return [...byPath].map(([relPath, at]) => ({ relPath, ...(at !== undefined ? { at } : {}) }));
    },
    fileOf: (workspaceId, docId) => {
      const scope = scopeOf(workspaceId);
      if (!scope || !scope.board.docIds.includes(docId)) return undefined;
      const src = sourcesFor(ctx, scope, false);
      const repoKey = projectRepoKey(src.docs, src.docKeyOf);
      const key = parseDocKey(src.docKeyOf(docId) ?? '');
      return repoKey !== null && key?.repoKey === repoKey ? key.relPath : undefined;
    },
  };
}
