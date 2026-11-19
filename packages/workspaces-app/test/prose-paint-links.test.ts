import { getProseFragment } from '@claude-workspaces/core/prose';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { renderProse } from '../src/doc/prose-paint.ts';

/**
 * The doc page's first paint is what a reader sees, and can click, before the
 * editor has loaded — seconds on a phone. It used to make a live link of any
 * target but `javascript:`, `data:` and `vbscript:`, so a doc's `file:` or
 * custom-scheme link was clickable until the editor took over. It now draws a
 * link only for http, https and mailto targets and for a target with no
 * scheme (a sibling doc, an anchor); anything else is drawn as plain text.
 */

/** The first paint of one paragraph holding one link to `href`. */
function paintLink(href: string): HTMLElement {
  const ydoc = new Y.Doc();
  const fragment = getProseFragment(ydoc);
  const p = new Y.XmlElement('paragraph');
  const text = new Y.XmlText();
  p.insert(0, [text]);
  fragment.insert(0, [p]);
  text.insert(0, 'the link', { link: { href } });
  return renderProse(fragment, document, '/assets/');
}

describe('first paint links', () => {
  it.each([
    'file:///etc/hosts',
    'FILE:///Users/x/notes.md',
    'ms-settings:privacy',
    'vscode://file/etc/hosts',
    'blob:https://example.com/1234',
    'f\tile:///etc/hosts',
    'javascript:alert(1)',
  ])('draws %s as text, not a live link', (href) => {
    const root = paintLink(href);
    expect(root.querySelector('a')).toBeNull();
    // The words are still on screen.
    expect(root.textContent).toBe('the link');
  });

  it.each([
    'https://example.com/x',
    'http://example.com',
    'mailto:a@example.com',
    'other-doc.md',
    '../notes/plan.md',
  ])('keeps %s a live link, in a new tab', (href) => {
    const a = paintLink(href).querySelector('a');
    expect(a?.getAttribute('href')).toBe(href);
    expect(a?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(a?.getAttribute('target')).toBe('_blank');
  });

  // A page of this app opens in this tab, so the agent chat and voice stay.
  it.each(['#section', '/workspaces/w/docs/d'])('keeps %s a live link, in this tab', (href) => {
    const a = paintLink(href).querySelector('a');
    expect(a?.getAttribute('href')).toBe(href);
    expect(a?.getAttribute('target')).toBeNull();
    expect(a?.getAttribute('rel')).toBeNull();
  });
});

/**
 * On a board's doc page a relative path names a file, and the board's open
 * route finds the doc bound to it — as the editor does once it has loaded.
 * Drawn raw, it resolved against the page's own address and named nothing.
 */
describe('first paint relative links on a doc page', () => {
  it('sends a relative path through the board, in this tab', () => {
    const happy = (window as unknown as { happyDOM: { setURL: (u: string) => void } }).happyDOM;
    happy.setURL('http://localhost:3000/workspaces/w-harbor/docs/guide');
    try {
      const a = paintLink('part-1/riverbend-data.mdx').querySelector('a');
      expect(a?.getAttribute('href')).toBe(
        '/workspaces/w-harbor/open?path=part-1%2Friverbend-data.mdx&from=guide',
      );
      expect(a?.getAttribute('target')).toBeNull();
    } finally {
      happy.setURL('http://localhost:3000/');
    }
  });
});
