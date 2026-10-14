import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  findAndReplace,
  getProseFragment,
  normalizeMarkdown,
  parseMarkdownBlocks,
  serializeFragmentToMarkdown,
} from '../src/prose.ts';

/**
 * A person types a line break, a second paragraph or a bullet list inside a
 * table cell in the editor. The row is one line of markdown, so that
 * structure has to be written within it and read back out of it — the cell
 * used to be written as its bare text, and an agent editing from that copy
 * wrote the flattening back over what the person typed (2026-10-14).
 */

type Shape = string | [string, ...Shape[]];

/** A block tree as nested arrays: `['paragraph', 'Harborlight', ['hardBreak']]`. */
function shape(node: Y.XmlElement | Y.XmlText): Shape {
  if (node instanceof Y.XmlText) return node.toString();
  return [
    node.nodeName,
    ...node.toArray().map((c) => shape(c as Y.XmlElement | Y.XmlText)),
  ] as Shape;
}

function el(name: string, ...kids: Array<Y.XmlElement | string>): Y.XmlElement {
  const e = new Y.XmlElement(name);
  const nodes = kids.map((k) => (typeof k === 'string' ? new Y.XmlText(k) : k));
  if (nodes.length > 0) e.insert(0, nodes);
  return e;
}
const p = (...kids: Array<Y.XmlElement | string>) => el('paragraph', ...kids);
const br = () => el('hardBreak');
const bullets = (...items: string[]) => el('bulletList', ...items.map((t) => el('listItem', p(t))));

/** A doc holding one table: a header row, then one body row of `cells` and a
 *  last plain cell — the parser reads a table of two columns or more. */
function tableDoc(given: Y.XmlElement[][]): Y.Doc {
  const doc = new Y.Doc();
  const cells = [...given, [p('end')]];
  const header = el('tableRow', ...cells.map((_, i) => el('tableHeader', p(`Col ${i + 1}`))));
  const body = el('tableRow', ...cells.map((blocks) => el('tableCell', ...blocks)));
  getProseFragment(doc).push([el('table', header, body)]);
  return doc;
}

/** The body row's cells after serialize then parse. */
function reparsedCells(doc: Y.Doc): Shape[] {
  const md = serializeFragmentToMarkdown(getProseFragment(doc));
  const back = new Y.Doc();
  getProseFragment(back).push(parseMarkdownBlocks(md));
  return bodyCells(back);
}

const END: Shape = ['tableCell', ['paragraph', 'end']];

function bodyCells(doc: Y.Doc): Shape[] {
  const table = getProseFragment(doc).toArray()[0] as Y.XmlElement;
  const row = table.toArray()[1] as Y.XmlElement;
  return row.toArray().map((c) => shape(c as Y.XmlElement));
}

