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

export const footnoteDecorationsKey = new PluginKey<DecorationSet>('footnote-decorations');

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
    const base = pos + 1;
    for (const f of findFootnotes(text)) {
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
    return [
      new Plugin<DecorationSet>({
        key: footnoteDecorationsKey,
        state: {
          init: (_config, state) => build(state.doc, state.selection.from, editable()),
          // Re-derived whenever the text or the caret moves. Both matter: the
          // text decides where the notes are, and the caret decides whether
          // the one it is inside shows its raw characters.
          apply: (tr, value, oldState, newState) =>
            tr.docChanged || !oldState.selection.eq(newState.selection)
              ? build(newState.doc, newState.selection.from, editable())
              : value,
        },
        props: {
          decorations: (state) => footnoteDecorationsKey.getState(state),
        },
      }),
    ];
  },
});
