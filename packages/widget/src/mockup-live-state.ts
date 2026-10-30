/**
 * What a mock keeps of itself when its next round lands.
 *
 * The swap (`mockup-live.ts`) keeps the page's window, so the frame's address,
 * its hash, `sessionStorage` and every `window` global come through a round
 * untouched. What a mock lost was its own screen: the round's scripts run
 * again from the start, and a mock that restores its state in a
 * `DOMContentLoaded` or `load` listener never restores it, because a page
 * that does not reload never fires either event again. So a reader on an
 * inner tab landed back on the first one after every save, whatever the mock
 * had saved. Measured headless on 30 October: across a swap the hash, the
 * query, the scroll, `sessionStorage`, `localStorage`, a global and
 * `window.name` all held their values, and a `DOMContentLoaded` listener the
 * new round added was never called.
 *
 * Three things fix that, in the order a swap runs them:
 *
 * 1. `cw-round-leaving` fires on `window` before the old round goes. A mock
 *    puts what it wants back on `event.detail.state`.
 * 2. While the new round's scripts are inserted, `window.cwRoundState` holds
 *    that value, so a script can read it at the top level. The
 *    `DOMContentLoaded` and `load` listeners those scripts add, and an
 *    `onload` they set, are then called once, so a mock whose start-up lives
 *    in one of them starts at all.
 * 3. `cw-round-arrived` fires on `window` with the same `detail.state`, for a
 *    mock that would rather restore in a listener.
 *
 * The contract is written for mock authors in
 * `packages/plugin/skills/building-a-mock/SKILL.md`; change both together.
 */

export const LEAVING_EVENT = 'cw-round-leaving';
export const ARRIVED_EVENT = 'cw-round-arrived';

/** The window field a new round's scripts read the kept value from. */
const STATE_FIELD = 'cwRoundState';

type Listener = EventListenerOrEventListenerObject;
type Held = { target: EventTarget; type: string; fn: Listener };

/** The start-up events a page that never reloads never fires again. */
const START_EVENTS = new Set(['DOMContentLoaded', 'load']);

/** Ask the round on screen what it wants back. */
export function collectRoundState(): unknown {
  const detail: { state: unknown } = { state: undefined };
  try {
    window.dispatchEvent(new CustomEvent(LEAVING_EVENT, { detail }));
  } catch (err) {
    // A mock's listener that throws must not cost the reader the round.
    console.error('[claude-workspaces] cw-round-leaving listener threw', err);
  }
  (window as unknown as Record<string, unknown>)[STATE_FIELD] = detail.state;
  return detail.state;
}

/**
 * Run `insert` with every start-up listener it adds held, then call them.
 *
 * Only listeners added WHILE `insert` runs are called. One the previous
 * round added is still registered on the same `document`, and calling it
 * would start the old round's code over the new round's page.
 */
export function insertRound(insert: () => void): void {
  const held: Held[] = [];
  const onloadBefore = window.onload;
  // On the two targets themselves rather than on `EventTarget.prototype`, so
  // nothing else's listeners pass through here, and an own property put back
  // exactly as it was leaves the page as it found it.
  const targets: EventTarget[] = [document, window];
  const saved = targets.map((t) => Object.getOwnPropertyDescriptor(t, 'addEventListener'));
  for (const target of targets) {
    const real = target.addEventListener;
    Object.defineProperty(target, 'addEventListener', {
      configurable: true,
      writable: true,
      value(type: string, fn: Listener | null, opts?: boolean | AddEventListenerOptions): void {
        if (!fn) return;
        if (START_EVENTS.has(type)) held.push({ target, type, fn });
        real.call(target, type, fn, opts);
      },
    });
  }
  try {
    insert();
  } finally {
    targets.forEach((t, i) => {
      const d = saved[i];
      if (d) Object.defineProperty(t, 'addEventListener', d);
      else Reflect.deleteProperty(t, 'addEventListener');
    });
  }
  const order = (type: string) => held.filter((h) => h.type === type);
  for (const h of [...order('DOMContentLoaded'), ...order('load')]) call(h.target, h.type, h.fn);
  const onload = window.onload;
  if (typeof onload === 'function' && onload !== onloadBefore) call(window, 'load', onload);
}

/** Tell the round that just landed what the last one kept. */
export function announceRoundArrived(state: unknown): void {
  try {
    window.dispatchEvent(new CustomEvent(ARRIVED_EVENT, { detail: { state } }));
  } catch (err) {
    console.error('[claude-workspaces] cw-round-arrived listener threw', err);
  }
}

/** One held listener, called the way the browser would have called it. */
function call(target: EventTarget, type: string, fn: Listener | ((ev: Event) => unknown)): void {
  const ev = new Event(type);
  try {
    if (typeof fn === 'function') fn.call(target, ev);
    else fn.handleEvent(ev);
  } catch (err) {
    console.error(`[claude-workspaces] mockup round: a ${type} listener threw`, err);
  }
}
