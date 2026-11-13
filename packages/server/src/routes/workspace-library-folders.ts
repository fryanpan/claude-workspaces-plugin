import { randomUUID } from 'node:crypto';
import {
  type FolderError,
  type FolderResult,
  archiveFolder,
  createFolder,
  liveFolders,
  moveFolder,
  renameFolder,
  setDocFolder,
  unarchiveFolder,
} from '../library-folders.ts';
import { type WorkspaceScope, matchRest, restIs } from '../middleware/workspace-scope.ts';
import type { BoardWorkspace } from '../tasks.ts';
import type { LibraryRouteRequest, LibraryRoutesContext } from './workspace-library.ts';

/**
 * The Library's folders over HTTP — the verbs the page's tree and the MCP
 * folder tools both call.
 *
 *   GET  /workspaces/<id>/library/folders                   → { folders }
 *   POST /workspaces/<id>/library/folders                   { name, parentId? }
 *   POST /workspaces/<id>/library/folders/<fid>/rename      { name }
 *   POST /workspaces/<id>/library/folders/<fid>/move        { parentId }
 *   POST /workspaces/<id>/library/folders/<fid>/archive
 *   POST /workspaces/<id>/library/folders/<fid>/unarchive
 *   PUT  /workspaces/<id>/library/docs/<docId>/folder       { folderId | null }
 *
 * Every answer carries the board's live folders, so a caller never needs a
 * second read to draw the tree. Filing is board data only: no verb here
 * touches a doc's file, path or id.
 *
 * Trusted-local, like the board's other configuration writes: none of these
 * paths is on `shareScopeAllows`, and a share visitor is refused here as
 * well. A member still SEES the folders, through `library/items`.
 */

/** A folder id as this server mints it, or the built-in `meetings`. */
const FOLDER_ID = /^[A-Za-z0-9_-]{1,64}$/;

const STATUS: Record<FolderError, number> = {
  'bad-name': 400,
  'bad-parent': 400,
  'duplicate-name': 409,
  'built-in': 409,
  'not-archived': 409,
  'too-many': 409,
  'not-found': 404,
};

const newFolderId = (): string => `f-${randomUUID().replace(/-/g, '').slice(0, 12)}`;

/** Answers the paths above, or `undefined` for any other. */
export async function handleLibraryFolderRoutes(
  ctx: LibraryRoutesContext,
  rq: LibraryRouteRequest,
): Promise<Response | undefined> {
  const { scope, req, visitor } = rq;
  if (!scope) return undefined;
  const list = restIs(scope, 'library/folders');
  const verb = matchRest(scope, /^library\/folders\/([^/]+)\/(rename|move|archive|unarchive)$/);
  const doc = matchRest(scope, /^library\/docs\/([^/]+)\/folder$/);
  if (!list && !verb && !doc) return undefined;
  const { j } = ctx;
  if (visitor) return j(403, { error: 'library folders are not available to share visitors' });
  const board = scope as WorkspaceScope<BoardWorkspace>;
  const answer = (res: FolderResult<object> | { ok: false; error: string }) => {
    if (!res.ok) {
      const status = STATUS[res.error as FolderError] ?? 404;
      const message = 'message' in res ? res.message : 'workspace not found';
      return j(status, { error: res.error, message });
    }
    const fresh = ctx.taskStore.getWorkspace(board.workspaceId) ?? board.board;
    return j(200, { ...res, folders: liveFolders(fresh) });
  };
  const update = <T extends { ok: boolean }>(op: (b: BoardWorkspace) => T) =>
    ctx.taskStore.updateLibraryFolders(board.workspaceId, op);

  if (list) {
    if (req.method === 'GET') return j(200, { folders: liveFolders(board.board) });
    if (req.method !== 'POST') return j(405, { error: 'method not allowed' });
    const body = await ctx.safeJson(req);
    const parentId = parentOf(body?.parentId);
    if (parentId === undefined)
      return j(400, { error: 'bad-parent', message: 'parentId must be a folder id or null.' });
    return answer(
      update((b) =>
        createFolder(b, { name: body?.name, parentId }, { now: Date.now(), newId: newFolderId }),
      ),
    );
  }

  if (verb) {
    if (req.method !== 'POST') return j(405, { error: 'method not allowed' });
    const id = decodeURIComponent(verb[1] ?? '');
    if (!FOLDER_ID.test(id))
      return j(404, { error: 'not-found', message: 'No such folder on this board.' });
    const body = (await ctx.safeJson(req)) ?? {};
    switch (verb[2]) {
      case 'rename':
        return answer(update((b) => renameFolder(b, id, body.name)));
      case 'move': {
        const parentId = 'parentId' in body ? parentOf(body.parentId) : undefined;
        if (parentId === undefined)
          return j(400, { error: 'bad-parent', message: 'parentId must be a folder id or null.' });
        return answer(update((b) => moveFolder(b, id, parentId)));
      }
      case 'archive':
        return answer(update((b) => archiveFolder(b, id, Date.now())));
      default:
        return answer(update((b) => unarchiveFolder(b, id)));
    }
  }

  // Filing a doc. It has to be on this board: a folder here is this board's
  // way of sorting its own docs.
  if (req.method !== 'PUT') return j(405, { error: 'method not allowed' });
  // An alias (`plan`) and the canonical id (`d-…`) name the same doc.
  const docId = ctx.docStore.resolveDocId(decodeURIComponent(doc?.[1] ?? ''));
  if (!board.board.docIds.includes(docId)) {
    return j(404, { error: 'not-found', message: 'That doc is not on this board.' });
  }
  const body = await ctx.safeJson(req);
  const folderId = body && 'folderId' in body ? parentOf(body.folderId) : undefined;
  if (folderId === undefined) {
    return j(400, { error: 'bad-parent', message: 'folderId must be a folder id or null.' });
  }
  return answer(update((b) => ({ ...setDocFolder(b, docId, folderId), docId })));
}

/** A parent or folder id from a body: null for none, undefined when malformed. */
function parentOf(raw: unknown): string | null | undefined {
  if (raw === undefined || raw === null || raw === '') return null;
  return typeof raw === 'string' && FOLDER_ID.test(raw) ? raw : undefined;
}
