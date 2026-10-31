import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { prose } from '@claude-workspaces/core';
import { parseFileEmbedDirective } from '@claude-workspaces/core/board-embeds';
import * as Y from 'yjs';
import { isGitListed } from './doc-file-listing.ts';

/**
 * Which part of a doc's folder `routes/doc-files.ts` may serve: the folder of
 * a page that a `::html{src="…"}` line in the doc's CURRENT content names,
 * when that folder is a subfolder of the doc's and the page is a file git
 * lists there. Nothing else, so a doc with no such line serves nothing.
 *
 * The folder, not the whole tree beside the doc, because the files route is
 * open to every reader of the doc, share visitors included, and some of them
 * may edit it. So:
 *
 *  - a page at the doc's own level (`::html{src="index.html"}`) frames
 *    nothing: its folder would be the doc's whole folder, a repository root
 *    or a home directory, and every listed `.json` and `.js` in it;
 *  - the page must exist and be listed (`doc-file-listing.ts`), so a line
 *    naming a page that is not there opens no folder;
 *  - outside a git work tree nothing is listed, so nothing is served.
 *
 * Read from the doc's live Yjs content rather than the file on disk, so a
 * line deleted in the editor stops serving at once. Lines are read at any
 * depth, inside a list or a quote too, as the editor renders them
 * (`workspaces-app/src/doc/board-embed-frames.ts` walks every paragraph).
 */

/** One framed page: its segments, and the folder segments it may load from. */
export interface FramedPage {
  page: string[];
  folder: string[];
}

/** The text of a paragraph, marks ignored. */
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

function collect(nodes: Array<Y.XmlElement | Y.XmlText | Y.XmlHook>, out: FramedPage[]): void {
  for (const node of nodes) {
    if (!(node instanceof Y.XmlElement)) continue;
    if (node.nodeName !== 'paragraph') {
      collect(node.toArray(), out);
      continue;
    }
    const d = parseFileEmbedDirective(paragraphText(node));
    if (d) out.push({ page: d.segments, folder: d.segments.slice(0, -1) });
  }
}

/** Every page the doc's `::html{src}` lines name, in order, at any depth. */
export function framedPages(ydoc: Y.Doc): FramedPage[] {
  const out: FramedPage[] = [];
  collect(prose.getProseFragment(ydoc).toArray(), out);
  return out;
}

const under = (segs: string[], prefix: string[]): boolean =>
  segs.length > prefix.length && prefix.every((s, i) => segs[i] === s);

/**
 * The pages whose folder `segments` sits under, deepest folder first. A page
 * at the doc's own level is never one: its folder is empty.
 */
export function candidatePages(pages: FramedPage[], segments: string[]): FramedPage[] {
  return pages
    .filter((p) => p.folder.length > 0 && under(segments, p.folder))
    .sort((a, b) => b.folder.length - a.folder.length);
}

/** Whether the page is a file on disk that git lists. */
async function pagePresent(dir: string, p: FramedPage): Promise<boolean> {
  const isFile = await stat(join(dir, ...p.page)).then(
    (st) => st.isFile(),
    () => false,
  );
  return isFile && (await isGitListed(dir, p.folder, p.page.join('/')));
}

/**
 * The folder `segments` may be served from under `dir`, the doc's folder:
 * the deepest folder of a present page the doc frames that it sits under,
 * or null.
 */
export async function servingFolder(
  dir: string,
  pages: FramedPage[],
  segments: string[],
): Promise<string[] | null> {
  for (const p of candidatePages(pages, segments)) {
    if (await pagePresent(dir, p)) return p.folder;
  }
  return null;
}
