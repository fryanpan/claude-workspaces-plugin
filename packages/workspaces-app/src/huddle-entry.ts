/**
 * The kind word in a doc's crumb — "Plan" or "Meeting notes" — and the
 * reading latch beside it. It is about the DOC (its meta says which kind it
 * is) and shows on every visit, so the router applies it beside the back
 * arrow, as shell chrome that outlives each mount.
 */

import { type HuddleKind, docKindLabel } from '@claude-workspaces/core';

/**
 * Whether this browser has been told it may only read.
 *
 * A latch, and the reason it is one: the crumb is written on EVERY
 * navigation, unconditionally, because a word left over from the last doc is
 * a wrong label on this one. So a caller that sets "Reading:" once has it
 * overwritten by the next in-place navigation, and the surface goes back to
 * announcing "Editing:" to somebody who cannot edit. The fact belongs to the
 * browser, not to the visit, so it is remembered here and re-applied by the
 * same function that would otherwise undo it.
 */
let readingOnly = false;
/** The last thing the crumb was told, so the latch can re-render it. */
let lastHuddle = false;
/** …and which kind it was, which is the word the crumb actually shows. */
let lastKind: HuddleKind | undefined;

/** Say this browser may only read, and repaint the crumb now. */
export function applyReadingCrumb(doc: Document): void {
  readingOnly = true;
  applyHuddleCrumb(doc, lastHuddle, lastKind);
}

/** Test seam — the latch is module state and outlives a single test. */
export function resetReadingCrumbForTest(): void {
  readingOnly = false;
  lastHuddle = false;
  lastKind = undefined;
}

/**
 * Name a live doc in the crumb — "Plan" or "Meeting notes" — or put
 * "Editing:" back for the next doc. Always writes every branch — navigation
 * is in place, and a word left over from the last doc is a wrong label on
 * this one.
 *
 * The kind word survives the reading latch: it names WHAT the doc is, not
 * what you may do to it. "Editing:" does not, because it claims the second
 * thing.
 *
 * The word comes from `docKindLabel`, the same function the server titles the
 * doc with, so the crumb and the title can never disagree.
 */
export function applyHuddleCrumb(doc: Document, huddle: boolean, kind?: HuddleKind): void {
  lastHuddle = huddle;
  lastKind = kind;
  const label = doc.querySelector('.doc-crumb .doc-label');
  if (!label) return;
  label.textContent = huddle ? docKindLabel(kind) : readingOnly ? 'Reading:' : 'Editing:';
  label.classList.toggle('doc-label-huddle', huddle);
}
