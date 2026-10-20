import { Image } from '@tiptap/extension-image';
import { Plugin } from '@tiptap/pm/state';
import { fromDisplaySrc, toDisplaySrc } from './doc-image-path.ts';
import { retryFailedDocImages } from './doc-image-retry.ts';

export { docAssetsBase, fromDisplaySrc, toDisplaySrc } from './doc-image-path.ts';

/** The editor's block image, resolving relative paths against `base`. */
export function docImageExtension(base: string | undefined) {
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
            typeof attrs.src === 'string' ? { src: toDisplaySrc(attrs.src, base) } : {},
        },
      };
    },
    // An image whose file is not there yet is asked for again (doc-image-retry.ts).
    addProseMirrorPlugins() {
      const parent = this.parent?.() ?? [];
      if (!base) return parent;
      const retry = new Plugin({
        view: (view) => ({ destroy: retryFailedDocImages(view.dom, base) }),
      });
      return [...parent, retry];
    },
  }).configure({ inline: false, allowBase64: false });
}
