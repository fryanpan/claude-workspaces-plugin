import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * The in-place swap: what a reviewer keeps when a mockup's next round lands
 * under him.
 *
 * The behaviour under test is `swapDocument`, which is the whole of the round
 * change as far as the page is concerned — the SSE frame that triggers it and
 * the fetch that feeds it are transport. What must hold is that the new round
 * is on screen, the reader has not been moved, the widget's own element and
 * everything it is holding are untouched, and a comment's element either
 * resolves against the new DOM or resolves against nothing (which is what puts
 * the thread into the outdated flow).
 */

const ROUND_TWO =
  '<!doctype html><html><head><style id="r2">h1{color:blue}</style></head>' +
  '<body class="round-two"><h1 id="hero">Round two</h1>' +
  '<p id="keeper">Unchanged paragraph</p></body></html>';

/** Let every queued requestAnimationFrame render run out. */
async function settle(): Promise<void> {
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
}

async function importLive() {
  return import('../src/mockup-live.ts');
}

/** The page as the server serves it: the mock, then the widget, then us. */
function paintRoundOne(): void {
  document.head.innerHTML = '<style id="r1">h1{color:red}</style>';
  document.body.innerHTML =
    '<h1 id="hero">Round one</h1>' +
    '<p id="keeper">Unchanged paragraph</p>' +
    '<div id="gone">Only in round one</div>' +
    '<claude-feedback-widget doc-id="d-1" workspace-id="w-1"></claude-feedback-widget>' +
    '<script src="/widget.iife.js"></script>' +
    '<script src="/widget/mockup-live.js" data-cw-live></script>';
  document.body.className = 'round-one';
}

describe('mockup live swap', () => {
  beforeEach(() => {
    paintRoundOne();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    document.head.innerHTML = '';
  });

  it('puts the new round on screen without touching the widget or the scroll', async () => {
    const { swapDocument } = await importLive();
    const widget = document.querySelector('claude-feedback-widget');
    // Something only the live element holds — if the swap recreated it, the
    // comment panel, the open thread and the socket would have gone with it.
    (widget as unknown as { keptState?: string }).keptState = 'panel-open';

    let scrolledTo: [number, number] | null = null;
    window.scrollTo = ((x: number, y: number) => {
      scrolledTo = [x, y];
    }) as typeof window.scrollTo;
    Object.defineProperty(window, 'scrollY', { value: 420, configurable: true });
    Object.defineProperty(window, 'scrollX', { value: 0, configurable: true });

    swapDocument(ROUND_TWO);

    expect(document.querySelector('#hero')?.textContent).toBe('Round two');
    expect(document.querySelector('#gone')).toBeNull();
    expect(document.body.className).toBe('round-two');
    // The same element object, not a replacement that looks like it.
    expect(document.querySelector('claude-feedback-widget')).toBe(widget);
    expect((widget as unknown as { keptState?: string }).keptState).toBe('panel-open');
    expect(scrolledTo).toEqual([0, 420]);
  });

  it('replaces the round stylesheet instead of stacking a second one', async () => {
    const { swapDocument } = await importLive();
    // The script claims the page's stylesheets on start; without that claim
    // round one's rules survive round two and the mock renders as neither.
    for (const el of Array.from(document.head.querySelectorAll('style'))) {
      el.setAttribute('data-cw-mock-style', '');
    }
    swapDocument(ROUND_TWO);
    const styles = Array.from(document.head.querySelectorAll('style')).map((s) => s.id);
    expect(styles).toEqual(['r2']);
  });

  it('leaves a surviving element resolvable and a removed one not', async () => {
    const { swapDocument } = await importLive();
    const { anchors } = await import('@claude-workspaces/core');
    const before = {
      keeper: anchors.Element.createAnchor(document.querySelector('#keeper') as HTMLElement),
      gone: anchors.Element.createAnchor(document.querySelector('#gone') as HTMLElement),
    };

    swapDocument(ROUND_TWO);

    // The paragraph the round kept: the comment on it still points at the page.
    expect(anchors.Element.resolve(before.keeper, { root: document }).ok).toBe(true);
    // The div the round removed: nothing to point at, which is what the
    // widget renders as an outdated comment rather than dropping.
    expect(anchors.Element.resolve(before.gone, { root: document }).ok).toBe(false);
  });
});

