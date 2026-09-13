import { describe, expect, it } from 'vitest';
import { EXCLUDED_MODULES, assertBundleExcludes } from '../scripts/bundle-guard.ts';

/**
 * The build refuses a widget bundle whose source map names a module it was
 * measured without. These drive the check over source lists shaped the way
 * Bun writes them — paths relative to `packages/widget/dist` — because a check
 * whose suffix match never fires would pass every bundle and look identical to
 * one that works.
 */

const kept = [
  '../../../node_modules/.bun/yjs@13.6.30/node_modules/yjs/dist/yjs.mjs',
  '../../core/src/anchor/element.ts',
  '../../core/src/anchor/context.ts',
  '../src/widget.ts',
];

describe('assertBundleExcludes', () => {
  it('passes a bundle holding only the modules the widget uses', () => {
    expect(() => assertBundleExcludes(kept, 'widget.iife.js')).not.toThrow();
  });

  it('refuses the anchor barrel and its text-range leaves, naming each and the fix', () => {
    const regrown = [
      ...kept,
      '../../core/src/anchor/index.ts',
      '../../core/src/anchor/text-range.ts',
      '../../core/src/anchor/validate.ts',
    ];
    expect(() => assertBundleExcludes(regrown, 'widget.iife.js')).toThrow(
      /widget\.iife\.js contains modules[\s\S]*anchor\/index\.ts[\s\S]*anchor\/element[\s\S]*anchor\/text-range\.ts[\s\S]*anchor\/validate\.ts/,
    );
  });

  it('matches a node_modules path whatever the store prefix, and Windows separators', () => {
    expect(() =>
      assertBundleExcludes(
        [...kept, '..\\..\\..\\node_modules\\.bun\\lib0@0.2.117\\node_modules\\lib0\\schema.js'],
        'widget.esm.js',
      ),
    ).toThrow(/lib0\/schema\.js/);
  });

  it('does not take a module whose name merely ends the same way', () => {
    // Matched at a `/`: a package called `not-lib0` is not lib0.
    expect(() =>
      assertBundleExcludes([...kept, '../../node_modules/not-lib0/dom.js'], 'widget.iife.js'),
    ).not.toThrow();
  });

  it('refuses a map it read no sources from rather than passing it', () => {
    expect(() => assertBundleExcludes([], 'widget.iife.js')).toThrow(/naming no sources/);
  });

  it('holds every module it names to that rule', () => {
    for (const { module } of EXCLUDED_MODULES) {
      expect(() => assertBundleExcludes([...kept, `../../x/${module}`], 'b.js')).toThrow(module);
    }
  });
});
