import {
  REDECLARATION,
  enterRecoverableInsert,
  leaveRecoverableInsert,
} from '@claude-workspaces/core/mock-swap-noise';

/**
 * Re-running a mock's own inline scripts, round after round.
 *
 * `swapDocument` (in `mockup-live.ts`) revives the round's `<script>` elements
 * and inserts them, because a parser-created script the HTML spec has marked
 * "already started" does not run again when it is moved. That re-execution is
 * where every problem in this file lives, so it is one file: what a browser
 * does with a script it is handed for the second time is a subject of its own,
 * and it is the half with the browser differences in it.
 */

/** Script types the browser runs as a CLASSIC script, in the global scope. */
const CLASSIC_TYPES = new Set([
  '',
  'text/javascript',
  'application/javascript',
  'text/ecmascript',
  'application/ecmascript',
  'text/jscript',
  'text/livescript',
]);

/**
 * Does this element carry inline source the browser runs in the page's ONE
 * global scope?
 *
 * `src` scripts carry no source of ours to touch. `type="module"` already has
 * a scope per script, which is why a module never had this problem. Any other
 * type — `application/json`, `text/x-template` — is a data block the page
 * reads as text, and rewriting it would corrupt the mock's own data.
 */
function isClassicInline(el: HTMLScriptElement): boolean {
  if (el.hasAttribute('src')) return false;
  const type = (el.getAttribute('type') ?? '').split(';')[0].trim().toLowerCase();
  return CLASSIC_TYPES.has(type);
}

