/**
 * The workspaces list redraws itself when something changes elsewhere.
 *
 * `/` is server-rendered, so a change is not applied here: the server sends
 * `landing.changed` on one stream (`packages/server/src/landing-changes.ts`),
 * naming the parts of the page that changed, and this re-reads `/` and swaps
 * those parts in place:
 *
 *  - `boards`: `#landing-review` and `#landing-boards`;
 *  - `inbox`: `#inbox`, through `landing-inbox.ts`, which keeps the open line
 *    and its card and holds the swap while the reader types or a modal is
 *    open;
 *  - `meeting`: no re-read of `/`; each `<meeting-banner>` re-reads its
 *    events list.
 *
 * A frame naming no parts (an older server) means `boards`.
 *
 * The reader's place survives a swap: the review bar's tab, every fold they
 * opened or closed, and the link that has keyboard focus are carried onto the
 * new markup. A swap waits while a finger or button is down, so a tap is
 * never lost to the row being replaced under it.
 *
 * Catch-up: the stream replays nothing, so when it reopens after an error
 * the page re-reads every part once. A hidden tab defers its re-read until
 * it is shown again, so a background tab does not render `/` for nobody.
 */
import { swapInboxFrom } from './landing-inbox.ts';

type Part = 'boards' | 'inbox' | 'meeting';
const PARTS: readonly Part[] = ['boards', 'inbox', 'meeting'];
const BOARD_REGIONS = ['#landing-review', '#landing-boards'];
export const LANDING_STREAM_URL = '/landing/events:stream';

/** The parts a frame names; none named is the board list, as before. */
export function partsOf(data: unknown): Part[] {
  try {
    const parts = (JSON.parse(String(data)) as { parts?: unknown }).parts;
    if (Array.isArray(parts)) {
      const known = PARTS.filter((p) => parts.includes(p));
      if (known.length > 0) return known;
    }
  } catch {
    // Not JSON: an older frame.
  }
  return ['boards'];
}

export interface LandingLiveOptions {
  openStream?: (url: string) => EventSource;
  /** How long a burst of frames gathers before one re-read. */
  debounceMs?: number;
}

/** A fold's name without its count, so "Inactive workspaces 3" still
 *  matches "Inactive workspaces 4". */
const foldKey = (d: HTMLDetailsElement): string =>
  (d.querySelector(':scope > summary')?.textContent ?? '').replace(/\d+/g, '').trim();

function carryState(here: Element, fresh: Element): void {
  const open = new Map<string, boolean>();
  for (const d of here.querySelectorAll('details')) open.set(foldKey(d), d.open);
  for (const d of fresh.querySelectorAll('details')) {
    const was = open.get(foldKey(d));
    if (was !== undefined) d.open = was;
  }
  for (const r of here.querySelectorAll<HTMLInputElement>('input[type="radio"]:checked')) {
    const twin = r.id ? fresh.querySelector<HTMLInputElement>(`#${CSS.escape(r.id)}`) : null;
    if (twin) twin.checked = true;
  }
}

function carryFocus(active: Element | null, here: Element, fresh: Element): void {
  if (!(active instanceof HTMLAnchorElement) || !here.contains(active)) return;
  const href = active.getAttribute('href');
  if (href) fresh.querySelector<HTMLElement>(`a[href="${CSS.escape(href)}"]`)?.focus();
}

function swapRegions(doc: Document, selectors: readonly string[]): void {
  for (const sel of selectors) {
    const here = document.querySelector(sel);
    const fresh = doc.querySelector(sel);
    if (!here || !fresh) continue;
    const node = document.importNode(fresh, true);
    carryState(here, node);
    const active = document.activeElement;
    here.replaceWith(node);
    carryFocus(active, here, node);
  }
}

/**
 * Redraw `parts`. Answers the parts still to do: all of them when a press
 * began while the read was in flight, the inbox alone when it is held.
 */
async function redraw(parts: ReadonlySet<Part>, held: () => boolean): Promise<Part[]> {
  if (parts.has('meeting')) {
    for (const b of document.querySelectorAll('meeting-banner')) {
      void (b as Element & { refresh?: () => Promise<void> }).refresh?.();
    }
  }
  const fromPage = [...parts].filter((p) => p !== 'meeting');
  if (fromPage.length === 0) return [];
  const res = await fetch('/', { credentials: 'same-origin' });
  if (!res.ok) return [];
  const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
  if (held()) return fromPage;
  if (parts.has('boards')) swapRegions(doc, BOARD_REGIONS);
  if (parts.has('inbox') && !swapInboxFrom(doc)) return ['inbox'];
  return [];
}

export function startLandingLive(opts: LandingLiveOptions = {}): () => void {
  if (!document.querySelector('#landing-boards')) return () => {};
  if (!opts.openStream && typeof EventSource === 'undefined') return () => {};
  const debounceMs = opts.debounceMs ?? 100;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let again = false;
  let deferred = false;
  let pressed = false;
  let heldByPress = false;
  /** Parts waiting for the next redraw. */
  const due = new Set<Part>();
  /** Parts a redraw left undone: retried on the next press release or blur. */
  const held = new Set<Part>();

  const run = async (): Promise<void> => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    const parts = new Set(due);
    due.clear();
    try {
      for (const p of await redraw(parts, () => pressed)) held.add(p);
    } catch {
      // A failed re-read leaves the page as it was; the next frame retries.
    } finally {
      running = false;
    }
    if (pressed && held.size > 0) heldByPress = true;
    if (again) {
      again = false;
      void run();
    }
  };
  const schedule = (parts: readonly Part[]): void => {
    for (const p of parts) due.add(p);
    if (pressed) {
      heldByPress = true;
      return;
    }
    if (document.visibilityState === 'hidden') {
      deferred = true;
      return;
    }
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      void run();
    }, debounceMs);
  };
  /** Retry what a redraw had to leave. */
  const retryHeld = (): void => {
    if (held.size === 0) return;
    const parts = [...held];
    held.clear();
    schedule(parts);
  };
  const onVisible = (): void => {
    if (document.visibilityState !== 'hidden' && deferred) {
      deferred = false;
      schedule([]);
    }
  };

  const stream = (opts.openStream ?? ((u) => new EventSource(u)))(LANDING_STREAM_URL);
  let dropped = false;
  stream.addEventListener('landing.changed', (ev) => schedule(partsOf((ev as MessageEvent).data)));
  stream.addEventListener('error', () => {
    dropped = true;
  });
  stream.addEventListener('open', () => {
    if (!dropped) return;
    dropped = false;
    schedule(PARTS);
  });
  const onDown = (): void => {
    pressed = true;
  };
  const onUp = (): void => {
    pressed = false;
    retryHeld();
    if (!heldByPress) return;
    heldByPress = false;
    schedule([]);
  };
  // The inbox holds its swap while a text box has focus or a modal is open;
  // leaving the box, or a key that closed the modal, is when to try again.
  const onLeave = (): void => {
    setTimeout(retryHeld, 0);
  };
  document.addEventListener('visibilitychange', onVisible);
  document.addEventListener('pointerdown', onDown, true);
  document.addEventListener('pointerup', onUp, true);
  document.addEventListener('pointercancel', onUp, true);
  document.addEventListener('focusout', onLeave, true);
  document.addEventListener('keyup', onLeave, true);
  return () => {
    if (timer) clearTimeout(timer);
    document.removeEventListener('visibilitychange', onVisible);
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('pointerup', onUp, true);
    document.removeEventListener('pointercancel', onUp, true);
    document.removeEventListener('focusout', onLeave, true);
    document.removeEventListener('keyup', onLeave, true);
    stream.close();
  };
}
