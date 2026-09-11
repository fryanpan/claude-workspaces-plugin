import { describe, expect, it } from 'vitest';
import { DEFAULT_NOTES_INSTRUCTIONS } from '../packages/server/src/notes-prompt-store.ts';
import { VARIANTS, resolveVariant } from './notes-eval-variants.ts';

/**
 * The eval's variants are built when the module loads, and each one that
 * rewrites the notes prompt finds its place by an exact sentence — `swap`
 * throws when that sentence is gone. So a reworded default breaks
 * `bun run notes:eval` before the first API call. Importing the module here
 * runs every swap without calling the API, which is the whole check: this
 * file fails to load when an anchor stops resolving.
 */
describe('the eval variants, against the shipped notes prompt', () => {
  it('every variant resolves', () => {
    for (const name of Object.keys(VARIANTS)) {
      expect(resolveVariant(name).name).toBe(name);
    }
  });

  it('every variant that rewrites the prompt really changed it', () => {
    // A swap that silently matched nothing would measure the baseline twice.
    const rewriting = Object.values(VARIANTS).filter((v) => v.instructions !== undefined);
    expect(rewriting.length).toBeGreaterThan(0);
    for (const v of rewriting) {
      expect([v.name, v.instructions === DEFAULT_NOTES_INSTRUCTIONS]).toEqual([v.name, false]);
    }
  });

  it('the shipped ledger methods write in two layers', () => {
    for (const name of ['method:ledger-haiku', 'method:ledger-opus']) {
      expect(resolveVariant(name).instructions).toContain('### Two layers');
    }
    expect(resolveVariant('method:original').instructions).toBeUndefined();
  });
});
