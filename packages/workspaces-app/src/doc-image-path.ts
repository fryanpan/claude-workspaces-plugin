/**
 * A doc image's display address, kept apart from the Tiptap extension in
 * `doc-image-src.ts` so the doc page's first paint (`doc/prose-paint.ts`) can
 * resolve an image without loading the editor.
 */
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

/** A src with a scheme, a leading `/` or `#`, or none at all is left alone. */
function isRelative(src: string): boolean {
  return src !== '' && !/^[a-z][a-z0-9+.-]*:/i.test(src) && !/^[/#?]/.test(src);
}

function decodeSafe(seg: string): string {
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

/** The address the browser fetches for `src`. */
export function toDisplaySrc(src: string, base: string | undefined): string {
  if (!base || !isRelative(src)) return src;
  const path = src.split(/[?#]/)[0] ?? '';
  const segs = path.split('/').filter((s) => s !== '' && s !== '.');
  return base + segs.map((s) => encodeURIComponent(decodeSafe(s))).join('/');
}

/**
 * The reverse, for HTML the editor parses back in (a paste of its own image).
 * The query is dropped: the only one the DOM carries is a retry's `?r=<n>`.
 */
export function fromDisplaySrc(src: string, base: string | undefined): string {
  if (!base || !src.startsWith(base)) return src;
  return (src.slice(base.length).split(/[?#]/)[0] ?? '')
    .split('/')
    .map((s) => decodeSafe(s))
    .join('/');
}
