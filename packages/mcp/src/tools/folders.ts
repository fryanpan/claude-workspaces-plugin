/**
 * The Library folder verbs. Each is one REST call to
 * `routes/workspace-library-folders.ts`, which validates everything; this arm
 * only addresses the call.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { boardIdOf } from '../board-path.ts';
import { libraryFoldersClient } from '../server-client.ts';

export interface FolderToolContext {
  http: (method: string, path: string, body?: unknown) => Promise<unknown>;
  ok: (data: unknown) => CallToolResult;
  err: (message: string) => CallToolResult;
}

const idOf = (v: unknown): string => (typeof v === 'string' ? v : '');
/** A parent or folder argument: null for none. */
const orNull = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

export async function handleFolderTool(
  name: string,
  a: Record<string, unknown>,
  ctx: FolderToolContext,
): Promise<CallToolResult | undefined> {
  const library = () => libraryFoldersClient(ctx.http).workspaces[':ws'].library;
  const ws = () => ({ ws: encodeURIComponent(boardIdOf(name, a)) });
  const folder = () => {
    const id = idOf(a.folderId);
    if (id === '') throw new Error(`${name} needs a folderId`);
    return { param: { ...ws(), folderId: encodeURIComponent(id) } };
  };
  const one = () => library().folders[':folderId'];
  switch (name) {
    case 'list_folders':
      return ctx.ok(await (await library().folders.$get({ param: ws() })).json());
    case 'create_folder':
      return ctx.ok(
        await (
          await library().folders.$post({
            param: ws(),
            json: { name: a.name as string, parentId: orNull(a.parentId) },
          })
        ).json(),
      );
    case 'rename_folder':
      return ctx.ok(
        await (await one().rename.$post({ ...folder(), json: { name: a.name as string } })).json(),
      );
    case 'move_folder':
      return ctx.ok(
        await (
          await one().move.$post({ ...folder(), json: { parentId: orNull(a.parentId) } })
        ).json(),
      );
    case 'archive_folder':
      return ctx.ok(await (await one().archive.$post(folder())).json());
    case 'unarchive_folder':
      return ctx.ok(await (await one().unarchive.$post(folder())).json());
    case 'move_doc_to_folder': {
      const docId = idOf(a.docId);
      if (docId === '') return ctx.err('move_doc_to_folder needs a docId');
      return ctx.ok(
        await (
          await library().docs[':docId'].folder.$put({
            param: { ...ws(), docId: encodeURIComponent(docId) },
            json: { folderId: orNull(a.folderId) },
          })
        ).json(),
      );
    }
    default:
      return undefined;
  }
}
