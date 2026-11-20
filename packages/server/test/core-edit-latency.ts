/**
 * The edit-latency measurement for a board on the collab core (M8 cutover
 * trial, bar 2): one page appends a paragraph to a doc, and the time until a
 * second page holds it is read off clocks recorded AT the two events, not off
 * how long a test took.
 *
 * The doc is named, so the number it reports always says what size it was
 * measured on: `TIDE_TABLE`, a markdown doc of `TIDE_TABLE_WEEKS` sections.
 * Its size in bytes is computed from the text and reported beside each
 * number. The browser half of the trial
 * (`workspaces-app/test/core-edit-latency-browser-driver.ts`) seeds the same
 * doc, so both halves measure on one size.
 */
import { type Page, appendParagraph, proseText } from './collab-core-page.ts';

/** How many weekly sections the named doc has. */
export const TIDE_TABLE_WEEKS = 200;

/** The named test doc: the Harborlight tide table, `TIDE_TABLE_WEEKS` weeks. */
export const TIDE_TABLE = [
  '# Harborlight tide table',
  '',
  ...Array.from({ length: TIDE_TABLE_WEEKS }, (_, i) =>
    [
      `## Week ${i + 1}`,
      '',
      `High water at Saltmarsh reaches the harbour wall on day ${i + 1}; the`,
      'low-water channel stays open for small boats and the pilot launch.',
      '',
    ].join('\n'),
  ),
].join('\n');

/** The doc's size, as reported beside every number measured on it. */
export const TIDE_TABLE_BYTES = new TextEncoder().encode(TIDE_TABLE).length;

/** The bars: a second page's stored state within 1s, its screen within 1.5s. */
export const STORED_BAR_MS = 1000;
export const SCREEN_BAR_MS = 1500;

/** A clock both ends can read: epoch milliseconds at sub-millisecond grain.
 *  The driver process and a browser on the same machine share it, which is
 *  what lets an edit stamped in one be compared with a paint in the other. */
export function epochNow(): number {
  return performance.timeOrigin + performance.now();
}

export interface StoredLatency {
  /** When page one made the edit, on `epochNow`. */
  editedAt: number;
  /** When page two's Y.Doc first held the edit, on the same clock. */
  heldAt: number;
  /** `heldAt - editedAt`. */
  storedMs: number;
  docBytes: number;
}

/**
 * Append `words` on `from`, and resolve with when `to` held them. The second
 * stamp is taken inside `to`'s own update handler, so it is the instant the
 * edit landed in that page's stored state, not the instant a poll noticed.
 */
export function measureStored(
  from: Page,
  to: Page,
  words: string,
  timeoutMs = 10_000,
): Promise<StoredLatency> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      to.ydoc.off('update', onUpdate);
      reject(new Error(`page two never held "${words}" within ${timeoutMs}ms`));
    }, timeoutMs);
    let editedAt = 0;
    const onUpdate = (_u: Uint8Array, origin: unknown) => {
      // An edit the page made itself is not one it received.
      if (origin === null) return;
      if (!proseText(to.ydoc).includes(words)) return;
      const heldAt = epochNow();
      clearTimeout(timer);
      to.ydoc.off('update', onUpdate);
      resolve({ editedAt, heldAt, storedMs: heldAt - editedAt, docBytes: TIDE_TABLE_BYTES });
    };
    to.ydoc.on('update', onUpdate);
    editedAt = epochNow();
    appendParagraph(from.ydoc, words);
  });
}

/** One line a CI log keeps: the number, the bar and the doc it was measured on. */
export function latencyLine(label: string, ms: number, barMs: number): string {
  return `[core-edit-latency] ${label}: ${ms.toFixed(1)}ms (bar ${barMs}ms) on the Harborlight tide table, ${TIDE_TABLE_WEEKS} weeks, ${TIDE_TABLE_BYTES} bytes`;
}
