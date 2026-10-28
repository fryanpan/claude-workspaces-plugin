/**
 * Which version of each image beside a bound `.md` the page should ask for.
 *
 * An image a doc names by a relative path is fetched from one address per
 * path, so a cache keyed on the address — the browser's, or one between the
 * browser and the server — can answer with the bytes the file held before it
 * was overwritten, and a page already showing the image never asks again.
 * The server records each image's mtime in the doc's `imageVersions` map
 * (`server/src/doc-image-versions.ts`), and the page adds it to the address
 * as `?v=<mtime>`: a new file is a new address. The map syncs like the rest of
 * the doc, so an open page sees a new version without a reload.
 *
 * The map is keyed by the path as the server reads it: each segment decoded,
 * empty and `.` segments dropped, the query and fragment cut. The prose node
 * keeps the path as written, so the `.md` on disk keeps it too.
 */
import * as Y from 'yjs';

export const IMAGE_VERSIONS_MAP = 'imageVersions';

export function imageVersionsMap(ydoc: Y.Doc): Y.Map<unknown> {
  return ydoc.getMap(IMAGE_VERSIONS_MAP);
}

/** A src with a scheme, a leading `/`, `#` or `?`, or none at all is not beside the doc. */
export function isRelativeImageSrc(src: string): boolean {
  return src !== '' && !/^[a-z][a-z0-9+.-]*:/i.test(src) && !/^[/#?]/.test(src);
}

function decodeSafe(seg: string): string {
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

/** The decoded path segments of a relative src, or null for any other src. */
export function imageSegments(src: string): string[] | null {
  if (!isRelativeImageSrc(src)) return null;
  const path = src.split(/[?#]/)[0] ?? '';
  const segs = path
    .split('/')
    .filter((s) => s !== '' && s !== '.')
    .map(decodeSafe);
  return segs.length > 0 ? segs : null;
}

/** The map key for `src`, or null when it is not a relative image path. */
export function imageVersionKey(src: string): string | null {
  return imageSegments(src)?.join('/') ?? null;
}

/** The recorded version of `src`. Anything but a finite number reads as none. */
export function imageVersionOf(map: Y.Map<unknown>, src: string): number | undefined {
  const key = imageVersionKey(src);
  if (key === null) return undefined;
  const v = map.get(key);
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Every relative image path the prose names, as map keys, in document order. */
export function relativeImageKeys(fragment: Y.XmlFragment): string[] {
  const out = new Set<string>();
  const walk = (node: Y.XmlFragment | Y.XmlElement): void => {
    for (const child of node.toArray()) {
      if (!(child instanceof Y.XmlElement)) continue;
      if (child.nodeName === 'image') {
        const src = child.getAttribute('src');
        const key = typeof src === 'string' ? imageVersionKey(src) : null;
        if (key !== null) out.add(key);
      }
      walk(child);
    }
  };
  walk(fragment);
  return [...out];
}
