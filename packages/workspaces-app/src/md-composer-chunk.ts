/**
 * The lazily-loaded half of the composer editor: Tiptap, configured for a box
 * somebody types a comment into. Reached ONLY through the dynamic `import()`
 * in md-composer.ts, so the board build splits it into its own chunk and the
 * board's entry stays a board. Import nothing from here statically.
 *
 * The extension list is the description editor's, minus what a composer has
 * no use for: no Collaboration (the words are private until they are posted,
 * so there is no room to join), no thread decorations or suggestion marks
 * (nobody comments on a comment being written), no tables or mermaid. What is
 * left is the part Bryan asked for — markdown, live, as you type.
 */
import { Editor } from '@tiptap/core';
import Placeholder from '@tiptap/extension-placeholder';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from 'tiptap-markdown';
import type {
  ComposerEditor,
  ComposerFocusOpts,
  ComposerSelection,
  CreateComposerEditorOpts,
} from './md-composer.ts';

export function createComposerEditor(opts: CreateComposerEditorOpts): ComposerEditor {
  const editor = new Editor({
    element: opts.parent,
    extensions: [
      StarterKit.configure({
        // Undo/redo is ON here, unlike the document surfaces — no Yjs history
        // plugin owns it in a composer, and a box with no undo is a box that
        // loses a paragraph to one stray Cmd+A.
        heading: { levels: [1, 2, 3] },
        link: {
          openOnClick: false,
          autolink: true,
          HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' },
        },
      }),
      Placeholder.configure({ placeholder: opts.placeholder }),
      Markdown.configure({
        html: false,
        tightLists: true,
        linkify: true,
        breaks: false,
        transformPastedText: true,
      }),
    ],
    onUpdate: () => opts.onUpdate(),
  });

  // SELECT ALL STAYS IN THE BOX. A reply box in an inline thread card sits
  // inside the doc's own editing host (the card is a widget decoration), and
  // WebKit's native select-all widens to the HIGHEST editable ancestor,
  // stepping over the card's `contenteditable=false`. So iOS's Select All
  // menu, which never sends a keydown for Tiptap's Mod-a to catch, selected
  // the whole doc from inside a comment. WebKit announces it first with a
  // cancellable `selectstart` aimed at that outer host: refuse it and select
  // this box instead. A selection starting inside the box targets the box's
  // own nodes, so a drag or a long-press is untouched.
  const doc = opts.parent.ownerDocument;
  const keepSelectAllInside = (ev: Event): void => {
    const dom = editor.view.dom;
    const target = ev.target;
    if (!(target instanceof Node) || target === dom || !target.contains(dom)) return;
    const anchor = doc.getSelection()?.anchorNode ?? null;
    if (!anchor || !dom.contains(anchor)) return;
    ev.preventDefault();
    editor.commands.selectAll();
  };
  doc.addEventListener('selectstart', keepSelectAllInside, true);

  const clamp = (pos: number) => Math.max(0, Math.min(pos, editor.state.doc.content.size));

  return {
    getMarkdown() {
      type MarkdownStorage = { getMarkdown: () => string };
      const store = (editor.storage as unknown as { markdown?: MarkdownStorage }).markdown;
      const md =
        store?.getMarkdown() ??
        editor.state.doc.textBetween(0, editor.state.doc.content.size, '\n');
      // tiptap-markdown spells a hard break backslash-newline, and comment
      // surfaces showed the backslash literally. Respell it as the two-space
      // break: invisible in raw text, and it round-trips through a draft
      // restore where a bare newline would soften back into a space.
      return md.replace(/\\\n/g, '  \n');
    },
    setMarkdown(md: string) {
      // `emitUpdate: false` is load-bearing rather than an optimisation. A
      // seed that emitted would push the serializer's rendering of the words
      // back into `ta.value`, so a comment handed back after a refused post
      // would come back subtly rewritten instead of verbatim.
      editor.commands.setContent(md, { emitUpdate: false });
    },
    focus(sel: ComposerSelection | null, opts: ComposerFocusOpts = {}) {
      const scrollIntoView = opts.scroll !== false;
      if (sel) editor.commands.setTextSelection({ from: clamp(sel.from), to: clamp(sel.to) });
      // Tiptap's focus command schedules the caret through
      // `requestAnimationFrame` and never checks that there is one. Every
      // browser has it; a torn-down test environment does not, because vitest
      // deletes each window key from the global when a file finishes. A stray
      // focus landing in that window took a whole 310-file run down with a
      // `ReferenceError` that named nothing a person could act on. Nothing is
      // lost by declining to move a caret on a page that no longer exists.
      if (typeof requestAnimationFrame !== 'function') return;
      editor.commands.focus(sel ? undefined : 'end', { scrollIntoView });
    },
    blur() {
      editor.commands.blur();
    },
    selection() {
      const { from, to } = editor.state.selection;
      return { from, to };
    },
    isFocused: () => editor.isFocused,
    // `emitUpdate: false` for the same reason `setMarkdown` passes it:
    // Tiptap's default is to announce an update, and a composer that answered
    // "the words changed" because it was disabled mid-send would push the
    // editor's rendering of them back over the textarea a caller is about to
    // hand back verbatim.
    setEditable: (on: boolean) => editor.setEditable(on, false),
    destroy: () => {
      doc.removeEventListener('selectstart', keepSelectAllInside, true);
      editor.destroy();
    },
  };
}
