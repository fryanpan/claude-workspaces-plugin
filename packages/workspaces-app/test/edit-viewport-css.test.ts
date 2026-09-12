import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { wireEditViewport } from '../src/edit-viewport.ts';
import { IPAD, PHONE, attach, installSheets, setViewport, styleOf } from './css-harness.ts';

/**
 * The stylesheet half of "editing on a phone is not broken": the meeting strip
 * yields its grid row while an editor has focus, and a RECORDING strip stays
 * on screen rather than disappearing.
 *
 * WHAT "ON SCREEN" MEANS AT PHONE WIDTH CHANGED on 2026-09-11. The bar under
 * the top bar is gone there — the recording indicator is the blinking dot on
 * the Record button, and nothing else is dedicated to it
 * (meeting-phone-layout-css.test.ts). So every phone reading below is taken on
 * a strip carrying a SENTENCE, which is the one state that still earns the
 * row; otherwise the yield would read as working on a bar that was already
 * gone.
 *
 * Both halves are read off the cascade here rather than out of `styles.css`'s
 * text. The old version searched the ≤720px block for a
 * `body[data-edit-viewport="hidden"] .meeting-strip { display: none }`
 * substring, which could not answer either of the questions that decide the
 * outcome: whether that block MATCHES at 430px, and whether anything later
 * un-does it. The sheet is installed and the strip is built at each viewport,
 * so what is asserted is the display value the browser would use — and the
 * "compact never hides" case is now measured on a real element instead of
 * inferred from a regex that no rule mentions.
 *
 * The yield is also driven end to end: `wireEditViewport` publishes the mode
 * and the strip element is checked for still being mounted and still not
 * `hidden`, which is the actual contract (`hidden` on the strip root already
 * means "no meeting surface is available here" — reusing it would let the
 * strip's own availability logic un-yield mid-edit, and would end a huddle's
 * only surface for the duration of a keystroke).
 *
 * NOT COVERED HERE, deliberately: `#editor`'s bottom padding, which is what
 * gives the LAST line of a document somewhere to scroll to under an open
 * keyboard (`max(160px, var(--kb-bottom, 0px))` — the larger of the resting
 * gap and the keyboard, never their sum). happy-dom does not implement
 * `max()`, and an unsupported function makes it drop the whole declaration, so
 * the computed padding comes back empty whatever the rule says. There is
 * nothing to assert that a deleted rule would not also satisfy. That property
 * is a browser check: measured rects at 430x932 and 1180x820 are in the PR
 * body, and `bun run ui:shot` is how it is re-measured.
 *
 * SHEETS: the review shell links `styles.css` then `doc.css` — the meeting
 * strip is one of the editor-only surfaces in the second, and the tokens and
 * the top bar it sits under are in the first (then `tokens.css`, left out
 * here — the served file is a vendored Open Props subset plus `src/tokens.css`,
 * and the mapping half alone re-points every remapped token at an undefined
 * `var(--gray-N)`).
 */

let cleanup = () => {};
beforeEach(() => {
  cleanup = installSheets('styles.css', 'doc.css');
});
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  document.body.removeAttribute('data-edit-viewport');
});

/** The strip's display at `vp` under a given yield mode, taken on the spot —
 *  happy-dom's computed style is live, so a held declaration re-answers after
 *  a viewport or attribute change. */
function stripDisplay(
  vp: { width: number; height: number },
  mode: string | null,
  opts: { note?: boolean } = {},
): string {
  setViewport(vp);
  if (mode === null) document.body.removeAttribute('data-edit-viewport');
  else document.body.dataset.editViewport = mode;
  const el = attach('meeting-strip');
  // A strip with a sentence in it is the one a phone still shows at all — see
  // the note on the recording case below. Without this, every phone reading
  // here is `none` before the yield has said anything.
  if (opts.note) {
    const line = document.createElement('div');
    line.className = 'meeting-feed-inner meeting-caption-line';
    const note = document.createElement('span');
    note.className = 'meeting-note';
    note.textContent = 'Asking for the microphone…';
    line.append(note);
    el.append(line);
  }
  return styleOf(el).display;
}

