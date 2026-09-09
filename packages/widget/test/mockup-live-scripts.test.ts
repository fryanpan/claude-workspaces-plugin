import vm from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * A mock's own scripts, run again round after round.
 *
 * `swapDocument` revives the round's inline `<script>` elements and inserts
 * them, which re-executes them in the page's ONE global scope. A classic
 * script's top-level `const` / `let` / `class` binds there and the page
 * outlives the swap, so round two used to throw `Identifier 'X' has already
 * been declared` out of `insertBefore`, aborting the swap mid-round (Sentry
 * CLAUDE-WORKSPACES-8).
 *
 * happy-dom cannot show any of this: it evaluates each `<script>` in a scope
 * of its own, so redeclaring is silently fine there and a DOM-only test would
 * pass against the bug. What a browser has is one shared global lexical scope
 * across classic scripts, and `node:vm` has exactly that — a context whose
 * `runInContext` calls share global `const` bindings, global `var`, and Annex
 * B's block-function hoisting.
 *
 * So `browserLikeScripts` below makes happy-dom's `insertBefore` behave like a
 * browser's: inserting an inline classic script RUNS its source, in one vm
 * context that lives as long as the page, and an early error comes back out of
 * `insertBefore` exactly as Chrome reports it. Everything else — the real
 * `swapDocument`, the real revived elements, the real retry — is the module's.
 */

/** The page as the server serves it: the mock, then the widget, then us. */
function paintRoundOne(): void {
  document.head.innerHTML = '<style id="r1">h1{color:red}</style>';
  document.body.innerHTML =
    '<h1 id="hero">Round one</h1>' +
    '<claude-feedback-widget doc-id="d-1" workspace-id="w-1"></claude-feedback-widget>' +
    '<script src="/widget/mockup-live.js" data-cw-live></script>';
  document.body.className = 'round-one';
}

async function importLive() {
  return import('../src/mockup-live.ts');
}

interface Page {
  /** The page's one global scope, as a plain object to read values off. */
  globals: Record<string, unknown>;
  /** Run a source in it, the way an inline `on*=` handler is run. */
  run: (source: string) => unknown;
  restore: () => void;
}

/** Make script insertion execute, and throw, the way a browser's does. */
function browserLikeScripts(): Page {
  const context = vm.createContext({});
  const realInsert = document.body.insertBefore.bind(document.body);
  document.body.insertBefore = ((node: Node, ref: Node | null) => {
    const out = realInsert(node, ref);
    if (node instanceof HTMLScriptElement && !node.hasAttribute('src')) {
      const type = (node.getAttribute('type') ?? '').toLowerCase();
      // A module has its own scope and a data block is not code; neither runs
      // in the page's global scope, so neither is this harness's business.
      if (type === '' || type === 'text/javascript') {
        // The browser leaves the failed element in the document and lets the
        // error out of the insert; taking it back out is the module's job.
        vm.runInContext(node.textContent ?? '', context);
      }
    }
    return out;
  }) as typeof document.body.insertBefore;
  return {
    globals: context as Record<string, unknown>,
    run: (source: string) => vm.runInContext(source, context),
    restore: () => {
      document.body.insertBefore = realInsert as typeof document.body.insertBefore;
    },
  };
}

/** A round that declares the five kinds of top-level binding a mock uses. */
function declaringRound(n: number): string {
  return (
    `<!doctype html><html><body class="round-${n}"><h1 id="hero">Round ${n}</h1>` +
    '<script>' +
    `const LABELS = ['round ${n}'];` +
    'let clicks = 0;' +
    'class Panel { label() { return LABELS[0]; } }' +
    'function currentLabel() { return new Panel().label(); }' +
    `var lastRound = ${n};` +
    'globalThis.onScreen = currentLabel();' +
    '</script></body></html>'
  );
}

