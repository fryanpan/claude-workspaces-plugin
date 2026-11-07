/**
 * The photos and files of a board's lead chat (`lead-chat/files.ts`).
 *
 *   POST /workspaces/<id>/lead-chat/files?name=<file name>
 *   GET  /workspaces/<id>/lead-chat/files/<fileId>
 *
 * The upload is the owner's, as the chat's write is. Anything over
 * `LEAD_CHAT_FILE_MAX_BYTES` is refused as soon as it passes the cap.
 *
 * The read is a member's, as the chat's read is, and the board's own lead
 * reads with its board token (`middleware/lead-scope.ts`). A share visitor is
 * refused, and neither path is in the share member table
 * (`middleware/host-guard.ts`). A file is looked up under the board in the
 * address, so an id from another board answers 404.
 *
 * `?encoding=base64` answers JSON with the bytes in it, for the MCP child,
 * whose one HTTP client reads JSON (`read_chat_attachment`).
 *
 * An image is served as the type its bytes proved. Everything else is an
 * opaque download, so a stored HTML file can never run as a page on this
 * origin.
 */
import { LEAD_CHAT_FILE_MAX_BYTES } from '@claude-workspaces/core/lead-chat';
import { readCapped } from './doc-assets.ts';
import type { WorkspaceRouteRequest, WorkspaceRoutesContext } from './workspace-routes-context.ts';

const UPLOAD = /^\/workspaces\/[^/]+\/lead-chat\/files$/;
const ONE_FILE = /^\/workspaces\/[^/]+\/lead-chat\/files\/([^/]+)$/;

export async function handleLeadChatFiles(
  ctx: WorkspaceRoutesContext,
  rq: WorkspaceRouteRequest,
): Promise<Response | undefined> {
  const { req, pathname, scope, visitor } = rq;
  if (!scope) return undefined;
  const { workspaceId } = scope;
  if (UPLOAD.test(pathname)) {
    if (req.method !== 'POST') return ctx.j(405, { error: 'method not allowed' });
    if (visitor) return ctx.j(403, { error: 'not a member route' });
    const denied = rq.requireOwner(workspaceId);
    if (denied) return denied;
    const bytes = await readCapped(req, LEAD_CHAT_FILE_MAX_BYTES);
    if (bytes === null) {
      return ctx.j(413, {
        error: 'file-too-large',
        hint: `A file is at most ${LEAD_CHAT_FILE_MAX_BYTES} bytes.`,
      });
    }
    if (bytes.byteLength === 0) return ctx.j(400, { error: 'empty-file' });
    const file = ctx.leadChatFiles.save(workspaceId, bytes, rq.url.searchParams.get('name'));
    return file ? ctx.j(201, { file }) : ctx.j(500, { error: 'write-failed' });
  }
  const match = pathname.match(ONE_FILE);
  if (!match) return undefined;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return ctx.j(405, { error: 'method not allowed' });
  }
  if (visitor && rq.leadBoard !== workspaceId) return ctx.j(403, { error: 'not a member route' });
  let id = '';
  try {
    id = decodeURIComponent(match[1] ?? '');
  } catch {
    return ctx.j(404, { error: 'no-file' });
  }
  const file = ctx.leadChatFiles.get(workspaceId, id);
  const path = ctx.leadChatFiles.pathOf(workspaceId, id);
  if (!file || !path) return ctx.j(404, { error: 'no-file' });
  if (rq.url.searchParams.get('encoding') === 'base64') {
    const bytes = await Bun.file(path).arrayBuffer();
    return ctx.j(200, { file, data: Buffer.from(bytes).toString('base64') });
  }
  const headers: Record<string, string> = {
    'content-type': file.type,
    'content-length': String(file.size),
    'content-disposition': `${file.image ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; sandbox",
    // The id names these bytes for good, and only a member may read them.
    'cache-control': 'private, max-age=604800, immutable',
  };
  if (req.method === 'HEAD') return new Response(null, { headers });
  return new Response(Bun.file(path), { headers });
}
