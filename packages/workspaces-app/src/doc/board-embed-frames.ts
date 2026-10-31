import {
  type BoardEmbeds,
  clampEmbedHeight,
  docFileUrl,
  docFilesBase,
  embedFrameSpec,
  parseEmbedDirective,
  parseFileEmbedDirective,
} from '@claude-workspaces/core/board-embeds';
import { Extension } from '@tiptap/core';
import type { Node as ProseNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

/**
 * A paragraph whose whole text is `::name{block="x"}` shows a live frame of
 * the board's mapped app beneath it (`@claude-workspaces/core/board-embeds`).
 *
 * STRICTLY RENDER-TIME, like the plan placeholder: the line stays an ordinary
 * paragraph with its own text, and the frame is a widget decoration after it,
 * so the stored doc and its markdown never change.
 *
 * The app door serves on our own origin, so its frame gets `allow-scripts`
 * and never `allow-same-origin`. An entry at an allowlisted https origin is
 * cross-origin to the board, so its frame keeps its own origin
 * (`allow-same-origin` grants it that origin, not ours). Its page then sends
 * its own address as the Referer on its requests, which a referrer-restricted
 * map key needs; the frame's own request sends none, so the board's host name
 * never reaches the site. Its height comes from a
 * `{type:"sfworks:height", block, height}` message, taken only when the
 * message's source is that frame's own window and, for an origin entry, its
 * `origin` is the entry's.
 *
 * A paragraph whose whole text is `::html{src="map/index.html"}` frames that
 * page from the doc's own folder instead (`server/src/routes/doc-files.ts`),
 * with no board mapping. Its frame is opaque like an app door's. The page's
 * relative `fetch` calls come here (`server/src/doc-file-frame.ts` installs
 * the relay inside it): a `cw-file-fetch` message from that frame's own
 * window, naming a path, is fetched under that doc's folder address and
 * nowhere else, with this page's session, and the status, type and bytes go
 * back on the message's port. Nothing else of this page reaches the frame.
 *
 * Not live by itself: an edit to the page or a file beside it shows when the
 * doc is reloaded. A page such as a map holds the reader's own state (where
 * they panned, what they opened), and reloading it under them on every save
 * would throw that away.
 *
 * Click to activate: a frame starts inert under a "Tap to interact" hint so
 * the doc scrolls past it; a tap activates it, and a tap outside it or Escape
 * puts it back.
 */

const key = new PluginKey<DecorationSet>('board-embed-frames');
const META_KEY = 'boardEmbedsLoaded';
const DEFAULT_HEIGHT = 320;

export interface BoardEmbedFramesOptions {
  /** The board the doc is on; null installs nothing. */
  workspaceId: string | null;
  /** The doc itself, for `::html{src}` lines; null shows none of those. */
  docId?: string | null;
  /** Reads the board's mapping; null or a throw shows no frames. */
  load: () => Promise<BoardEmbeds | null>;
}

async function defaultLoad(workspaceId: string): Promise<BoardEmbeds | null> {
  const res = await fetch(`/workspaces/${encodeURIComponent(workspaceId)}/embeds`);
  if (!res.ok) return null;
  const body = (await res.json()) as { embeds?: BoardEmbeds };
  return body.embeds ?? null;
}

function frameEl(
  url: string,
  origin: string | null,
  block: string,
  filesBase?: string,
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'board-embed';
  wrap.contentEditable = 'false';
  const frame = document.createElement('iframe');
  if (origin) {
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.dataset.embedOrigin = origin;
  } else {
    frame.setAttribute('sandbox', 'allow-scripts');
  }
  frame.setAttribute('loading', 'lazy');
  frame.setAttribute('title', block);
  frame.dataset.embedBlock = block;
  if (filesBase) frame.dataset.embedFiles = filesBase;
  frame.style.height = `${DEFAULT_HEIGHT}px`;
  frame.src = url;
  // Inactive, the frame takes no pointer events, so a wheel or a swipe over
  // it scrolls the doc; a tap anywhere on it hands it the pointer.
  const hint = document.createElement('button');
  hint.type = 'button';
  hint.className = 'board-embed-hint';
  hint.textContent = 'Tap to interact';
  wrap.append(frame, hint);
  wrap.addEventListener('click', () => setActive(wrap, true));
  return wrap;
}

function setActive(wrap: Element, on: boolean): void {
  wrap.classList.toggle('is-active', on);
}

function build(
  doc: ProseNode,
  workspaceId: string,
  docId: string | null,
  embeds: BoardEmbeds | null,
): DecorationSet {
  const decos: Decoration[] = [];
  const seen = new Map<string, number>();
  const widget = (pos: number, url: string, make: () => HTMLElement): void => {
    // Keyed on the address and its count, so an edit elsewhere keeps the
    // frame (and its loaded page) rather than reloading it.
    const n = (seen.get(url) ?? 0) + 1;
    seen.set(url, n);
    decos.push(
      Decoration.widget(pos, make, {
        key: `embed:${url}#${n}`,
        side: -1,
        ignoreSelection: true,
        stopEvent: () => true,
      }),
    );
  };
  doc.descendants((node, pos) => {
    if (node.type.name !== 'paragraph') return true;
    const file = docId ? parseFileEmbedDirective(node.textContent) : null;
    if (file && docId) {
      const url = docFileUrl(workspaceId, docId, file.segments);
      const base = docFilesBase(workspaceId, docId);
      widget(pos + node.nodeSize, url, () => frameEl(url, null, file.src, base));
      return false;
    }
    if (!embeds) return false;
    const d = parseEmbedDirective(node.textContent);
    const spec = d ? embedFrameSpec(embeds, workspaceId, d.name, d.block) : null;
    if (d && spec) {
      const { url, origin } = spec;
      widget(pos + node.nodeSize, url, () => frameEl(url, origin, d.block));
    }
    return false;
  });
  return DecorationSet.create(doc, decos);
}

function hasDirective(doc: ProseNode): boolean {
  let found = false;
  doc.descendants((node) => {
    if (found) return false;
    if (node.type.name !== 'paragraph') return true;
    if (parseEmbedDirective(node.textContent)) found = true;
    return false;
  });
  return found;
}

export const BoardEmbedFrames = Extension.create<BoardEmbedFramesOptions>({
  name: 'boardEmbedFrames',

  addOptions() {
    return { workspaceId: null, docId: null, load: async () => null };
  },

  addProseMirrorPlugins() {
    const { workspaceId, load } = this.options;
    const docId = this.options.docId ?? null;
    if (!workspaceId) return [];
    let embeds: BoardEmbeds | null = null;
    return [
      new Plugin<DecorationSet>({
        key,
        state: {
          init: (_cfg, s) => build(s.doc, workspaceId, docId, embeds),
          apply: (tr, prev) =>
            tr.docChanged || tr.getMeta(META_KEY)
              ? build(tr.doc, workspaceId, docId, embeds)
              : prev.map(tr.mapping, tr.doc),
        },
        props: {
          decorations: (state) => key.getState(state),
        },
        view(view) {
          let live = true;
          let asked = false;
          // The mapping is read once, and only when the doc first holds a
          // directive line, so a doc without one makes no request.
          const ensureLoaded = (doc: ProseNode): void => {
            if (asked || !hasDirective(doc)) return;
            asked = true;
            load()
              .then((m) => {
                if (!live || !m) return;
                embeds = m;
                view.dispatch(view.state.tr.setMeta(META_KEY, true));
              })
              .catch(() => {});
          };
          ensureLoaded(view.state.doc);
          const onMessage = (ev: MessageEvent): void => {
            const data = ev.data as { type?: unknown; block?: unknown; height?: unknown } | null;
            if (data?.type === FILE_FETCH) {
              relayFileFetch(view.dom, ev);
              return;
            }
            if (data?.type !== 'sfworks:height' || typeof data.height !== 'number') return;
            if (!Number.isFinite(data.height)) return;
            for (const f of view.dom.querySelectorAll<HTMLIFrameElement>(
              'iframe[data-embed-block]',
            )) {
              if (ev.source === null || f.contentWindow !== ev.source) continue;
              // A file frame is one page of its own; its window is the check.
              if (f.dataset.embedFiles === undefined && f.dataset.embedBlock !== data.block) {
                continue;
              }
              const origin = f.dataset.embedOrigin;
              if (origin !== undefined && ev.origin !== origin) continue;
              f.style.height = `${clampEmbedHeight(data.height)}px`;
            }
          };
          window.addEventListener('message', onMessage);
          const deactivate = (keep: EventTarget | null): void => {
            for (const w of view.dom.querySelectorAll('.board-embed.is-active')) {
              if (!(keep instanceof Node && w.contains(keep))) setActive(w, false);
            }
          };
          const onPointerDown = (ev: PointerEvent): void => deactivate(ev.target);
          const onKey = (ev: KeyboardEvent): void => {
            if (ev.key === 'Escape') deactivate(null);
          };
          document.addEventListener('pointerdown', onPointerDown, true);
          document.addEventListener('keydown', onKey);
          return {
            update(v) {
              ensureLoaded(v.state.doc);
            },
            destroy() {
              live = false;
              window.removeEventListener('message', onMessage);
              document.removeEventListener('pointerdown', onPointerDown, true);
              document.removeEventListener('keydown', onKey);
            },
          };
        },
      }),
    ];
  },
});

/** What a file frame's relay asks this page for (`server/src/doc-file-frame.ts`). */
const FILE_FETCH = 'cw-file-fetch';
const FILE_PATH_MAX = 2048;

/**
 * One relayed GET for a file frame: only from the window of a frame this
 * editor drew for a `::html` line, only for a path under that doc's folder
 * address once the browser has resolved it, and answered on the message's
 * own port with the status, the type and the bytes.
 */
function relayFileFetch(root: HTMLElement, ev: MessageEvent): void {
  const port = ev.ports[0];
  const path = (ev.data as { path?: unknown }).path;
  if (!port) return;
  const fail = (): void => port.postMessage({ error: true });
  const frame = [...root.querySelectorAll<HTMLIFrameElement>('iframe[data-embed-files]')].find(
    (f) => ev.source !== null && f.contentWindow === ev.source,
  );
  const base = frame?.dataset.embedFiles;
  let target: URL | null = null;
  if (base && typeof path === 'string' && path.length <= FILE_PATH_MAX) {
    try {
      target = new URL(base + path, location.origin);
    } catch {
      target = null;
    }
  }
  if (!base || !target || target.origin !== location.origin || !target.pathname.startsWith(base)) {
    fail();
    return;
  }
  fetch(target.pathname + target.search, { credentials: 'same-origin', cache: 'no-cache' })
    .then(async (res) => {
      const body = await res.arrayBuffer();
      port.postMessage({ status: res.status, type: res.headers.get('content-type') ?? '', body }, [
        body,
      ]);
    })
    .catch(fail);
}

/** The extension wired to the board's own mapping route. */
export function boardEmbedFramesFor(workspaceId: string | null, docId?: string | null) {
  return BoardEmbedFrames.configure({
    workspaceId,
    docId: docId ?? null,
    load: () => (workspaceId ? defaultLoad(workspaceId) : Promise.resolve(null)),
  });
}
