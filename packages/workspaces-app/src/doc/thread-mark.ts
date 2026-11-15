/**
 * An agent's mark on a thread card's glyph: working on it, or done.
 *
 * The same two marks the widget draws on an app's or a mock's pins, from the
 * same markup and clock (`thread-progress.ts` in core), so a comment reads the
 * same in a doc, on the board and on a dev server (the owner: "it should work
 * in doc or dev server too"). The glyph becomes a filled disc of the pin's
 * colour holding the three breathing dots, or teal holding the check that
 * draws once. It keeps the glyph's size and place, so nothing on the card
 * moves when a mark arrives. Styles: `styles.css`, beside the glyphs, because
 * the board renders this card too.
 */
import {
  type Thread,
  authorLabel,
  createProgressClock,
  formatTime,
  progressMarkHtml,
} from '@claude-workspaces/core';

/** One per page: every copy of a card (margin, drawer, inline, board) asks
 *  the same clock, so a second copy continues the first one's draw. */
const clock = createProgressClock();

const SAYS = { working: 'is working on this', done: 'marked this done' } as const;

/** Put `t`'s mark on its card's glyph, and say it in the glyph's title. An
 *  unmarked card is still told to the clock, so a later Done draws. */
export function markGlyph(glyph: HTMLElement, t: Thread, open: boolean): void {
  const p = open ? t.progress : undefined;
  const sinceDone = clock(t.id, p?.state ?? 'open');
  if (!p) return;
  glyph.classList.add('thread-mark');
  glyph.dataset.mark = p.state;
  glyph.title = `${authorLabel(p.by)} ${SAYS[p.state]} · ${formatTime(p.at)}`;
  glyph.innerHTML = progressMarkHtml(p.state, sinceDone);
}
