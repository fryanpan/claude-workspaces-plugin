import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { makeDocKey } from '../doc-key.ts';
import type { DocStore } from '../doc-store.ts';
import {
  type LibrarySources,
  type ProjectFile,
  buildLibrary,
  openableFiles,
  projectRepoKey,
} from '../library.ts';
import { listMeetings } from '../meetings.ts';
import { type ShareTarget, isLoopbackAddress } from '../middleware/host-guard.ts';
import { type WorkspaceScope, restIs } from '../middleware/workspace-scope.ts';
import type { MountStore } from '../mount-store.ts';
import { isWithinRoot } from '../safe-path.ts';
import type { TaskProjection } from '../task-projection.ts';
import type { BoardWorkspace, TaskStore } from '../tasks.ts';

/**
 * The board's Library over HTTP: the list behind the Library page, and the
 * one verb that opens a project file nobody has bound yet.
 *
 *   GET  /workspaces/<id>/library/items — meetings and files, newest first
 *   POST /workspaces/<id>/library/open  — `{ path }` → `{ docId, href }`
 *
 * Neither is on `shareScopeAllows`, so both are trusted-local: a member on the
 * operator host or the box. The PAGE (`/workspaces/<id>/library`) is a board
 * tab like Activity and is served with the shell; the data is not, because it
 * names files in a repo on this machine rather than content filed on the
 * board. Each handler refuses a share visitor itself as well, so a later
 * allowlist entry under the board's prefix cannot open them silently.
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
}

export interface LibraryRouteRequest {
  scope?: WorkspaceScope<BoardWorkspace>;
  req: Request;
  visitor: ShareTarget | null;
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
  if (visitor) return j(403, { error: 'the library is not available to share visitors' });
  if (items && req.method === 'GET') return j(200, buildLibrary(sourcesFor(ctx, scope, req)));
  if (open && req.method === 'POST') return openFile(ctx, scope, req);
  return j(405, { error: 'method not allowed' });
}

/** Did this request come from this machine, unproxied? */
function isOnBox(ctx: LibraryRoutesContext, req: Request): boolean {
  if (req.headers.has('cf-ray')) return false;
  return isLoopbackAddress(ctx.requestAddress(req));
}

/** What the Library of this board is built from, for this request. */
function sourcesFor(
  ctx: LibraryRoutesContext,
  scope: WorkspaceScope<BoardWorkspace>,
  req: Request,
): LibrarySources {
  const { docStore, mounts, dataDir } = ctx;
  const ids = new Set(scope.board.docIds);
  const docs = docStore.list().filter((m) => ids.has(m.docId));
  const boundPaths = new Map(docs.map((m) => [m.docId, m.sourceUrl]));
  // A local-only project's files must not leave the machine, and their NAMES
  // are the first thing that would: off the box, such a project lists only
  // the docs already filed on the board, exactly as `/mounts/<id>` refuses
  // its bytes.
  const hidden = (repoKey: string): boolean =>
    mounts.privacyOf(repoKey) === 'local-only' && !isOnBox(ctx, req);
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
    // page view. `statSync` never materializes a cloud-synced file, so an
    // online-only file costs a syscall rather than a download — the same
    // reason `createMarkdownLister` stats instead of reading.
    fileMtime: (docId) => {
      const path = boundPaths.get(docId);
      if (path === undefined || !path.startsWith('/')) return undefined;
      const st = statSync(path, { throwIfNoEntry: false });
      return st?.isFile() ? st.mtimeMs : undefined;
    },
    projectRoot: (repoKey) => (hidden(repoKey) ? null : mounts.rootFor(repoKey)),
    markdownFiles: ctx.markdownFiles,
    mountedFiles: (repoKey) =>
      mounts
        .listFiles(repoKey, { limit: MAX_MOUNTED_FILES })
        .files.map((f) => ({ fileId: f.fileId, relPath: f.relPath, mtimeMs: f.mtimeMs })),
  };
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
  const src = sourcesFor(ctx, scope, req);
  const repoKey = projectRepoKey(src.docs, src.docKeyOf);
  const root = repoKey ? src.projectRoot(repoKey) : null;
  if (!repoKey || !root) return j(404, { error: 'not-listed' });
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

  const hrefOf = (docId: string): string =>
    `/workspaces/${encodeURIComponent(scope.workspaceId)}/docs/${encodeURIComponent(docId)}`;
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
    return j(200, { docId: held, href: hrefOf(held) });
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
  return j(200, { docId, href: hrefOf(docId) });
}
