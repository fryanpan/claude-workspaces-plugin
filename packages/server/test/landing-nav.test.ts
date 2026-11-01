/**
 * Home's bottom bar, built directly: which sections it names and the
 * workspace navbar markup each entry uses. The route test
 * (`landing-section-nav.test.ts`) checks who gets which entries through the
 * real page; the browser test checks how it looks and scrolls.
 */
import { describe, expect, it } from 'bun:test';
import { landingSections, renderLandingNav } from '../src/landing-nav.ts';
import { readLandingNav } from './landing-nav-read.ts';

describe('landingSections', () => {
  it('names all four in page order when the page carries Inbox and Coach', () => {
    expect(landingSections({ inbox: true, coach: true }).map((s) => [s.id, s.label])).toEqual([
      ['landing-review', 'Review'],
      ['inbox', 'Inbox'],
      ['landing-boards', 'Projects'],
      ['coach', 'Coach'],
    ]);
  });

  it('leaves out Inbox and Coach when the page does not carry them', () => {
    expect(landingSections({ inbox: false, coach: false }).map((s) => s.label)).toEqual([
      'Review',
      'Projects',
    ]);
    expect(landingSections({ inbox: true, coach: false }).map((s) => s.label)).toEqual([
      'Review',
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
  it('draws each entry as a workspace nav item: an icon, then a label', async () => {
    const html = renderLandingNav(landingSections({ inbox: false, coach: false }));
    const { navClasses, entries } = await readLandingNav(html);
    expect(navClasses).toEqual(['board-nav home-nav']);
    expect(entries).toEqual([
      { id: 'landing-review', label: 'Review', icon: true },
      { id: 'landing-boards', label: 'Projects', icon: true },
    ]);
  });
});

describe('the lead chat dock on Home', () => {
  /** The dock elements in the bar, and the board each names, read by a parser. */
  async function docks(html: string): Promise<Array<string | null>> {
    const found: Array<string | null> = [];
    await new HTMLRewriter()
      .on('nav.home-nav .board-nav-dock', {
        element(el) {
          found.push(el.getAttribute('data-lead-board'));
        },
      })
      .transform(new Response(html))
      .text();
    return found;
  }

  it('names the board whose lead the chat talks to, inside the bar', async () => {
    const html = renderLandingNav(landingSections({ inbox: false, coach: false }), 'w-harbor');
    expect(await docks(html)).toEqual(['w-harbor']);
    // The bar's entries are unchanged by it.
    expect((await readLandingNav(html)).entries.map((e) => e.id)).toEqual([
      'landing-review',
      'landing-boards',
    ]);
  });

  it('draws no dock with no board, and escapes the id it is given', async () => {
    expect(await docks(renderLandingNav(landingSections({ inbox: false, coach: false })))).toEqual(
      [],
    );
    // An id that tries to close the attribute stays inside it: one dock, and
    // no element the id would have opened. (The rewriter hands back the
    // attribute undecoded, so the count is the check.)
    const hostile = renderLandingNav([], 'w"><script>x</script>');
    expect(await docks(hostile)).toHaveLength(1);
    let scripts = 0;
    await new HTMLRewriter()
      .on('script', {
        element() {
          scripts += 1;
        },
      })
      .transform(new Response(hostile))
      .text();
    expect(scripts).toBe(0);
  });
});
