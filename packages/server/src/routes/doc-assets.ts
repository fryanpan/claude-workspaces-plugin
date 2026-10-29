import { statSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { GuardRefused, readBytesChecked } from '../bound-path-guard.ts';
import {
  IMAGE_TYPES,
  MAX_IMAGE_BYTES,
  decodeSegments,
  imageStem,
  resolveInside,
  sniffImage,
  storeImageBeside,
} from '../doc-image-store.ts';
import { fileSandboxHeaders } from '../mockup-frame.ts';
import { boundFiles } from '../slow-fs.ts';
import type { DocResourceRouteRequest, DocRoutesContext } from './docs-routes-context.ts';

/**
 * An image a bound doc names by a path relative to its own `.md`.
 *
 *   GET /workspaces/<ws>/docs/<docId>/assets/<relative path>
 *
 * `![chart](img/chart.png)` beside a bound file renders on GitHub because
 * GitHub resolves the path against the file. The editor page is not beside
 * the file, so the editor rewrites a relative `src` to this address and the
 * `.md` keeps the path it was written with.
 *
 * What a request can reach is the doc's directory tree and nothing else:
 *
 *  - image extensions only (`IMAGE_TYPES`), checked before the disk is read
 *    and again on the file a symlink resolves to;
 *  - every segment decoded on its own, and refused if it is empty, `.`, `..`
 *    or carries a separator — `%2F` and `%5C` are how a path escapes a router
 *    that has already normalised the literal ones away;
 *  - the joined path resolved through `realpath` and required to sit under the
 *    realpath of the `.md`'s directory, so a symlink pointing out of the tree
 *    is refused for where it lands, not for what it is called.
 *
 * Gate: `share-scope`. The host guard admits `assets/*` on a doc only when the
 * doc is inside the shared board, the same line that admits the doc's text,
 * and an image the doc displays is part of that text.
 *
 *   POST /workspaces/<ws>/docs/<docId>/assets?name=<file name>
 *
 * stores a pasted, dropped or picked image (`doc-image-store.ts`) and answers
 * `{ src }`, the relative path the editor writes as `![](src)`. It is a write,
 * so it is admitted exactly where the doc's live-editing socket is: on a
 * shared doc, and only for a browser the write gate lets edit.
 */

export { IMAGE_TYPES, decodeSegments, resolveInside };

/** The route segment the editor addresses a doc's relative images under. */
export const DOC_ASSETS_SEGMENT = 'assets';

export async function handleDocAssetsRoute(
  ctx: DocRoutesContext,
  rq: DocResourceRouteRequest,
): Promise<Response | undefined> {
  const { rest, req, docId } = rq;
  const { j } = ctx;
  if (rest === DOC_ASSETS_SEGMENT) {
    if (req.method !== 'POST') return j(405, { error: 'method not allowed' });
    return uploadImage(ctx, rq);
  }
  if (!rest.startsWith(`${DOC_ASSETS_SEGMENT}/`)) return undefined;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return j(405, { error: 'method not allowed' });
  }
  const segments = decodeSegments(rest.slice(DOC_ASSETS_SEGMENT.length + 1));
  if (!segments) return j(400, { error: 'not a path inside the doc folder' });
  const type = IMAGE_TYPES[extname(segments[segments.length - 1] ?? '').toLowerCase()];
  if (!type) return j(415, { error: 'only images are served beside a doc' });
  const md = ctx.docStore.boundPathOf(docId);
  if (!md) return j(404, { error: 'this doc is not bound to a file' });
  // Under a walled lead's root, judged as every bound read is: the folders
  // on the way may have been swapped for links since the doc was bound.
  let lands: ((real: string) => boolean) | null;
  try {
    lands = boundFiles.guards.landsFor(join(dirname(md), ...segments));
  } catch {
    return j(404, { error: 'no image at that path beside the doc' });
  }
  const abs = resolveInside(dirname(md), segments);
  if (!abs) return j(404, { error: 'no image at that path beside the doc' });
  // Asked again of where a link LANDS: `chart.png -> notes.txt` is a text file.
  if (IMAGE_TYPES[extname(abs).toLowerCase()] !== type) {
    return j(415, { error: 'only images are served beside a doc' });
  }
  const guarded = lands ? await guardedImage(abs, lands) : null;
  if (guarded === 'refused') return j(404, { error: 'no image at that path beside the doc' });
  if (guarded === 'too-large') return j(413, { error: 'this image is too large to serve' });
  const st = guarded ? guarded.st : statSync(abs, { bigint: true });
  const size = Number(st.size);
  // A validator, so a cache that revalidates can tell a changed file from an
  // unchanged one. `no-cache` stays: the page's `?v=` (doc-image-versions.ts)
  // is what makes a new file a new address, and an address with a stale
  // version must still be answered with what is on disk now.
  const etag = `W/"${st.size.toString(16)}-${st.mtimeNs.toString(16)}"`;
  const headers: Record<string, string> = {
    'content-type': type,
    'cache-control': 'no-cache',
    etag,
    'last-modified': new Date(Number(st.mtimeMs)).toUTCString(),
    'x-content-type-options': 'nosniff',
    // An `<img>` ignores both of these. A reader who opens the address on
    // its own gets an SVG as a download without scripts, never as a page on
    // this origin (`mount-file.ts` gives the same answer for the same reason).
    'content-disposition': type === 'image/svg+xml' ? 'attachment' : 'inline',
    ...fileSandboxHeaders(abs),
  };
  if (req.headers.get('if-none-match') === etag) {
    return new Response(null, { status: 304, headers });
  }
  if (req.method === 'HEAD') {
    return new Response(null, { headers: { ...headers, 'content-length': String(size) } });
  }
  return new Response(guarded ? guarded.bytes : Bun.file(abs), { headers });
}

