import { describe, expect, it } from 'vitest';
import { UNREADABLE, readOpenTag } from './tag-props.ts';

describe('an mdx opening tag read as literals', () => {
  it('reads strings, braced literals, bare attributes and an unreadable expression', () => {
    const src = '<StreetMap title="Harborlight" zoom={12} rings={[150]} legend src={file} />';
    const tag = readOpenTag(src);
    expect(tag.name).toBe('StreetMap');
    expect(tag.end).toBe(src.length);
    expect(Object.fromEntries(tag.props)).toEqual({
      title: 'Harborlight',
      zoom: 12,
      rings: [150],
      legend: true,
      src: UNREADABLE,
    });
  });

  it('starts at the offset it is given and stops at that tag', () => {
    const block = '<Wrap>\n  <StreetMap src="a.json" />\n</Wrap>';
    const at = block.indexOf('<StreetMap');
    const tag = readOpenTag(block, at);
    expect(tag.name).toBe('StreetMap');
    expect(tag.props.get('src')).toBe('a.json');
    expect(block.slice(tag.end)).toBe('\n</Wrap>');
  });

  it('reads no props from a tag that is never closed, and no name from a fragment', () => {
    expect(readOpenTag('<StreetMap src="a.json"')).toMatchObject({ end: -1, name: 'StreetMap' });
    expect(readOpenTag('<StreetMap src="a.json"').props.size).toBe(0);
    expect(readOpenTag('<>words</>').name).toBe('');
  });
});
