import vm from 'node:vm';
import {
  insideRecoverableInsert,
  isRecoveredMockCollision,
} from '@claude-workspaces/core/mock-swap-noise';
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
  /** The error events nothing called `preventDefault()` on. */
  unhandled: () => ErrorEvent[];
  restore: () => void;
}

/**
 * How the browser under test reports a script's evaluation error.
 *
 * `throw` is Chrome, which rethrows out of the insert — the shape the Sentry
 * event that opened this ticket has. `event` is WebKit and Firefox, which
 * report only through the global error-reporting mechanism: the insert returns
 * normally and an `error` event fires synchronously during evaluation. Bryan
 * reviews mockups on an iPad, so `event` is the shape his device has.
 */
type Reporting = 'throw' | 'event';

/** Make script insertion execute, and report, the way a browser's does. */
function browserLikeScripts(reporting: Reporting = 'throw'): Page {
  const context = vm.createContext({});
  // Every error event this page raised, so a test can ask what a listener —
  // Sentry's, in production — would have been told.
  const uncaught: ErrorEvent[] = [];
  const realInsert = document.body.insertBefore.bind(document.body);
  document.body.insertBefore = ((node: Node, ref: Node | null) => {
    const out = realInsert(node, ref);
    if (node instanceof HTMLScriptElement && !node.hasAttribute('src')) {
      const type = (node.getAttribute('type') ?? '').toLowerCase();
      // A module has its own scope and a data block is not code; neither runs
      // in the page's global scope, so neither is this harness's business.
      if (type === '' || type === 'text/javascript') {
        // The browser leaves the failed element in the document; taking it
        // back out is the module's job.
        try {
          vm.runInContext(node.textContent ?? '', context);
        } catch (err) {
          if (reporting === 'throw') throw err;
          const ev = new ErrorEvent('error', {
            cancelable: true,
            message: `${(err as Error).name}: ${(err as Error).message}`,
            error: err,
          });
          window.dispatchEvent(ev);
          uncaught.push(ev);
        }
      }
    }
    return out;
  }) as typeof document.body.insertBefore;
  return {
    globals: context as Record<string, unknown>,
    unhandled: () => uncaught.filter((ev) => !ev.defaultPrevented),
    run: (source: string) => vm.runInContext(source, context),
    restore: () => {
      document.body.insertBefore = realInsert as typeof document.body.insertBefore;
    },
  };
}

/**
 * A round that declares the five kinds of top-level binding a mock uses.
 *
 * `prologue` puts a directive in front of them: `"use strict"` makes the
 * script one the swap must NOT retry, because a block's function declarations
 * do not reach the global in strict mode and wrapping one would take the
 * mock's own handlers away.
 */
function declaringRound(n: number, prologue = ''): string {
  return (
    `<!doctype html><html><body class="round-${n}"><h1 id="hero">Round ${n}</h1>` +
    '<script>' +
    prologue +
    `const LABELS = ['round ${n}'];` +
    'let clicks = 0;' +
    'class Panel { label() { return LABELS[0]; } }' +
    'function currentLabel() { return new Panel().label(); }' +
    `var lastRound = ${n};` +
    'globalThis.onScreen = currentLabel();' +
    '</script></body></html>'
  );
}

/** An error event as the page's Sentry handler would have it: the report it
 *  hands `beforeSend`. */
function reportOf(ev: Event): { message: string } {
  return { message: (ev as ErrorEvent).message };
}

/**
 * What a page-level `error` listener — Sentry's, registered in the shell's
 * head long before the widget loads — decides about each error the swap
 * raises. Returns one verdict per event heard, `true` meaning "the product
 * recovered this, do not file it".
 */
function listenLikeSentry(run: () => void): boolean[] {
  const verdicts: boolean[] = [];
  const listener = (ev: Event): void => {
    verdicts.push(isRecoveredMockCollision(reportOf(ev)));
  };
  window.addEventListener('error', listener);
  try {
    run();
  } finally {
    window.removeEventListener('error', listener);
  }
  return verdicts;
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

  it('recovers a round on a browser that reports the collision as an event', async () => {
    const { swapDocument } = await importLive();
    // WebKit's shape, which is what Bryan's iPad has: nothing comes out of the
    // insert, and the only sign is an `error` event fired while the script was
    // being evaluated. Detecting the throw alone leaves this browser with the
    // round-two failure the ticket is about.
    page = browserLikeScripts('event');
    paintRoundOne();

    swapDocument(declaringRound(1));
    swapDocument(declaringRound(2));

    expect(page.globals.onScreen).toBe('round 2');
    expect(document.querySelector('#hero')?.textContent).toBe('Round 2');
    // The round recovered, so the event is marked handled and the browser's
    // own default reporting of it is suppressed. (A page-level listener
    // installed before the swap still HEARS the event; `preventDefault` was
    // never able to unregister anyone.)
    expect(page.unhandled()).toEqual([]);
  });

  it('tells the page-level error listener that a recovered collision is recovered', async () => {
    const { swapDocument } = await importLive();
    page = browserLikeScripts('event');
    paintRoundOne();

    // Sentry cannot be beaten to the event — `window.onerror` keeps the
    // position it was first assigned, and the shell assigns it in `<head>` —
    // so the swap instead raises a flag the handler reads while deciding.
    const verdicts = listenLikeSentry(() => {
      swapDocument(declaringRound(1));
      swapDocument(declaringRound(2));
    });

    expect(page.globals.onScreen).toBe('round 2');
    expect(verdicts).toEqual([true]);
    // And the flag is down again the moment the insert is over: a window left
    // up would silence collisions nothing recovered.
    expect(insideRecoverableInsert()).toBe(false);
  });

  it('still files a collision it will not retry', async () => {
    const { swapDocument } = await importLive();
    page = browserLikeScripts('event');
    paintRoundOne();

    // `"use strict"` is outside the retry, so this round LOSES its script and
    // the reader needs to be told. The negative half of the case above: same
    // collision, same listener, opposite verdict.
    const verdicts = listenLikeSentry(() => {
      swapDocument(declaringRound(1, '"use strict";'));
      swapDocument(declaringRound(2, '"use strict";'));
    });

    expect(page.globals.onScreen).toBe('round 1');
    expect(verdicts).toEqual([false]);
  });

  it('does not re-run a script whose SyntaxError came from its own runtime', async () => {
    const { swapDocument } = await importLive();
    page = browserLikeScripts();
    paintRoundOne();
    const errors: unknown[][] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => errors.push(args);

    try {
      // `JSON.parse` on bad input throws a SyntaxError at RUNTIME — after the
      // line above it has already run. Treating any SyntaxError as a
      // collision retries this script and does its side effect twice.
      swapDocument(
        '<!doctype html><html><body><h1 id="hero">Round side-effect</h1>' +
          '<script>' +
          'globalThis.sent = (globalThis.sent || 0) + 1;' +
          "JSON.parse('{');" +
          '</script>' +
          '<p id="keeper">Unchanged paragraph</p></body></html>',
      );
    } finally {
      console.error = realError;
    }

    expect(page.globals.sent).toBe(1);
    // The round is not retried, so the failure is reported and the rest of it
    // still lands.
    expect(errors.length).toBe(1);
    expect(document.querySelector('#keeper')).not.toBeNull();
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
