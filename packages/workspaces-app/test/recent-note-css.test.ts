import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IPAD, installSheets, setViewport, styleOf } from './css-harness.ts';

/**
 * The recent-note tint's stylesheet contract (settle-wash.ts decorates,
 * doc.css paints). Read off the cascade: step 0 is louder than step 3, and
 * a line with no step carries no tint at all.
 */

let cleanup = () => {};
beforeEach(() => {
  cleanup = installSheets('styles.css', 'doc.css');
  setViewport(IPAD);
});
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

/** A tinted line where the editor puts one: #editor > .ProseMirror > p. */
function tintedLine(age: string | null): HTMLElement {
  const editor = document.createElement('div');
  editor.id = 'editor';
  const pm = document.createElement('div');
  pm.className = 'ProseMirror';
  const p = document.createElement('p');
  p.className = 'recent-note';
  if (age !== null) p.setAttribute('data-age', age);
  pm.appendChild(p);
  editor.appendChild(pm);
  document.body.appendChild(editor);
  return p;
}

describe('the recent-note tint', () => {
  it('step 0 is the loud one and step 3 the quiet one', () => {
    const w = (age: string) => styleOf(tintedLine(age)).getPropertyValue('--recent-w').trim();
    expect(w('0')).toBe('1');
    expect(Number(w('3'))).toBeLessThan(Number(w('1')));
    expect(Number(w('3'))).toBeGreaterThan(0);
  });

  it('a line with no step has no weight — the cascade never reaches it', () => {
    expect(styleOf(tintedLine(null)).getPropertyValue('--recent-w').trim()).toBe('');
  });
});
