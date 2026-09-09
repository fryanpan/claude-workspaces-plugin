/**
 * A served mockup, kept live.
 *
 * The page this runs on is somebody's own HTML, served by the workspace with
 * the comment widget added on the way out (`mockup-widget.ts`). This module is
 * the second thing added: it listens for the server's `mockup.updated` frame,
 * fetches the round it names, and swaps the page's content in place — same
 * link, same scroll position, same open comment panel, same threads
 * re-anchoring onto whatever the new DOM turned out to be.
 *
 * Why in place rather than `location.reload()`. A reload throws away the
 * reviewer's scroll, every bit of state the mock's own scripts were holding,
 * and the comment panel he had open — which is precisely the "leave what you
 * are doing and go find it again" that the whole ticket is about. A reload
 * would also race the widget's socket and make every round look like a new
 * visit.
 *
 * Why not part of the widget bundle. The widget is a GUEST on other people's
 * pages — dev servers, staging sites, a page whose own scripts are not ours —
 * and a guest that replaces its host's DOM is a bug waiting for a report. This
 * behaviour only ever makes sense for a mockup the workspace itself serves, so
 * it ships as its own file, loaded only by that one route, and stays off the
 * widget's hard gzipped budget.
 *
 * It talks to the server through exactly two addresses, both of which the
 * reader could already reach: the doc's SSE stream, and the mockup's own URL
 * with a round on it.
 */

interface Config {
  docId: string;
  workspaceId: string;
  /** The round on screen, or null for a mockup with no rounds recorded. */
  version: number | null;
  versions: number[];
}

/** Marks a head node this module owns, so the next swap can replace it. */
const MOCK_STYLE_ATTR = 'data-cw-mock-style';
/** Marks the version control, so the swap never eats its own chrome. */
const CONTROL_ATTR = 'data-cw-mock-versions';

