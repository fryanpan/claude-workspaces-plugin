import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { labelDirection } from '../src/doc/doc-rename.ts';
import { IPAD, PHONE, attach, installSheets, setViewport, styleOf } from './css-harness.ts';

/**
 * A meeting's NAME is set in the prose face; a file PATH keeps the mono one.
 *
 * `.doc-path` is one element doing two jobs. For a path the monospace face is
 * the right answer — even columns, l and 1 apart, the file name scannable —
 * and it arrived when the crumb only ever held a path. A doc now shows its
 * title there, and "Riverbend permit review with the Harborlight planning
 * office" came out reading like a line of terminal output in the top bar.
 *
 * The question is already answered in the markup: `labelDirection` puts
 * `dir="rtl"` on a label with a slash in it, for the truncation trick that
 * keeps a path's file name on screen, and `dir="ltr"` on everything else. So
 * the face follows `dir`, and these cases pin both halves — including that the
 * renderer really does hand the crumb the dir these rules key on, which a
 * stylesheet alone cannot promise.
 *
 * Read off the cascade rather than out of the file: the mono declaration is on
 * the base rule and the override is a later, more specific one, so only the
 * computed value says which wins. happy-dom resolves the cascade; it lays
 * nothing out, and nothing here needs it to.
 *
 * All fixtures synthetic: Riverbend and Harborlight are place names.
 */

let cleanup = () => {};
beforeEach(() => {
  cleanup = installSheets('board.css', 'styles.css');
});
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

const NAME = 'Riverbend permit review with the Harborlight planning office';
const PATH = 'docs/notes/riverbend.md';

/** The crumb label as the review topbar renders it, at `vp`. */
function crumbLabel(vp: { width: number; height: number }, label: string): CSSStyleDeclaration {
  setViewport(vp);
  const crumb = attach('doc-crumb');
  const el = attach('doc-path', {
    tag: 'span',
    parent: crumb,
    attrs: { dir: labelDirection(label) },
  });
  el.textContent = label;
  return styleOf(el);
}

const isMono = (family: string): boolean => /mono/i.test(family);

describe('the face the top bar sets a doc label in', () => {
  for (const [name, vp] of [
    ['430', PHONE],
    ['1180', IPAD],
  ] as const) {
    it(`sets a meeting's name in the prose face at ${name}`, () => {
      const s = crumbLabel(vp, NAME);
      expect(isMono(s.fontFamily)).toBe(false);
      // The same rule is what puts the ellipsis at the end of a name.
      expect(s.direction).toBe('ltr');
    });

    /** THE CONTROL: a path at the same width keeps the mono face, so the case
     *  above is about names and not about the sheet having lost the rule. */
    it(`keeps a file path in the mono face at ${name}`, () => {
      const s = crumbLabel(vp, PATH);
      expect(isMono(s.fontFamily)).toBe(true);
      expect(s.direction).toBe('rtl');
    });
  }

  it('asks the renderer, not the test, which of the two a label is', () => {
    expect(labelDirection(NAME)).toBe('ltr');
    expect(labelDirection(PATH)).toBe('rtl');
  });
});
