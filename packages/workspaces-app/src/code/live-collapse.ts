import { getChunks, uncollapseUnchanged } from '@codemirror/merge';
import { type EditorState, type Extension, type Range, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, WidgetType } from '@codemirror/view';

/**
 * Collapsed unchanged stretches for a diff whose target text keeps changing
 * — a LIVE working-tree review, where the agent saves the file while the
 * reviewer reads it.
 *
 * @codemirror/merge's own `collapseUnchanged` builds its ranges once, and
 * when a later change lands inside a collapsed stretch it drops that whole
 * stretch. On a live review that means one agent save in the middle of a
 * long unchanged region expands the region, and the Diff view reads as the
 * whole file. This field instead re-collapses the touched stretch around the
 * new change, with the same margin a first render gives it. Stretches the
 * reviewer expanded by hand are not in the set, so they stay expanded, and
 * stretches no change touched are left exactly as they were.
 */
export function liveCollapseUnchanged(cfg: { margin: number; minSize: number }): Extension {
  return StateField.define<DecorationSet>({
    create: (state) => collapseSpan(state, 1, state.doc.lines, cfg),
    update(deco, tr) {
      let next = deco.map(tr.changes);
      for (const e of tr.effects) {
        if (e.is(uncollapseUnchanged)) {
          const at = e.value;
          next = next.update({ filter: (from) => from !== at });
        }
      }
      const chunks = getChunks(tr.state)?.chunks;
      if (!next.size || !chunks || chunks === getChunks(tr.startState)?.chunks) return next;
      const touched: Array<{ from: number; to: number }> = [];
      for (const c of chunks) {
        next.between(c.fromB, c.toB, (from, to) => {
          if (!touched.some((t) => t.from === from)) touched.push({ from, to });
        });
      }
      if (!touched.length) return next;
      const doc = tr.state.doc;
      const rebuilt: Range<Decoration>[] = [];
      for (const t of touched) {
        const span = collapseSpan(
          tr.state,
          doc.lineAt(t.from).number,
          doc.lineAt(t.to).number,
          cfg,
        );
        span.between(0, doc.length, (from, to, value) => {
          rebuilt.push(value.range(from, to));
        });
      }
      return next.update({
        filter: (from) => !touched.some((t) => t.from === from),
        add: rebuilt,
        sort: true,
      });
    },
    provide: (f) => EditorView.decorations.from(f),
  });
}

/**
 * The collapsed ranges for lines `first`..`last`, the way the library builds
 * them for a whole document: each run of unchanged lines at least `minSize`
 * long, less `margin` lines of context beside every change. The span's own
 * ends get no margin — the lines past them are already showing.
 */
function collapseSpan(
  state: EditorState,
  first: number,
  last: number,
  cfg: { margin: number; minSize: number },
): DecorationSet {
  const doc = state.doc;
  const spanFrom = doc.line(first).from;
  const spanTo = doc.line(last).to;
  const chunks = (getChunks(state)?.chunks ?? []).filter(
    (c) => c.fromB <= spanTo && c.toB >= spanFrom,
  );
  const ranges: Range<Decoration>[] = [];
  let prevLine = first;
  for (let i = 0; ; i++) {
    const chunk = i < chunks.length ? chunks[i] : undefined;
    const from = i ? prevLine + cfg.margin : first;
    const to = chunk ? doc.lineAt(chunk.fromB).number - 1 - cfg.margin : last;
    const lines = to - from + 1;
    if (lines >= cfg.minSize) {
      ranges.push(
        Decoration.replace({ widget: new CollapsedLines(lines), block: true }).range(
          doc.line(from).from,
          doc.line(to).to,
        ),
      );
    }
    if (!chunk) break;
    prevLine = doc.lineAt(Math.min(doc.length, chunk.toB)).number;
  }
  return Decoration.set(ranges);
}

/** The "N unchanged lines" bar. Same class and wording as the library's, so
 *  the stylesheet's rules for it hold; a click expands the stretch. */
class CollapsedLines extends WidgetType {
  constructor(readonly lines: number) {
    super();
  }
  override eq(other: CollapsedLines): boolean {
    return this.lines === other.lines;
  }
  toDOM(view: EditorView): HTMLElement {
    const outer = document.createElement('div');
    outer.className = 'cm-collapsedLines';
    outer.textContent = view.state.phrase('$ unchanged lines', this.lines);
    outer.addEventListener('click', (e) => {
      const pos = view.posAtDOM(e.target as Node);
      view.dispatch({ effects: uncollapseUnchanged.of(pos) });
    });
    return outer;
  }
  override ignoreEvent(e: Event): boolean {
    return e instanceof MouseEvent;
  }
  override get estimatedHeight(): number {
    return 27;
  }
}
