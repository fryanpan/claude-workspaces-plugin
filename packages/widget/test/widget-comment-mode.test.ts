import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { enterFeedbackMode, exitFeedbackMode } from '../src/widget-picker.ts';
import type { FeedbackWidgetEl } from '../src/widget.ts';

/**
 * COMMENT MODE — the four behaviours settled on round 3 of the mock.
 *
 * 1. No "Done" above Post. While a draft is open the control beside Post is
 *    CANCEL, which throws the draft away and leaves you IN the mode. Leaving
 *    the mode is a separate control that never sits next to Post.
 * 2. The mode survives a post, at every width.
 * 3. Entering the mode focuses the text input — at tablet width it opens into
 *    a focused composer; at phone width it opens as a prompt and the field
 *    arrives, focused, on the tap.
 * 4. Enter submits. Shift+Enter makes a newline.
 *
 * Each has its negative control beside it, because three of the four are
 * "X still holds afterwards" and an assertion of that shape passes on a
 * widget that can never leave the state at all.
 *
 * Widths are set rather than assumed: happy-dom's default is 1024, which is
 * the PHONE face here, so a test that set nothing would exercise one of the
 * two faces twice and neither on purpose.
 */

const TABLET = 1180;
const PHONE = 430;

function setWidth(px: number): void {
  const hd = (window as unknown as { happyDOM?: { setViewport(v: { width: number }): void } })
    .happyDOM;
  if (hd?.setViewport) hd.setViewport({ width: px });
  else Object.defineProperty(window, 'innerWidth', { value: px, configurable: true });
}

interface Mounted {
  el: FeedbackWidgetEl;
  posts: Array<Record<string, unknown>>;
}

