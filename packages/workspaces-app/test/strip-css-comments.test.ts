/**
 * The build's stylesheet copy (scripts/strip-css-comments.ts): comments go,
 * every rule and value stays.
 */
import { describe, expect, it } from 'vitest';
import { stripCssComments } from '../scripts/strip-css-comments.ts';

describe('stripCssComments', () => {
  it('drops block comments, blank lines and indentation', () => {
    const css = '/* banner */\n\n.a {\n  /* why */\n  color: red; /* trailing */\n}\n';
    expect(stripCssComments(css)).toBe('.a {\ncolor: red;\n}\n');
  });

  it('keeps a comment opener that sits inside a quoted string', () => {
    const css = `.b { content: "/* not a comment */"; background: url('a/*b.svg'); }`;
    expect(stripCssComments(css)).toBe(`${css}\n`);
  });

  it('keeps an escaped quote inside a string', () => {
    const css = `.c { content: "say \\"/*hi*/\\""; }`;
    expect(stripCssComments(css)).toBe(`${css}\n`);
  });

  it('keeps every rule in its order across a multi-line comment', () => {
    const css = '.x{a:1}\n/* one\n two\n*/\n.y{b:2}\n.x{a:3}';
    expect(stripCssComments(css)).toBe('.x{a:1}\n.y{b:2}\n.x{a:3}\n');
  });
});
