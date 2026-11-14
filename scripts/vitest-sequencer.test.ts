/**
 * The browser-gate signal and the table key the duration sequencer uses.
 * The split and the order themselves are `vitest-shard.test.ts`.
 *
 * audit: no-text — the reader is injected; nothing here reads a source file.
 */
import { describe, expect, it } from 'vitest';
import { callsBrowserGate, specKey } from './vitest-sequencer.ts';

describe('specKey', () => {
  it('is the project and the repo-relative path', () => {
    expect(specKey('dom', '/repo', '/repo/packages/widget/test/a.test.ts')).toBe(
      'dom:packages/widget/test/a.test.ts',
    );
  });
});

describe('callsBrowserGate', () => {
  const text: Record<string, string> = {
    gated: "const CHROME = chromeForSuite();\ndescribe.skipIf(CHROME === null)('x', () => {});",
    named: "// see chromeForSuite in scripts/browser-tests.ts\nit('x', () => {});",
    plain: "it('x', () => {});",
  };
  const read = (p: string) => {
    const t = text[p];
    if (t === undefined) throw new Error(`ENOENT ${p}`);
    return t;
  };

  it('is true for a file that calls the gate', () => {
    expect(callsBrowserGate('gated', read)).toBe(true);
  });

  it('is false for a file that only names it, or never mentions it', () => {
    expect(callsBrowserGate('named', read)).toBe(false);
    expect(callsBrowserGate('plain', read)).toBe(false);
  });

  it('is false, not a throw, for a file it cannot read', () => {
    expect(callsBrowserGate('missing', read)).toBe(false);
  });
});
