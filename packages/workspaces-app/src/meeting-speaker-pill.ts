/**
 * Who said this run of the transcript, and — where a name can be recorded —
 * the tap that names them.
 *
 * Split out of `meeting-live-zone.ts` for the same reason
 * `meeting-live-hold.ts` was: the zone sits on the 500-line bar. What it
 * holds is one decision, and the decision is not the zone's: a pill promises
 * an edit only where somebody handed in a way to make one.
 *
 * TWO ELEMENTS, NEVER ONE, and the split is the one the strip's own pill
 * learned the hard way (see `.meeting-speaker` in doc.css): the OUTER element
 * is the tap target and carries padding and nothing else, the INNER carries
 * every visual. Grow the hit area on the element that also draws the pill and
 * the pill grows with it.
 *
 * THE CUE IS NOT A HOVER. `cursor` and `title` are both hover-only and the
 * device this was built for has none, which is exactly how a real two-voice
 * capture ended with "no ability to edit the speaker names" while a tappable
 * pill was on screen. The pencil and the dotted underline are the
 * stylesheet's, on `button.lz-speaker` alone; the accessible name is set here
 * because a `::before` is not one.
 */

import { speakerDisplayName } from '@claude-workspaces/core';

/**
 * One speaker pill. `nameSpeaker` absent renders the plain label the zone
 * always had — a bot meeting, or any mount with no rename channel.
 */
export function speakerPill(
  label: string,
  names: Readonly<Record<string, string>>,
  nameSpeaker?: (label: string) => void,
): HTMLElement {
  const shown = speakerDisplayName(label, names);
  const outer = nameSpeaker ? document.createElement('button') : document.createElement('span');
  outer.className = 'lz-speaker';
  outer.dataset.speaker = label;
  const inner = document.createElement('span');
  inner.className = 'lz-speaker-pill';
  inner.textContent = shown;
  outer.append(inner);
  if (outer instanceof HTMLButtonElement && nameSpeaker) {
    outer.type = 'button';
    outer.title = 'Tap to name this speaker';
    outer.setAttribute('aria-label', `Name ${shown}`);
    outer.addEventListener('click', () => nameSpeaker(label));
  }
  return outer;
}
