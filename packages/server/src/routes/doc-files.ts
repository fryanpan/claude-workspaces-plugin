import { dirname } from 'node:path';
import { DOC_FILES_SEGMENT } from '@claude-workspaces/core/board-embeds';
import { frameHtml, readDocFile } from '../doc-file-frame.ts';
import { decodeSegments } from '../doc-image-store.ts';
import { MOCK_FRAME_CSP, fileSandboxHeaders } from '../mockup-frame.ts';
import type { DocResourceRouteRequest, DocRoutesContext } from './docs-routes-context.ts';

/**
 * The files beside a bound doc, served so a `::html{src="…"}` line can frame
 * a page from the doc's own folder with no server of its own.
 *
 *   GET /workspaces/<ws>/docs/<docId>/files/<relative path>
 *
 * What may be read, and why the frame's scripts are written into its page,
 * is `doc-file-frame.ts`. This module decodes the path, refuses a doc with no
 * bound file, and sets the headers:
 *
 *  - every segment decoded on its own and refused if it is empty, `.`, `..`
 *    or carries a separator or a NUL (`decodeSegments`), so `%2e%2e`, `%2f`
 *    and an absolute path in one segment never reach the disk;
 *  - an HTML page goes out under the mock frame's policy (`MOCK_FRAME_CSP`):
 *    sandboxed without `allow-same-origin`, framed only by the board, so its
 *    scripts run with an opaque origin whether framed or opened directly;
 *  - every other file goes out with the bare `sandbox` policy, `nosniff`, and
 *    an SVG as an attachment, so no file opened by its address is a page on
 *    this origin.
 *
 * Gate: `share-scope`. The host guard admits `files/*` on a doc only when the
 * doc is inside the shared board — the line that admits the doc's text and its
 * relative images (`docSubrouteAllowed`, `middleware/host-guard.ts`) — and
 * only for GET and HEAD.
 *
 * Every answer is `no-cache` with an `ETag`, so a reload after an edit to the
 * page or a file beside it shows the edit.
 */
export async function handleDocFilesRoute(
  ctx: DocRoutesContext,
  rq: DocResourceRouteRequest,
): Promise<Response | undefined> {
  const { rest, req, docId } = rq;
  const { j } = ctx;
  if (rest !== DOC_FILES_SEGMENT && !rest.startsWith(`${DOC_FILES_SEGMENT}/`)) return undefined;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return j(405, { error: 'method not allowed' });
  }
  const tail = rest.slice(DOC_FILES_SEGMENT.length + 1);
  const segments = decodeSegments(tail);
  if (!segments) return j(400, { error: 'not a path inside the doc folder' });
  const md = ctx.docStore.boundPathOf(docId);
  if (!md) return j(404, { error: 'this doc is not bound to a file' });
  const dir = dirname(md);
  const got = await readDocFile(dir, segments);
  if (!got.ok) {
    const error =
      got.status === 415
        ? 'that kind of file is not served beside a doc'
        : got.status === 413
          ? 'this file is too large to serve'
          : 'no file at that path beside the doc';
    return j(got.status, { error });
  }
  const html = got.type.startsWith('text/html');
  const last = segments[segments.length - 1] ?? '';
  // A page carries its scripts and styles inside it, so its validator is
  // taken over what goes out: an edit to a sibling file is a new page.
  const body = html ? await framePage(rq, dir, segments, tail, got.bytes) : got.bytes;
  const etag = html
    ? `W/"p-${Bun.hash(body).toString(16)}"`
    : `W/"${got.st.size.toString(16)}-${got.st.mtimeNs.toString(16)}"`;
  const headers: Record<string, string> = {
    'content-type': got.type,
    'cache-control': 'no-cache',
    etag,
    'last-modified': new Date(Number(got.st.mtimeMs)).toUTCString(),
    'x-content-type-options': 'nosniff',
    'content-disposition': got.type === 'image/svg+xml' ? 'attachment' : 'inline',
    ...(html ? { 'content-security-policy': MOCK_FRAME_CSP } : fileSandboxHeaders(last)),
  };
  if (req.headers.get('if-none-match') === etag) {
    return new Response(null, { status: 304, headers });
  }
  if (req.method === 'HEAD') return new Response(null, { headers });
  return new Response(body, { headers });
}

/** The page as the frame gets it (`frameHtml`), siblings read by the same rules. */
async function framePage(
  rq: DocResourceRouteRequest,
  dir: string,
  segments: string[],
  tail: string,
  bytes: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  const { pathname } = rq.url;
  // The address the page was asked for ends with `tail` as sent; what comes
  // before it is the folder's address as the frame's relative URLs see it.
  const base = pathname.endsWith(tail)
    ? pathname.slice(0, pathname.length - tail.length)
    : `${pathname.slice(0, pathname.indexOf(`/${DOC_FILES_SEGMENT}/`))}/${DOC_FILES_SEGMENT}/`;
  const page = await frameHtml(new TextDecoder().decode(bytes), segments, base, async (s) => {
    const sib = await readDocFile(dir, s);
    return sib.ok ? sib.bytes : null;
  });
  return new TextEncoder().encode(page);
}
