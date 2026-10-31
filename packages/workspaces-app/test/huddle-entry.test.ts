import { afterEach, describe, expect, it } from 'vitest';
import {
  applyHuddleCrumb,
  applyReadingCrumb,
  resetReadingCrumbForTest,
} from '../src/huddle-entry.ts';

/**
 * The kind word in the crumb — "Plan" or "Meeting notes" — is a fact about
 * the DOC (its meta), not about how it was opened: it shows on every later
 * visit too. All fixtures synthetic.
 */

describe('applyHuddleCrumb', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    resetReadingCrumbForTest();
  });
  const crumb = () => {
    document.body.innerHTML =
      '<div class="doc-crumb"><a href="/" class="back-link">←</a><span class="doc-label">Editing:</span></div>';
    return document.querySelector('.doc-crumb .doc-label') as HTMLElement;
  };

  it('names the doc by its kind in the crumb, and takes it back for the next doc', () => {
    const label = crumb();
    applyHuddleCrumb(document, true, 'discussion');
    expect(label.textContent).toBe('Meeting notes');
    expect(label.classList.contains('doc-label-huddle')).toBe(true);
    // Navigation is in-place: the next doc must not inherit the word.
    applyHuddleCrumb(document, false);
    expect(label.textContent).toBe('Editing:');
    expect(label.classList.contains('doc-label-huddle')).toBe(false);
  });

  it('says Plan on a plan doc, and falls back to Meeting notes with no kind', () => {
    // The kind is what the word is FOR: a plan doc and a meeting doc are the
    // same surface, and the crumb is the only thing that tells them apart.
    // A doc created before the kind existed is a meeting doc, which is what
    // an untyped live doc has always been.
    const label = crumb();
    applyHuddleCrumb(document, true, 'plan');
    expect(label.textContent).toBe('Plan');
    applyHuddleCrumb(document, true);
    expect(label.textContent).toBe('Meeting notes');
  });

  it('does nothing on a shell with no crumb', () => {
    document.body.innerHTML = '';
    expect(() => applyHuddleCrumb(document, true)).not.toThrow();
  });

  it('says Reading to a browser that may not write, and KEEPS saying it', () => {
    // The bug this is for: the crumb is rewritten unconditionally on every
    // in-place navigation, so setting the word once was undone by the next
    // one and the surface went back to announcing "Editing:" to somebody who
    // could not edit.
    const label = crumb();
    applyReadingCrumb(document);
    expect(label.textContent).toBe('Reading:');
    applyHuddleCrumb(document, false);
    expect(label.textContent).toBe('Reading:');
  });

  it('still names a live doc by its kind — that word is about the doc', () => {
    const label = crumb();
    applyReadingCrumb(document);
    applyHuddleCrumb(document, true, 'plan');
    expect(label.textContent).toBe('Plan');
    // And back to Reading, not to Editing, on the next ordinary doc.
    applyHuddleCrumb(document, false);
    expect(label.textContent).toBe('Reading:');
  });

  it('says Editing to everyone else', () => {
    // The control: without this, "Reading:" would also be what a signed-in
    // editor sees, which is the same bug pointing the other way.
    const label = crumb();
    applyHuddleCrumb(document, false);
    expect(label.textContent).toBe('Editing:');
  });
});
