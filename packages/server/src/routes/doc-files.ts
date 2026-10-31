import { dirname } from 'node:path';
import { DOC_FILES_SEGMENT } from '@claude-workspaces/core/board-embeds';
import {
  DOC_PAGE_CSP,
  type DocFileRead,
  cachedPage,
  frameHtml,
  readDocFile,
} from '../doc-file-frame.ts';
import { framedPages, servingFolder } from '../doc-file-scope.ts';
import { decodeSegments } from '../doc-image-store.ts';
import { fileSandboxHeaders } from '../mockup-frame.ts';
import type { DocResourceRouteRequest, DocRoutesContext } from './docs-routes-context.ts';

/**
 * The files of a page a bound doc frames, served so a `::html{src="…"}` line
 * can show it with no server of its own.
 *
 *   GET /workspaces/<ws>/docs/<docId>/files/<relative path>
 *
 * Which folder a doc may serve is `doc-file-scope.ts` (only the folder of a
 * page a `::html` line in the doc's current content names); what may be read
 * there, and why the page's scripts are written into it, is
 * `doc-file-frame.ts`. This module decodes the path, refuses a doc with no
 * bound file, and sets the headers:
 *
 *  - every segment decoded on its own and refused if it is empty, `.`, `..`
 *    or carries a separator or a NUL (`decodeSegments`), so `%2e%2e`, `%2f`
 *    and an absolute path in one segment never reach the disk;
 *  - an HTML page answers only a frame (`Sec-Fetch-Dest: iframe`), as the
 *    frame hostname answers a mock (`frame-host.ts`), and goes out under
 *    `DOC_PAGE_CSP`: sandboxed without `allow-same-origin`, framed only by
 *    the board, and allowed to connect nowhere;
 *  - every other file goes out with the bare `sandbox` policy, and an SVG as
 *    an attachment, so no file opened by its address is a page on this
 *    origin;
 *  - every answer, refusals included, carries `nosniff` and
 *    `Cross-Origin-Resource-Policy: same-origin`, so a page on another site
 *    cannot load one of these files as its own script even where this
 *    machine's loopback admits it without a cookie.
 *
 * Gate: `share-scope`. The host guard admits `files/*` on a doc only when the
 * doc is inside the shared board — the line that admits the doc's text and its
 * relative images (`docSubrouteAllowed`, `middleware/host-guard.ts`) — and
 * only for GET and HEAD.
 *
 * Every answer is `no-cache` with an `ETag`, so a reload after an edit to the
 * page or a file beside it shows the edit. A page's validator is taken over
 * the built page; HEAD builds nothing and sends none.
 */

const ALWAYS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'cross-origin-resource-policy': 'same-origin',
};

const refusal = (status: number, error: string): Response =>
  new Response(JSON.stringify({ error }), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...ALWAYS },
  });

const READ_ERRORS: Record<number, string> = {
  404: 'no file at that path beside a page this doc frames',
  413: 'this file is too large to serve',
  415: 'that kind of file is not served beside a doc',
};

export async function handleDocFilesRoute(
  ctx: DocRoutesContext,
  rq: DocResourceRouteRequest,
): Promise<Response | undefined> {
  const { rest, req, docId, doc } = rq;
  if (rest !== DOC_FILES_SEGMENT && !rest.startsWith(`${DOC_FILES_SEGMENT}/`)) return undefined;
  if (req.method !== 'GET' && req.method !== 'HEAD') return refusal(405, 'method not allowed');
  const tail = rest.slice(DOC_FILES_SEGMENT.length + 1);
  const segments = decodeSegments(tail);
  if (!segments) return refusal(400, 'not a path inside the doc folder');
  const md = ctx.docStore.boundPathOf(docId);
  if (!md) return refusal(404, 'this doc is not bound to a file');
  const folder = servingFolder(framedPages(doc.ydoc), segments);
  if (!folder) return refusal(404, READ_ERRORS[404] ?? '');
  const html = /\.html$/i.test(segments[segments.length - 1] ?? '');
  if (html && req.headers.get('sec-fetch-dest') !== 'iframe') {
    return refusal(403, 'a page beside a doc is served only into its frame');
  }
  const dir = dirname(md);
  const got = await readDocFile(dir, folder, segments);
  if (!got.ok) return refusal(got.status, READ_ERRORS[got.status] ?? '');
  const headers: Record<string, string> = {
    'content-type': got.type,
    'cache-control': 'no-cache',
    'last-modified': new Date(Number(got.st.mtimeMs)).toUTCString(),
    'content-disposition': got.type === 'image/svg+xml' ? 'attachment' : 'inline',
    ...ALWAYS,
    ...(html
      ? { 'content-security-policy': DOC_PAGE_CSP }
      : fileSandboxHeaders(segments[segments.length - 1] ?? '')),
  };
  if (req.method === 'HEAD') return new Response(null, { headers });
  let body: Uint8Array<ArrayBuffer> = got.bytes;
  if (html) {
    const built = await framePage(rq, dir, folder, segments, got);
    if (built === null) return refusal(413, 'this page and the files it loads are too large');
    body = built;
    headers.etag = `W/"p-${Bun.hash(body).toString(16)}"`;
  } else {
    headers.etag = `W/"${got.st.size.toString(16)}-${got.st.mtimeNs.toString(16)}"`;
  }
  if (req.headers.get('if-none-match') === headers.etag) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(body, { headers });
}

/** The page as the frame gets it (`frameHtml`), through the page cache. */
async function framePage(
  rq: DocResourceRouteRequest,
  dir: string,
  folder: string[],
  segments: string[],
  got: Extract<DocFileRead, { ok: true }>,
): Promise<Uint8Array<ArrayBuffer> | null> {
  const { pathname } = rq.url;
  // The relay's base is the page's own folder as its relative URLs see it.
  const base = pathname.slice(0, pathname.lastIndexOf('/') + 1);
  return cachedPage(`${base}\n${got.abs}`, got, async (note, miss) => {
    const page = await frameHtml(new TextDecoder().decode(got.bytes), segments, base, async (s) => {
      const sib = await readDocFile(dir, folder, s);
      if (!sib.ok) {
        // A file the folder could hold but does not yet; a refusal stays one.
        if (sib.status === 404 && folder.every((f, i) => s[i] === f)) miss();
        return null;
      }
      note(sib.abs, sib.st);
      return sib.bytes;
    });
    return page === null ? null : new TextEncoder().encode(page);
  });
}
