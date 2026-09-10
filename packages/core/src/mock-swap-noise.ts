/**
 * The one browser error a mockup round raises and the product already handles.
 *
 * A mock's live reload re-runs the round's inline `<script>` sources in the
 * page's one global scope, so round two's top-level `const X` meets round
 * one's and the script is rejected with `Identifier 'X' has already been
 * declared`. PR 841 made that RECOVER: the swap puts the same source in a
 * block and inserts it again, and the reader gets the round. What it could not
 * do is stop the browser REPORTING the collision — Chrome raises the early
 * error at `window` while the script is being evaluated, and the page's Sentry
 * handler is registered long before the widget loads, so a fully recovered
 * round still filed an event. Nine of them in one day
 * (CLAUDE-WORKSPACES-A, CLAUDE-WORKSPACES-8), which is how a real client error
 * gets lost among reports of a failure nothing needs to look at.
 *
 * ## Why a flag rather than a listener that runs first
 *
 * The other way to silence it would be to hear the error before Sentry does
 * and cancel it. Nothing here can: `window.onerror` keeps the position it was
 * FIRST assigned, `/app/sentry.js` is a module in the shell's `<head>`, and the
 * swap runs from a bundle the page loads afterwards. `preventDefault()` on the
 * event suppresses only the browser's own default reporting; it cannot
 * unregister a listener. So the interception has to happen where the event is
 * turned into an envelope — `beforeSend` — and this module is what the two
 * sides (the widget's swap, the page's Sentry init) agree on, since they are
 * separate bundles that share nothing but the page.
 *
 * ## Why it stays narrow
 *
 * A filter that dropped every redeclaration would be a regression, not a fix:
 * the collisions the swap does NOT retry — a `"use strict"` source, a
 * `type="module"`, an `src` script — still lose the mock's script and still
 * need reporting. So the window is exactly the insert that will be retried,
 * raised immediately before it and lowered immediately after, and the event
 * must ALSO look like a declaration collision. Everything outside that pair of
 * conditions files exactly as it did before.
 */

/**
 * The property the swap raises on the global while it inserts a script it can
 * retry. A DEPTH rather than a boolean so a nested insert cannot lower a
 * window its caller still needs.
 */
const DEPTH_KEY = '__cwMockSwapRecoverableInsert';

/**
 * The message a redeclaration gets, in the three engines this ships to.
 *
 * V8: `Identifier 'X' has already been declared` — which Chrome also wraps as
 * `Failed to execute 'insertBefore' on 'Node': …` when it rethrows the early
 * error out of the DOM call (measured, `scripts/mockup-sentry-probe.ts`).
 * JavaScriptCore, which is what an iPad runs: `Cannot declare a const variable
 * twice: 'X'.`, or `Cannot redeclare …`. SpiderMonkey: `redeclaration of
 * const X`.
 */
export const REDECLARATION =
  /already been declared|cannot declare a (?:let|const|class) variable twice|cannot redeclare|redeclaration of/i;

/** The global the flag lives on. Injectable so a test can use its own. */
export type SwapScope = Record<string, unknown>;

/**
 * The floor is HERE and only here — a leave without its enter, and whatever a
 * mock's own script may have left on the global under this name, both read as
 * zero. Clamping in `leaveRecoverableInsert` as well looked like belt and
 * braces and was dead code: the test for it stayed green with that clamp
 * deleted, because this read had already done the job.
 */
function depth(scope: SwapScope): number {
  const n = scope[DEPTH_KEY];
  return typeof n === 'number' && n > 0 ? n : 0;
}

/** Raise the window: a collision reported from here on is one we will retry. */
export function enterRecoverableInsert(scope: SwapScope = globalThis as SwapScope): void {
  scope[DEPTH_KEY] = depth(scope) + 1;
}

/** Lower it again. Always from a `finally` — a window left up silences later
 *  collisions that nothing recovered. */
export function leaveRecoverableInsert(scope: SwapScope = globalThis as SwapScope): void {
  scope[DEPTH_KEY] = depth(scope) - 1;
}

/** Is a retryable insert on the stack right now? */
export function insideRecoverableInsert(scope: SwapScope = globalThis as SwapScope): boolean {
  return depth(scope) > 0;
}

/** As much of a Sentry event as this decision reads. */
export interface ErrorReport {
  message?: string;
  exception?: { values?: Array<{ type?: string; value?: string }> };
}

/**
 * Does this report name a declaration collision — and only that?
 *
 * The name is checked as a string rather than by `instanceof`, and either half
 * may carry it: a browser that hands `onerror` its exception object gets
 * `type: 'SyntaxError'`, and one that withholds it leaves the SDK to build the
 * report from the raw `Uncaught SyntaxError: …` message. Requiring the
 * signature as well as the name is what keeps a RUNTIME `SyntaxError`
 * (`JSON.parse` on bad input, the everyday one) reportable: only a declaration
 * collision is an early error, and only an early error is what the swap
 * retries.
 */
export function isRedeclarationReport(event: ErrorReport): boolean {
  const message = event.message ?? '';
  for (const v of event.exception?.values ?? []) {
    const value = v.value ?? '';
    if (!REDECLARATION.test(value)) continue;
    if (v.type === 'SyntaxError' || /SyntaxError/i.test(value)) return true;
  }
  return /SyntaxError/i.test(message) && REDECLARATION.test(message);
}

/**
 * The whole verdict: a collision raised inside an insert the swap is about to
 * retry. `beforeSend` drops one of these and sends everything else.
 */
export function isRecoveredMockCollision(
  event: ErrorReport,
  scope: SwapScope = globalThis as SwapScope,
): boolean {
  return insideRecoverableInsert(scope) && isRedeclarationReport(event);
}
