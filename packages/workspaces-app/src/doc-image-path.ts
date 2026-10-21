/**
 * A doc image's display address, kept apart from the Tiptap extension in
 * `doc-image-src.ts` so the doc page's first paint (`doc/prose-paint.ts`) can
 * resolve an image without loading the editor.
 */
import { imageSegments } from '@claude-workspaces/core/image-versions';
import { api } from './doc-path.ts';

/**
 * Where an image a doc names by a RELATIVE path is fetched from.
 *
 * `![chart](img/chart.png)` is written against the `.md`'s own folder, which
 * is how GitHub reads it. The editor page is `/workspaces/<ws>/docs/<id>`, so a
 * browser left to resolve the path itself asks for `/workspaces/<ws>/docs/img/…`
 * — a doc that does not exist. The server serves the doc's folder at
 * `…/docs/<id>/assets/` (`server/src/routes/doc-assets.ts`), and this is the
 * one place a `src` is turned into that address.
 *
 * Only the DOM sees the address. The node keeps the path as written, so the
 * `.md` on disk keeps it too.
 */
export function docAssetsBase(docId: string, workspaceId?: string | null): string {
  return `${api(`docs/${encodeURIComponent(docId)}/assets`, workspaceId)}/`;
}

function decodeSafe(seg: string): string {
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

/**
 * The address the browser fetches for `src`.
 *
 * `version` is the file's mtime from the doc's `imageVersions` map
 * (`@claude-workspaces/core/image-versions`). It goes on as `?v=`, so a file
 * that changed is a new address no cache has an answer for.
 */
export function toDisplaySrc(src: string, base: string | undefined, version?: number): string {
  if (!base) return src;
  const segs = imageSegments(src);
  if (!segs) return src;
  const path = base + segs.map((s) => encodeURIComponent(s)).join('/');
  return version === undefined ? path : `${path}?v=${encodeURIComponent(String(version))}`;
}

/**
 * The reverse, for HTML the editor parses back in (a paste of its own image).
 * The query is dropped: the DOM carries only a version's `?v=` or a retry's `?r=<n>`.
 */
export function fromDisplaySrc(src: string, base: string | undefined): string {
  if (!base || !src.startsWith(base)) return src;
  return (src.slice(base.length).split(/[?#]/)[0] ?? '')
    .split('/')
    .map((s) => decodeSafe(s))
    .join('/');
}