async function mount(width: number): Promise<Mounted> {
  setWidth(width);
  const posts: Array<Record<string, unknown>> = [];
  (globalThis as unknown as { fetch: unknown }).fetch = (async (
    _url: string,
    init?: RequestInit,
  ) => {
    if (init?.method === 'POST') posts.push(JSON.parse(String(init.body ?? '{}')));
    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  class FakeWS {
    static OPEN = 1;
    readyState = 1;
    binaryType = 'arraybuffer';
    addEventListener(): void {}
    removeEventListener(): void {}
    send(): void {}
    close(): void {}
  }
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWS;
  const mod = await import('../src/widget.ts');
  const el = mod.FeedbackWidget.init({
    workspaceId: 'w-1',
    docId: `d-mode-${width}`,
    user: 'jordan',
  });
  return { el, posts };
}

const composer = (el: FeedbackWidgetEl): HTMLElement | null =>
  el.shadow.querySelector('.composer') as HTMLElement | null;
const field = (el: FeedbackWidgetEl): HTMLTextAreaElement | null =>
  el.shadow.querySelector('.composer textarea') as HTMLTextAreaElement | null;

/** Tap the page the way the armed picker sees a tap. */
function tapPage(el: FeedbackWidgetEl): void {
  const target = document.getElementById('hello') as HTMLElement;
  (
    document as unknown as { elementFromPoint: (x: number, y: number) => Element }
  ).elementFromPoint = () => target;
  window.dispatchEvent(
    new (window as unknown as { PointerEvent: typeof MouseEvent }).PointerEvent('pointerup', {
      clientX: 40,
      clientY: 40,
      bubbles: true,
      cancelable: true,
    }) as PointerEvent,
  );
  void el;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

describe('comment mode', () => {
  beforeEach(() => {
    document.body.innerHTML = '<main><button id="hello">Hello</button></main>';
  });
  afterEach(() => {
    document.querySelectorAll('claude-feedback-widget').forEach((el) => el.remove());
    document.querySelectorAll('.cfw-overlay, #cfw-light-styles').forEach((el) => el.remove());
  });

  describe('3. entering the mode gives you somewhere to type', () => {
    it('at tablet width, opens into a composer whose field already has focus', async () => {
      const { el } = await mount(TABLET);
      expect(composer(el), 'nothing is composing before the mode is entered').toBeNull();
      enterFeedbackMode(el);
      const ta = field(el);
      expect(ta, 'the mode should rest in a composer').toBeTruthy();
      expect(el.shadow.activeElement).toBe(ta);
    });

    it('at phone width, opens as a prompt and the field arrives focused on the tap', async () => {
      // A 300px composer over a 430px page covers the thing being commented
      // on, so the mode rests in the banner instead — and the tap that picks
      // an element is what opens the field.
      const { el } = await mount(PHONE);
      enterFeedbackMode(el);
      expect(composer(el), 'a phone-width mode must not open a composer over the page').toBeNull();
      expect(el.shadow.querySelector('.picker-banner')).toBeTruthy();
      tapPage(el);
      const ta = field(el);
      expect(ta, 'the tap should open the field').toBeTruthy();
      expect(el.shadow.activeElement).toBe(ta);
    });

    it('tapping an element RE-ANCHORS the open draft rather than losing it', async () => {
      // The composer the mode rests in is about the page; pointing at
      // something moves the sentence you were already writing onto it. A
      // draft thrown away by a tap is the one thing that would make the
      // resting composer worse than no composer.
      const { el } = await mount(TABLET);
      enterFeedbackMode(el);
      const ta = field(el) as HTMLTextAreaElement;
      expect(el.shadow.querySelector('.composer-snippet')?.textContent).toBe('About this page');
      ta.value = 'this is the bit I mean';
      tapPage(el);
      expect(field(el)?.value).toBe('this is the bit I mean');
      expect(el.shadow.querySelector('.composer-snippet')?.textContent).toContain('Hello');
    });
  });

  describe('1. the control beside Post is Cancel, and Cancel keeps the mode', () => {
    it('the composer offers Cancel and Post, and no way out of the mode', async () => {
      const { el } = await mount(TABLET);
      enterFeedbackMode(el);
      const actions = Array.from(
        composer(el)?.querySelectorAll('.composer-actions button') ?? [],
      ).map((b) => (b.textContent ?? '').trim());
      expect(actions).toEqual(['Cancel', 'Post']);
      // Leaving the mode lives on the banner, never beside Post: adjacent,
      // the two read as the same button and Done eats the comment.
      expect(actions.some((t) => /done/i.test(t))).toBe(false);
      expect(el.shadow.querySelector('.picker-banner .picker-cancel')?.textContent).toContain(
        'Done',
      );
    });

    it('Cancel throws the draft away and leaves you IN the mode', async () => {
      const { el } = await mount(TABLET);
      enterFeedbackMode(el);
      const ta = field(el) as HTMLTextAreaElement;
      ta.value = 'the sign is hard to read from the sidewalk';
      (composer(el)?.querySelector('.cancel') as HTMLButtonElement).click();
      expect(el.feedbackMode, 'Cancel must NOT leave comment mode').toBe(true);
      // Still resting in a composer, and the discarded sentence is gone from
      // it — a Cancel that carried the draft forward would be a no-op.
      expect(field(el)?.value).toBe('');
    });

    it('CONTROL: the banner IS a way out, so the mode can be left at all', async () => {
      // Without this, "Cancel left you in the mode" would pass on a widget
      // with no exit — which is not the behaviour, it is a trap.
      const { el } = await mount(TABLET);
      enterFeedbackMode(el);
      (el.shadow.querySelector('.picker-cancel') as HTMLButtonElement).click();
      expect(el.feedbackMode).toBe(false);
      expect(el.shadow.querySelector('.picker-banner')).toBeNull();
    });
  });

  describe('2. the mode survives a post, at every width', () => {
    for (const width of [TABLET, PHONE]) {
      it(`at ${width}px`, async () => {
        const { el, posts } = await mount(width);
        enterFeedbackMode(el);
        if (width === PHONE) tapPage(el);
        const ta = field(el) as HTMLTextAreaElement;
        ta.value = 'the price is bigger than the lemon';
        (composer(el)?.querySelector('.submit') as HTMLButtonElement).click();
        await settle();
        expect(posts.map((p) => p.text)).toEqual(['the price is bigger than the lemon']);
        expect(el.feedbackMode, 'posting must not drop you out of the mode').toBe(true);
        // "Still in the mode" is asserted through what the mode DOES, not
        // through the flag alone: at tablet width it rests in a fresh empty
        // composer, and at phone width the banner is still up and the next
        // tap still opens a field. Round 3 lost exactly this at tablet — the
        // next element was untappable until the FAB had been pressed twice.
        if (width === TABLET) {
          expect(field(el)?.value).toBe('');
        } else {
          expect(el.shadow.querySelector('.picker-banner')).toBeTruthy();
          expect(composer(el), 'no composer over a 430px page').toBeNull();
          tapPage(el);
          expect(field(el), 'the next tap still opens a field').toBeTruthy();
          expect(field(el)?.value).toBe('');
        }
        exitFeedbackMode(el);
      });
    }

    it('CONTROL: a REFUSED post keeps the composer and the words', async () => {
      // "Still in the mode" is only meaningful if the post actually happened
      // and the widget can tell a refusal from an acceptance.
      const { el } = await mount(TABLET);
      (globalThis as unknown as { fetch: unknown }).fetch = (async () =>
        new Response('{}', { status: 500 })) as unknown as typeof fetch;
      enterFeedbackMode(el);
      const ta = field(el) as HTMLTextAreaElement;
      ta.value = 'the price is bigger than the lemon';
      (composer(el)?.querySelector('.submit') as HTMLButtonElement).click();
      await settle();
      expect(field(el)?.value).toBe('the price is bigger than the lemon');
      expect(composer(el)?.textContent).toContain('try again');
      expect(el.feedbackMode).toBe(true);
    });
  });

  describe('4. Enter submits, Shift+Enter makes a newline', () => {
    const enter = (ta: HTMLTextAreaElement, shift: boolean): boolean =>
      ta.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          shiftKey: shift,
          bubbles: true,
          cancelable: true,
        }),
      );

    it('Enter posts what is typed', async () => {
      const { el, posts } = await mount(TABLET);
      enterFeedbackMode(el);
      const ta = field(el) as HTMLTextAreaElement;
      ta.value = 'move the jug off the sign';
      const notCancelled = enter(ta, false);
      await settle();
      expect(posts.map((p) => p.text)).toEqual(['move the jug off the sign']);
      // The browser's own newline is suppressed, or the posted line would
      // arrive with a stray one appended.
      expect(notCancelled, 'Enter should be consumed by the composer').toBe(false);
    });

    it('CONTROL: Shift+Enter posts NOTHING and leaves the draft intact', async () => {
      const { el, posts } = await mount(TABLET);
      enterFeedbackMode(el);
      const ta = field(el) as HTMLTextAreaElement;
      ta.value = 'move the jug off the sign';
      const notCancelled = enter(ta, true);
      await settle();
      expect(posts, 'Shift+Enter must not post').toEqual([]);
      expect(field(el)?.value).toBe('move the jug off the sign');
      // Not consumed: the textarea's own newline is what Shift+Enter is for.
      expect(notCancelled).toBe(true);
    });

    it('CONTROL: an IME Enter picks a candidate and posts nothing', async () => {
      const { el, posts } = await mount(TABLET);
      enterFeedbackMode(el);
      const ta = field(el) as HTMLTextAreaElement;
      ta.value = 'nihongo';
      ta.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          cancelable: true,
          isComposing: true,
        } as KeyboardEventInit),
      );
      await settle();
      expect(posts).toEqual([]);
    });
  });
});
