import { Image } from '@tiptap/extension-image';
import { Plugin } from '@tiptap/pm/state';
import type * as Y from 'yjs';
import { fromDisplaySrc, toDisplaySrc } from './doc-image-path.ts';
import { retryFailedDocImages } from './doc-image-retry.ts';
import { followImageVersions, imageVersionLookup } from './doc-image-versions.ts';

export { docAssetsBase, fromDisplaySrc, toDisplaySrc } from './doc-image-path.ts';

/**
 * The editor's block image, resolving relative paths against `base`. With
 * `ydoc`, each address carries the image's version (doc-image-versions.ts).
 */
export function docImageExtension(base: string | undefined, ydoc?: Y.Doc) {
  const versionOf = ydoc ? imageVersionLookup(ydoc) : () => undefined;
  return Image.extend({
    addAttributes() {
      const parent = this.parent?.() ?? {};
      return {
        ...parent,
        src: {
          default: null,
          parseHTML: (el: HTMLElement) =>
            fromDisplaySrc(el.getAttribute('src') ?? '', base) || null,
          renderHTML: (attrs: Record<string, unknown>) =>
            typeof attrs.src === 'string'
              ? { src: toDisplaySrc(attrs.src, base, versionOf(attrs.src)) }
              : {},
        },
      };
    },
    // An image whose file is not there yet is asked for again (doc-image-retry.ts),
    // and one whose file changed is asked for at its new version.
    addProseMirrorPlugins() {
      const parent = this.parent?.() ?? [];
      if (!base) return parent;
      const retry = new Plugin({
        view: (view) => {
          const stopRetry = retryFailedDocImages(view.dom, base);
          const stopFollow = ydoc ? followImageVersions(view.dom, base, ydoc) : () => {};
          return {
            destroy: () => {
              stopRetry();
              stopFollow();
            },
          };
        },
      });
      return [...parent, retry];
    },
  }).configure({ inline: false, allowBase64: false });
}
