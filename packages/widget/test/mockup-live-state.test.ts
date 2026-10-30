import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * What a mock keeps of itself through a round swap (`mockup-live-state.ts`).
 *
 * A reader on an inner screen of a mock landed back on its first screen after
 * every save: the round's scripts start over, and a start-up listener the
 * round adds is never called, because a page that does not reload never fires
 * `DOMContentLoaded` or `load` again. These cases drive the real
 * `swapDocument` with a round whose script restores itself the three
 * documented ways, and read what the page shows afterwards.
 *
 * happy-dom does not run an inserted script, so `runInsertedScripts` runs
 * each inline one as it lands, the way a browser does; the shared-scope
 * behaviour of a browser is `mockup-live-scripts.test.ts`'s.
 */

type Win = Window & Record<string, unknown>;
const win = window as unknown as Win;

/** Round one, as the server serves it, with a tab the reader moved to. */
function paintRoundOne(): void {
  document.head.innerHTML = '';
  document.body.innerHTML =
    '<p id="screen">tab-b</p>' +
    '<claude-feedback-widget doc-id="d-1" workspace-id="w-1"></claude-feedback-widget>' +
    '<script src="/widget/mockup-live.js" data-cw-live></script>';
}

/** Round two: draws its first tab, unless the kept state names another. */
const roundTwo = (script: string) =>
  `<!doctype html><html><head></head><body><p id="screen">tab-a</p><script>${script}</script></body></html>`;

/** Make inserting an inline script run it, synchronously, as a browser does. */
function runInsertedScripts(): () => void {
  const realInsert = document.body.insertBefore.bind(document.body);
  document.body.insertBefore = ((node: Node, ref: Node | null) => {
    const out = realInsert(node, ref);
    if (node instanceof HTMLScriptElement && !node.hasAttribute('src')) {
      new Function(node.textContent ?? '')();
    }
    return out;
  }) as typeof document.body.insertBefore;
  return () => {
    document.body.insertBefore = realInsert as typeof document.body.insertBefore;
  };
}

const screen = () => document.getElementById('screen')?.textContent;

describe('a mock keeping its screen through a round', () => {
  let leaving: ((ev: Event) => void) | null = null;
  let restore: () => void = () => {};

  beforeEach(() => {
    paintRoundOne();
    restore = runInsertedScripts();
    leaving = (ev) => {
      (ev as CustomEvent<{ state: unknown }>).detail.state = { tab: 'tab-b' };
    };
    window.addEventListener('cw-round-leaving', leaving);
  });

  afterEach(() => {
    restore();
    if (leaving) window.removeEventListener('cw-round-leaving', leaving);
    document.body.innerHTML = '';
    win.cwRoundState = undefined;
    window.onload = null;
  });

  it('hands the new round what the old one kept, at its top level', async () => {
    const { swapDocument } = await import('../src/mockup-live.ts');
    swapDocument(
      roundTwo(
        "if (window.cwRoundState) document.getElementById('screen').textContent = window.cwRoundState.tab;",
      ),
    );
    expect(screen()).toBe('tab-b');
  });

  it('calls a DOMContentLoaded start-up the new round adds, once', async () => {
    const { swapDocument } = await import('../src/mockup-live.ts');
    swapDocument(
      roundTwo(
        "window.__starts = (window.__starts || 0) + 1; document.addEventListener('DOMContentLoaded', () => {" +
          ' window.__ran = (window.__ran || 0) + 1;' +
          " document.getElementById('screen').textContent = (window.cwRoundState || {}).tab || 'tab-a'; });",
      ),
    );
    expect(win.__starts).toBe(1);
    expect(win.__ran).toBe(1);
    expect(screen()).toBe('tab-b');
    win.__starts = undefined;
    win.__ran = undefined;
  });

  it("calls a window.onload the round sets, and not the previous round's start-up", async () => {
    const { swapDocument } = await import('../src/mockup-live.ts');
    let oldRoundRan = 0;
    // Round one's start-up, still registered on the same document.
    document.addEventListener('DOMContentLoaded', () => {
      oldRoundRan++;
    });
    swapDocument(
      roundTwo(
        "window.onload = () => { document.getElementById('screen').textContent = window.cwRoundState.tab; };",
      ),
    );
    expect(screen()).toBe('tab-b');
    expect(oldRoundRan).toBe(0);
  });

  it('tells a listener on cw-round-arrived what was kept', async () => {
    const { swapDocument } = await import('../src/mockup-live.ts');
    swapDocument(
      roundTwo(
        "window.addEventListener('cw-round-arrived', (e) => { document.getElementById('screen').textContent = e.detail.state.tab; }, { once: true });",
      ),
    );
    expect(screen()).toBe('tab-b');
  });

  it('keeps the round on screen when the leaving listener throws', async () => {
    const { swapDocument } = await import('../src/mockup-live.ts');
    const boom = () => {
      throw new Error('a mock bug');
    };
    window.addEventListener('cw-round-leaving', boom);
    try {
      swapDocument(roundTwo(''));
    } finally {
      window.removeEventListener('cw-round-leaving', boom);
    }
    expect(screen()).toBe('tab-a');
  });
});
