import type * as Y from 'yjs';
import type { Anchor, ElementAnchor, TextRangeAnchor } from '../types.ts';
import * as Element from './element.ts';
import * as TextRange from './text-range.ts';

export * from './context.ts';
export * from './validate.ts';
export { TextRange, Element };

export interface TextResolveEnv {
  doc: Y.Doc;
  ytext: Y.Text;
}

export interface ElementResolveEnv {
  root: ParentNode;
}

export type TextResolution =
  | { ok: true; start: number; end: number }
  | { ok: false; reason: 'deleted' };

export type ElementResolution =
  | { ok: true; element: HTMLElement; score: number }
  | { ok: false; reason: 'not-found' | 'low-confidence'; score: number };

export function resolveText(anchor: TextRangeAnchor, env: TextResolveEnv): TextResolution {
  return TextRange.resolve(anchor, env);
}

export function resolveElement(anchor: ElementAnchor, env: ElementResolveEnv): ElementResolution {
  return Element.resolve(anchor, env);
}

/** Convenience: classify an anchor as orphan eligible. A subject anchor
 *  resolves to the document itself, so there is nothing to resolve and
 *  nothing that can break; a review-item anchor points into a sidecar string
 *  no Yjs position tracks, so the same holds. */
export function isResolvable(anchor: Anchor): boolean {
  return anchor.kind !== 'orphan' && anchor.kind !== 'subject' && anchor.kind !== 'review-item';
}

// Defined in the leaf that uses it, re-exported here for the callers that
// read it off the barrel. It used to live here and be imported BACK by
// element.ts, which made the barrel and the leaf a runtime cycle — the shape
// that took every doc page down in PR 817. `bun run check:import-cycles`.
export { SCORE_THRESHOLD } from './element.ts';
