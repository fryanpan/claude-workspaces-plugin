/**
 * The board's comment widget, with voice feedback beside it.
 *
 * The widget on the board is not about the project on the board: its doc is
 * the Workspaces feedback doc (`BOARD_FEEDBACK_DOC_ID`, `shells.ts`), so what
 * it takes is feedback on the app itself. The owner's words (2026-09-11):
 * "Replace the feedback history button with a button that initiates voice
 * feedback. On hover, both buttons should clearly indicate that they're
 * feedback buttons for the workspace. Not for this particular project."
 *
 * So this is the board's `loadWidget`: import the widget, then give its one
 * element the mic (`@claude-workspaces/widget/mic`) and voice feedback
 * (`@claude-workspaces/widget/voice`) — the same tap-to-talk a mock page
 * fetches on its first tap, imported here directly because the board bundles
 * the widget itself. Talking about the board lands as comments on the board
 * elements named, through the widget, so they carry its identity.
 *
 * Loaded lazily by `board-entry.ts`, like the widget it imports, so none of
 * this is in the board's first chunk.
 */
import { FeedbackWidgetEl } from '@claude-workspaces/widget';
import { addMic } from '@claude-workspaces/widget/mic';
import {
  type VoiceMode,
  type VoiceModeOpts,
  mountVoiceMode,
} from '@claude-workspaces/widget/voice';
import { FEEDBACK_MIC_ICON } from '../icons.ts';

/**
 * What each button says on hover — whose feedback it takes.
 *
 * All three carry "not this project", because that is the thing a reader gets
 * wrong: the buttons sit on a board about somebody's work, and they are about
 * the app the board is drawn in. Two of them said so and the history button
 * did not, which made it read as the odd one that WAS about the project.
 */
export const FEEDBACK_LABELS = {
  comment: 'Type: feedback on the Workspaces app, not this project — click anything',
  voice: 'Talk: voice feedback on the Workspaces app, not this project',
  history: 'Feedback on the Workspaces app, not this project — what has been said so far',
  icon: FEEDBACK_MIC_ICON,
};

/** Mic and voice feedback on this widget. */
export function mountFeedbackMic(widget: FeedbackWidgetEl, opts: VoiceModeOpts = {}): VoiceMode {
  return mountVoiceMode(widget, addMic(widget, FEEDBACK_LABELS), opts);
}

/** The board's `loadWidget`. The import upgrades the element the shell
 *  rendered, which builds its buttons, so the mic has a slot to take. */
export function mountFeedbackWidget(doc: Document): void {
  const el = doc.querySelector('claude-feedback-widget');
  if (el instanceof FeedbackWidgetEl) mountFeedbackMic(el);
}
