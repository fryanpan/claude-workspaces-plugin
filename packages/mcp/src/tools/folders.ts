/**
 * The Library folder verbs. Each is one REST call to
 * `routes/workspace-library-folders.ts`, which validates everything; this arm
 * only addresses the call.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { boardPathOf } from '../board-path.ts';

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
  const folder = (verb: string) => {
    const id = idOf(a.folderId);
    if (id === '') throw new Error(`${name} needs a folderId`);
    return `${boardPathOf(name, a)}/library/folders/${encodeURIComponent(id)}/${verb}`;
  };
  switch (name) {
    case 'list_folders':
      return ctx.ok(await ctx.http('GET', `${boardPathOf(name, a)}/library/folders`));
    case 'create_folder':
      return ctx.ok(
        await ctx.http('POST', `${boardPathOf(name, a)}/library/folders`, {
          name: a.name,
          parentId: orNull(a.parentId),
        }),
      );
    case 'rename_folder':
      return ctx.ok(await ctx.http('POST', folder('rename'), { name: a.name }));
    case 'move_folder':
      return ctx.ok(await ctx.http('POST', folder('move'), { parentId: orNull(a.parentId) }));
    case 'archive_folder':
      return ctx.ok(await ctx.http('POST', folder('archive')));
    case 'unarchive_folder':
      return ctx.ok(await ctx.http('POST', folder('unarchive')));
    case 'move_doc_to_folder': {
      const docId = idOf(a.docId);
      if (docId === '') return ctx.err('move_doc_to_folder needs a docId');
      return ctx.ok(
        await ctx.http(
          'PUT',
          `${boardPathOf(name, a)}/library/docs/${encodeURIComponent(docId)}/folder`,
          { folderId: orNull(a.folderId) },
        ),
      );
    }
    default:
      return undefined;
  }
}
