import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { minifyCss } from '../scripts/minify-css.ts';

/**
 * The build minifies the widget stylesheet into the bundle, because a JS
 * minifier will not look inside a template literal and the widget ships under
 * a hard gzipped budget. A wrong rewrite here is invisible to the tests that
 * import `widgetStyles` — they get the string after the template has already
 * been evaluated — and shows up only as broken styling on a host page.
 *
 * So these drive the transform directly, and the second block drives it over
 * the same input the build plugin gives it: the RAW source text of the
 * literal, `${STATUS_COLORS.open}` and all. That is the reason for reading
 * the file rather than importing the module — an imported `widgetStyles` has
 * no interpolations left in it to preserve.
 */

// The stylesheet is this transform's INPUT, not its subject. Nothing below
// asserts anything about what `styles.ts` says — every assertion compares
// `minifyCss(rawCss)` against `rawCss`, so a renamed selector, a deleted rule
// or a reworded declaration changes both sides and cannot make a case pass or
// fail. Same standing as the `fixtures/` carve-out, except that the sample has
// to be the REAL stylesheet: a copy would drift, and the break this catches —
// a `${…}` interpolation mangled in the text the build actually feeds the
// minifier — only exists in the live file.
// audit: not-source — parser input, not the subject; every assertion is a
// relation between the input and the transform's output
const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
/** Every sheet the build feeds the minifier — its filter is `styles*.ts`. */
const SHEETS = ['styles.ts', 'styles-dock.ts'];
const rawCss = SHEETS.map(
  (f) => readFileSync(join(srcDir, f), 'utf8').match(/export const \w+ = `([\s\S]*?)`;/)?.[1],
).join('\n');

describe('minifyCss', () => {
  it('drops comments, newlines and indentation', () => {
    expect(minifyCss('/* note */\n.a {\n  color: red;\n}\n')).toBe('.a{color:red}');
  });

  it('keeps the descendant combinator between two selectors', () => {
    expect(minifyCss('.a .b { color: red; }')).toBe('.a .b{color:red}');
  });

  it('keeps the space inside calc(), where it is an operator', () => {
    expect(minifyCss('.a { width: calc(100% - 12px); }')).toBe('.a{width:calc(100% - 12px)}');
  });

  it('keeps a comma-separated font stack readable to the parser', () => {
    expect(minifyCss('.a { font-family: Segoe UI, system-ui, sans-serif; }')).toBe(
      '.a{font-family:Segoe UI,system-ui,sans-serif}',
    );
  });

  it('leaves a ${} interpolation byte-for-byte alone', () => {
    expect(minifyCss('.a { background: ${STATUS_COLORS.open}; }')).toBe(
      '.a{background:${STATUS_COLORS.open}}',
    );
  });

  it('does not collapse whitespace or punctuation inside an interpolation', () => {
    expect(minifyCss('.a { color: ${pick(a, b) > 1 ? x : y}; }')).toContain(
      '${pick(a, b) > 1 ? x : y}',
    );
  });

  it('keeps the trailing space inside a quoted content string', () => {
    // The comment card draws "on " before an element's name and "✓ " before
    // a tick; lose the space and the name runs into the word.
    expect(minifyCss('.a::before { content: "on "; }')).toBe('.a::before{content:"on "}');
  });

  it('is idempotent', () => {
    const once = minifyCss('/* c */\n.a {\n  color: red;\n}\n.b .c { width: calc(1px + 2px); }');
    expect(minifyCss(once)).toBe(once);
  });

  describe('over the stylesheet the build actually feeds it', () => {
    it('found a literal in every sheet the build minifies', () => {
      // A renamed or reshaped sheet would otherwise silently narrow every
      // case below to whatever still matched — and the build's own filter
      // would keep minifying a file these assertions no longer read.
      for (const f of SHEETS) {
        const one = readFileSync(join(srcDir, f), 'utf8').match(/export const \w+ = `([\s\S]*?)`;/);
        expect(one?.[1], `no stylesheet literal in ${f}`).toBeTypeOf('string');
      }
    });

    it('preserves every interpolation the source declares', () => {
      const source = rawCss.match(/\$\{[^}]*\}/g) ?? [];
      expect(source.length).toBeGreaterThan(0);
      expect(minifyCss(rawCss).match(/\$\{[^}]*\}/g)).toEqual(source);
    });

    it('preserves every selector block', () => {
      const braces = (s: string) => (s.match(/\{/g) ?? []).length;
      // `${...}` contributes an opening brace of its own; count only rule blocks.
      const rules = (s: string) => braces(s) - (s.match(/\$\{/g) ?? []).length;
      expect(rules(minifyCss(rawCss))).toBe(rules(rawCss as string));
    });

    it('preserves every declaration', () => {
      const decls = (s: string) => (s.match(/[a-z-]+\s*:\s*[^;{}]+/g) ?? []).length;
      expect(decls(minifyCss(rawCss))).toBe(decls(rawCss as string));
    });

    it('gets meaningfully smaller', () => {
      const min = minifyCss(rawCss);
      expect(min.length).toBeLessThan(rawCss.length * 0.9);
    });

    it('leaves no minifier sentinel behind', () => {
      expect(minifyCss(rawCss)).not.toContain('__CSSHOLE');
    });
  });
});