/**
 * The version affordance, and the rule about who it may move.
 *
 * Criterion 3 of the ticket is that each round stays a version the reader can
 * flip back to, so the chevrons are not chrome — they are the only way back to
 * the page a comment was written against.
 */
describe('the version control', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('stays away until a second round exists', async () => {
    const { renderControl } = await importLive();
    renderControl({ docId: 'd-1', workspaceId: 'w-1', version: 1, versions: [1] }, () => {});
    expect(document.querySelector('[data-cw-mock-versions]')).toBeNull();
    renderControl({ docId: 'd-1', workspaceId: 'w-1', version: 2, versions: [1, 2] }, () => {});
    expect(document.querySelector('[data-cw-mock-versions]')).not.toBeNull();
  });

  it('sends the reader back a round, and forward to the live address', async () => {
    const { renderControl } = await importLive();
    const asked: (number | null)[] = [];
    const go = (v: number | null) => asked.push(v);
    renderControl({ docId: 'd-1', workspaceId: 'w-1', version: 3, versions: [1, 2, 3] }, go);
    const at3 = [...document.querySelectorAll('[data-cw-mock-versions] button')];
    // On the newest round there is nowhere forward to go.
    expect((at3[1] as HTMLButtonElement).disabled).toBe(true);
    (at3[0] as HTMLButtonElement).click();
    expect(asked).toEqual([2]);

    renderControl({ docId: 'd-1', workspaceId: 'w-1', version: 2, versions: [1, 2, 3] }, go);
    const at2 = [...document.querySelectorAll('[data-cw-mock-versions] button')];
    (at2[1] as HTMLButtonElement).click();
    // Forward to the NEWEST round is the unpinned address, not `?v=3`: a
    // reader who steps back to the end is live again rather than stuck on a
    // number the next round will make stale.
    expect(asked).toEqual([2, null]);
  });

  it('holds the 44px touch floor the rest of the chrome holds', async () => {
    const { renderControl } = await importLive();
    renderControl({ docId: 'd-1', workspaceId: 'w-1', version: 2, versions: [1, 2] }, () => {});
    for (const b of document.querySelectorAll('[data-cw-mock-versions] button')) {
      expect((b as HTMLElement).style.width).toBe('44px');
      expect((b as HTMLElement).style.height).toBe('44px');
    }
  });
});

describe('a round landing while the reader is reading', () => {
  it('swaps the page under a reader who is following the newest round', async () => {
    const { applyUpdateFrame } = await importLive();
    const out = applyUpdateFrame([1], null, JSON.stringify({ version: 2 }));
    expect(out).toEqual({ versions: [1, 2], reload: true });
  });

  it('leaves a reader who stepped back exactly where he put himself', async () => {
    const { applyUpdateFrame } = await importLive();
    // Pinned to round 1 — commenting on it. Round 3 arriving must light the
    // forward chevron and move nothing.
    const out = applyUpdateFrame([1, 2], 1, JSON.stringify({ version: 3 }));
    expect(out).toEqual({ versions: [1, 2, 3], reload: false });
  });

  it('takes the whole round list when the frame carries one', async () => {
    const { applyUpdateFrame } = await importLive();
    // A prune drops old rounds, so the list SHRINKS — appending would leave
    // the control offering a round the server no longer has.
    const out = applyUpdateFrame(
      [1, 2, 3],
      null,
      JSON.stringify({ versions: [{ v: 2 }, { v: 3 }] }),
    );
    expect(out).toEqual({ versions: [2, 3], reload: true });
  });

  it('leaves the page alone on a frame that is not JSON', async () => {
    const { applyUpdateFrame } = await importLive();
    expect(applyUpdateFrame([1], null, 'not json')).toBeNull();
  });
});

