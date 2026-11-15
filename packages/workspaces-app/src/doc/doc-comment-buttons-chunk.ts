/**
 * The widget behind a doc's corner buttons (`doc-comment-buttons.ts`), in a
 * chunk of its own.
 *
 * Imported into the doc's bundle rather than fetched as `/widget.iife.js`,
 * for the board's reason (`board/board-feedback-mic.ts`): that bundle carries
 * its own copy of Yjs, and two on one page is the "Yjs was already imported"
 * warning. The import defines the element, which upgrades the one already on
 * the page and builds its buttons; the mic and the thread list then take
 * their places beside them, worded for a doc.
 *
 * No pencil. On a mock it lets a reader retype the page's words and send them
 * to the agent; a doc's words are already editable in place, and a second
 * edit mode would retype the editor's DOM under it.
 */
import { FeedbackWidgetEl } from '@claude-workspaces/widget';
import { type MicLabels, addMic } from '@claude-workspaces/widget/mic';
import { mountPageList } from '@claude-workspaces/widget/page-list';
import { mountVoiceMode } from '@claude-workspaces/widget/voice';
import { MIC_ICON } from '../icons.ts';

/** What each button says on hover: about this doc. */
export const DOC_LABELS: MicLabels = {
  comment: 'Type: comment on this doc — click anything',
  voice: 'Talk: voice feedback on this doc',
  history: 'Past comments on this doc',
  icon: MIC_ICON,
};

/** Give the doc's widget its mic and thread list. */
export function mountDocWidget(el: HTMLElement): void {
  if (!(el instanceof FeedbackWidgetEl) || !el.isConnected) return;
  mountVoiceMode(el, addMic(el, DOC_LABELS));
  mountPageList(el);
}
