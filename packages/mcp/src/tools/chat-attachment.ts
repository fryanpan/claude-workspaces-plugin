/**
 * `read_chat_attachment`: a photo or file a person sent the lead in the
 * board's chat, handed to the session as a file it can read.
 *
 * The bytes stay on the server, under the board, and a lead's wall may forbid
 * reading them there, or the lead may run on another machine, so the server's
 * path is no use to it. This child fetches them over its own connection to
 * the board (`middleware/lead-scope.ts` admits the read) and writes them to a
 * fresh private folder under this process's temp dir. The folder is new for
 * every call, so nothing another session planted can sit at the path. A small
 * image also comes back inline, so the model sees it with no second call.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LEAD_CHAT_FILE_ID,
  leadChatFilePath,
  parseLeadChatAttachment,
} from '@claude-workspaces/core/lead-chat';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/** The largest image sent inline: the API refuses images past about 5 MB of
 *  base64. A larger one is read from its path. */
export const INLINE_IMAGE_MAX_BYTES = 3_500_000;

export interface ChatAttachmentContext {
  http: (method: string, path: string, body?: unknown) => Promise<unknown>;
  err: (message: string) => CallToolResult;
  /** Where the fresh folder goes; a test passes its own. */
  tempRoot?: string;
}

const onDisk = (name: string): string => name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^\.+/, '');

export async function readChatAttachment(
  ctx: ChatAttachmentContext,
  workspaceId: string | undefined,
  fileId: string | undefined,
): Promise<CallToolResult> {
  if (!workspaceId || !fileId) return ctx.err('workspaceId and fileId are required');
  if (!LEAD_CHAT_FILE_ID.test(fileId)) return ctx.err('fileId is not a chat file id');
  const got = (await ctx.http(
    'GET',
    `${leadChatFilePath(workspaceId, fileId)}?encoding=base64`,
  )) as { file?: unknown; data?: unknown };
  const file = parseLeadChatAttachment(got.file);
  if (!file || typeof got.data !== 'string') return ctx.err('the server sent no file');
  const dir = mkdtempSync(join(ctx.tempRoot ?? tmpdir(), 'cw-chat-file-'));
  const path = join(dir, onDisk(file.name) || 'file');
  writeFileSync(path, Buffer.from(got.data, 'base64'), { flag: 'wx', mode: 0o600 });
  const said = { name: file.name, type: file.type, size: file.size, path };
  return {
    content: [
      { type: 'text', text: JSON.stringify(said, null, 2) },
      ...(file.image && file.size <= INLINE_IMAGE_MAX_BYTES
        ? [{ type: 'image' as const, data: got.data, mimeType: file.type }]
        : []),
    ],
  };
}
