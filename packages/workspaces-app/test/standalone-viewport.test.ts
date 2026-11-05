// @vitest-environment happy-dom
/**
 * After a text field blurs in a home-screen app, the body leaves layout and
 * comes back, so iOS re-measures a viewport the keyboard left short. Whether
 * that cures the iPhone is the owner's check; this holds when it runs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HEAL_DELAY_MS, wireStandaloneViewportHeal } from '../src/standalone-viewport.ts';

/** Stands in for a window, on its own document so no listener outlives a case. */
function fakeWindow(doc: Document, standalone: boolean) {
  const scrollTo = vi.fn();
  return {
    win: {
      document: doc,
      scrollY: 700,
      scrollTo,
      navigator: { standalone },
      matchMedia: () => ({ matches: false }),
      setTimeout: (fn: () => void, ms: number) => window.setTimeout(fn, ms),
    } as unknown as Window,
    scrollTo,
  };
}

describe('the re-measure after a text field blurs', () => {
  /** The body's display each time something forces layout. */
  let forced: string[];
  let doc: Document;
  let field: HTMLTextAreaElement;
  const blur = () => {
    field.dispatchEvent(new FocusEvent('focusout', { bubbles: true, composed: true }));
    vi.advanceTimersByTime(HEAL_DELAY_MS);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    forced = [];
    doc = document.implementation.createHTMLDocument();
    field = doc.createElement('textarea');
    doc.body.append(field);
    Object.defineProperty(doc.body, 'offsetHeight', {
      get: () => {
        forced.push(doc.body.style.display);
        return 0;
      },
    });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('takes the body out of layout and back, keeping the scroll position', () => {
    const { win, scrollTo } = fakeWindow(doc, true);
    wireStandaloneViewportHeal(win);
    blur();
    expect(forced).toEqual(['none']);
    expect(doc.body.style.display).toBe('');
    expect(scrollTo).toHaveBeenCalledWith(0, 700);
  });

  it('leaves a page in a browser tab alone', () => {
    wireStandaloneViewportHeal(fakeWindow(doc, false).win);
    blur();
    expect(forced).toEqual([]);
  });

  it('waits while focus moved to another field, because the keyboard stays', () => {
    const next = doc.createElement('input');
    doc.body.append(next);
    wireStandaloneViewportHeal(fakeWindow(doc, true).win);
    field.dispatchEvent(new FocusEvent('focusout', { bubbles: true, composed: true }));
    next.focus();
    vi.advanceTimersByTime(HEAL_DELAY_MS);
    expect(forced).toEqual([]);
  });

  it('ignores a blur that is not a text field', () => {
    const button = doc.createElement('button');
    doc.body.append(button);
    wireStandaloneViewportHeal(fakeWindow(doc, true).win);
    button.dispatchEvent(new FocusEvent('focusout', { bubbles: true, composed: true }));
    vi.advanceTimersByTime(HEAL_DELAY_MS);
    expect(forced).toEqual([]);
  });
});
