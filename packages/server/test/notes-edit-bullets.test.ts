/**
 * The note-taker's prose lines become bullets before a batch is applied
 * (`notes-edit-bullets.ts`). A huddle's notes turned into paragraphs once a
 * `**Question:**` line arrived with no marker.
 */
import { describe, expect, test } from 'bun:test';
import type { prose } from '@claude-workspaces/core';
import { bulletNotesEdits, bulletProseLines } from '../src/notes-edit-bullets.ts';

describe('bulletProseLines', () => {
  test('a question with no marker becomes a bullet', () => {
    expect(bulletProseLines('**Question:** Does Harborlight sign off?')).toEqual({
      markdown: '- **Question:** Does Harborlight sign off?',
      bulleted: 1,
    });
  });

  test('each prose line becomes its own bullet, after a bullet as well', () => {
    expect(bulletProseLines('- The ferry moves\n**Decision:** keep seven').markdown).toBe(
      '- The ferry moves\n- **Decision:** keep seven',
    );
  });

  test('headings, bullets, nesting, quotes, tables, rules and fences are left alone', () => {
    const md = [
      '### Riverbend ferry',
      '',
      '- a point',
      '  continued under it',
      '1. numbered',
      '> quoted',
      '| a | b |',
      '---',
      '```',
      'code line',
      '```',
    ].join('\n');
    expect(bulletProseLines(md)).toEqual({ markdown: md, bulleted: 0 });
  });

  test('the text line of an underlined heading stays a heading', () => {
    const md = ['Riverbend ferry', '---', '', 'Harborlight kiln', '==='].join('\n');
    expect(bulletProseLines(md)).toEqual({ markdown: md, bulleted: 0 });
  });

  test('a fence closes only on its own marker, so code quoting the other one stays code', () => {
    const md = ['~~~', '```js', 'kiln budget line', '~~~', 'After the code'].join('\n');
    expect(bulletProseLines(md).markdown).toBe(
      ['~~~', '```js', 'kiln budget line', '~~~', '- After the code'].join('\n'),
    );
  });

  test('a raw HTML block keeps the text inside it, and prose after the blank line is a note', () => {
    const md = [
      '<div class="ferry">',
      'Riverbend runs at seven',
      '</div>',
      '',
      'The kiln quote is 42k',
    ].join('\n');
    expect(bulletProseLines(md).markdown).toBe(
      [
        '<div class="ferry">',
        'Riverbend runs at seven',
        '</div>',
        '',
        '- The kiln quote is 42k',
      ].join('\n'),
    );
  });

  test('a fence marker four spaces in is code, and does not close the fence', () => {
    const md = ['```', '    ```', 'kiln budget line', '```', 'After the code'].join('\n');
    expect(bulletProseLines(md).markdown).toBe(
      ['```', '    ```', 'kiln budget line', '```', '- After the code'].join('\n'),
    );
  });
});

describe('bulletNotesEdits', () => {
  const outline: prose.OutlineEntry[] = [
    {
      id: 'h',
      kind: 'heading',
      nodeName: 'heading',
      level: 2,
      text: 'Meeting notes',
      author: 'meeting-notes',
    },
    {
      id: 'own-para',
      kind: 'block',
      nodeName: 'paragraph',
      text: 'old note',
      author: 'meeting-notes',
    },
    { id: 'their-para', kind: 'block', nodeName: 'paragraph', text: 'a person wrote this' },
    {
      id: 'own-item',
      kind: 'listItem',
      nodeName: 'listItem',
      text: 'a bullet',
      author: 'meeting-notes',
      depth: 0,
    },
  ];

  test('every insert gets its prose notes bulleted', () => {
    const { edits } = bulletNotesEdits(
      [
        { op: 'insert_under_heading', headingId: 'h', markdown: 'Kiln quote is 42k' },
        { op: 'insert_at_end', markdown: '## Meeting notes\n\nFirst point' },
      ],
      { outline },
    );
    expect(edits).toEqual([
      { op: 'insert_under_heading', headingId: 'h', markdown: '- Kiln quote is 42k' },
      { op: 'insert_at_end', markdown: '## Meeting notes\n\n- First point' },
    ]);
  });

  test("a replace rebullets only the note-taker's own paragraph", () => {
    const { edits, bulleted } = bulletNotesEdits(
      [
        { op: 'replace_block', blockId: 'own-para', markdown: 'old note, fixed' },
        { op: 'replace_block', blockId: 'their-para', markdown: 'a suggestion' },
        { op: 'replace_block', blockId: 'own-item', markdown: 'a bullet, reworded' },
        { op: 'delete_block', blockId: 'own-item' },
      ],
      { outline },
    );
    expect(bulleted).toBe(1);
    expect(edits.map((e) => ('markdown' in e ? e.markdown : e.op))).toEqual([
      '- old note, fixed',
      'a suggestion',
      'a bullet, reworded',
      'delete_block',
    ]);
  });
});
