import { afterEach, describe, expect, it } from 'vitest';

/** The page as the server serves it: the mock, then the widget, then us. */
function paintRoundOne(): void {
  document.head.innerHTML = '<style id="r1">h1{color:red}</style>';
  document.body.innerHTML =
    '<h1 id="hero">Round one</h1>' +
    '<p id="keeper">Unchanged paragraph</p>' +
    '<claude-feedback-widget doc-id="d-1" workspace-id="w-1"></claude-feedback-widget>' +
    '<script src="/widget.iife.js"></script>' +
    '<script src="/widget/mockup-live.js" data-cw-live></script>';
  document.body.className = 'round-one';
}

async function importLive() {
  return import('../src/mockup-live.ts');
}

/**
 * A mock's own scripts, re-run round after round.
 *
 * `reviveScript` copies each of the round's inline `<script>` elements into a
 * live one so the mock's behaviour actually runs. Every round therefore
 * executes its scripts in the SAME global scope as the round before it, and a
 * classic script's top-level `const` / `let` / `class` lands in that scope's
 * lexical bindings — so round two throws `Identifier 'X' has already been
 * declared`, the insert that was executing it throws mid-swap, and the round
 * neither runs nor finishes landing. Most mocks declare a top-level `const`,
 * so this was live reload broken on round two for almost all of them
 * (Sentry CLAUDE-WORKSPACES-8).
 *
 * happy-dom cannot show it: it evaluates each `<script>` in a scope of its
 * own, so redeclaring is silently fine there and a DOM-only test would pass
 * against the bug. What the browser does have is one shared global lexical
 * scope across classic scripts, and `node:vm` has exactly that — a context
 * whose `runInContext` calls share global `const` bindings, global `var` and
 * Annex B's block-function hoisting. So the DOM half runs in happy-dom (the
 * real `swapDocument`, the real revived elements) and the SOURCES those
 * elements carry are executed round by round in one vm context, which is the
 * semantics the browser applies to them.
 */
function mockRound(n: number): string {
  return (
    `<!doctype html><html><head><style id="r${n}">h1{color:red}</style></head>` +
    `<body class="round-${n}"><h1 id="hero">Round ${n}</h1>` +
    '<script>' +
    `const LABELS = ['round ${n}'];` +
    'let clicks = 0;' +
    'class Panel { label() { return LABELS[0]; } }' +
    'function currentLabel() { clicks += 1; return new Panel().label(); }' +
    `var lastRound = ${n};` +
    'globalThis.onScreen = currentLabel();' +
    '</script>' +
    '<p id="keeper">Unchanged paragraph</p></body></html>'
  );
}

/** The sources of the inline scripts the last swap put on the page, in order. */
function landedScriptSources(): string[] {
  return [...document.body.querySelectorAll('script')]
    .filter((s) => !s.hasAttribute('src'))
    .map((s) => s.textContent ?? '');
}

describe('a mock whose scripts declare things at top level', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    document.head.innerHTML = '';
  });

  it('survives three rounds and runs the third one, keeping functions and var global', async () => {
    const { swapDocument } = await importLive();
    const vm = await import('node:vm');
    // One context for the whole page's life, which is what a browser tab is.
    const page = vm.createContext({});
    const globals = page as Record<string, unknown>;

    paintRoundOne();
    const ran: string[] = [];
    for (const n of [1, 2, 3]) {
      swapDocument(mockRound(n));
      // Executing here, between swaps, is the browser's timing: each round's
      // scripts run as they are inserted, against everything the rounds
      // before them left in the global scope.
      for (const source of landedScriptSources()) vm.runInContext(source, page);
      ran.push(String(globals.onScreen));
    }

    // AC 1: no exception, and round three's script has run.
    expect(ran).toEqual(['round 1', 'round 2', 'round 3']);
    expect(document.querySelector('#hero')?.textContent).toBe('Round 3');

    // AC 2: what an inline `on*=` handler can reach is the GLOBAL scope, so
    // the mock's top-level functions and `var`s must still be there after a
    // swap — the wrapping only moves `const` / `let` / `class` out of it.
    expect(typeof globals.currentLabel).toBe('function');
    expect(globals.lastRound).toBe(3);
    expect((globals.currentLabel as () => string)()).toBe('round 3');
  });

  it('leaves a module script and an external script exactly as the round wrote them', async () => {
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
    // A module has its own scope already, an external script's source is not
    // ours to rewrite, and a JSON data block is not code at all.
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
    // AC 3: the swap does not abort — the rest of the round is on screen …
    expect(document.querySelector('#hero')?.textContent).toBe('Round boom');
    expect(document.querySelector('#keeper')).not.toBeNull();
    expect(document.body.className).toBe('round-boom');
    // … and the failure is reported once rather than per node or not at all.
    expect(errors.length).toBe(1);
    expect(String(errors[0]?.[0])).toContain('mockup');
  });
});
