import { describe, expect, it } from 'bun:test';
import * as Y from 'yjs';
import { lineHunks, patchFlatText } from '../src/flat-text-patch.ts';

const lines = (n: number, tag = 'buoy') =>
  Array.from({ length: n }, (_, i) => `const ${tag}${i} = ${i};\n`).join('');

function textOf(s: string): { doc: Y.Doc; content: Y.Text } {
  const doc = new Y.Doc();
  const content = doc.getText('content');
  content.insert(0, s);
  return { doc, content };
}

describe('patchFlatText', () => {
  const cases: Array<[string, string, string]> = [
    ['one line changed', 'a\nb\nc\n', 'a\nB\nc\n'],
    ['two far-apart lines changed', `x\n${lines(40)}y\n`, `X\n${lines(40)}Y\n`],
    ['a line inserted', 'a\nc\n', 'a\nb\nc\n'],
    ['a line removed', 'a\nb\nc\n', 'a\nc\n'],
    ['trailing newline dropped', 'a\nb\n', 'a\nb'],
    ['from empty', '', 'a\nb\n'],
    ['to empty', 'a\nb\n', ''],
    ['no line in common', 'a\nb\n', 'c\nd\ne\n'],
    ['repeated lines', '}\n}\n}\nx\n}\n', '}\nx\n}\n}\n'],
  ];
  for (const [name, before, after] of cases) {
    it(`reaches the new text exactly: ${name}`, () => {
      const { content } = textOf(before);
      patchFlatText(content, after);
      expect(content.toString()).toBe(after);
    });
  }

  it('reaches the new text for 300 seeded random line edits', () => {
    let seed = 7;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const pool = ['a\n', 'b\n', '}\n', '\n', 'tide\n', 'x'];
    for (let round = 0; round < 300; round++) {
      const make = () => Array.from({ length: rand(12) }, () => pool[rand(pool.length)]).join('');
      const before = make();
      const after = make();
      const { content } = textOf(before);
      patchFlatText(content, after);
      expect(content.toString()).toBe(after);
    }
  });

  it('keeps a position on an untouched line where it was', () => {
    const before = `const port = 'riverbend';\n${lines(30)}const tide = 1;\n`;
    const after = `const port = 'harborlight';\n${lines(30)}const tide = 10;\n`;
    const { doc, content } = textOf(before);
    const at = before.indexOf('const buoy15');
    const rel = Y.createRelativePositionFromTypeIndex(content, at);
    patchFlatText(content, after);
    const abs = Y.createAbsolutePositionFromRelativePosition(rel, doc);
    expect(abs?.index).toBe(after.indexOf('const buoy15'));
  });

  it('changes only the lines that differ', () => {
    const before = `x\n${lines(40)}y\n`;
    const hunks = lineHunks(before, `X\n${lines(40)}Y\n`);
    expect(hunks).toEqual([
      { from: 0, deleteLength: 2, insert: 'X\n' },
      { from: before.length - 2, deleteLength: 2, insert: 'Y\n' },
    ]);
  });

  it('emits one update for the whole patch inside a transaction', () => {
    const { doc, content } = textOf('a\nb\nc\n');
    let updates = 0;
    doc.on('update', () => updates++);
    doc.transact(() => patchFlatText(content, 'A\nb\nC\n'), 'file-watch');
    expect(updates).toBe(1);
    expect(content.toString()).toBe('A\nb\nC\n');
  });

  it('does nothing when the text is unchanged', () => {
    const { doc, content } = textOf('a\nb\n');
    let updates = 0;
    doc.on('update', () => updates++);
    patchFlatText(content, 'a\nb\n');
    expect(updates).toBe(0);
  });

  it('still reaches the new text when the middle is too different to diff', () => {
    const before = lines(3000, 'riverbend');
    const after = lines(3000, 'harborlight');
    const { content } = textOf(before);
    patchFlatText(content, after);
    expect(content.toString()).toBe(after);
  });
});
