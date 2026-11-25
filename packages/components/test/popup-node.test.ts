/**
 * A popup and a tooltip as the page gets them: every word a text node, and a
 * card's link kept only when its filled value is an http(s) URL; and a
 * layer's card, tooltip and `clickable` as `readLayers` reads them.
 */
import { describe, expect, it } from 'vitest';
import { popupText, readLayers } from '../src/layers.ts';
import { popupNode, tooltipNode } from '../src/popup-node.ts';

const card = { title: '{name}', link: { href: '{url}' } };
const filled = (props: Record<string, unknown>) =>
  popupNode(document, card, (t) => popupText(t, props));

describe('popupNode', () => {
  it('keeps a filled http(s) link, opening in a new tab', () => {
    const a = filled({ name: 'Riverbend', url: ' https://example.org/riverbend ' }).querySelector(
      'a',
    );
    expect(a?.getAttribute('href')).toBe('https://example.org/riverbend');
    expect(a?.target).toBe('_blank');
    expect(a?.rel).toBe('noopener noreferrer');
  });

  it.each([
    ['empty', ''],
    ['spaced', 'https:// example.org'],
    ['a script', 'javascript:alert(1)'],
    ['markup', '<a href="https://example.org">x</a>'],
    ['a data URL', 'data:text/html,<b>x</b>'],
  ])('drops a link whose filled value is %s, and keeps the rest', (_, url) => {
    const node = filled({ name: 'Saltmarsh', url });
    expect(node.querySelector('a')).toBeNull();
    expect(node.textContent).toBe('Saltmarsh');
  });

  it('draws markup in any field as its characters', () => {
    const node = popupNode(document, {
      title: '<b>Alice</b>',
      lines: ['<img src=x onerror=alert(1)>'],
      link: { href: 'https://example.org', text: '<i>go</i>' },
    });
    expect([...node.querySelectorAll('*')].map((n) => n.tagName)).toEqual(['STRONG', 'P', 'A']);
    expect(node.textContent).toBe('<b>Alice</b><img src=x onerror=alert(1)><i>go</i>');
    expect(tooltipNode(document, '<b>Bob</b>').children).toHaveLength(0);
  });
});

function only<T>(r: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

describe("a layer's popup, tooltip and clickable, as read", () => {
  it('reads a card popup, a tooltip and clickable, and refuses a card link that is not http(s)', () => {
    const [road] = only(
      readLayers([
        {
          type: 'line',
          id: 'roads',
          data: [],
          tooltip: '{name}',
          clickable: true,
          popup: {
            title: '{name}',
            lines: ['{speed} mph'],
            link: { href: 'https://example.org/{slug}' },
          },
        },
      ]),
    );
    expect(road).toMatchObject({
      tooltip: '{name}',
      clickable: true,
      popup: {
        title: '{name}',
        lines: ['{speed} mph'],
        link: { href: 'https://example.org/{slug}' },
      },
    });
    // A whole-key link is judged once filled; any other start must be http(s).
    expect(
      readLayers([{ type: 'line', id: 'roads', data: [], popup: { link: { href: '{url}' } } }]).ok,
    ).toBe(true);
    const r = readLayers([
      { type: 'line', id: 'roads', data: [], popup: { link: { href: 'javascript:{x}' } } },
    ]);
    expect(r.ok ? '' : r.error).toContain('link.href must be an http(s) URL');
    expect(only(readLayers([{ type: 'line', data: [], tooltip: 7 }]))[0]).toMatchObject({
      tooltip: '7',
    });
  });
});
