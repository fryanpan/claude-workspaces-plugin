/**
 * Build-time stand-in for `y-protocols/awareness` in the widget bundle.
 *
 * PRESENCE IS NOT A THING THE WIDGET HAS. It draws pins, a panel, a popover
 * and the review dock, and it reads `client.awareness` nowhere — measured by
 * searching `packages/widget/src` for it. The two surfaces in the app that DO
 * render presence (`board-chrome-region.ts`, `meeting-solo.ts`) both skip an
 * entry whose state carries no `user.name`, and a widget's state is `{}`, so a
 * widget has never appeared to a single reader.
 *
 * What it did do, on every page it is a guest on:
 *
 * - announced that empty entry on every connect and reconnect. The comment in
 *   `ws-client.ts` used to call that push a "no-op for clients (like the
 *   widget) that never set local awareness state" — but the real `Awareness`
 *   constructor ends with `this.setLocalState({})`, so `getStates()` held one
 *   entry and the push ran. The comment described this file's behaviour, a
 *   year early.
 * - ran a `setInterval` every 3 seconds (`outdatedTimeout / 10`) for the life
 *   of the page, renewing a clock nobody read and timing out peers nobody
 *   drew, on somebody else's site.
 * - cost 919 bytes gzipped of a 40 KB budget, with the module's own lib0
 *   dependencies behind it.
 *
 * So the widget stops taking part. It still READS the awareness frames the
 * server sends — `ws-client` decodes the payload off the wire before it gets
 * here, so message framing is untouched and the socket stays in step — and
 * then drops them, which is what rendering none of them already amounted to.
 *
 * What it costs: a widget cannot show presence without undoing this, and the
 * server no longer learns that a widget is attached FROM AWARENESS (it still
 * has the socket). Neither is a thing anything renders today. If the widget
 * ever grows a "who else is looking at this mock" strip, drop the resolve rule
 * in `build.ts` and pay the bytes back deliberately.
 *
 * Every export the real module declares is present, because `build.ts`
 * compares the two lists and fails the build when they diverge — a missing
 * export would ship as a silent `undefined` inside somebody else's library.
 * The METHODS are not checked by that, so the class carries the whole public
 * surface rather than only the five `ws-client` calls: a future caller should
 * get a no-op, not a TypeError on a host page.
 *
 * TypeScript rather than the `.js` its two neighbours are written in, for one
 * reason: it is the only shim a test drives, and `awareness-shim.test.ts` can
 * import it directly without the repo growing an `allowJs`. tsc reads it as
 * part of the ordinary typecheck, which the other two never get.
 */

/** The real module's value, unchanged: anything reading it reads the same number. */
export const outdatedTimeout = 30000;

const EMPTY = new Uint8Array(0);

/** All the real class reads off the doc it is handed. */
interface AwarenessDoc {
  clientID: number;
}

export class Awareness {
  readonly doc: AwarenessDoc;
  readonly clientID: number;
  /** Empty and staying empty. `ws-client` pushes local state on connect only
   *  when `getStates()` is non-empty, so this is what stops the announcement. */
  readonly states = new Map<number, Record<string, unknown>>();
  readonly meta = new Map<number, { clock: number; lastUpdated: number }>();

  constructor(doc: AwarenessDoc) {
    this.doc = doc;
    this.clientID = doc.clientID;
  }

  /** Null, never `{}`: "this client has no presence" rather than "empty presence". */
  getLocalState(): Record<string, unknown> | null {
    return null;
  }

  setLocalState(_state?: Record<string, unknown> | null): void {}
  setLocalStateField(_field?: string, _value?: unknown): void {}

  getStates(): Map<number, Record<string, unknown>> {
    return this.states;
  }

  // The Observable surface the real class inherits. No handler is ever called
  // because nothing emits, so `ws-client`'s 'update' listener simply never
  // fires and no awareness frame is ever sent.
  on(_name?: string, _fn?: (...args: never[]) => void): void {}
  once(_name?: string, _fn?: (...args: never[]) => void): void {}
  off(_name?: string, _fn?: (...args: never[]) => void): void {}
  emit(_name?: string, _args?: unknown[]): void {}
  destroy(): void {}
}

/** Dropped. The frame was decoded off the wire by the caller either way. */
export const applyAwarenessUpdate = (
  _awareness?: Awareness,
  _update?: Uint8Array,
  _origin?: unknown,
): void => {};

/** Never reached: nothing here emits an update, and `getStates()` is empty. */
export const encodeAwarenessUpdate = (_awareness?: Awareness, _clients?: number[]): Uint8Array =>
  EMPTY;

/** Nothing to remove — no state was ever recorded for any client. */
export const removeAwarenessStates = (
  _awareness?: Awareness,
  _clients?: number[],
  _origin?: unknown,
): void => {};

/** Handed back unchanged: rewriting a frame nobody reads changes nothing. */
export const modifyAwarenessUpdate = (update: Uint8Array): Uint8Array => update;
