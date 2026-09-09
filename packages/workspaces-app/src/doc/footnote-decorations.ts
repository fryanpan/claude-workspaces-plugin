import { factRange, findFootnotes } from '@claude-workspaces/core';
import { Extension } from '@tiptap/core';
import type { Node as ProseNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

/**
 * Where a `^[…]` note is on screen, and which words it is about.
 *
 * STRICTLY RENDER-TIME, like the task-link chips beside it. A footnote is
 * the literal characters in the prose and nothing else — no mark, no node,
 * no attribute — so this plugin writes nothing to the document. It reads the
 * text of every block on every state change and hands back two decorations
 * per note: one over the `^[…]` run itself (the stylesheet folds it down to
 * a superscript, or hides it where the margin carries the note) and one over
 * the fact the note supports (the underline, dotted when the author said
 * "Unconfirmed").
 *
 * The raw run is REVEALED, not hidden, while the caret sits inside it: a
 * note you cannot see is a note you cannot fix, and the editor is the only
 * place a person can type one. `cw-fn-open` is that state.
 *
 * The numbering is document order, one sequence for the whole doc, because
 * that is what the printed sources list is numbered by.
 */

/** The decoration set, plus the editability it was built for. */
export interface FootnoteDecoState {
  set: DecorationSet;
  editable: boolean;
}

export const footnoteDecorationsKey = new PluginKey<FootnoteDecoState>('footnote-decorations');

/** One note, located in the document. */
export interface FootnoteRun {
  /** 1-based position in document order. */
  n: number;
  /** The `^[…]` run. */
  from: number;
  to: number;
  /** The words the note is about. */
  factFrom: number;
  factTo: number;
  note: string;
  unsure: boolean;
}

/**
 * The offsets inside a textblock that carry the `code` mark.
 *
 * `textBetween` flattens marks away, so `Write \`^[a note]\` to add one` reads
 * as a plain sentence holding a note — and drawing one there would contradict
 * the parser, which keeps a `^[…]` in backticks as code and says so in
 * `prose-footnote-roundtrip.test.ts`. A code span is documentation ABOUT the
 * syntax, so the characters must stay characters.
 *
 * Child sizes, not text lengths, because that is the unit the placeholder
 * passed to `textBetween` also counts an inline leaf in.
 */
function codeRanges(node: ProseNode): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let off = 0;
  node.forEach((child) => {
    const size = child.nodeSize;
    if (child.marks.some((m) => m.type.name === 'code')) out.push([off, off + size]);
    off += size;
  });
  return out;
}

/**
 * Every footnote in the document, in order.
 *
 * Offsets inside a text block map to positions one-for-one as long as the
 * block's non-text leaves each count as one character, which is what the
 * `￼` placeholder passed to `textBetween` buys: without it an inline
 * image would shift every note after it in the same paragraph.
 */
export function footnoteRuns(doc: ProseNode): FootnoteRun[] {
  const out: FootnoteRun[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    const text = node.textBetween(0, node.content.size, undefined, '￼');
    const code = codeRanges(node);
    const base = pos + 1;
    for (const f of findFootnotes(text)) {
      if (code.some(([a, b]) => f.start < b && f.end > a)) continue;
      const fact = factRange(text, f.start);
      out.push({
        n: out.length + 1,
        from: base + f.start,
        to: base + f.end,
        factFrom: base + fact.start,
        factTo: base + fact.end,
        note: f.note,
        unsure: f.unsure,
      });
    }
    return false;
  });
  return out;
}

function build(doc: ProseNode, caret: number, editable: boolean): DecorationSet {
  const decos: Decoration[] = [];
  for (const r of footnoteRuns(doc)) {
    const open = editable && caret > r.from && caret < r.to;
    decos.push(
      Decoration.inline(r.from, r.to, {
        class: open ? 'cw-fn cw-fn-open' : 'cw-fn',
        'data-cw-fn': String(r.n),
        'data-cw-fn-note': r.note,
        ...(r.unsure ? { 'data-cw-fn-unsure': '' } : {}),
      }),
    );
    if (r.factTo > r.factFrom) {
      decos.push(
        Decoration.inline(r.factFrom, r.factTo, {
          class: r.unsure ? 'cw-fn-fact cw-fn-fact-unsure' : 'cw-fn-fact',
          'data-cw-fn-for': String(r.n),
        }),
      );
    }
  }
  return DecorationSet.create(doc, decos);
}

export const FootnoteDecorations = Extension.create({
  name: 'footnoteDecorations',
  addProseMirrorPlugins() {
    const editable = () => this.editor.isEditable;
    const derive = (state: { doc: ProseNode; selection: { from: number } }): FootnoteDecoState => ({
      set: build(state.doc, state.selection.from, editable()),
      editable: editable(),
    });
    return [
      new Plugin<FootnoteDecoState>({
        key: footnoteDecorationsKey,
        state: {
          init: (_config, state) => derive(state),
          // Re-derived whenever the text or the caret moves, or the doc stops
          // being editable. All three matter: the text decides where the
          // notes are, the caret decides whether the one it is inside shows
          // its raw characters, and a read-only doc reveals nothing at all.
          apply: (tr, value, oldState, newState) =>
            tr.docChanged ||
            !oldState.selection.eq(newState.selection) ||
            value.editable !== editable()
              ? derive(newState)
              : value,
        },
        props: {
          /**
           * `setEditable` reaches the view through `updateState`, NOT through
           * a transaction, so `apply` above never runs for it and the stored
           * set can outlive the editability it was built for — leaving the
           * raw `^[…]` characters of the note the caret was in exposed to a
           * reader who can no longer edit them. Rebuilding here closes that
           * window; the stored set catches up on the next transaction.
           */
          decorations: (state) => {
            const value = footnoteDecorationsKey.getState(state);
            if (!value) return null;
            return value.editable === editable() ? value.set : derive(state).set;
          },
        },
      }),
    ];
  },
});