/** True when the source opens with a `"use strict"` directive prologue. */
function isStrictSource(source: string): boolean {
  const head = source.replace(/^(?:\s|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*/, '');
  return /^(['"])use strict\1\s*;?/.test(head);
}

/**
 * Insert a round's inline script, and fall back to a block only if it collides.
 *
 * A classic script's top-level `const`, `let` and `class` are bindings of the
 * page's global lexical scope, and that scope survives a swap because the page
 * does. So round two's `const METHODS` met round one's and threw
 * `Identifier 'METHODS' has already been declared` — out of `insertBefore`,
 * which aborted the rest of the swap, so the round neither ran nor finished
 * landing (Sentry CLAUDE-WORKSPACES-8). Most mocks declare a top-level
 * `const`, so live reload was broken on round two for almost all of them.
 *
 * Wrapping every script in a block would fix that and quietly break working
 * mocks: a block's `const` is gone the moment the script ends, so a later
 * script reading an earlier one's `const`, or an inline `onclick="count++"`
 * naming a top-level `let`, would start throwing `ReferenceError` on pages
 * that work today. So the unwrapped source stays the DEFAULT and the block is
 * the recovery: insert as written, and only if THAT throws a redeclaration
 * put the same source in a block and insert it again.
 *
 * Retrying is safe precisely because a redeclaration is an early error: the
 * script is rejected before its first statement runs, so nothing of it has
 * happened and running it again is not running it twice. The failed element is
 * taken back out first — a browser leaves it in the document.
 *
 * What the block still costs, for the round that needed it: `var` is
 * function-scoped so stays global, and Annex B still hoists the block's
 * function declarations to the global in sloppy mode (which is what an inline
 * `onclick="doThing()"` looks up), but its `const` / `let` / `class` are now
 * invisible to a LATER script in that same round. A mock that both collides
 * and shares a lexical binding across two of its own scripts loses the second
 * one — a much narrower page than the one this recovers, and it gets a
 * `ReferenceError` in the console rather than a dead round.
 *
 * Left out of the retry entirely: `src` scripts (no source of ours to
 * rewrite), `type="module"` (its own scope already, which is why this never
 * happened to a module), other types like `application/json` (data, and
 * wrapping would corrupt it), and `"use strict"` sources — strict mode does
 * not give a block's functions to the global, so wrapping one would take its
 * handlers away. Those keep colliding, and the caller's per-node catch keeps
 * the rest of the round on screen.
 */
function canRetryWrapped(el: HTMLScriptElement, source: string): boolean {
  return isClassicInline(el) && !isStrictSource(source);
}

/**
 * Is this the early error a redeclaration raises — and only that?
 *
 * The name alone is not enough, and reading it as enough was a bug: a mock's
 * script can throw a `SyntaxError` at RUNTIME, `JSON.parse` on bad input being
 * the everyday way, and by then the script has done whatever it did before the
 * throw. Retrying that one repeats every side effect. Only a declaration
 * collision is an early error — rejected before the first statement runs — so
 * only a message that names one may be retried.
 *
 * The name is checked by string rather than by `instanceof`: what comes out of
 * an insert is the browser's own exception, and a `SyntaxError` from another
 * realm is not an `instanceof` match for this one's.
 */
function isRedeclaration(err: unknown): boolean {
  const e = err as { name?: string; message?: string } | null;
  return e?.name === 'SyntaxError' && REDECLARATION.test(e.message ?? '');
}

/**
 * The same early error, arriving as an `error` event instead.
 *
 * Chrome rethrows a dynamically inserted script's evaluation error out of the
 * insert — the Sentry event that opened this ticket reads
 * `Failed to execute 'insertBefore' on 'Node': Identifier 'METHODS' has
 * already been declared`. WebKit and Firefox do not: they report it only
 * through the global error-reporting mechanism, so the insert returns normally
 * and a listener hears about it. Bryan reviews mockups on an iPad, which is
 * WebKit, so the event is the shape that matters most here.
 *
 * `error` is null when a browser withholds the exception object, so the
 * message carries both halves of the question in that case.
 */
function isRedeclarationEvent(ev: Event): boolean {
  const e = ev as { error?: unknown; message?: string };
  if (e.error != null) return isRedeclaration(e.error);
  const message = e.message ?? '';
  return /SyntaxError/i.test(message) && REDECLARATION.test(message);
}

/**
 * Copy a parsed `<script>` into a live one so it actually runs.
 *
 * `importNode` on a script produces an inert element — the HTML spec marks a
 * parser-created script "already started" and moving it does not restart it.
 * A mockup's own behaviour lives in those scripts, so a swap that dropped them
 * would hand the reviewer a page that looks right and does nothing.
 */
function reviveScript(src: HTMLScriptElement, source: string): HTMLScriptElement {
  const out = document.createElement('script');
  for (const a of Array.from(src.attributes)) out.setAttribute(a.name, a.value);
  out.textContent = source;
  return out;
}

/**
 * Insert one of the round's scripts, blocking its scope only if it must.
 *
 * The collision is heard two ways because browsers report it two ways: caught
 * from the insert (Chrome) or recorded by a one-shot capturing listener
 * (WebKit, Firefox), which fires synchronously while the script is being
 * evaluated and so is finished before the insert returns. The listener is
 * added immediately before and removed immediately after, so nothing else on
 * the page can be mistaken for this script's failure.
 *
 * `preventDefault()` runs only on the event this will retry, and does exactly
 * one thing: it suppresses the browser's DEFAULT reporting of an error the
 * reader never sees. It does NOT unregister anyone else — a page-level `error`
 * listener installed before the swap (Sentry's is) still hears the event, and
 * for as long as that was the whole story a recovered round on Chrome filed
 * one CLAUDE-WORKSPACES-8 anyway. So the insert that WILL be retried also
 * raises the window `enterRecoverableInsert` opens, which is what
 * `/app/sentry.js` reads in `beforeSend` to tell a collision the product
 * handled from one it did not. It is lowered in the same `finally` as the
 * listener is removed: an error this does NOT retry — the wrapped retry
 * itself included — is left to propagate and be reported exactly as before.
 */
export function insertScript(src: HTMLScriptElement, before: Node | null): void {
  const source = src.textContent ?? '';
  const asWritten = reviveScript(src, source);
  const retryable = canRetryWrapped(src, source);
  let collided = false;
  const onError = (ev: Event): void => {
    if (!retryable || !isRedeclarationEvent(ev)) return;
    collided = true;
    ev.preventDefault();
  };
  if (retryable) enterRecoverableInsert();
  window.addEventListener('error', onError, true);
  let threw: { err: unknown } | null = null;
  try {
    document.body.insertBefore(asWritten, before);
  } catch (err) {
    threw = { err };
  } finally {
    window.removeEventListener('error', onError, true);
    if (retryable) leaveRecoverableInsert();
  }
  if (threw && !(retryable && isRedeclaration(threw.err))) throw threw.err;
  if (!threw && !collided) return;
  asWritten.remove();
  // The newlines matter: a source ending in a `// line comment` would
  // otherwise swallow the closing brace.
  document.body.insertBefore(reviveScript(src, `{\n${source}\n}`), before);
}
