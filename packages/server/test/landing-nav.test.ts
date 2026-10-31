/**
 * Home's bottom bar, built directly: which sections it names and the
 * workspace navbar markup each entry uses. The route test
 * (`landing-section-nav.test.ts`) checks who gets which entries through the
 * real page; the browser test checks how it looks and scrolls.
 */
import { describe, expect, it } from 'bun:test';
import { landingSections, renderLandingNav } from '../src/landing-nav.ts';

describe('landingSections', () => {
  it('names all four in page order when the page carries Inbox and Coach', () => {
    expect(landingSections({ inbox: true, coach: true }).map((s) => [s.id, s.label])).toEqual([
      ['landing-review', 'Review items'],
      ['inbox', 'Inbox'],
      ['landing-boards', 'Projects'],
      ['coach', 'Coach'],
    ]);
  });

  it('leaves out Inbox and Coach when the page does not carry them', () => {
    expect(landingSections({ inbox: false, coach: false }).map((s) => s.label)).toEqual([
      'Review items',
      'Projects',
    ]);
    expect(landingSections({ inbox: true, coach: false }).map((s) => s.label)).toEqual([
      'Review items',
      'Inbox',
      'Projects',
    ]);
  });

  it('gives every section its own icon', () => {
    const icons = landingSections({ inbox: true, coach: true }).map((s) => s.icon);
    expect(new Set(icons).size).toBe(4);
    for (const icon of icons) expect(icon).toStartWith('<svg ');
  });
});

describe('renderLandingNav', () => {
  it('draws each entry as a workspace nav item: an icon, then a label', () => {
    const html = renderLandingNav(landingSections({ inbox: false, coach: false }));
    expect(html).toStartWith('<nav class="board-nav home-nav" aria-label="Sections">');
    expect(html).toEndWith('</nav>');
    const items = [
      ...html.matchAll(
        /<a class="board-nav-item" href="(#[^"]+)"><span class="board-nav-icon" aria-hidden="true">(<svg .*?<\/svg>)<\/span><span class="board-nav-label">([^<]+)<\/span><\/a>/g,
      ),
    ].map((m) => [m[1], m[3]]);
    expect(items).toEqual([
      ['#landing-review', 'Review items'],
      ['#landing-boards', 'Projects'],
    ]);
  });
});
