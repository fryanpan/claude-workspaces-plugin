/**
 * KaTeX, fetched the first time a doc shows an equation and never before.
 *
 * Not an `import('katex')`: the doc bundle was built with splitting off when
 * this was written, and Bun inlines a dynamic import into the entry when it
 * cannot split, so the library would have ridden in every page load. The
 * bundle splits now; this stays a fixed URL because the fonts and stylesheet
 * sit beside it. `scripts/build.ts` builds it as its own file under `/app/katex/` beside its
 * stylesheet and fonts, and this module asks for that URL by value, which the
 * bundler leaves alone.
 *
 * Every render is TeX that an agent or a collaborator wrote, drawn on the
 * board's own origin, so the options are fixed here and nowhere else:
 * `trust: false` refuses `\href`, `\url`, `\includegraphics` and `\htmlClass`
 * outright (a `javascript:` link cannot be made at all), and
 * `throwOnError: false` turns bad TeX into its own source in a muted span
 * rather than an exception.
 */

/** Where the build puts KaTeX. Tests read it to know what a fetch looks like. */
export const KATEX_BASE = '/app/katex/';

interface KatexOptions {
  displayMode: boolean;
  throwOnError: boolean;
  trust: boolean;
  strict: 'ignore';
  output: 'htmlAndMathml';
  maxExpand: number;
}

export interface KatexApi {
  render(tex: string, el: HTMLElement, opts: KatexOptions): void;
}

let ready: KatexApi | null = null;
let loading: Promise<KatexApi | null> | null = null;

/** The stylesheet and the script, from this server. */
function fetchFromApp(): Promise<KatexApi | null> {
  const css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = `${KATEX_BASE}katex.min.css`;
  document.head.appendChild(css);
  // Built at runtime so the bundler cannot fold it into a literal it might
  // try to resolve and inline.
  const url = new URL(`${KATEX_BASE}katex.js`, location.href).href;
  return (import(url) as Promise<{ default: KatexApi }>).then(
    (m) => m.default,
    () => {
      css.remove();
      return null;
    },
  );
}

let fetchKatex: () => Promise<KatexApi | null> = fetchFromApp;

/**
 * How a test swaps in its own KaTeX, or its own fetch of one, and starts
 * again from nothing fetched. The page never calls it.
 */
export function setKatexForTest(
  api: KatexApi | null,
  fetcher: (() => Promise<KatexApi | null>) | null = null,
): void {
  ready = api;
  loading = api ? Promise.resolve(api) : null;
  fetchKatex = fetcher ?? fetchFromApp;
}

/**
 * KaTeX, fetching it and its stylesheet the first time. Resolves to null when
 * the fetch fails, so a caller leaves the TeX source showing; a later call
 * tries again.
 */
export function loadKatex(): Promise<KatexApi | null> {
  if (loading) return loading;
  const pending = fetchKatex().then((api) => {
    if (api) ready = api;
    else if (loading === pending) loading = null;
    return api;
  });
  loading = pending;
  return pending;
}

function draw(api: KatexApi, el: HTMLElement, tex: string, displayMode: boolean): void {
  el.textContent = '';
  el.classList.remove('cw-math-pending');
  api.render(tex, el, {
    displayMode,
    throwOnError: false,
    trust: false,
    strict: 'ignore',
    output: 'htmlAndMathml',
    maxExpand: 1000,
  });
}

/**
 * Draw `tex` into `el`. Until KaTeX has arrived `el` holds the source in the
 * muted pending style, so the words are on screen from the first paint.
 */
export function renderTex(el: HTMLElement, tex: string, displayMode: boolean): void {
  if (ready) {
    draw(ready, el, tex, displayMode);
    return;
  }
  el.textContent = tex;
  el.classList.add('cw-math-pending');
  void loadKatex().then((api) => {
    // Re-rendered or detached while the fetch was in flight: that render won.
    if (!api || el.textContent !== tex || !el.isConnected) return;
    draw(api, el, tex, displayMode);
  });
}