/** The most a guarded image answer reads into memory. */
export const GUARDED_IMAGE_MAX = 16 * 1024 * 1024;

/** An image under a walled lead's root, read from the descriptor that was
 *  judged rather than reopened by path. */
async function guardedImage(
  abs: string,
  lands: (real: string) => boolean,
): Promise<Awaited<ReturnType<typeof readBytesChecked>> | 'refused'> {
  try {
    return await readBytesChecked(abs, GUARDED_IMAGE_MAX, lands);
  } catch (err) {
    if (err instanceof GuardRefused || (err as NodeJS.ErrnoException).code) return 'refused';
    throw err;
  }
}

async function uploadImage(ctx: DocRoutesContext, rq: DocResourceRouteRequest): Promise<Response> {
  const { j } = ctx;
  const md = ctx.docStore.boundPathOf(rq.docId);
  if (!md || !/\.(md|markdown|mdx)$/i.test(md)) {
    return j(404, { error: 'only a doc bound to a markdown file takes images' });
  }
  const bytes = await readCapped(rq.req, MAX_IMAGE_BYTES);
  if (bytes === null) return j(413, { error: `an image is at most ${MAX_IMAGE_BYTES} bytes` });
  const ext = sniffImage(bytes);
  if (!ext) return j(415, { error: 'only PNG, JPEG, GIF and WebP images are stored' });
  const name = new URL(rq.req.url).searchParams.get('name');
  let lands: ((real: string) => boolean) | null;
  try {
    lands = boundFiles.guards.landsFor(md);
  } catch {
    return j(409, { error: 'cannot store beside this doc: outside' });
  }
  const out = storeImageBeside(md, bytes, ext, imageStem(name), undefined, lands);
  if (!out.ok) return j(409, { error: `cannot store beside this doc: ${out.reason}` });
  return j(201, { src: out.src });
}

/** The body, or null as soon as it passes `cap` — a long upload is not read to the end. */
async function readCapped(req: Request, cap: number): Promise<Uint8Array | null> {
  if (Number(req.headers.get('content-length') ?? 0) > cap) return null;
  const reader = req.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}
