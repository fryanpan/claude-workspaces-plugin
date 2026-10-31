import { prose } from '@claude-workspaces/core';
/**
 * Which part of a doc's folder `routes/doc-files.ts` may serve: the folder of
 * each page a `::html{src="…"}` line in the doc's CURRENT content names, and
 * nothing else. A doc with no such line serves nothing.
 *
 * The folder, not the whole tree beside the doc, because the files route is
 * open to every reader of the doc, share visitors included. A doc in a home
 * directory or a repository root otherwise exposes every `.json` and `.js`
 * under it (a credentials file, a config module) whether or not the doc frames
 * anything. The directive names the page; its folder is the site it loads.
 *
 * Read from the doc's live Yjs content rather than the file on disk, so a
 * line deleted in the editor stops serving at once, and a line typed there
 * serves before the write-back lands.
 */
import { parseFileEmbedDirective } from '@claude-workspaces/core/board-embeds';
import * as Y from 'yjs';

/** One framed page: its segments, and the folder segments it may load from. */
export interface FramedPage {
  page: string[];
  folder: string[];
}

/** The text of a top-level paragraph, marks ignored. */
function paragraphText(el: Y.XmlElement): string {
  let out = '';
  for (const child of el.toArray()) {
    if (child instanceof Y.XmlText) {
      for (const op of child.toDelta() as Array<{ insert?: unknown }>) {
        if (typeof op.insert === 'string') out += op.insert;
      }
    }
  }
  return out;
}

/** Every page the doc's top-level `::html{src}` lines name, in order. */
export function framedPages(ydoc: Y.Doc): FramedPage[] {
  const out: FramedPage[] = [];
  for (const node of prose.getProseFragment(ydoc).toArray()) {
    if (!(node instanceof Y.XmlElement) || node.nodeName !== 'paragraph') continue;
    const d = parseFileEmbedDirective(paragraphText(node));
    if (d) out.push({ page: d.segments, folder: d.segments.slice(0, -1) });
  }
  return out;
}

const startsWith = (segs: string[], prefix: string[]): boolean =>
  segs.length > prefix.length && prefix.every((s, i) => segs[i] === s);

/**
 * The folder `segments` may be served from: the deepest framed page folder
 * it sits under, or null when it sits under none.
 */
export function servingFolder(pages: FramedPage[], segments: string[]): string[] | null {
  let best: string[] | null = null;
  for (const { folder } of pages) {
    if (startsWith(segments, folder) && (best === null || folder.length > best.length)) {
      best = folder;
    }
  }
  return best;
}
