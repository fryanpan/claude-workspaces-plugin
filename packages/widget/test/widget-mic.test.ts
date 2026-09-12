import { beforeEach, describe, expect, it, vi } from 'vitest';
import { addMic } from '../src/widget-mic.ts';
import type { FeedbackWidgetEl } from '../src/widget.ts';

/**
 * The mic the host hangs on the widget, in the slot the thread list stood in.
 *
 * The owner (2026-09-11): "Replace the feedback history button with a button
 * that initiates voice feedback. On hover, both buttons should clearly
 * indicate that they're feedback buttons for the workspace. Not for this
 * particular project." The widget cannot know whose feedback it is taking, so
 * the words come from the host — and this checks that every one of the three
 * buttons ends up wearing them.
 */

const LABELS = {
  comment: 'Feedback on the app, not this project — click anything',
  voice: 'Voice feedback on the app, not this project — hold to talk',
  history: 'Feedback on the app so far',
  icon: '<svg class="mic-glyph"></svg>',
};

/** The widget's shell, as `renderShell` builds the parts the mic reaches. */
function fakeWidget(): FeedbackWidgetEl {
  const host = document.createElement('div');
  const shadow = host.attachShadow({ mode: 'open' });
  const list = document.createElement('button');
  list.className = 'fab-list';
  list.title = 'Comment threads';
  const fab = document.createElement('button');
  fab.className = 'fab';
  fab.title = 'Give feedback — click anything to comment';
  shadow.append(list, fab);
  document.body.append(host);
  // The host element itself, not an object holding its shadow root: the real
  // `FeedbackWidgetEl` IS the element, and the mic writes the height it
  // measures into that element's own inline style.
  return Object.assign(host, { shadow }) as unknown as FeedbackWidgetEl;
}

