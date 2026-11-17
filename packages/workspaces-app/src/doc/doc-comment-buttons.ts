/**
 * The round comment buttons in a markdown doc's bottom-right corner — the
 * speech bubble, the mic and the thread list a mock or an app page shows.
 *
 * Bryan, 14 Nov, on a doc beside a live map embed: "What happened to my
 * commenting tools bottom right?" A doc page had never loaded them; mocks
 * and app pages always had. He approved adding them to docs.
 *
 * The widget is pointed at the doc on screen, so what it takes lands on that
 * doc's threads and reaches the agent watching it. It is created here, per
 * doc mount, and removed when the mount is torn down: the widget has no way
 * to change its doc once it has started, and the page swaps docs in place.
 *
 * Not on a page opened as an embed (`cw-embed=1`), the same rule the app door
 * applies to a board embed's frame (`routes/apps.ts`): an embed is read-only
 * and its host page has its own buttons.
 *
 * The element is made at once and the widget's code follows in its own chunk
 * (`doc-comment-buttons-chunk.ts`), so none of it is in the doc's first load.
 */
import { readDocMeta } from '@claude-workspaces/core';
import { EMBED_PARAM } from '@claude-workspaces/core/board-embeds';
import type * as Y from 'yjs';
import type { MountScope } from '../mount-scope.ts';

/** The widget's tag, as `widget.ts` defines it. */
export const WIDGET_TAG = 'claude-feedback-widget';

/** Whether a page at this address should carry the buttons. */
export function wantsCommentButtons(search: string): boolean {
  return new URLSearchParams(search).get(EMBED_PARAM) !== '1';
}

export interface CommentButtonsOpts {
  doc: Document;
  /** The board in the page's address. */
  workspaceId: string;
  /** The id in the page's address, which may be an alias. */
  docId: string;
  /** The doc's synced state. Its meta names the canonical id, which is the
   *  one the widget is given. */
  ydoc?: Y.Doc;
  /** The page's `location.search`. */
  search: string;
  scope: MountScope;
  /** Brings in the widget and gives the element its mic. A test that only
   *  checks the element passes its own. */
  load?: (el: HTMLElement) => Promise<unknown>;
}

const loadChunk = (el: HTMLElement): Promise<unknown> =>
  import('./doc-comment-buttons-chunk.ts').then((m) => m.mountDocWidget(el));

/** Put the widget on this doc, or nothing on an embed. Answers the element. */
export function mountCommentButtons(opts: CommentButtonsOpts): HTMLElement | null {
  const { doc, scope } = opts;
  if (!wantsCommentButtons(opts.search) || scope.disposed) return null;
  // A widget left from a doc whose mount did not clean up would be a second
  // corner of buttons on another doc's threads.
  for (const old of doc.querySelectorAll(WIDGET_TAG)) old.remove();
  const el = doc.createElement(WIDGET_TAG);
  el.setAttribute('workspace-id', opts.workspaceId);
  // The canonical id, never the address's alias. The widget's socket creates
  // a mock that does not exist, and archiving releases the alias, so a widget
  // on the alias reconnected after an archive and made an empty mock under
  // the name the page was opened by.
  el.setAttribute('doc-id', (opts.ydoc && readDocMeta(opts.ydoc).docId) || opts.docId);
  // This page is ours and already knows the reader's name (`mockup-widget.ts`
  // explains the attribute).
  el.setAttribute('identity-scope', 'host');
  doc.body.append(el);
  scope.onCleanup(() => el.remove());
  void (opts.load ?? loadChunk)(el).catch(() => {
    // A chunk that failed to load leaves the doc as it was without the
    // buttons; the element with no definition draws nothing.
  });
  return el;
}
