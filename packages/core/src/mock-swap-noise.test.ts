import { describe, expect, it } from 'vitest';
import {
  type SwapScope,
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
    enterRecoverableInsert(scope);
    expect(insideRecoverableInsert(scope)).toBe(true);
    leaveRecoverableInsert(scope);
    expect(insideRecoverableInsert(scope)).toBe(false);
  });

  it('survives a nested insert lowering it — the outer window is still up', () => {
    const scope: SwapScope = {};
    enterRecoverableInsert(scope);
    enterRecoverableInsert(scope);
    leaveRecoverableInsert(scope);
    // A boolean would have gone down here and let the outer insert's own
    // collision through, which is the whole reason this is a depth.
    expect(insideRecoverableInsert(scope)).toBe(true);
    leaveRecoverableInsert(scope);
    expect(insideRecoverableInsert(scope)).toBe(false);
  });

  it('cannot be driven below zero by an unpaired leave', () => {
    const scope: SwapScope = {};
    leaveRecoverableInsert(scope);
    leaveRecoverableInsert(scope);
    enterRecoverableInsert(scope);
    expect(insideRecoverableInsert(scope)).toBe(true);
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

describe('the verdict beforeSend reads', () => {
  const collision = report('SyntaxError', "Identifier 'params' has already been declared");

  it('drops a collision raised inside the insert that will be retried', () => {
    const scope: SwapScope = {};
    enterRecoverableInsert(scope);
    expect(isRecoveredMockCollision(collision, scope)).toBe(true);
  });

  it('sends the same collision when no insert raised the window', () => {
    // The mutation control for the case above: turn the flag off and the
    // identical report is filed. A filter that silences a collision the swap
    // never retried is a regression, not a fix.
    expect(isRecoveredMockCollision(collision, {})).toBe(false);
  });

  it('sends a runtime SyntaxError even inside the window', () => {
    const scope: SwapScope = {};
    enterRecoverableInsert(scope);
    expect(
      isRecoveredMockCollision(report('SyntaxError', 'Unexpected end of JSON input'), scope),
    ).toBe(false);
  });

  it('sends the collision again once the insert has finished', () => {
    const scope: SwapScope = {};
    enterRecoverableInsert(scope);
    leaveRecoverableInsert(scope);
    expect(isRecoveredMockCollision(collision, scope)).toBe(false);
  });
});