/**
 * Criterion 2, end to end: the LIVE widget's own reaction to the swap.
 *
 * The swap test above proves the anchors resolve or do not; this proves the
 * widget notices. Nothing in `mockup-live.ts` tells the widget a round
 * landed — the claim the design rests on is that the widget's existing
 * MutationObserver on `document.body` is enough, and a claim about another
 * module's observer is exactly the kind that is true right up until somebody
 * narrows the observer's scope.
 */
describe('a mockup round and the widget watching it', () => {
  afterEach(() => {
    document.querySelectorAll('claude-feedback-widget').forEach((el) => el.remove());
    document.body.innerHTML = '';
    document.head.innerHTML = '';
  });

  it('re-anchors the thread that survived and outdates the one whose element is gone', async () => {
    (globalThis as unknown as { fetch: unknown }).fetch = (async () =>
      new Response('{}', { headers: { 'content-type': 'application/json' } })) as never;
    class FakeWS {
      static OPEN = 1;
      readyState = 1;
      binaryType = 'arraybuffer';
      addEventListener() {}
      removeEventListener() {}
      send() {}
      close() {}
    }
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWS;

    paintRoundOne();
    const widgetMod = await import('../src/widget.ts');
    const core = await import('@claude-workspaces/core');
    const { swapDocument } = await importLive();

    const el = widgetMod.FeedbackWidget.init({
      workspaceId: 'w-1',
      docId: 'd-mock',
      user: 'bryan',
    });
    const inner = el as unknown as {
      client: { ydoc: import('yjs').Doc } | null;
      renderThreads: () => void;
    };
    const ydoc = inner.client?.ydoc;
    expect(ydoc).toBeTruthy();
    if (!ydoc) return;
    const author = { id: 'known-b', name: 'Bryan', kind: 'known' as const, color: '#2e7dd7' };
    for (const [id, target, text] of [
      ['th-keeper', '#keeper', 'This paragraph reads well'],
      ['th-gone', '#gone', 'This block should go'],
    ] as const) {
      core.createThread(ydoc, {
        threadId: id,
        anchor: core.anchors.Element.createAnchor(
          document.querySelector(target) as HTMLElement,
        ) as never,
        createdBy: author,
        firstComment: { id: `c-${id}`, text },
      });
    }
    inner.renderThreads();
    // Drain every render the thread creation itself queued. Without this the
    // wait after the swap collects THAT render instead, and the test passes
    // with the widget's observer disconnected — which is the whole claim.
    await settle();
    const before = [...el.shadowRoot!.querySelectorAll('.panel-threads .thread')];
    // Positive control: BEFORE the round, both elements are on the page, so
    // neither thread is outdated. Without this the assertion below passes on
    // a widget that renders every thread as orphaned.
    expect(before.length).toBe(2);
    expect(before.filter((r) => r.classList.contains('status-orphan')).length).toBe(0);

    swapDocument(ROUND_TWO);
    // The observer schedules through requestAnimationFrame; wait for it
    // rather than calling renderThreads, so what is under test is the widget
    // NOTICING rather than this test telling it.
    await settle();

    // The pin overlay is a SIBLING of the host element in the light DOM, and
    // the swap used to take it: every surviving thread kept its panel row and
    // lost its pin, which is a failure only the page shows.
    expect(document.querySelectorAll('.cfw-overlay').length).toBe(1);
    expect(document.querySelectorAll('.cfw-pin').length).toBe(1);

    const rows = [...el.shadowRoot!.querySelectorAll('.panel-threads .thread')];
    const orphaned = rows.filter((r) => r.classList.contains('status-orphan'));
    expect(orphaned.length).toBe(1);
    expect(orphaned[0]?.textContent).toContain('This block should go');
    const kept = rows.filter((r) => !r.classList.contains('status-orphan'));
    expect(kept.length).toBe(1);
    expect(kept[0]?.textContent).toContain('This paragraph reads well');
  });
});

