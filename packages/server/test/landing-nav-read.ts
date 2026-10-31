/**
 * Read Home's bottom bar out of a page the way a browser would, with Bun's
 * HTMLRewriter rather than a pattern over the markup, so attribute order and
 * whitespace do not matter. Used by `landing-nav.test.ts` and
 * `landing-section-nav.test.ts`.
 */

export interface NavEntry {
  /** The fragment the entry links to, without the `#`. */
  id: string;
  label: string;
  /** The entry draws an `<svg>` inside its `.board-nav-icon`. */
  icon: boolean;
}

export interface NavRead {
  /** How many `<nav>` elements the page has, and the class of each. */
  navClasses: string[];
  /** The entries of the nav classed `board-nav`, in order. */
  entries: NavEntry[];
}

export async function readLandingNav(html: string): Promise<NavRead> {
  const navClasses: string[] = [];
  const entries: NavEntry[] = [];
  let inBar = false;
  let current: NavEntry | null = null;
  let inIcon = false;
  let inLabel = false;
  const rewriter = new HTMLRewriter()
    .on('nav', {
      element(el) {
        const cls = el.getAttribute('class') ?? '';
        navClasses.push(cls);
        inBar = cls.split(/\s+/).includes('board-nav');
        el.onEndTag(() => {
          inBar = false;
        });
      },
    })
    .on('a', {
      element(el) {
        if (!inBar || !(el.getAttribute('class') ?? '').split(/\s+/).includes('board-nav-item'))
          return;
        current = { id: (el.getAttribute('href') ?? '').replace(/^#/, ''), label: '', icon: false };
        entries.push(current);
        el.onEndTag(() => {
          current = null;
        });
      },
    })
    .on('span', {
      element(el) {
        if (!current) return;
        const cls = (el.getAttribute('class') ?? '').split(/\s+/);
        if (cls.includes('board-nav-icon')) {
          inIcon = true;
          el.onEndTag(() => {
            inIcon = false;
          });
        } else if (cls.includes('board-nav-label')) {
          inLabel = true;
          el.onEndTag(() => {
            inLabel = false;
          });
        }
      },
      text(t) {
        if (current && inLabel) current.label += t.text;
      },
    })
    .on('svg', {
      element() {
        if (current && inIcon) current.icon = true;
      },
    });
  await rewriter.transform(new Response(html)).text();
  return { navClasses, entries };
}
