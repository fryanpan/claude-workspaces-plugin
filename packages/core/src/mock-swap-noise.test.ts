import { describe, expect, it } from 'vitest';
import {
  type SwapScope,
  collidableNames,
  enterRecoverableInsert,
  insideRecoverableInsert,
  isRecoveredMockCollision,
  isRedeclarationReport,
  leaveRecoverableInsert,
} from './mock-swap-noise.ts';

/**
 * Which browser reports a recovered mockup round, and which ones still have to
 * be filed.
 *
 * The verdict is two conditions ANDed, and both halves matter: dropping every
 * redeclaration would silence the collisions the swap does NOT retry — a
 * `"use strict"` source, a module, an `src` script — which lose the mock's
 * script and are exactly what a reader needs told. So every case below that
 * expects `true` has the case next to it that expects `false` for turning off
 * one condition.
 */

/** The source the swap is inserting in these cases: it declares `params`,
 *  which is the identifier the real Sentry issues collided on. */
const SOURCE = "const params = ['round 2'];";

/** A window.onerror report as the SDK builds it from an exception object. */
function report(
  type: string,
  value: string,
): { exception: { values: [{ type: string; value: string }] } } {
  return { exception: { values: [{ type, value }] } };
}

describe('the flag a recoverable insert raises', () => {
  it('is down until an insert raises it, and down again after', () => {
    const scope: SwapScope = {};
    expect(insideRecoverableInsert(scope)).toBe(false);
    const before = enterRecoverableInsert(SOURCE, scope);
    expect(insideRecoverableInsert(scope)).toBe(true);
    leaveRecoverableInsert(before, scope);
    expect(insideRecoverableInsert(scope)).toBe(false);
  });

  it('survives a nested insert lowering it — the outer window is still up', () => {
    const scope: SwapScope = {};
    const outer = enterRecoverableInsert(SOURCE, scope);
    const inner = enterRecoverableInsert(SOURCE, scope);
    leaveRecoverableInsert(inner, scope);
    // A boolean would have gone down here and let the outer insert's own
    // collision through, which is the whole reason this is a depth.
    expect(insideRecoverableInsert(scope)).toBe(true);
    leaveRecoverableInsert(outer, scope);
    expect(insideRecoverableInsert(scope)).toBe(false);
  });

  it.each([
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a number no swap could have written', 9_000],
    ['a fraction', 1.5],
    ['true', true],
    ['a string', '3'],
  ])('reads %s left on the global by a mock as no window at all', (_what, planted) => {
    // The flag lives on the same global a mock's own scripts run in — there is
    // nothing else the two bundles share. Decrementing whatever was there
    // would have made `Infinity` permanent, and every later redeclaration
    // silently unreportable.
    const scope: SwapScope = { __cwMockSwapRecoverableInsert: planted };
    expect(insideRecoverableInsert(scope)).toBe(false);
  });

  it('closes the window even if the mock overwrites the flag mid-insert', () => {
    const scope: SwapScope = {};
    const before = enterRecoverableInsert(SOURCE, scope);
    // The inserted script runs here, and this one is careless.
    scope.__cwMockSwapRecoverableInsert = 5;
    leaveRecoverableInsert(before, scope);
    expect(insideRecoverableInsert(scope)).toBe(false);
  });
});

describe('which reports name a declaration collision', () => {
  it.each([
    ['V8', "Identifier 'params' has already been declared"],
    // What Chrome actually sent, measured by scripts/mockup-sentry-probe.ts:
    // the early error rethrown out of the DOM call that ran the script.
    [
      'V8 through insertBefore',
      "Failed to execute 'insertBefore' on 'Node': Identifier 'params' has already been declared",
    ],
    ['JavaScriptCore', "Cannot declare a const variable twice: 'params'."],
    ['JavaScriptCore, redeclare', "Cannot redeclare block-scoped variable 'params'"],
    ['SpiderMonkey', 'redeclaration of const params'],
  ])('%s', (_engine, message) => {
    expect(isRedeclarationReport(report('SyntaxError', message))).toBe(true);
  });

  it('reads the message when the browser withheld the exception object', () => {
    // No `exception.values` at all — the SDK has only the raw onerror string.
    expect(
      isRedeclarationReport({
        message: "Uncaught SyntaxError: Identifier 'params' has already been declared",
      }),
    ).toBe(true);
  });

  it('does not name a SyntaxError thrown at runtime', () => {
    // `JSON.parse` on bad input is the everyday one, and by the time it throws
    // the script has already done whatever it did. Nothing recovers it and the
    // reader needs to see it.
    expect(isRedeclarationReport(report('SyntaxError', 'Unexpected end of JSON input'))).toBe(
      false,
    );
  });

  it('does not name an ordinary error that happens to mention a declaration', () => {
    expect(isRedeclarationReport(report('TypeError', 'params is not a function'))).toBe(false);
  });
});