describe("a mock's scripts across rounds", () => {
  let page: Page | null = null;

  afterEach(() => {
    page?.restore();
    page = null;
    document.body.innerHTML = '';
    document.head.innerHTML = '';
  });

  it('leaves a round that does not collide in the page scope it was written for', async () => {
    const { swapDocument } = await importLive();
    page = browserLikeScripts();
    paintRoundOne();

    swapDocument(
      '<!doctype html><html><body><h1 id="hero">Round one</h1>' +
        "<script>const SHARED = 'from the first script'; let count = 0;</script>" +
        '<script>globalThis.readBack = SHARED;</script>' +
        '<p id="keeper">Unchanged paragraph</p></body></html>',
    );

    // A later script in the same round reads the earlier one's `const`. Put
    // every script in a block and this is a ReferenceError on a page that
    // works today.
    expect(page.globals.readBack).toBe('from the first script');
    // And an inline `onclick="count++"` names a top-level `let` — a handler is
    // compiled in the global scope, so it can only see a binding still there.
    expect(() => page?.run('count += 1')).not.toThrow();
    expect(page.run('count')).toBe(1);
    expect(document.querySelector('#keeper')).not.toBeNull();
  });

  it('recovers a colliding round instead of losing it, three rounds deep', async () => {
    const { swapDocument } = await importLive();
    page = browserLikeScripts();
    paintRoundOne();

    const ran: string[] = [];
    for (const n of [1, 2, 3]) {
      swapDocument(declaringRound(n));
      ran.push(String(page.globals.onScreen));
    }

    // Every round ran, including the ones whose `const LABELS` met the round
    // before it. Unrecovered, round two throws and the swap aborts.
    expect(ran).toEqual(['round 1', 'round 2', 'round 3']);
    expect(document.querySelector('#hero')?.textContent).toBe('Round 3');
    // What the mock's own markup depends on survives the block: `var` is
    // function-scoped, and Annex B hoists the block's functions to the global,
    // which is what an inline `onclick="currentLabel()"` looks up.
    expect(typeof page.globals.currentLabel).toBe('function');
    expect(page.globals.lastRound).toBe(3);
    expect(page.run('currentLabel()')).toBe('round 3');
  });

  it('leaves a module script, an external script and a data block as written', async () => {
    const { swapDocument } = await importLive();
    paintRoundOne();
    swapDocument(
      '<!doctype html><html><body>' +
        '<script type="module">const M = 1; export {};</script>' +
        '<script src="/mock/app.js"></script>' +
        '<script type="application/json">{"const": 1}</script>' +
        '</body></html>',
    );
    const scripts = [...document.body.querySelectorAll('script')].filter(
      (s) => !/widget\.iife|mockup-live/.test(s.getAttribute('src') ?? ''),
    );
    expect(scripts[0]?.textContent).toBe('const M = 1; export {};');
    expect(scripts[1]?.getAttribute('src')).toBe('/mock/app.js');
    expect(scripts[2]?.textContent).toBe('{"const": 1}');
  });

  it('reports a node that will not insert once and lands the rest of the round', async () => {
    const { swapDocument } = await importLive();
    paintRoundOne();
    const errors: unknown[][] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    const realInsert = document.body.insertBefore.bind(document.body);
    let failed = 0;
    document.body.insertBefore = ((node: Node, ref: Node | null) => {
      if (node instanceof HTMLElement && node.id === 'boom') {
        failed += 1;
        throw new Error('insert refused');
      }
      return realInsert(node, ref);
    }) as typeof document.body.insertBefore;
    try {
      swapDocument(
        '<!doctype html><html><body class="round-boom">' +
          '<h1 id="hero">Round boom</h1><div id="boom">bad</div>' +
          '<p id="keeper">Unchanged paragraph</p></body></html>',
      );
    } finally {
      document.body.insertBefore = realInsert as typeof document.body.insertBefore;
      console.error = realError;
    }

    expect(failed).toBe(1);
    // The swap does not abort — the rest of the round is on screen …
    expect(document.querySelector('#hero')?.textContent).toBe('Round boom');
    expect(document.querySelector('#keeper')).not.toBeNull();
    expect(document.body.className).toBe('round-boom');
    // … and the failure is reported once rather than per node or not at all.
    expect(errors.length).toBe(1);
    expect(String(errors[0]?.[0])).toContain('mockup');
  });
});