/**
 * The three halves, connected: a frame arrives on the stream, the round it
 * names is fetched, and the page becomes it.
 *
 * Each half is asserted on its own above. This is the wiring — the part that
 * can be wrong while every piece is right, and the part a reviewer experiences
 * as "nothing happened when the agent shipped round two".
 */
describe('the live loop', () => {
  let fetched: string[] = [];
  let listeners: Record<string, (ev: { data: string }) => void> = {};
  let streamOpened: string[] = [];

  beforeEach(() => {
    fetched = [];
    listeners = {};
    streamOpened = [];
    class StubStream {
      constructor(url: string) {
        streamOpened.push(url);
      }
      addEventListener(name: string, fn: (ev: { data: string }) => void) {
        listeners[name] = fn;
      }
    }
    (globalThis as unknown as { EventSource: unknown }).EventSource = StubStream;
    (globalThis as unknown as { fetch: unknown }).fetch = async (url: string) => {
      // happy-dom routes the page's own <script src> loads through fetch too;
      // only the mockup's address is this test's subject.
      if (url.includes('/mockups/')) fetched.push(url);
      return { ok: true, text: async () => ROUND_TWO } as unknown as Response;
    };
    paintRoundOne();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    document.head.innerHTML = '';
  });

  it('fetches the round a frame announces and puts it on the page', async () => {
    const { startMockupLive } = await importLive();
    startMockupLive({ docId: 'd-1', workspaceId: 'w-1', version: 1, versions: [1] });
    expect(streamOpened).toEqual(['/workspaces/w-1/docs/d-1/events:stream']);
    // Positive control: before the frame, nothing has been asked for and the
    // page is still round one.
    expect(fetched).toEqual([]);
    expect(document.querySelector('#hero')?.textContent).toBe('Round one');

    listeners['mockup.updated']?.({ data: JSON.stringify({ version: 2 }) });
    await settle();

    // The newest round is fetched WITHOUT `?v=`: that address is the one that
    // keeps updating.
    expect(fetched).toEqual(['/workspaces/w-1/mockups/d-1']);
    expect(document.querySelector('#hero')?.textContent).toBe('Round two');
    // And now that a second round exists, the reader can get back to the one
    // he commented on.
    expect(document.querySelectorAll('[data-cw-mock-versions] button').length).toBe(2);
  });

  it('asks for the pinned round by number when the reader steps back', async () => {
    const { startMockupLive } = await importLive();
    startMockupLive({ docId: 'd-1', workspaceId: 'w-1', version: 3, versions: [1, 2, 3] });
    const back = document.querySelector('[data-cw-mock-versions] button') as HTMLButtonElement;
    back.click();
    await settle();
    expect(fetched).toEqual(['/workspaces/w-1/mockups/d-1?v=2']);

    // A round landing now must NOT move him: he is pinned to round 2.
    listeners['mockup.updated']?.({ data: JSON.stringify({ version: 4 }) });
    await settle();
    expect(fetched).toEqual(['/workspaces/w-1/mockups/d-1?v=2']);
  });

  it('leaves the page alone when the round will not load', async () => {
    (globalThis as unknown as { fetch: unknown }).fetch = async () => ({
      ok: false,
      text: async () => '',
    });
    const { startMockupLive } = await importLive();
    startMockupLive({ docId: 'd-1', workspaceId: 'w-1', version: 1, versions: [1] });
    listeners['mockup.updated']?.({ data: JSON.stringify({ version: 2 }) });
    await settle();
    expect(document.querySelector('#hero')?.textContent).toBe('Round one');
  });
});

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
