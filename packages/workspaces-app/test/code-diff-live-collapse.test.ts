import { getContent } from '@claude-workspaces/core';
import { uncollapseUnchanged } from '@codemirror/merge';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createCodeEditor } from '../src/code/code-editor.ts';

/**
 * A live working-tree diff keeps collapsing its unchanged stretches as the
 * agent saves the file. The library's own collapse dropped a whole stretch
 * when a save landed inside it, so one save in a long file expanded the Diff
 * view into the whole file.
 */

const BASE = `${Array.from({ length: 80 }, (_, i) => `const buoy${i} = ${i};`).join('\n')}\n`;
const lineOf = (text: string, needle: string) => text.indexOf(needle);

const open: Array<() => void> = [];
afterEach(() => {
  for (const close of open.splice(0)) close();
});

/** A diff of BASE against BASE with line 40 changed, editable or not. */
function mount(editable: boolean) {
  const ydoc = new Y.Doc();
  const content = getContent(ydoc);
  content.insert(0, BASE.replace('const buoy40 = 40;', 'const buoy40 = 400;'));
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const surface = createCodeEditor({
    parent,
    ydoc,
    sourceUrl: 'app.js',
    editable,
    diff: { baseText: BASE },
    initialViewMode: 'diff',
  });
  open.push(() => {
    surface.destroy();
    parent.remove();
  });
  const view = EditorView.findFromDOM(parent);
  if (!view) throw new Error('no EditorView mounted');
  const bars = () =>
    [...parent.querySelectorAll('.cm-collapsedLines')].map((b) => b.textContent ?? '');
  /** Change one line the way the server's patch does: only that line. */
  const save = (from: string, to: string) => {
    const at = lineOf(content.toString(), from);
    content.delete(at, from.length);
    content.insert(at, to);
  };
  return { content, view, bars, save };
}

describe('collapsed unchanged lines on a live diff', () => {
  for (const editable of [false, true]) {
    const which = editable ? 'editable' : 'read-only';

    it(`re-collapse around a save that lands inside a collapsed stretch (${which})`, () => {
      const { view, bars, save } = mount(editable);
      // Lines 1-37 and 45-81 collapse around the change on line 41.
      expect(bars()).toEqual(['37 unchanged lines', '37 unchanged lines']);
      save('const buoy70 = 70;', 'const buoy70 = 700;');
      expect(view.state.doc.toString()).toContain('buoy70 = 700');
      // The top stretch is untouched; the bottom one splits around line 71
      // exactly as a first render of the new text would split it.
      expect(bars()).toEqual(['37 unchanged lines', '23 unchanged lines', '7 unchanged lines']);
    });

    it(`leave a stretch the reviewer expanded expanded (${which})`, () => {
      const { view, bars, save } = mount(editable);
      view.dispatch({ effects: uncollapseUnchanged.of(0) });
      expect(bars()).toEqual(['37 unchanged lines']);
      save('const buoy10 = 10;', 'const buoy10 = 100;');
      save('const buoy70 = 70;', 'const buoy70 = 700;');
      expect(bars()).toEqual(['23 unchanged lines', '7 unchanged lines']);
    });
  }
});