function readConfig(script: HTMLScriptElement | null): Config | null {
  const d = script?.dataset;
  if (!d?.docId || !d.workspaceId) return null;
  const versions = (d.versions ?? '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n >= 1);
  const version = d.version ? Number(d.version) : Number.NaN;
  return {
    docId: d.docId,
    workspaceId: d.workspaceId,
    version: Number.isInteger(version) ? version : null,
    versions,
  };
}

const enc = encodeURIComponent;

/** This mockup's own address, optionally pinned to a round. */
export function mockupUrl(cfg: Pick<Config, 'docId' | 'workspaceId'>, v: number | null): string {
  const base = `/workspaces/${enc(cfg.workspaceId)}/mockups/${enc(cfg.docId)}`;
  return v === null ? base : `${base}?v=${v}`;
}

/** The doc's live event stream. */
export function streamUrl(cfg: Pick<Config, 'docId' | 'workspaceId'>): string {
  return `/workspaces/${enc(cfg.workspaceId)}/docs/${enc(cfg.docId)}/events:stream`;
}

/**
 * Which nodes in the CURRENT body must survive a swap.
 *
 * The widget's host element holds the comment panel and the open thread; the
 * version control is this module's own; and the two script tags are what is
 * running. Everything else on the page is the mock, and the mock is what a
 * round replaces.
 *
 * The widget's chrome is NOT all inside its host element, which is the thing
 * this had wrong. The pin overlay is a sibling `<div>` in the light DOM —
 * deliberately, so a pin can be positioned in page coordinates — and the
 * stylesheet those pins are drawn with is another. Both carry the widget's own
 * `data-feedback-widget` marker (the light-DOM styles carry an id instead),
 * which is the same marker the widget uses to know a node is its own. Keeping
 * the host element alone left `pinLayer` pointing at a detached node, so after
 * a round every surviving thread still listed in the panel and NOT ONE had a
 * pin on the page — caught headless at 1180x820, not by any unit test, because
 * the panel row is right and only the page is wrong.
 */
const WIDGET_OWN_ATTR = 'data-feedback-widget';

function isOurs(node: Node): boolean {
  if (!(node instanceof Element)) return false;
  if (node.tagName === 'CLAUDE-FEEDBACK-WIDGET') return true;
  if (node.hasAttribute(WIDGET_OWN_ATTR)) return true;
  if (node.id === 'cfw-light-styles') return true;
  if (node.hasAttribute(CONTROL_ATTR)) return true;
  if (node.tagName === 'SCRIPT') {
    const src = (node as HTMLScriptElement).getAttribute('src') ?? '';
    if (/widget\.(iife|esm)\.js|mockup-live\.js/.test(src)) return true;
  }
  return false;
}

/** Script types the browser runs as a CLASSIC script, in the global scope. */
const CLASSIC_TYPES = new Set([
  '',
  'text/javascript',
  'application/javascript',
  'text/ecmascript',
  'application/ecmascript',
  'text/jscript',
  'text/livescript',
]);

/**
 * Does this element carry inline source the browser runs in the page's ONE
 * global scope?
 *
 * `src` scripts carry no source of ours to touch. `type="module"` already has
 * a scope per script, which is why a module never had this problem. Any other
 * type — `application/json`, `text/x-template` — is a data block the page
 * reads as text, and rewriting it would corrupt the mock's own data.
 */
function isClassicInline(el: HTMLScriptElement): boolean {
  if (el.hasAttribute('src')) return false;
  const type = (el.getAttribute('type') ?? '').split(';')[0].trim().toLowerCase();
  return CLASSIC_TYPES.has(type);
}

/** True when the source opens with a `"use strict"` directive prologue. */
function isStrictSource(source: string): boolean {
  const head = source.replace(/^(?:\s|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*/, '');
  return /^(['"])use strict\1\s*;?/.test(head);
}

/**
 * The source to give a revived classic script, wrapped so re-running it is
 * clean.
 *
 * A classic script's top-level `const`, `let` and `class` are bindings of the
 * page's global lexical scope, and that scope survives a swap because the page
 * does. So round two's `const METHODS` met round one's and threw
 * `Identifier 'METHODS' has already been declared` — inside `insertBefore`,
 * which aborted the rest of the swap, so the round neither ran nor finished
 * landing (Sentry CLAUDE-WORKSPACES-8). Most mocks declare a top-level
 * `const`, so live reload was broken on round two for almost all of them.
 *
 * Wrapping the source in a block is what makes those three re-runnable: in a
 * block they are block-scoped and go away with the round, while the two things
 * the mock's own markup depends on stay exactly where they were. `var` is
 * still function-scoped, so still global; and a top-level function declaration
 * in a block is still hoisted to the global in sloppy mode (Annex B), which is
 * what an inline `onclick="doThing()"` looks up. So a mock's handlers keep
 * working across rounds.
 *
 * Annex B is the part a `"use strict"` script does not get: under strict mode
 * a function declared in a block stays in the block, so wrapping such a script
 * would take its handlers away. Those are left unwrapped and keep colliding —
 * a strict mock that redeclares is a narrower bug than the one this fixes, and
 * the swap now survives it either way rather than aborting.
 */
export function reviveSource(el: HTMLScriptElement): string {
  const source = el.textContent ?? '';
  if (!isClassicInline(el) || isStrictSource(source)) return source;
  // The newlines matter: a source ending in a `// line comment` would
  // otherwise swallow the closing brace.
  return `{\n${source}\n}`;
}

/**
 * Copy a parsed `<script>` into a live one so it actually runs.
 *
 * `importNode` on a script produces an inert element — the HTML spec marks a
 * parser-created script "already started" and moving it does not restart it.
 * A mockup's own behaviour lives in those scripts, so a swap that dropped them
 * would hand the reviewer a page that looks right and does nothing.
 */
function reviveScript(src: HTMLScriptElement): HTMLScriptElement {
  const out = document.createElement('script');
  for (const a of Array.from(src.attributes)) out.setAttribute(a.name, a.value);
  out.textContent = reviveSource(src);
  return out;
}

/** True for a head node that belongs to the mock rather than to the server. */
function isMockHeadNode(node: Element): boolean {
  if (node.tagName === 'STYLE') return true;
  return node.tagName === 'LINK' && (node.getAttribute('rel') ?? '').toLowerCase() === 'stylesheet';
}

/**
 * Replace the page's content with `html`, keeping the reader where they were.
 *
 * Exported so a test can drive the swap without a server, a stream or a real
 * round: what this function does to the DOM is the whole behaviour the ticket
 * is about, and it is the half that is hard to observe from the outside.
 */
export function swapDocument(html: string): void {
  const x = window.scrollX;
  const y = window.scrollY;
  const next = new DOMParser().parseFromString(html, 'text/html');

  // Head: drop the stylesheets the last round installed, install this one's.
  // Scoped to stylesheets because everything else in the head of a served
  // mockup was put there by the server (the Sentry meta tags and its module),
  // and removing those would take the page's monitoring with each round.
  for (const el of Array.from(document.head.querySelectorAll(`[${MOCK_STYLE_ATTR}]`))) {
    el.remove();
  }
  for (const el of Array.from(next.head.children)) {
    if (!isMockHeadNode(el)) continue;
    const copy = document.importNode(el, true) as Element;
    copy.setAttribute(MOCK_STYLE_ATTR, '');
    document.head.appendChild(copy);
  }

  // Body: everything that is not ours goes; the round's nodes take its place,
  // inserted BEFORE our own chrome so the widget's element stays last in the
  // document exactly as the server writes it.
  const keep = Array.from(document.body.childNodes).filter(isOurs);
  for (const node of Array.from(document.body.childNodes)) {
    if (!keep.includes(node)) node.remove();
  }
  const first = document.body.firstChild;
  // Per node, because one node that will not insert must not cost the reader
  // the rest of the round. A mock's script can still throw for reasons that
  // are the mock's own — its round one left something in a bad state, it
  // reads an API this browser lacks — and inserting a script RUNS it, so the
  // throw comes out of `insertBefore`. One report at the end, not one per
  // node: a round with fifty broken nodes is one broken round.
  const failures: unknown[] = [];
  for (const node of Array.from(next.body.childNodes)) {
    if (isOurs(node)) continue;
    try {
      const copy =
        node instanceof HTMLScriptElement
          ? reviveScript(node)
          : (document.importNode(node, true) as Node);
      document.body.insertBefore(copy, first);
    } catch (err) {
      failures.push(err);
    }
  }
  if (failures.length > 0) {
    console.error(
      `[claude-workspaces] mockup round: ${failures.length} node(s) failed to land`,
      ...failures,
    );
  }
  // Body attributes too — a round that changes a class or a theme on <body>
  // would otherwise render against the previous round's.
  for (const a of Array.from(document.body.attributes)) {
    if (a.name === 'style' || next.body.hasAttribute(a.name)) continue;
    document.body.removeAttribute(a.name);
  }
  for (const a of Array.from(next.body.attributes)) {
    document.body.setAttribute(a.name, a.value);
  }

  // Last, after layout has the new content: a restore before it would be
  // clamped against a page that is momentarily empty and land at the top.
  window.scrollTo(x, y);
}

/**
 * The version affordance: two chevrons, and nothing else.
 *
 * No caption, no chip, no round number spelled out — a reader who can move
 * backwards and forwards through the rounds does not need to be told that is
 * what the arrows do, and the project's rule is affordances over explanatory
 * text. It appears only once a second round exists, so a mockup with one round
 * carries no chrome at all.
 */
export function renderControl(state: Config, go: (v: number | null) => void): void {
  const existing = document.querySelector(`[${CONTROL_ATTR}]`);
  if (state.versions.length < 2) {
    existing?.remove();
    return;
  }
  const idx =
    state.version === null ? state.versions.length - 1 : state.versions.indexOf(state.version);
  const box = (existing as HTMLElement | null) ?? document.createElement('div');
  if (!existing) {
    box.setAttribute(CONTROL_ATTR, '');
    box.style.cssText = [
      'position:fixed',
      'left:16px',
      'bottom:16px',
      'z-index:2147483000',
      'display:flex',
      'gap:2px',
      'padding:2px',
      'border-radius:999px',
      'background:rgba(20,20,22,0.72)',
      'backdrop-filter:blur(6px)',
      'box-shadow:0 2px 8px rgba(0,0,0,0.25)',
      'font:600 17px/1 system-ui,sans-serif',
    ].join(';');
    document.body.appendChild(box);
  }
  box.textContent = '';
  const at = idx < 0 ? state.versions.length - 1 : idx;
  for (const [label, target] of [
    ['‹', state.versions[at - 1]],
    ['›', state.versions[at + 1]],
  ] as const) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.setAttribute('aria-label', label === '‹' ? 'Previous version' : 'Next version');
    const on = target !== undefined;
    b.disabled = !on;
    // 44px, the same touch floor the widget's own chrome holds
    // (`packages/widget/test/tap-targets.test.ts`). Bryan reviews on an iPad,
    // where a 28px chevron is a miss as often as a hit.
    b.style.cssText = [
      'all:unset',
      'width:44px',
      'height:44px',
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'border-radius:999px',
      `color:${on ? '#fff' : 'rgba(255,255,255,0.28)'}`,
      `cursor:${on ? 'pointer' : 'default'}`,
    ].join(';');
    if (on) {
      b.addEventListener('click', () => {
        // The newest round is requested as "no round": that is the address
        // that keeps updating, so a reader who steps forward to the end is
        // live again rather than pinned to a number that will go stale.
        go(target === state.versions[state.versions.length - 1] ? null : target);
      });
    }
    box.appendChild(b);
  }
}

/**
 * What a `mockup.updated` frame does to a reader, decided without touching the
 * DOM or the network.
 *
 * Exported because the rule it holds is the one a reviewer would notice being
 * broken and no swap or fetch could reveal: a reader who has stepped BACK to
 * an earlier round is LEFT WHERE HE PUT HIMSELF. The new round joins the
 * history so the forward chevron lights up, but nothing moves under him —
 * yanking a reader off the round he is part-way through commenting on is the
 * same interruption this whole mechanism exists to remove.
 *
 * `null` for a frame that is not JSON: a malformed frame leaves the page
 * exactly as it is rather than reloading it on a guess.
 */
export function applyUpdateFrame(
  versions: number[],
  pinned: number | null,
  data: string,
): { versions: number[]; reload: boolean } | null {
  let frame: { version?: number; versions?: { v: number }[] };
  try {
    frame = JSON.parse(data);
  } catch {
    return null;
  }
  let next = versions;
  if (Array.isArray(frame.versions)) {
    next = frame.versions.map((r) => r.v).filter((v) => Number.isInteger(v));
  } else if (typeof frame.version === 'number' && !versions.includes(frame.version)) {
    next = [...versions, frame.version];
  }
  return { versions: next, reload: pinned === null };
}

/**
 * Wire a served mockup up to its own stream. Exported so a test can drive the
 * whole loop — frame in, round fetched, page swapped, control redrawn —
 * against a stub stream, which is the only way to see that the three halves
 * are actually connected to each other rather than merely each correct.
 */
export function startMockupLive(cfg: Config): void {
  const state: Config = { ...cfg };
  // Claim the stylesheets this page loaded with. They belong to round N, and
  // the first swap has to be able to take them away — without this the second
  // round renders under two stylesheets at once, which is how a mock ends up
  // looking like neither of its rounds.
  for (const el of Array.from(document.head.children)) {
    if (isMockHeadNode(el)) el.setAttribute(MOCK_STYLE_ATTR, '');
  }
  /** Null means "pinned to nothing" — following the newest round. */
  let pinned: number | null = null;

  const load = (v: number | null): void => {
    void fetch(mockupUrl(state, v), { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.text() : null))
      .then((html) => {
        if (html === null) return;
        pinned = v;
        state.version = v ?? state.versions[state.versions.length - 1] ?? null;
        swapDocument(html);
        renderControl(state, load);
      })
      .catch(() => {
        /* a round that will not load leaves the page exactly as it is */
      });
  };

  renderControl(state, load);

  const es = new EventSource(streamUrl(state));
  es.addEventListener('mockup.updated', (ev) => {
    const next = applyUpdateFrame(state.versions, pinned, (ev as MessageEvent).data as string);
    if (next === null) return;
    state.versions = next.versions;
    if (!next.reload) {
      renderControl(state, load);
      return;
    }
    load(null);
  });
}

// Auto-start from the tag the server wrote. `document.currentScript` is still
// the loading tag at top-level evaluation, which is the only moment it is.
const script = document.currentScript as HTMLScriptElement | null;
const parsed = readConfig(script);
if (parsed) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => startMockupLive(parsed), { once: true });
  } else {
    startMockupLive(parsed);
  }
}
