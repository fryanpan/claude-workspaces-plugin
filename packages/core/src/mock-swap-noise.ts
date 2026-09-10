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
 *
 * It sits on the same global a mock's own scripts run in, which is unavoidable
 * — that global is the only thing the two bundles share. So the value is
 * treated as untrusted input rather than as state this module owns: a read
 * accepts only a small positive integer this module could have written, and a
 * leave RESTORES what its own enter saw rather than decrementing whatever is
 * there now. Between them, a page that writes `Infinity`, `true`, `'2'` or a
 * huge number to this key cannot leave the window standing open — which
 * decrementing could, since `Infinity - 1` is `Infinity`.
 */
const DEPTH_KEY = '__cwMockSwapRecoverableInsert';

/**
 * And the identifiers the source being inserted declares, so the window is not
 * the whole of the verdict.
 *
 * A script that does NOT collide runs, and while it runs the window is still
 * up — so a page whose script synchronously inserts or evaluates other code
 * could raise a redeclaration of its own that nothing recovered, and a filter
 * reading only the window would drop it. Naming the identifiers turns "some
 * collision happened while we were inserting" into "the collision is on one of
 * the bindings THIS source declares", which is the thing that is actually
 * about to be retried.
 *
 * `null` means "could not enumerate them" — a destructuring declaration, whose
 * targets this does not parse — and reads as the whole window, which is the
 * behaviour before the names existed. Failing that way keeps the noise fix
 * intact; failing the other way would let it back.
 */
const NAMES_KEY = '__cwMockSwapRecoverableNames';

/** Deeper than the swap ever nests; a stored value above it is not ours. */
const MAX_DEPTH = 8;

/**
 * Every binding a source declares that a second run could collide on. A
 * SUPERSET on purpose: a name inside a nested block or a string costs nothing
 * (it can only widen what is recognised as this script's own collision),
 * whereas a name missed would file noise this exists to stop.
 */
const DECLARATION = /\b(?:const|let|class|var|function)\s+([A-Za-z_$][\w$]*|[{[])/g;

/** The identifier a redeclaration message names, per engine. Chrome's wrapped
 *  form puts `'insertBefore'` and `'Node'` in front of the real one, which is
 *  why each pattern is anchored to its own phrase rather than taking the first
 *  quoted word. */
const COLLIDED_NAME = [
  /Identifier '([A-Za-z_$][\w$]*)'/,
  /twice: '([A-Za-z_$][\w$]*)'/,
  /redeclare[^']*'([A-Za-z_$][\w$]*)'/i,
  /redeclaration of (?:const|let|class|var|function)\s+([A-Za-z_$][\w$]*)/i,
];

/** The names `source` declares, or `null` when they cannot all be enumerated. */
export function declaredNames(source: string): string[] | null {
  const names: string[] = [];
  for (const m of source.matchAll(DECLARATION)) {
    const target = m[1];
    if (target === '{' || target === '[') return null;
    names.push(target);
  }
  return names;
}

function collidedName(message: string): string | null {
  for (const pattern of COLLIDED_NAME) {
    const m = pattern.exec(message);
    if (m) return m[1];
  }
  return null;
}

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
 * The stored depth, or zero for anything this module would not have written.
 * The floor, the integer check and the ceiling are all HERE and only here.
 */
function depth(scope: SwapScope): number {
  const n = scope[DEPTH_KEY];
  return typeof n === 'number' && Number.isInteger(n) && n > 0 && n <= MAX_DEPTH ? n : 0;
}

/** The names on the global, or `null` for anything this module would not have
 *  written — which reads as "cannot enumerate", the widest case. */
function names(scope: SwapScope): string[] | null {
  const v = scope[NAMES_KEY];
  return Array.isArray(v) ? v.filter((n): n is string => typeof n === 'string') : null;
}

/** What a `leaveRecoverableInsert` puts back. Opaque to the caller. */
export interface RecoverableInsert {
  depth: number;
  names: string[] | null;
}

/**
 * Raise the window around the insert of `source`: a collision on one of the
 * bindings it declares, reported from here on, is one we will retry.
 *
 * Returns the state to restore, which its `leaveRecoverableInsert` must be
 * handed — that pairing is what makes the close unconditional.
 */
export function enterRecoverableInsert(
  source: string,
  scope: SwapScope = globalThis as SwapScope,
): RecoverableInsert {
  const before = { depth: depth(scope), names: names(scope) };
  scope[DEPTH_KEY] = Math.min(before.depth + 1, MAX_DEPTH);
  scope[NAMES_KEY] = declaredNames(source);
  return before;
}

/** Lower it again, to exactly what the matching enter saw. Always from a
 *  `finally` — a window left up silences later collisions that nothing
 *  recovered. */
export function leaveRecoverableInsert(
  before: RecoverableInsert,
  scope: SwapScope = globalThis as SwapScope,
): void {
  scope[DEPTH_KEY] = before.depth;
  scope[NAMES_KEY] = before.names;
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
/** Every string in the report that could carry the collision's message. */
function reportText(event: ErrorReport): string {
  const parts = [event.message ?? ''];
  for (const v of event.exception?.values ?? []) parts.push(v.value ?? '');
  return parts.join(' ');
}

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
 * The whole verdict: a collision, on a binding the source now being inserted
 * declares, raised inside the insert the swap is about to retry.
 * `beforeSend` drops one of these and sends everything else.
 *
 * A message no pattern can read an identifier out of counts as this script's
 * own, as does a source whose declarations could not be enumerated. Both are
 * the wide answer, and wide is the safe direction here: the narrow one files
 * the noise again.
 */
export function isRecoveredMockCollision(
  event: ErrorReport,
  scope: SwapScope = globalThis as SwapScope,
): boolean {
  if (!insideRecoverableInsert(scope) || !isRedeclarationReport(event)) return false;
  return collisionIsOurs(reportText(event), names(scope));
}

/** Does this report name one of `declared`? `null` declarations, or a message
 *  with no identifier in it, answer yes. */
export function collisionIsOurs(message: string, declared: string[] | null): boolean {
  if (declared === null) return true;
  const name = collidedName(message);
  return name === null || declared.includes(name);
}
