import { describe, expect, it } from 'vitest';
import { assertReadsNoStrippedField, stripUnreadFields } from '../scripts/strip-unread-fields.ts';

/**
 * The widget's build stops its thread reader lifting fields the widget never
 * reads. Two things make that safe, and each is driven here: the cut refuses a
 * reader it cannot find its statements in, and the bundle check refuses a
 * widget that starts reading a field the cut removed.
 */
describe('cutting unread fields out of the widget copy of the thread reader', () => {
  const reader = [
    'function read(value) {',
    '  const out = {};',
    "  if (typeof value.note === 'string') out.note = value.note;",
    "  if (typeof value.kept === 'string') out.kept = value.kept;",
    '  if (Array.isArray(value.log)) {',
    '    for (const row of value.log) {',
    '      out.log.push(row);',
    '    }',
    '  }',
    '  return out;',
    '}',
    '',
  ].join('\n');
  const cut = {
    file: 'core/src/reader.ts',
    lines: ["  if (typeof value.note === 'string') out.note = value.note;\n"],
    blocks: ['  if (Array.isArray(value.log)) {\n'],
  };

  it('drops the statements and the whole block, and leaves the rest alone', () => {
    const out = stripUnreadFields(reader, cut, 'reader.ts');
    expect(out).not.toContain('note');
    expect(out).not.toContain('log');
    // The nested `}` inside the block did not end it early, and nothing after
    // the block went with it.
    expect(out).toBe(
      [
        'function read(value) {',
        '  const out = {};',
        "  if (typeof value.kept === 'string') out.kept = value.kept;",
        '  return out;',
        '}',
        '',
      ].join('\n'),
    );
  });

  it('refuses a reader it cannot find a statement or a block in, naming it', () => {
    const renamed = reader.replace('value.note', 'value.memo');
    expect(() => stripUnreadFields(renamed, cut, 'reader.ts')).toThrow(/value\.note/);
    const reshaped = reader.replace('Array.isArray(value.log)', 'value.log');
    expect(() => stripUnreadFields(reshaped, cut, 'reader.ts')).toThrow(/value\.log/);
    // Control: the same cut over the unrenamed reader does not throw.
    expect(() => stripUnreadFields(reader, cut, 'reader.ts')).not.toThrow();
  });
});

describe('refusing a widget bundle that reads a stripped field', () => {
  const fields = ['summary', 'via'];

  it('refuses a property read, an object key and a quoted key', () => {
    for (const bundle of [
      'let a=t.summary;',
      'let a=t?.summary;',
      'let{summary:a}=t;',
      'x={id:1,via:v}',
      'm.get("via")',
    ]) {
      expect(() => assertReadsNoStrippedField(bundle, 'w.js', fields), bundle).toThrow(
        /w\.js reads/,
      );
    }
  });

  it('lets markup and CSS that only contain the word through', () => {
    const bundle =
      '.vnote summary{list-style:none}.vnote summary::-webkit-details-marker{display:none}' +
      '`<details><summary>Raw words</summary></details>`;let viable=1;obj.viaduct=2;';
    expect(() => assertReadsNoStrippedField(bundle, 'w.js', fields)).not.toThrow();
  });
});