describe('the voice strip yields while an editor has focus', () => {
  it('hides an idle strip only under the phone breakpoint', () => {
    // Measured on a strip carrying a sentence, because that is the only strip
    // a phone shows at all since 2026-09-11 — otherwise the yield would read
    // as working on a bar that was already gone.
    expect(stripDisplay(PHONE, 'hidden', { note: true })).toBe('none');
    expect(stripDisplay(PHONE, null, { note: true })).toBe('flex');
    // Above the breakpoint the same attribute buys nothing: the complaint is a
    // phone complaint and the iPad pays for its 36px bar once.
    expect(stripDisplay(IPAD, 'hidden')).toBe('flex');
  });

  it('keeps a RECORDING strip on screen whole — above the phone tier', () => {
    // `stripYield` publishes `compact` for a live strip, and no rule consumes
    // it: a live mic with no indicator is not a thing to ship. Only `hidden` —
    // the idle strip's yield — may reach `display: none`.
    expect(stripDisplay(IPAD, 'compact')).toBe('flex');
    expect(stripDisplay(PHONE, 'compact', { note: true })).toBe('flex');
    // Positive control, in the mode that DOES hide, so the reads above are
    // discriminating rather than an empty stylesheet.
    expect(stripDisplay(PHONE, 'hidden', { note: true })).toBe('none');
  });

  it('on a phone the recording indicator is the button’s dot, so the bar itself goes', () => {
    // Bryan, 2026-09-11, recording from his phone: "no white status bar under
    // the recording bar; the recording indicator blinks in the top right and
    // nothing else is dedicated to it". A strip with only words to show gives
    // up its row at this width in EVERY yield mode — the invariant the case
    // above protects is met by the blinking dot on the Record button, which
    // meeting-phone-layout-css.test.ts owns.
    for (const mode of ['compact', 'hidden', null]) {
      expect(stripDisplay(PHONE, mode)).toBe('none');
    }
    // And not because the sheet reaches nothing: the same strip at iPad width
    // is the 36px row it always was.
    expect(stripDisplay(IPAD, 'compact')).toBe('flex');
  });

  it('yields in layout only — never by unmounting the strip or setting [hidden]', () => {
    // Driven through the real wiring rather than grepping `edit-viewport.ts`:
    // put a phone-width editor under a keyboard, focus it, and ask what the
    // strip looks like afterwards.
    setViewport(PHONE);
    const editor = attach('', { attrs: { id: 'editor' } });
    const prose = attach('', { parent: editor });
    // happy-dom does not derive isContentEditable from the attribute.
    Object.defineProperty(prose, 'isContentEditable', { value: true });
    prose.tabIndex = 0;
    const strip = attach('meeting-strip');
    // With a sentence in it, so `display: none` below is the YIELD's doing and
    // not the phone tier's own rule (see the case above).
    const noteLine = document.createElement('div');
    noteLine.className = 'meeting-feed-inner meeting-caption-line';
    const note = document.createElement('span');
    note.className = 'meeting-note';
    note.textContent = 'Asking for the microphone…';
    noteLine.append(note);
    strip.append(noteLine);
    // Something is covering the bottom of the window — `keyboardInset` reads
    // the difference between the layout and the visual viewport.
    Object.defineProperty(window, 'visualViewport', {
      value: {
        height: window.innerHeight - 300,
        offsetTop: 0,
        addEventListener() {},
        removeEventListener() {},
      },
      configurable: true,
    });
    const off: Array<() => void> = [];
    const api = wireEditViewport({
      roots: () => [editor],
      scroller: () => editor,
      strip: () => strip,
      caretRect: () => ({ top: 10, bottom: 30 }),
      listen: (t, type, h, o) => {
        t.addEventListener(type, h, o);
        off.push(() => t.removeEventListener(type, h, o));
      },
      onCleanup: (fn) => off.push(fn),
    });
    prose.focus();
    api.sync();

    // The yield happened…
    expect(document.body.dataset.editViewport).toBe('hidden');
    expect(styleOf(strip).display).toBe('none');
    // …and it happened in the stylesheet ONLY. The element is still mounted,
    // its state machine and socket untouched, and the attribute that means
    // "no meeting surface here" is still the strip's own to set.
    expect(strip.isConnected).toBe(true);
    expect(strip.hidden).toBe(false);

    for (let i = off.length - 1; i >= 0; i--) off[i]?.();
  });
});