describe('the mic a host adds to the widget', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('puts a mic button and a readout in the shadow root', () => {
    const el = fakeWidget();
    const { button, readout } = addMic(el, LABELS);
    expect(button.isConnected).toBe(true);
    expect(button.classList.contains('fab-mic')).toBe(true);
    // `.fab-list` as well, so everything that steps around the widget's own
    // buttons — the comment card, the phone panel — steps around this one.
    expect(button.classList.contains('fab-list')).toBe(true);
    expect(button.querySelector('.mic-glyph'), 'the host supplies the glyph').toBeTruthy();
    expect(readout.classList.contains('hidden'), 'nothing is said until it hears').toBe(true);
    expect(readout.getAttribute('aria-live')).toBe('polite');
  });

  it('says whose feedback each of the three buttons takes', () => {
    const el = fakeWidget();
    const { button } = addMic(el, LABELS);
    const fab = el.shadow.querySelector('.fab') as HTMLElement;
    const list = el.shadow.querySelector('.fab-list:not(.fab-mic)') as HTMLElement;
    for (const [b, text] of [
      [fab, LABELS.comment],
      [button, LABELS.voice],
      [list, LABELS.history],
    ] as const) {
      expect(b.dataset.tip, 'the hover label').toBe(text);
      expect(b.getAttribute('aria-label'), 'and the one a screen reader reads').toBe(text);
      // The title is taken off, or the browser's own tip shows under ours.
      expect(b.getAttribute('title')).toBeNull();
    }
  });

  it('moves the thread list up, so the mic takes its place', () => {
    const el = fakeWidget();
    const list = el.shadow.querySelector('.fab-list') as HTMLElement;
    expect(list.classList.contains('side'), 'CONTROL: it stands in the first slot').toBe(false);
    addMic(el, LABELS);
    expect(list.classList.contains('side')).toBe(true);
  });

  it('styles the states the capture puts on the readout', () => {
    // `createVoiceCapture` classes the readout busy while a post is in flight
    // and long for a paragraph-length answer, and puts a spinner inside it.
    // The app's rules for all three live in a document stylesheet, which
    // cannot cross into this shadow root — so the sheet the mic injects has
    // to carry them, or the wait shows nothing and a long answer runs off.
    const el = fakeWidget();
    const { readout } = addMic(el, LABELS);
    readout.classList.remove('hidden');
    const spinner = document.createElement('span');
    spinner.className = 'voice-spinner';
    readout.append(spinner);
    readout.classList.add('voice-indicator--busy', 'voice-indicator--long');
    expect(getComputedStyle(readout).display, 'the spinner sits beside the words').toBe('flex');
    expect(getComputedStyle(readout).overflowY, 'a long answer scrolls').toBe('auto');
    expect(getComputedStyle(spinner).width, 'and the spinner has a size').toBe('14px');
    // And hidden still wins: a readout the capture has cleared stays gone.
    readout.classList.add('hidden');
    expect(getComputedStyle(readout).display).toBe('none');
  });

  describe('measuring the bottom panel the mic has to clear', () => {
    it('runs only while a panel is up, and gives the slot back on the way out', async () => {
      // The height must be read per frame while the panel is there, because
      // it grows as the field fills. With nothing there it must read nothing:
      // a widget idling on a board would otherwise pay layout and battery
      // every frame for a panel that does not exist, on the phone this whole
      // change is for.
      const frames: FrameRequestCallback[] = [];
      const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
        frames.push(cb);
        return frames.length;
      });
      const el = fakeWidget();
      addMic(el, LABELS);
      expect(frames, 'no panel, no frames').toHaveLength(0);

      const panel = document.createElement('div');
      panel.className = 'composer quick';
      el.shadow.append(panel);
      await Promise.resolve();
      expect(frames.length, 'a panel starts it').toBeGreaterThan(0);
      frames.shift()?.(0);
      expect(frames.length, 'and it keeps going while the panel is there').toBeGreaterThan(0);

      panel.remove();
      frames.shift()?.(0);
      await Promise.resolve();
      expect(frames, 'the panel goes and so does the loop').toHaveLength(0);
      expect(el.style.getPropertyValue('--cw-quick-h'), 'slot given back').toBe('0px');
      raf.mockRestore();
    });
  });

  describe('the sign-in retry slot, once a mic shares it', () => {
    /** The slot, as both the widget and a host see it. */
    const slot = (el: FeedbackWidgetEl) =>
      el as unknown as { retryAfterSignIn: (() => void) | null };

    it('keeps every retry put in it, and runs them oldest first', () => {
      // One field, two writers: the typed composer arms it on a refusal and
      // the host arms it for a spoken comment the workspace would not take.
      // Both are told their draft is kept, so both have to go out.
      const el = fakeWidget();
      addMic(el, LABELS);
      const ran: string[] = [];
      slot(el).retryAfterSignIn = () => ran.push('what was spoken');
      slot(el).retryAfterSignIn = () => ran.push('what was typed');
      slot(el).retryAfterSignIn?.();
      expect(ran).toEqual(['what was spoken', 'what was typed']);
    });

    it('is empty before anything is put in it, and again once it has run', () => {
      // The widget reads the slot to decide whether there is anything to do
      // and clears it straight after, so an empty queue must read as null or
      // a signed-in person is told a draft went out that never existed.
      const el = fakeWidget();
      addMic(el, LABELS);
      expect(slot(el).retryAfterSignIn, 'nothing held yet').toBeNull();
      let ran = 0;
      slot(el).retryAfterSignIn = () => {
        ran += 1;
      };
      slot(el).retryAfterSignIn?.();
      expect(ran).toBe(1);
      expect(slot(el).retryAfterSignIn, 'and the queue emptied as it ran').toBeNull();
      slot(el).retryAfterSignIn = null;
      expect(slot(el).retryAfterSignIn).toBeNull();
      expect(ran, 'CONTROL: clearing it runs nothing').toBe(1);
    });

    it('holds a retry that re-arms itself for the NEXT sign-in, not this pass', () => {
      // A retry can be refused again and park itself back in the slot. That
      // belongs to the sign-in after this one; running it inside this pass
      // would spin.
      const el = fakeWidget();
      addMic(el, LABELS);
      let ran = 0;
      const again = (): void => {
        ran += 1;
        slot(el).retryAfterSignIn = again;
      };
      slot(el).retryAfterSignIn = again;
      slot(el).retryAfterSignIn?.();
      expect(ran).toBe(1);
      expect(slot(el).retryAfterSignIn, 'and it is armed for next time').not.toBeNull();
    });
  });

  it('is idempotent — a second call hands back the first mic', () => {
    // A capture is wired to exactly one button; a second button would be a
    // mic nothing listens to.
    const el = fakeWidget();
    const first = addMic(el, LABELS);
    const again = addMic(el, LABELS);
    expect(again.button).toBe(first.button);
    expect(again.readout).toBe(first.readout);
    expect(el.shadow.querySelectorAll('.fab-mic')).toHaveLength(1);
    expect(el.shadow.querySelectorAll('.readout')).toHaveLength(1);
  });
});
