/**
 * The all-workspaces review bar, woken: the server paints it on Hard with the
 * full total, and this repaints the reader's choice (cached, then the
 * account's — see `createSizeChoice`) and keeps the
 * total in step as the bar moves. Only the number changes — the label around
 * it is the server's and stays put.
 */
import { type ReviewSize, parseReviewSize } from '@claude-workspaces/core';
import type { BootStorage } from './boot-env.ts';
import {
  type SizePrefRemote,
  createSizeChoice,
  httpSizePref,
  onFillBarPick,
  paintFillBar,
  totalMinutes,
} from './review-sizes.ts';

/** The items the page embedded, as `[size, minutes]` pairs. */
function readSizes(doc: Document): Array<{ size: ReviewSize; minutes: number }> {
  const raw = doc.getElementById('review-sizes')?.textContent;
  if (!raw) return [];
  try {
    const pairs = JSON.parse(raw) as unknown;
    if (!Array.isArray(pairs)) return [];
    return pairs.flatMap((p) => {
      const size = Array.isArray(p) ? parseReviewSize(p[0]) : null;
      const minutes = Array.isArray(p) && typeof p[1] === 'number' ? p[1] : null;
      return size && minutes !== null ? [{ size, minutes }] : [];
    });
  } catch {
    return [];
  }
}

export function wakeLandingReviewBar(
  doc: Document,
  storage: BootStorage,
  remote: SizePrefRemote = httpSizePref(),
): void {
  const bar = doc.querySelector<HTMLElement>('.allbar .review-sizes');
  if (!bar) return;
  const items = readSizes(doc);
  const est = doc.getElementById('est');
  const go = doc.querySelector<HTMLElement>('.allbar .allgo');
  const paint = (level: ReviewSize) => {
    paintFillBar(bar, level);
    const total = totalMinutes(items, level);
    if (est) est.textContent = String(total);
    if (go) go.hidden = total === 0;
  };
  const choice = createSizeChoice(storage, remote, paint);
  paint(choice.level());
  onFillBarPick(bar, (level) => {
    choice.pick(level);
    paint(level);
  });
}
