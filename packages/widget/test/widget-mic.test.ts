import { beforeEach, describe, expect, it } from 'vitest';
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
  return { shadow } as unknown as FeedbackWidgetEl;
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
