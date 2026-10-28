/**
 * An open doc page follows the server's record of each image's version.
 *
 * The server writes an image's mtime into the doc's `imageVersions` map when
 * the file changes (`server/src/doc-image-versions.ts`). A rendered `<img>`
 * is not re-rendered by a change outside the prose, so this points every
 * doc-asset `<img>` under a root at `?v=<new mtime>` when the map moves: the
 * browser asks for the new address and shows the new file without a reload.
 * The node keeps the path as written; only the DOM's `src` changes.
 */
import { imageVersionOf, imageVersionsMap } from '@claude-workspaces/core/image-versions';
import type * as Y from 'yjs';
import { fromDisplaySrc, toDisplaySrc } from './doc-image-path.ts';

export type ImageVersionOf = (src: string) => number | undefined;

/** The current version of a src as the node writes it, read from `ydoc`. */
export function imageVersionLookup(ydoc: Y.Doc): ImageVersionOf {
  const map = imageVersionsMap(ydoc);
  return (src) => imageVersionOf(map, src);
}

/** Points each doc-asset `<img>` under `root` whose version moved at the new address. */
export function applyImageVersions(
  root: ParentNode,
  base: string,
  versionOf: ImageVersionOf,
): void {
  for (const img of root.querySelectorAll('img')) {
    const shown = img.getAttribute('src') ?? '';
    if (!shown.startsWith(base)) continue;
    const path = fromDisplaySrc(shown, base);
    const want = versionOf(path);
    const query = shown.split('?')[1]?.split('#')[0] ?? '';
    const have = new URLSearchParams(query).get('v');
    if ((want === undefined ? null : String(want)) === have) continue;
    // A retry's `?r=` with no version yet is left alone until one arrives.
    if (want === undefined && have === null) continue;
    img.setAttribute('src', toDisplaySrc(path, base, want));
  }
}

/** Re-point `root`'s images on every change to `ydoc`'s versions. Returns the stop. */
export function followImageVersions(root: ParentNode, base: string, ydoc: Y.Doc): () => void {
  const map = imageVersionsMap(ydoc);
  const versionOf = imageVersionLookup(ydoc);
  const onChange = (): void => applyImageVersions(root, base, versionOf);
  map.observe(onChange);
  return () => map.unobserve(onChange);
}