describe('the identifiers a source could collide on', () => {
  it.each([
    ['a plain declaration', 'const LABELS = [1];', 'LABELS'],
    // The three shapes a declaration parser missed, each of which would have
    // made this script's own collision look like somebody else's and stopped
    // the round being recovered at all.
    ['a second declarator', 'const fresh = 1, existing = 2;', 'existing'],
    ['a destructured binding', 'const { alpha, beta } = window.cfg;', 'beta'],
    ['a declarator on its own line', 'let\n  wrapped = 1;', 'wrapped'],
  ])('cannot miss the name in %s', (_shape, source, name) => {
    expect(collidableNames(source)).toContain(name);
  });

  it('lists each name once however often it is written', () => {
    expect(collidableNames('const a = 1; a = a + 1;')).toEqual(['const', 'a']);
  });

  it('has nothing to give for a source with no identifiers in it', () => {
    expect(collidableNames('"12" + 34;')).toEqual([]);
  });
});

describe('the verdict beforeSend reads', () => {
  const collision = report('SyntaxError', "Identifier 'params' has already been declared");

  it('drops a collision raised inside the insert that will be retried', () => {
    const scope: SwapScope = {};
    enterRecoverableInsert(SOURCE, scope);
    expect(isRecoveredMockCollision(collision, scope)).toBe(true);
  });

  it('does not drop one because a mock left the flag looking raised', () => {
    expect(
      isRecoveredMockCollision(collision, {
        __cwMockSwapRecoverableInsert: Number.POSITIVE_INFINITY,
      }),
    ).toBe(false);
  });

  it('sends the same collision when no insert raised the window', () => {
    // The mutation control for the case above: turn the flag off and the
    // identical report is filed. A filter that silences a collision the swap
    // never retried is a regression, not a fix.
    expect(isRecoveredMockCollision(collision, {})).toBe(false);
  });

  it('sends a collision on a binding this source never declared', () => {
    // The script did not collide, so it RAN, and while it ran it inserted or
    // evaluated code of its own that collided on something else. Nothing
    // recovers that one, so it is filed — the window alone would have dropped
    // it (Codex review, round 2).
    const scope: SwapScope = {};
    enterRecoverableInsert(SOURCE, scope);
    expect(
      isRecoveredMockCollision(
        report('SyntaxError', "Identifier 'somethingElse' has already been declared"),
        scope,
      ),
    ).toBe(false);
  });

  it('reads the identifier past the wrapper Chrome puts in front of it', () => {
    // `Failed to execute 'insertBefore' on 'Node': …` quotes two names before
    // the real one, so taking the first quoted word would compare against
    // `insertBefore` and drop nothing.
    const scope: SwapScope = {};
    enterRecoverableInsert(SOURCE, scope);
    expect(
      isRecoveredMockCollision(
        report(
          'SyntaxError',
          "Failed to execute 'insertBefore' on 'Node': Identifier 'params' has already been declared",
        ),
        scope,
      ),
    ).toBe(true);
  });

  it('drops a collision on a name only a destructuring pattern bound', () => {
    // The shape a declaration parser could not enumerate, and the reason the
    // set is every identifier the source mentions rather than the ones it can
    // be proved to declare.
    const scope: SwapScope = {};
    enterRecoverableInsert('const { params } = cfg;', scope);
    expect(isRecoveredMockCollision(collision, scope)).toBe(true);
  });

  it('drops a collision whose message names no identifier it can read', () => {
    // An engine wording none of the patterns match. Wide is the safe
    // direction: the narrow answer files the noise again, and this is still
    // inside an insert about to be retried.
    const scope: SwapScope = {};
    enterRecoverableInsert(SOURCE, scope);
    expect(
      isRecoveredMockCollision({ message: 'SyntaxError: cannot redeclare that thing' }, scope),
    ).toBe(true);
  });

  it('sends a runtime SyntaxError even inside the window', () => {
    const scope: SwapScope = {};
    enterRecoverableInsert(SOURCE, scope);
    expect(
      isRecoveredMockCollision(report('SyntaxError', 'Unexpected end of JSON input'), scope),
    ).toBe(false);
  });

  it('sends the collision again once the insert has finished', () => {
    const scope: SwapScope = {};
    leaveRecoverableInsert(enterRecoverableInsert(SOURCE, scope), scope);
    expect(isRecoveredMockCollision(collision, scope)).toBe(false);
  });
});
