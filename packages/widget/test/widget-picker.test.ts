import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * The picker's outline is a SELECTION, not a stack: at most one element on
 * the page wears it, and nothing wears it once the comment is posted or
 * cancelled.
 *
 * The bug this pins: `highlight()` re-read `style.outline` on every
 * pointermove, so the second move over the same element saved the picker's
 * own colour as that element's "previous" outline. Restoring then painted
 * the highlight back on — permanently, and on every element the pointer had
 * crossed. The saved value also rode into the thread anchor, because an
 * element fingerprint captures every `data-*` attribute.
 */

async function importWidget() {
  (globalThis as unknown as { fetch: unknown }).fetch = (async () =>
    new Response(JSON.stringify({ ok: true }), {
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
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
  return import('../src/widget.ts');
}

/** Poll rather than sleep: the post resolves on a microtask chain whose
 *  length is not ours to predict. */
async function waitFor(what: string, cond: () => boolean): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** What a reader would see: the outline the browser resolved for the
 *  element, not the property the widget happened to write. */
function outlineOf(el: HTMLElement): string {
  return getComputedStyle(el).outline;
}

const move = (x: number) =>
  window.dispatchEvent(
    new PointerEvent('pointermove', { clientX: x, clientY: 10, pointerType: 'mouse' }),
  );
const tap = (x: number) =>
  window.dispatchEvent(
    new PointerEvent('pointerup', { clientX: x, clientY: 10, cancelable: true }),
  );

describe('picker highlight', () => {
  let alpha: HTMLElement;
  let beta: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML =
      '<main><button id="alpha">Alpha</button><button id="beta">Beta</button></main>';
    document.head.querySelectorAll('style').forEach((s) => s.remove());
    alpha = document.getElementById('alpha') as HTMLElement;
    beta = document.getElementById('beta') as HTMLElement;
  });

  afterEach(() => {
    document.querySelectorAll('claude-feedback-widget').forEach((el) => el.remove());
    document.querySelectorAll('.cfw-overlay, #cfw-light-styles').forEach((el) => el.remove());
  });

  it('outlines only the tapped element, and leaves nothing behind on post', async () => {
    const mod = await importWidget();
    const el = mod.FeedbackWidget.init({ workspaceId: 'w-1', docId: 't-hl', user: 'bryan' });
    const root = el.shadowRoot as ShadowRoot;
    (root.querySelector('.fab') as HTMLButtonElement).click();

    // Hover Alpha, twice — a pointer crossing one element fires many moves.
    document.elementFromPoint = () => alpha;
    move(10);
    const hovered = outlineOf(alpha);
    expect(hovered, 'hovering paints no outline at all').not.toBe('');
    move(11);
    tap(10);
    expect(root.querySelector('.composer'), 'no composer for the tapped element').toBeTruthy();

    // Site 1 — the tapped element is the one that is outlined.
    expect(outlineOf(alpha)).toBe(hovered);
    expect(outlineOf(beta)).toBe('');
    // Site 2 — the widget's bookkeeping never lands on the page, so it
    // cannot ride into the anchor fingerprint (which reads every data-*).
    expect(alpha.getAttribute('data-cfw-prev-outline')).toBeNull();

    // Tap Beta. Alpha must go back to bare.
    document.elementFromPoint = () => beta;
    move(50);
    move(51);
    tap(50);
    // Site 3 — one highlight at a time.
    expect(outlineOf(beta)).toBe(hovered);
    expect(outlineOf(alpha), 'the earlier tap is still outlined').toBe('');

    // Post it. Site 4 — nothing outlined once the comment is gone.
    const composer = root.querySelector('.composer') as HTMLElement;
    (composer.querySelector('textarea') as HTMLTextAreaElement).value = 'Beta reads as disabled.';
    (composer.querySelector('.submit') as HTMLButtonElement).click();
    await waitFor('the composer to close', () => root.querySelector('.composer') === null);
    expect(outlineOf(beta)).toBe('');
    expect(outlineOf(alpha)).toBe('');
  });

  it('cancelling clears the outline, and gives the page back the one it had', async () => {
    const mod = await importWidget();
    // The host page's own outline on the element we are about to comment on.
    beta.style.outline = '3px dotted rgb(255, 0, 0)';
    const authored = outlineOf(beta);
    const el = mod.FeedbackWidget.init({ workspaceId: 'w-1', docId: 't-hl2', user: 'bryan' });
    const root = el.shadowRoot as ShadowRoot;
    (root.querySelector('.fab') as HTMLButtonElement).click();

    document.elementFromPoint = () => beta;
    move(50);
    move(51);
    tap(50);
    expect(outlineOf(beta), 'the picker never overrode the page outline').not.toBe(authored);

    const composer = root.querySelector('.composer') as HTMLElement;
    (composer.querySelector('.cancel') as HTMLButtonElement).click();
    // Site 5 — cancel restores the page's outline, not the picker's.
    expect(outlineOf(beta)).toBe(authored);
    expect(beta.getAttribute('data-cfw-prev-outline')).toBeNull();
  });

  it('leaving feedback mode leaves no outline behind', async () => {
    const mod = await importWidget();
    const el = mod.FeedbackWidget.init({ workspaceId: 'w-1', docId: 't-hl3', user: 'bryan' });
    const root = el.shadowRoot as ShadowRoot;
    (root.querySelector('.fab') as HTMLButtonElement).click();
    document.elementFromPoint = () => alpha;
    move(10);
    move(11);
    tap(10);
    // Escape once closes the composer, twice leaves the mode.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    // Site 6 — dismissing the composer takes the outline with it.
    expect(outlineOf(alpha)).toBe('');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.body.classList.contains('cfw-feedback-mode')).toBe(false);
    expect(outlineOf(alpha)).toBe('');
  });
  /**
   * Two widgets on one page is a real configuration — a mockup embedding a
   * second board's widget alongside its own. The highlight is one per page,
   * but taking it away is not everyone's to do: a widget that closes its
   * composer must not strip the outline from the element ANOTHER widget is
   * still composing about.
   */
  it('a widget clears only the outline it owns', async () => {
    await importWidget();
    // Declarative embeds rather than `init`, which is a per-page singleton.
    const embed = (docId: string) => {
      const host = document.createElement('claude-feedback-widget');
      host.setAttribute('doc-id', docId);
      host.setAttribute('workspace-id', 'w-1');
      document.body.appendChild(host);
      return host.shadowRoot as ShadowRoot;
    };
    const rootOne = embed('t-own-1');
    const rootTwo = embed('t-own-2');

    // The first widget takes Alpha.
    (rootOne.querySelector('.fab') as HTMLButtonElement).click();
    document.elementFromPoint = () => alpha;
    move(10);
    tap(10);
    const hovered = outlineOf(alpha);
    expect(hovered).not.toBe('');
    expect(rootOne.querySelector('.composer')).toBeTruthy();
    expect(rootTwo.querySelector('.composer'), 'the unarmed widget composed too').toBeNull();

    // The second widget takes Beta, so the page's one outline moves to it.
    // (Both are armed now, so the tap reaches both — that is the situation
    // this test is about.)
    (rootTwo.querySelector('.fab') as HTMLButtonElement).click();
    document.elementFromPoint = () => beta;
    tap(50);
    expect(rootTwo.querySelector('.composer'), 'the second widget composed nothing').toBeTruthy();
    expect(outlineOf(beta)).toBe(hovered);
    expect(outlineOf(alpha)).toBe('');

    // Site 7 — the first widget backing out leaves the second one's
    // selection alone: its composer is still open about Beta.
    (rootOne.querySelector('.composer .cancel') as HTMLButtonElement).click();
    expect(rootOne.querySelector('.composer')).toBeNull();
    expect(rootTwo.querySelector('.composer')).toBeTruthy();
    expect(outlineOf(beta), 'the other widget stripped the outline').toBe(hovered);

    // Site 8 — nor does the first widget leaving feedback mode.
    (rootOne.querySelector('.fab') as HTMLButtonElement).click();
    expect(rootOne.querySelector('.fab')?.getAttribute('aria-pressed')).toBe('false');
    expect(outlineOf(beta)).toBe(hovered);

    // Positive control: the widget that DOES own the outline still clears it.
    (rootTwo.querySelector('.composer .cancel') as HTMLButtonElement).click();
    expect(outlineOf(beta)).toBe('');
  });
});
