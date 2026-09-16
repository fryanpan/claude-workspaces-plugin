import { basename, extname } from 'node:path';
import { fileSandboxHeaders } from '../mockup-frame.ts';
import { isOnBox } from './mount-routes-context.ts';
import type { MountRouteRequest, MountRoutesContext } from './mount-routes-context.ts';

/**
 * A mounted file at its ADDRESS — the member-facing half of the mount family.
 *
 * `/api/mounts…` beside this is the lead's table and is loopback-only; this
 * one has to be readable by the people a file was mounted for, so it carries
 * its own two refusals: a share visitor, and a folder whose privacy says its
 * bytes stay on the machine. It lives apart from the table for size alone —
 * the gate it answers is written out in `mounts.ts`'s header, which is still
 * the one place the family's security story is told.
 */

/** Content types a mounted file is served as. Anything else is a download. */
const CT: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

/**
 * A mounted file at its address.
 *
 * `GET /mounts/<fileId>` is the metadata and `…/raw` is the bytes. The bytes
 * are streamed with `Bun.file` rather than served through `serveStatic`,
 * which reads the whole file into memory — a mount holds the 23 GB run
 * directories this feature exists for, and one request for one of those would
 * take the server down.
 */
export function serveMountedFile(
  ctx: MountRoutesContext,
  rq: MountRouteRequest,
): Response | undefined {
  const { mounts, j } = ctx;
  const { req, pathname, visitor } = rq;
  const rest = pathname.slice('/mounts/'.length);
  if (pathname === '/mounts' || rest === '') return j(404, { error: 'no file id in the address' });
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return j(405, { error: 'method not allowed' });
  }
  const [rawId, sub, ...extra] = rest.split('/');
  const fileId = decodeURIComponent(rawId ?? '');
  if (extra.length > 0 || (sub !== undefined && sub !== 'raw')) {
    return j(404, { error: 'not a mount address' });
  }

  // Belt to the admission layer's braces: `/mounts/…` is not on
  // `shareScopeAllows`, so a visitor is refused before reaching here. The
  // local refusal is what keeps that true if a prefix is ever widened.
  if (visitor) return j(403, { error: 'mounted files are not available to share visitors' });

  const found = mounts.resolveFile(fileId);
  if (!found) return j(404, { error: 'no mounted file at that address', fileId });

  // The rule this file is served under: the narrower of its mount's answer
  // and its project's. `local-only` means the bytes do not leave the machine,
  // so it is answered against the socket and the edge header rather than
  // against who the caller is. It gates the METADATA below as well as the
  // bytes — a name and a size are already the file leaving.
  if (
    mounts.mountPrivacyOf(found.repoKey, found.file.mountId) === 'local-only' &&
    !isOnBox(ctx, req)
  ) {
    return j(403, {
      error: 'this folder is local-only — its mounted files are served on the box alone',
    });
  }

  if (sub !== 'raw') {
    return j(200, {
      fileId,
      mountId: found.file.mountId,
      relPath: found.file.relPath,
      name: basename(found.file.relPath),
      size: found.file.size,
      mtimeMs: found.file.mtimeMs,
      contentType: CT[extname(found.file.relPath).toLowerCase()] ?? 'application/octet-stream',
      rawUrl: `/mounts/${encodeURIComponent(fileId)}/raw`,
    });
  }

  const ext = extname(found.file.relPath).toLowerCase();
  const headers: Record<string, string> = {
    'content-type': CT[ext] ?? 'application/octet-stream',
    // An address serves whatever the file holds NOW — that is the point of an
    // in-place update — so the browser has to revalidate. The tag is size and
    // mtime rather than a content hash: hashing 23 GB per request is the
    // thing this route exists not to do.
    'cache-control': 'no-cache',
    etag: `"${found.file.size.toString(16)}-${Math.floor(found.file.mtimeMs).toString(16)}"`,
    'content-disposition': `${dispositionFor(ext)}; filename="${safeFilename(found.file.relPath)}"`,
    'x-content-type-options': 'nosniff',
    // A browser that renders the file anyway (a download it opens, a type
    // served inline) gets it without scripts and without this origin: an SVG
    // or HTML file is somebody's markup, not the board's (`mockup-frame.ts`).
    ...fileSandboxHeaders(found.file.relPath),
  };
  if (req.method === 'HEAD') {
    headers['content-length'] = String(found.file.size);
    return new Response(null, { headers });
  }
  // Streamed, never read whole: the response must not be bounded by memory
  // when the file is one of the multi-gigabyte ones a mount exists to hold.
  return new Response(Bun.file(found.abs), { headers });
}

/**
 * Inline, or a download?
 *
 * A mounted file is served from the SERVER'S OWN ORIGIN, beside every session
 * cookie it holds — so anything the browser would execute as a document has
 * to arrive as an attachment. That is `.svg` (it carries script and renders
 * as a document), `.html` in every spelling, and everything unrecognised,
 * which is the case that matters most: a type nobody listed is a type nobody
 * reasoned about. What stays inline is the set a reviewer opens by clicking —
 * raster images, PDF, plain text and media.
 */
const INLINE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.pdf',
  '.txt',
  '.md',
  '.csv',
  '.mp3',
  '.m4a',
  '.wav',
  '.mp4',
  '.webm',
]);

function dispositionFor(ext: string): 'inline' | 'attachment' {
  return INLINE_EXTENSIONS.has(ext) ? 'inline' : 'attachment';
}

/** A filename safe to put inside a quoted header value. */
function safeFilename(relPath: string): string {
  return basename(relPath).replace(/[^A-Za-z0-9._-]/g, '_');
}
