/**
 * The shell's modulepreload links (scripts/module-preload.ts): every chunk the
 * entry reaches through static imports, and none it only reaches lazily.
 */
import { describe, expect, it } from 'vitest';
import {
  injectModulePreloads,
  staticChunkClosure,
  staticImports,
} from '../scripts/module-preload.ts';

describe('staticImports', () => {
  it('finds minified static imports and skips dynamic ones', () => {
    const code =
      'import{a as b}from"./chunk-aaaa1111.js";import"./side-bbbb2222.js";' +
      'import*as c from"./ns-cccc3333.js";const m=()=>import("./lazy-dddd4444.js");';
    expect(staticImports(code).sort()).toEqual([
      'chunk-aaaa1111.js',
      'ns-cccc3333.js',
      'side-bbbb2222.js',
    ]);
  });
  it('ignores bare package specifiers', () => {
    expect(staticImports('import x from"yjs";')).toEqual([]);
  });
});

describe('staticChunkClosure', () => {
  it('follows chunks through each other, once each', () => {
    const files: Record<string, string> = {
      'app.js': 'import"./a-11111111.js";import"./b-22222222.js";',
      'a-11111111.js': 'import"./c-33333333.js";',
      'b-22222222.js': 'import"./c-33333333.js";',
      'c-33333333.js': 'const l=()=>import("./lazy-44444444.js");',
    };
    expect(staticChunkClosure('app.js', (n) => files[n] ?? null)).toEqual([
      'a-11111111.js',
      'b-22222222.js',
      'c-33333333.js',
    ]);
  });
});

describe('injectModulePreloads', () => {
  it('adds one link per chunk inside the head', () => {
    const html = '<html><head><title>x</title></head><body></body></html>';
    const out = injectModulePreloads(html, ['a-11111111.js']);
    const head = out.slice(0, out.indexOf('</head>'));
    expect(head).toContain('<link rel="modulepreload" href="/app/a-11111111.js" />');
  });
  it('leaves the shell alone when there is nothing to preload', () => {
    const html = '<html><head></head></html>';
    expect(injectModulePreloads(html, [])).toBe(html);
  });
});
