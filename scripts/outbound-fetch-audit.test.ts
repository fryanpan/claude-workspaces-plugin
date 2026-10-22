/**
 * The outbound-fetch gate, on fixtures rather than this repo: a test that
 * asserted the real tree is clean would pass the day the tree was clean and
 * never show the check still works. Each flagged shape has a legal twin
 * beside it, so a check that flagged everything fails as loudly as one that
 * flagged nothing.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { audit, findingsIn } from './outbound-fetch-audit';

const lines = (src: string): number[] => findingsIn('f.ts', src).map((f) => f.line);

describe('findingsIn', () => {
  it('flags a bare call, a default and a shorthand', () => {
    const src = [
      'await fetch(url);',
      'const f = opts.fetch ?? fetch;',
      'make({ fetch });',
      'function g(get: typeof fetch = fetch) {}',
    ].join('\n');
    expect(lines(src)).toEqual([1, 2, 3, 4]);
  });

  it("flags the global's other spellings", () => {
    const src = [
      'globalThis.fetch(url);',
      "globalThis['fetch'](url);",
      'const f = Bun.fetch;',
      'window.fetch(url);',
    ].join('\n');
    expect(lines(src)).toEqual([1, 2, 3, 4]);
  });

  it('flags a call wrapped across lines once, at its start', () => {
    expect(lines('const r = await fetch(\n  url,\n  { method: "POST" },\n);')).toEqual([1]);
  });

  it('passes an injected function, a property or method named fetch, and a type', () => {
    const src = [
      'await opts.fetch(url);',
      'Bun.serve({ fetch: () => new Response() });',
      'const o = { async fetch(req: Request) { return req; } };',
      'type F = typeof fetch;',
      'let f: typeof fetch | undefined;',
      'interface I { fetch?: typeof fetch }',
      'const { fetch: injected } = deps;',
    ].join('\n');
    expect(lines(src)).toEqual([]);
  });

  it('passes a local binding that shadows the global, and only inside its scope', () => {
    const src = [
      'function a(fetch: F) { return fetch(url); }',
      'function b() { const fetch = deps.fetch; return fetch(url); }',
      'fetch(url);',
    ].join('\n');
    expect(lines(src)).toEqual([3]);
  });

  it('passes text in strings, templates and comments', () => {
    const src = [
      "const s = 'fetch(url)';",
      'const page = `<script>fetch("/api")</script>`;',
      '// fetch(url) would be bad',
      '/* globalThis.fetch(url) */',
    ].join('\n');
    expect(lines(src)).toEqual([]);
  });
});

describe('audit', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('exempts the guard module and names every other file that fetches', () => {
    const root = mkdtempSync(join(tmpdir(), 'outbound-fetch-'));
    dirs.push(root);
    const src = join(root, 'packages', 'server', 'src');
    mkdirSync(join(src, 'routes'), { recursive: true });
    writeFileSync(join(src, 'outbound-fetch.ts'), 'export const f = globalThis.fetch;\n');
    writeFileSync(join(src, 'clean.ts'), "import { publicFetch } from './outbound-fetch.ts';\n");
    writeFileSync(join(src, 'routes', 'leaky.ts'), '\nexport const r = () => fetch("x");\n');
    expect(audit(root)).toEqual([
      {
        file: 'packages/server/src/routes/leaky.ts',
        line: 2,
        text: 'export const r = () => fetch("x");',
      },
    ]);
  });
});
