import { anchors } from '@claude-workspaces/core';
import { SPEAKER_TAG_SCHEME } from '@claude-workspaces/core';
import { type AnyExtension, Editor } from '@tiptap/core';
import Collaboration from '@tiptap/extension-collaboration';
import { Image } from '@tiptap/extension-image';
import { Table } from '@tiptap/extension-table';
import { TableCell } from '@tiptap/extension-table-cell';
import { TableHeader } from '@tiptap/extension-table-header';
import { TableRow } from '@tiptap/extension-table-row';
import StarterKit from '@tiptap/starter-kit';
// IMPORTANT: these must come from @tiptap/y-tiptap, not y-prosemirror.
// Tiptap's Collaboration extension registers the sync plugin under its own
// PluginKey instance re-exported from @tiptap/y-tiptap; importing from
// y-prosemirror gets a *different* key and `getState()` always returns
// undefined — which was the real cause of "no selection" errors.
import {
  absolutePositionToRelativePosition,
  relativePositionToAbsolutePosition,
  ySyncPluginKey,
} from '@tiptap/y-tiptap';
import { Markdown } from 'tiptap-markdown';
import type { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { BlockIdentity } from './block-identity.ts';
import { workspaceIdFromPath } from './doc-path.ts';
import { FootnoteDecorations } from './doc/footnote-decorations.ts';
import { resolveDocLink, safeLinkHref } from './link-open.ts';
import { ListBehavior } from './list-behavior.ts';
import { MermaidCodeBlock } from './mermaid-code-block.ts';
import { NotesLinkAffordance, type NotesLinkAffordanceOptions } from './notes-link-affordance.ts';
import { PlanPlaceholder } from './plan-placeholder.ts';
import type { InlineThreadCard } from './review-surface.ts';
import { SettleWash, type SettleWashOptions } from './settle-wash.ts';
import { SuggestInput } from './suggest-input.ts';
import { CODE_BLOCK_MARKS, SuggestDelete, SuggestInsert } from './suggest-marks.ts';
import { SuggestionChips } from './suggestions/suggestion-chips.ts';
import { TaskLinkChips } from './task-link-chips.ts';
import { ThreadDecorations, type ThreadRange, setThreadDecorations } from './thread-decorations.ts';

/**
 * WYSIWYG markdown editor backed by Tiptap (ProseMirror) + Yjs collaboration.
 * Storage: content lives in a Y.XmlFragment named `prose`. (The pre-Tiptap
 * `content` Y.Text migration was removed 2026-07 after a scan showed no
 * persisted doc still needed it; `content` is now the CODE/DIFF surface.)
 */

export interface EditorHandle {
  editor: Editor;
  getSelectionRel: () => { start: Uint8Array; end: Uint8Array; snippet: string } | null;
  resolveRel: (startRel: Uint8Array, endRel: Uint8Array) => { from: number; to: number } | null;
  scrollToPos: (pos: number) => void;
  /** Brief highlight pulse on a text range — used when clicking a thread in the panel. */
  pulseRange: (from: number, to: number) => void;
  /** Update which thread anchors should be highlighted in the editor. */
  setThreadRanges: (ranges: ThreadRange[], activeId: string | null) => void;
  /** Place comment cards in the flow, under the block they are anchored in
   *  (the mobile inline comment surface). Empty array clears them. */
  setInlineCards: (cards: InlineThreadCard[]) => void;
  /** Keep the words a comment is being written about marked; null clears. */
  markPending: (range: { from: number; to: number } | null) => void;
  getText: () => string;
  setMarkdown: (md: string) => void;
  getMarkdown: () => string;
  destroy: () => void;
}

export interface CreateEditorOpts {
  parent: HTMLElement;
  ydoc: Y.Doc;
  awareness: Awareness;
  fragmentName?: string;
  onSelectionChange?: () => void;
  onUpdate?: () => void;
  user?: { name: string; color: string };
  seedMarkdown?: string;
  /** Surface-specific extensions appended to the standard list (e.g. the
   *  redline surface's live-markup decorations). */
  extraExtensions?: AnyExtension[];
  /** When the doc belongs to a workspace, Cmd/Ctrl+Click on a relative link
   *  to a sibling file navigates in-SPA (via `navigate`) instead of opening
   *  a raw relative URL that 404s. Omit for standalone docs. */
  docLink?: { workspaceId: string; relPath: string; navigate: (url: string) => void };
  /**
   * The two taps a note's task links accept: turning the note-taker's
   * "related: …?" question into a real link, and undoing one that was wrong
   * (`notes-link-affordance.ts`). Omit and the plugin is not installed —
   * every surface that is not a workspace doc.
   */
  notesLinks?: NotesLinkAffordanceOptions;
  /** Doc surface with a meeting strip: wash freshly arrived remote notes so
   *  the eye can follow the live transcript up into the note it became
   *  (settle-wash.ts). Absent = no plugin, nothing watched. */
  settleWash?: SettleWashOptions;
  /**
   * Whether the surface accepts typing AT ALL, from its first paint. Defaults
   * to `true` — the markdown surface owns its own view/edit toggle and calls
   * `setEditable` itself.
   *
   * Passed at CONSTRUCTION rather than corrected afterwards on purpose: a
   * surface built editable and locked a moment later is editable for that
   * moment, which is the whole failure the write gate exists to prevent.
   */
  editable?: boolean;
}

/**
 * One stored anchor's absolute position, or null when it has none right now.
 *
 * `relativePositionToAbsolutePosition` walks the Yjs tree and asks the ySync
 * binding's mapping for the ProseMirror node of every sibling it steps over —
 * `mapping.get(t).nodeSize`, unguarded. The mapping is rebuilt by the sync
 * plugin's OWN observer on the prose fragment, so during a remote update that
 * touches both the threads map and the prose there is a window where a Yjs
 * element is already in the tree and not yet in the mapping: the threads
 * observer repaints the panel first, this walk reaches the new element, and
 * the read throws a TypeError on undefined.
 *
 * That throw was never one thread's problem. It escaped the whole collect
 * pass, so Yjs logged "Caught error while handling a Yjs update" and EVERY
 * thread on the doc lost its repaint for that update. An anchor the mapping
 * cannot place is exactly an anchor that does not resolve, so it answers null
 * and takes the existing orphan path; the sync plugin's own dispatch repaints
 * a moment later with the mapping complete, and the thread comes back.
 */
function absFromRel(
  ydoc: Y.Doc,
  type: Y.XmlFragment,
  rel: Y.RelativePosition,
  mapping: Parameters<typeof relativePositionToAbsolutePosition>[3],
): number | null {
  try {
    return relativePositionToAbsolutePosition(ydoc, type, rel, mapping);
  } catch {
    return null;
  }
}

export function createEditor(opts: CreateEditorOpts): EditorHandle {
  // y-prosemirror awareness CURSORS are still a follow-up (once the Tiptap 3
  // cursor extension lands upstream); `awareness` and `user` are accepted now
  // so callers don't churn when that wiring lands — nothing reads them yet.

  const fragmentName = opts.fragmentName ?? 'prose';

  const editor = new Editor({
    element: opts.parent,
    editable: opts.editable ?? true,
    extensions: [
      StarterKit.configure({
        undoRedo: false, // Yjs Collaboration plugin owns undo/redo
        codeBlock: false, // replaced by MermaidCodeBlock below
        link: {
          openOnClick: false,
          autolink: true,
          // A speaker tag is a link whose href names a VOICE, not a
          // destination (`speaker:B`, see core/speaker-tags.ts). Tiptap
          // renders an href outside its allow-list as `href=""`, which would
          // erase the label the tag exists to carry — so the scheme is
          // declared here. Clicking one still goes nowhere: `safeLinkHref`
          // refuses it, which is the half that decides what may be opened.
          protocols: [SPEAKER_TAG_SCHEME.replace(':', '')],
          HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' },
        },
      }),
      // Block identity (`cwId` / `cwAuthor`) declared on every block type, so
      // y-prosemirror neither strips the server's attributes on the next local
      // edit nor counts them as a difference and re-creates the block. In the
      // BASE list because every prose surface binds to a doc the server also
      // writes; deleting it silently un-does the server-side identity work
      // (packages/core/src/prose-outline.ts).
      BlockIdentity,
      // A code block must admit the suggestion marks, or y-prosemirror deletes
      // any code block a proposal touches — see CODE_BLOCK_MARKS.
      MermaidCodeBlock.extend({ marks: CODE_BLOCK_MARKS }),
      // Block-level images. The server-side markdown round-trip (packages/core
      // prose.ts) emits/consumes `image` nodes for `![alt](src)` lines; without
      // this extension the schema has no `image` node and sync would drop them.
      // Works for remote URLs and relative/local paths alike.
      Image.configure({ inline: false, allowBase64: false }),
      Markdown.configure({
        html: false,
        tightLists: true,
        linkify: true,
        breaks: false,
        transformPastedText: true,
      }),
      // GFM tables. resizable:false keeps the column widths inferred
      // from content — no drag handles competing with the comment pill.
      Table.configure({ resizable: false, HTMLAttributes: { class: 'prose-table' } }),
      TableRow,
      TableHeader,
      TableCell,
      // Suggested-edit marks (Phase 2). Registered in the BASE schema so
      // y-prosemirror never drops an agent-written suggestion from the Yjs
      // doc — see suggest-marks.ts for why this is load-bearing.
      SuggestInsert,
      SuggestDelete,
      // The Suggesting input mode (off until setSuggesting flips it on): in
      // Suggesting, typing/deleting becomes attributed proposals instead of
      // direct edits. Registered in the base list so every prose surface
      // (plain markdown AND the redline lens) gets the same behavior.
      SuggestInput,
      // Mobile "✎ suggestion" chip decoration (commit 5) — same base-schema
      // reasoning as the marks above.
      SuggestionChips,
      Collaboration.configure({
        document: opts.ydoc,
        field: fragmentName,
      }),
      ThreadDecorations,
      // Live status chips beside workspace task links — render-time only,
      // never written into the fragment. In the base list because every
      // prose surface may hold a task link (meeting notes are the driver).
      TaskLinkChips,
      // `^[a note]` in the prose, drawn as a margin note beside the line or a
      // superscript on a phone (doc/footnote-decorations.ts). Render-time
      // only — the note is the literal text and stays that way — and in the
      // base list because a footnote is prose, so any surface may hold one.
      FootnoteDecorations,
      // Accept a suggested link, or take a wrong one back off. Configured or
      // it installs no plugin at all, so it costs the redline and task-body
      // surfaces nothing.
      NotesLinkAffordance.configure(opts.notesLinks ?? {}),
      // Bullet-list ergonomics: Tab-indent for a first/sole list item and
      // auto-join of adjacent same-type lists. Deliberately NOT part of the
      // redline surface (redline-editor.ts builds its own Editor) — adjacent
      // lists are load-bearing there (they carry per-hunk anchors).
      ListBehavior,
      ...(opts.settleWash ? [SettleWash.configure(opts.settleWash)] : []),
      // "Type or say what problem you'd like to solve…" on an unwritten
      // plan doc — render-time only, self-gating on the doc's own meta, so
      // it costs nothing on every other surface.
      PlanPlaceholder.configure({ ydoc: opts.ydoc }),
      ...(opts.extraExtensions ?? []),
    ],
    onSelectionUpdate: () => opts.onSelectionChange?.(),
    onUpdate: () => opts.onUpdate?.(),
  });

  // Content arrives via Yjs sync from the server (which loaded it from the
  // bound .md file). The editor never seeds locally — that would race the
  // server's authoritative content.

  /**
   * A single tap or click opens the link — on a phone and under a mouse
   * alike.
   *
   * Tiptap's own opener is off (`openOnClick: false`) and this replaces it,
   * because the doc is now EDITABLE for everyone who can write it: the
   * Cmd/Ctrl-click this used to require is a gesture a touch screen does not
   * have, and a reader on a phone had no way at all to follow a link in their
   * own notes. The href is still filtered by `safeLinkHref`, so a
   * script-bearing scheme opens nothing.
   *
   * Three gestures are NOT this one:
   *
   * - Alt/Option-click, the deliberate "put the caret in here". This is the
   *   way to edit a link's own words now that a plain click leaves the page,
   *   and it is the only one: a browser sends the FIRST click of a double
   *   click with `detail === 1`, so by the time a second arrives the link has
   *   already opened. Double-click-to-select and click-to-open cannot both
   *   have the plain gesture, and the spec gives it to opening.
   * - Shift-click, which extends a selection across it.
   * - anything but the primary button, which belongs to the context menu.
   *
   * `ev.detail > 1` is still refused, and it is not that missing fourth
   * gesture: it stops the SECOND click of a double click from opening the
   * same link a second time, in a second tab.
   *
   * Bound at the DOM level so it works whether or not the view is editable.
   */
  const onLinkClick = (ev: MouseEvent) => {
    if (ev.button !== 0 || ev.detail > 1 || ev.altKey || ev.shiftKey) return;
    const target = ev.target as HTMLElement | null;
    const anchor = target?.closest?.('a[href]') as HTMLAnchorElement | null;
    if (!anchor) return;
    const href = safeLinkHref(anchor.getAttribute('href'));
    if (!href) return;
    ev.preventDefault();
    ev.stopPropagation();
    // A relative link to a sibling workspace doc navigates in-app (same
    // tab — it's the same review session); everything else opens externally.
    const inApp = opts.docLink
      ? resolveDocLink({
          href,
          reviewId: opts.docLink.workspaceId,
          relPath: opts.docLink.relPath,
          workspaceId: workspaceIdFromPath(location.pathname),
        })
      : null;
    if (inApp && opts.docLink) {
      opts.docLink.navigate(inApp);
      return;
    }
    window.open(href, '_blank', 'noopener,noreferrer');
  };
  editor.view.dom.addEventListener('click', onLinkClick);

  function syncState() {
    return ySyncPluginKey.getState(editor.state);
  }

  return {
    editor,
    getSelectionRel() {
      const sync = syncState();
      if (!sync?.binding) return null;
      const { mapping, type } = sync.binding;
      const toRel = (from: number, to: number) => {
        const startRel = absolutePositionToRelativePosition(from, type, mapping);
        const endRel = absolutePositionToRelativePosition(to, type, mapping);
        const snippet = editor.state.doc.textBetween(from, to, ' ').slice(0, 80);
        return {
          start: Y.encodeRelativePosition(startRel),
          end: Y.encodeRelativePosition(endRel),
          snippet,
        };
      };
      // 1) ProseMirror's own selection — authoritative in edit mode.
      const { from, to, empty } = editor.state.selection;
      if (!empty) return toRel(from, to);
      // 2) Fall back to the raw DOM selection. In VIEW mode (contenteditable
      //    =false) a long-press text selection — notably on iOS Safari —
      //    never propagates into ProseMirror's selection state, so the PM
      //    selection reads empty even though the user has visibly selected
      //    text. Map the DOM range back to document positions via posAtDOM so
      //    commenting works without making the doc editable.
      const dom = window.getSelection();
      if (!dom || dom.rangeCount === 0 || dom.isCollapsed) return null;
      const range = dom.getRangeAt(0);
      const view = editor.view;
      if (!view.dom.contains(range.startContainer) || !view.dom.contains(range.endContainer)) {
        return null;
      }
      let a: number;
      let b: number;
      try {
        a = view.posAtDOM(range.startContainer, range.startOffset);
        b = view.posAtDOM(range.endContainer, range.endOffset);
      } catch {
        return null;
      }
      if (a < 0 || b < 0 || a === b) return null;
      return toRel(Math.min(a, b), Math.max(a, b));
    },
    resolveRel(startRel, endRel) {
      const sync = syncState();
      if (!sync?.binding) return null;
      const { mapping, type } = sync.binding;
      // Undecodable bytes (a hand-written anchor persisted before the routes
      // validated them) answer null, the same as a position that no longer
      // resolves. Throwing here would break every decoration on the doc, not
      // just this one thread's.
      const startDecoded = anchors.decodeRelativePositionSafe(startRel);
      const endDecoded = anchors.decodeRelativePositionSafe(endRel);
      if (!startDecoded || !endDecoded) return null;
      const startAbs = absFromRel(opts.ydoc, type, startDecoded, mapping);
      const endAbs = absFromRel(opts.ydoc, type, endDecoded, mapping);
      if (startAbs == null || endAbs == null) return null;
      const from = Math.min(startAbs, endAbs);
      const to = Math.max(startAbs, endAbs);
      if (from === to) return null;
      return { from, to };
    },
    scrollToPos(pos) {
      const clamped = Math.max(0, Math.min(pos, editor.state.doc.content.size));
      editor.commands.setTextSelection(clamped);
      editor.commands.scrollIntoView();
      editor.commands.focus();
    },
    pulseRange(from, to) {
      // Pulse the range by emitting a pulseId meta; the extension adds a
      // transient .pulse class. We pass a synthetic id (from-to) so repeated
      // clicks on the same thread retrigger the animation.
      const pulseId = `pulse-${from}-${to}-${Date.now()}`;
      setThreadDecorations(editor.view, { pulseId });
      setTimeout(() => setThreadDecorations(editor.view, { pulseId: null }), 1200);
    },
    setThreadRanges(ranges, activeId) {
      setThreadDecorations(editor.view, { ranges, activeId });
    },
    markPending(range) {
      setThreadDecorations(editor.view, { pending: range });
    },
    setInlineCards(cards) {
      setThreadDecorations(editor.view, {
        inlineCards: cards.map((c) => ({ id: c.id, el: c.el })),
      });
    },
    getText() {
      return editor.state.doc.textBetween(0, editor.state.doc.content.size, '\n');
    },
    setMarkdown(md) {
      editor.commands.setContent(md, { emitUpdate: true });
    },
    getMarkdown() {
      type MarkdownStorage = { getMarkdown: () => string };
      const store = (editor.storage as unknown as { markdown?: MarkdownStorage }).markdown;
      return store?.getMarkdown() ?? this.getText();
    },
    destroy() {
      editor.view.dom.removeEventListener('click', onLinkClick);
      editor.destroy();
    },
  };
}
