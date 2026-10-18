import { mediaTypeOf } from '@claude-workspaces/core';
import type { DocStore } from '../doc-store.ts';

/**
 * A video or image in an attached folder, as bytes.
 *
 *   GET /workspaces/<ws>/attachments/<setId>/raw?path=<relPath>
 *
 * The page a folder's video opens on points its `<video>` here. A phone will
 * not play or seek a video served whole: Safari asks for `bytes=0-1` first and
 * gives up on a server that answers 200, so this route answers a `Range`
 * request with 206 and exactly those bytes, and says `Accept-Ranges: bytes`
 * on every answer.
 *
 * What a request can reach is what a lazy open can reach and nothing more:
 * `docStore.resolveSetFile` refuses a path outside the set's root (by spelling
 * and by where a symlink lands), an excluded path, and anything the scan does
 * not list, the same checks `context-file` runs. On top of that, only a media
 * extension is served (`folder-file-types.ts`), so this is not a second way to
 * read a set's source files.
 *
 * The path is a query parameter rather than trailing segments so the share
 * gate can name this verb as `raw` in its table, beside `context-file`
 * (`REVIEW_MEMBER_ROUTES` in `middleware/host-guard.ts`). A local-only set is
 * refused off the box by the request chain before this runs, as every route
 * under `attachments/<setId>/` is.
 *
 * Streamed from `Bun.file`, never read whole: a recording is megabytes and a
 * mounted run directory can be gigabytes.
 */
export async function serveReviewRaw(
  docStore: DocStore,
  j: (status: number, body: unknown) => Response,
  setId: string,
  req: Request,
  url: URL,
): Promise<Response> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return j(405, { error: 'method not allowed' });
  }
  const relPath = url.searchParams.get('path');
  if (!relPath) return j(400, { error: 'path required' });
  const type = mediaTypeOf(relPath);
  if (!type) return j(415, { error: 'only video and image files are served raw' });
  const res = await docStore.resolveSetFile(setId, relPath, { media: true });
  if (!res.ok) {
    const status = res.error === 'bad-path' ? 400 : res.error === 'unavailable' ? 503 : 404;
    return j(status, { error: res.error });
  }
  const size = res.size;
  const headers: Record<string, string> = {
    'content-type': type,
    'accept-ranges': 'bytes',
    'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff',
    'content-disposition': 'inline',
  };
  const range = parseByteRange(req.headers.get('range'), size);
  if (range.kind === 'unsatisfiable') {
    return new Response(null, {
      status: 416,
      headers: { ...headers, 'content-range': `bytes */${size}` },
    });
  }
  const file = Bun.file(res.abs);
  if (range.kind === 'full') {
    headers['content-length'] = String(size);
    return new Response(req.method === 'HEAD' ? null : file, { status: 200, headers });
  }
  headers['content-range'] = `bytes ${range.start}-${range.end}/${size}`;
  headers['content-length'] = String(range.end - range.start + 1);
  // The slice itself, not `.stream()`: a stream is sent chunked once the
  // request chain has touched it, and Safari will not play a chunked 206. The
  // chain sets its headers on this Response in place, so the slice reaches
  // the socket as a sized body (`range-content-length.test.ts`).
  const body = req.method === 'HEAD' ? null : file.slice(range.start, range.end + 1);
  return new Response(body, { status: 206, headers });
}

export type ByteRange =
  | { kind: 'full' }
  | { kind: 'partial'; start: number; end: number }
  | { kind: 'unsatisfiable' };

/**
 * One `Range: bytes=…` header against a file of `size` bytes (RFC 9110 §14).
 *
 * `a-b`, the open-ended `a-` and the suffix `-n` are answered; `b` past the
 * end is clamped to the last byte. A range that starts at or past the end, a
 * suffix of zero, a range whose end comes before its start, or a header that
 * does not parse is unsatisfiable (416). No header, another unit, or a list
 * of several ranges is served whole: the spec lets a server ignore a range it
 * will not honour, and a `<video>` never asks for more than one.
 */
export function parseByteRange(header: string | null, size: number): ByteRange {
  if (header === null) return { kind: 'full' };
  const m = /^\s*bytes\s*=\s*(.*)$/i.exec(header);
  if (!m) return { kind: 'full' };
  const spec = (m[1] ?? '').trim();
  if (spec.includes(',')) return { kind: 'full' };
  const parts = /^(\d*)-(\d*)$/.exec(spec);
  if (!parts) return { kind: 'unsatisfiable' };
  const [, first = '', last = ''] = parts;
  if (first === '' && last === '') return { kind: 'unsatisfiable' };
  if (first === '') {
    const suffix = Number(last);
    if (suffix === 0 || size === 0) return { kind: 'unsatisfiable' };
    return { kind: 'partial', start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(first);
  if (start >= size) return { kind: 'unsatisfiable' };
  const end = last === '' ? size - 1 : Math.min(Number(last), size - 1);
  if (end < start) return { kind: 'unsatisfiable' };
  return { kind: 'partial', start, end };
}
