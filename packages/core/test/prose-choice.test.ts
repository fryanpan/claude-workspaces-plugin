import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { CHOICE_LANGUAGE, parseChoice, setChoicePick } from '../src/prose-choice.ts';
import {
  getProseFragment,
  parseMarkdownBlocks,
  serializeFragmentToMarkdown,
  serializeKeepingSource,
} from '../src/prose.ts';

const LINE = 'id=lead-riverbend options="yes,maybe,no" picked="maybe"';
const DOC = [
  '# Leads',
  '',
  'Riverbend is the harbour contact.',
  '',
  '```choice',
  LINE,
  '```',
  '',
  'Next lead.',
  '',
].join('\n');

function fragmentOf(md: string): { doc: Y.Doc; fragment: Y.XmlFragment } {
  const doc = new Y.Doc();
  const fragment = getProseFragment(doc);
  fragment.push(parseMarkdownBlocks(md));
  return { doc, fragment };
}

function choiceElement(fragment: Y.XmlFragment): Y.XmlElement {
  const el = (fragment.toArray() as Y.XmlElement[]).find(
    (n) => n.nodeName === 'codeBlock' && n.getAttribute('language') === CHOICE_LANGUAGE,
  );
  if (!el) throw new Error('no choice block');
  return el;
}

describe('choice block text', () => {
  it('reads the id, the options and the pick', () => {
    expect(parseChoice(LINE)).toEqual({
      id: 'lead-riverbend',
      options: ['yes', 'maybe', 'no'],
      picked: 'maybe',
    });
    expect(parseChoice('options=yes,no')).toEqual({ options: ['yes', 'no'] });
  });

  it('reads no choice when there is no option, and ignores a pick that is not one', () => {
    expect(parseChoice('id=x')).toBeNull();
    expect(parseChoice('options=yes,no picked=perhaps')).toEqual({ options: ['yes', 'no'] });
  });

  it('sets, replaces and clears the pick, keeping every other byte', () => {
    const bare = 'id=a options="yes,maybe,no"';
    const set = setChoicePick(bare, 'yes');
    expect(set).toBe('id=a options="yes,maybe,no" picked=yes');
    expect(setChoicePick(set, 'no')).toBe('id=a options="yes,maybe,no" picked=no');
    expect(setChoicePick(set, null)).toBe(bare);
    expect(setChoicePick('picked=no options="yes,no"', null)).toBe('options="yes,no"');
    expect(setChoicePick(LINE, 'no')).toBe('id=lead-riverbend options="yes,maybe,no" picked=no');
    expect(setChoicePick('options="sure,not sure"', 'not sure')).toBe(
      'options="sure,not sure" picked="not sure"',
    );
  });
});

describe('choice block in a doc', () => {
  it('parses to a choice code block and serializes back byte for byte', () => {
    const { fragment } = fragmentOf(DOC);
    const el = choiceElement(fragment);
    expect(el.toArray().map((t) => (t as Y.XmlText).toString())).toEqual([LINE]);
    expect(serializeFragmentToMarkdown(fragment)).toBe(DOC);
    expect(serializeKeepingSource(fragment, DOC)).toBe(DOC);
  });

  it('a pick written into the block text reaches the markdown', () => {
    const { doc, fragment } = fragmentOf(DOC);
    const text = choiceElement(fragment).get(0) as Y.XmlText;
    doc.transact(() => {
      const next = setChoicePick(text.toString(), 'yes');
      text.delete(0, text.length);
      text.insert(0, next);
    });
    const out = serializeKeepingSource(fragment, DOC);
    expect(out).toBe(DOC.replace('picked="maybe"', 'picked=yes'));
    // And the written file parses back to the same pick.
    const reread = choiceElement(fragmentOf(out).fragment).get(0) as Y.XmlText;
    expect(parseChoice(reread.toString())?.picked).toBe('yes');
  });

  it('a doc with no choice block serializes exactly as it did', () => {
    const plain = [
      '# Plan',
      '',
      'Some **bold** and a [link](https://example.com).',
      '',
      '- one',
      '- two',
      '',
      '```ts',
      'const choice = "options=yes,no";',
      '```',
      '',
      '| a   | b   |',
      '| --- | --- |',
      '| 1   | 2   |',
      '',
    ].join('\n');
    const { fragment } = fragmentOf(plain);
    expect(serializeFragmentToMarkdown(fragment)).toBe(plain);
    expect(serializeKeepingSource(fragment, plain)).toBe(plain);
  });
});
