// Anchor leaves, not the `anchors` namespace — see widget-threads.ts.
import { resolve } from '@claude-workspaces/core/anchor/element';
import { DRAFTS_ARRIVED, draftKey, readDraft } from './draft-store.ts';
import { type CommentDraft, drafts } from './widget-card.ts';
import { enterFeedbackMode, setHighlight, showComposer } from './widget-picker.ts';
import type { FeedbackWidgetEl } from './widget.ts';

/**
 * Bring back the comment a reload interrupted (`draft-store.ts`): the mode
 * and the composer as they were, on the element its anchor finds, with the
 * words in it. A draft whose element this page no longer has still comes
 * back, resting where a card with no element rests, and posts on its anchor.
 * A draft the mode had closed over waits on its element again.
 *
 * Read at load, when the page's own content is there to resolve against, and
 * again when a sandboxed frame's drafts arrive from the page holding it.
 */
export function restoreDraft(el: FeedbackWidgetEl): void {
  const go = (): void => {
    const d = readDraft<CommentDraft>(draftKey('comment', el.opts.docId));
    if (!d?.t || !d.a || el.shadow.querySelector('.composer')) return;
    const r = resolve(d.a, { root: document });
    const t = r.ok ? r.element : null;
    if (!d.o) {
      if (t) drafts.set(t, d.t);
      return;
    }
    enterFeedbackMode(el);
    if (t) {
      el.hoverEl = t;
      setHighlight(el, t);
    }
    showComposer(el, d.a, t ?? document.createElement('p'), d.t);
  };
  if (document.readyState === 'complete') go();
  else addEventListener('load', go, { once: true });
  addEventListener(DRAFTS_ARRIVED, go);
}