describe('a table cell keeps its structure through serialize then parse', () => {
  it('a hard break', () => {
    const doc = tableDoc([[p('Harborlight', br(), 'Riverbend')]]);
    expect(serializeFragmentToMarkdown(getProseFragment(doc))).toContain(
      '| Harborlight<br>Riverbend |',
    );
    expect(reparsedCells(doc)).toEqual(bodyCells(doc));
  });

  it('two paragraphs', () => {
    const doc = tableDoc([[p('Harborlight'), p('Saltmarsh')]]);
    expect(serializeFragmentToMarkdown(getProseFragment(doc))).toContain(
      '| Harborlight<br><br>Saltmarsh |',
    );
    expect(reparsedCells(doc)).toEqual(bodyCells(doc));
  });

  it('a bullet list, and a paragraph above it', () => {
    const doc = tableDoc([[p('Stops'), bullets('Harborlight', 'Riverbend')], [p('plain')]]);
    expect(serializeFragmentToMarkdown(getProseFragment(doc))).toContain(
      '| Stops<br><br>- Harborlight<br>- Riverbend |',
    );
    expect(reparsedCells(doc)).toEqual(bodyCells(doc));
  });

  it('an ordered list', () => {
    const list = el('orderedList', el('listItem', p('first')), el('listItem', p('second')));
    const doc = tableDoc([[list]]);
    expect(serializeFragmentToMarkdown(getProseFragment(doc))).toContain(
      '| 1. first<br>2. second |',
    );
    expect(reparsedCells(doc)).toEqual(bodyCells(doc));
  });

  it('a newline typed into a cell is written as a break, never as the end of the row', () => {
    const doc = tableDoc([[p('Harborlight\nRiverbend')]]);
    const md = serializeFragmentToMarkdown(getProseFragment(doc));
    expect(md).toContain('| Harborlight<br>Riverbend |');
    expect(reparsedCells(doc)).toEqual([
      ['tableCell', ['paragraph', 'Harborlight', ['hardBreak'], 'Riverbend']],
      END,
    ]);
  });

  it('a pipe in a formatted cell stays escaped', () => {
    const doc = tableDoc([[p('a | b', br(), 'c')]]);
    expect(serializeFragmentToMarkdown(getProseFragment(doc))).toContain('| a \\| b<br>c |');
    expect(reparsedCells(doc)).toEqual(bodyCells(doc));
  });

  it('the written form is a fixed point, so sync arbitration sees no drift', () => {
    const doc = tableDoc([
      [p('Harborlight', br(), 'Riverbend')],
      [p('Stops'), bullets('Saltmarsh', 'Riverbend')],
    ]);
    const md = serializeFragmentToMarkdown(getProseFragment(doc));
    expect(normalizeMarkdown(md)).toBe(md);
  });

  it('a hand-written <br/> in a cell is read as a break', () => {
    const md = '| A | B |\n| --- | --- |\n| Harborlight<br/>Riverbend | end |\n';
    const doc = new Y.Doc();
    getProseFragment(doc).push(parseMarkdownBlocks(md));
    expect(bodyCells(doc)).toEqual([
      ['tableCell', ['paragraph', 'Harborlight', ['hardBreak'], 'Riverbend']],
      END,
    ]);
  });
});

describe('a plain cell is written exactly as before', () => {
  it('a table of one-paragraph cells serializes byte for byte as it did', () => {
    const md =
      '| Name        | Notes      |\n' +
      '| ----------- | ---------- |\n' +
      '| Harborlight | **bold** x |\n' +
      '| Saltmarsh   | a \\| b     |\n';
    const doc = new Y.Doc();
    getProseFragment(doc).push(parseMarkdownBlocks(md));
    expect(serializeFragmentToMarkdown(getProseFragment(doc))).toBe(md);
  });
});

describe('find_and_replace inside a cell', () => {
  it('a <br> in the replacement becomes a line break, not a literal tag', () => {
    const doc = tableDoc([[p('Harborlight Riverbend')]]);
    const res = findAndReplace(doc, {
      find: 'Harborlight Riverbend',
      replace: 'Harborlight<br>Riverbend',
    });
    expect(res.ok).toBe(true);
    const md = serializeFragmentToMarkdown(getProseFragment(doc));
    expect(md).toContain('| Harborlight<br>Riverbend |');
    expect(getProseFragment(doc).toString()).not.toContain('&lt;br');
    expect(reparsedCells(doc)).toEqual([
      ['tableCell', ['paragraph', 'Harborlight', ['hardBreak'], 'Riverbend']],
      END,
    ]);
  });

  it('outside a cell a <br> stays text', () => {
    const doc = new Y.Doc();
    getProseFragment(doc).push([p('Harborlight Riverbend')]);
    findAndReplace(doc, { find: 'Harborlight Riverbend', replace: 'Harborlight<br>Riverbend' });
    expect(serializeFragmentToMarkdown(getProseFragment(doc))).toBe('Harborlight<br>Riverbend\n');
  });

  it('a row quoted with its <br> breaks matches, and its replacement keeps them', () => {
    const doc = tableDoc([[p('Stops'), bullets('Harborlight', 'Riverbend')], [p('old')]]);
    const res = findAndReplace(doc, {
      find: '| Stops<br><br>- Harborlight<br>- Riverbend | old | end |',
      replace: '| Stops<br><br>- Harborlight<br>- Saltmarsh | new | end |',
    });
    expect(res.ok).toBe(true);
    expect(bodyCells(doc)).toEqual([
      [
        'tableCell',
        ['paragraph', 'Stops'],
        [
          'bulletList',
          ['listItem', ['paragraph', 'Harborlight']],
          ['listItem', ['paragraph', 'Saltmarsh']],
        ],
      ],
      ['tableCell', ['paragraph', 'new']],
      END,
    ]);
  });
});
