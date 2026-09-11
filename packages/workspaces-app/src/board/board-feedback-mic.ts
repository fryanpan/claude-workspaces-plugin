/**
 * The board's comment widget, with a microphone beside it.
 *
 * The widget on the board is not about the project on the board: its doc is
 * the Workspaces feedback doc (`BOARD_FEEDBACK_DOC_ID`, `shells.ts`), so what
 * it takes is feedback on the app itself. The owner's words (2026-09-11):
 * "Replace the feedback history button with a button that initiates voice
 * feedback. On hover, both buttons should clearly indicate that they're
 * feedback buttons for the workspace. Not for this particular project."
 *
 * So this is the board's `loadWidget`: import the widget, then give its one
 * element the mic (`@claude-workspaces/widget/mic`) and wire the board's own
 * hold-to-talk capture to it. The capture is `createVoiceCapture`, the same
 * one the voice dock runs, with `spaceHotkey` off — Space is the dock's, and
 * two captures on one press both record. What it heard lands where typed
 * feedback lands: a thread about the feedback doc as a whole (a subject
 * anchor), posted through the widget so it carries the widget's identity.
 *
 * Loaded lazily by `board-entry.ts`, like the widget it imports, so none of
 * this is in the board's first chunk.
 */
import { FeedbackWidgetEl } from '@claude-workspaces/widget';
import { addMic } from '@claude-workspaces/widget/mic';
import { MIC_ICON } from '../icons.ts';
import {
  type OriginFacts,
  type RecognitionLike,
  type VoiceCapture,
  createVoiceCapture,
} from '../voice-capture.ts';

/** What each button says on hover — whose feedback it takes. */
export const FEEDBACK_LABELS = {
  comment: 'Feedback on the Workspaces app, not this project — click anything',
  voice: 'Voice feedback on the Workspaces app, not this project — hold to talk',
  history: 'Feedback on the Workspaces app so far',
  icon: MIC_ICON,
};

export interface FeedbackMicOpts {
  createRecognition?: () => RecognitionLike | null;
  readOrigin?: () => OriginFacts;
}

/** Mic on this widget, wired to a capture that posts to its doc. */
export function mountFeedbackMic(
  widget: FeedbackWidgetEl,
  opts: FeedbackMicOpts = {},
): VoiceCapture {
  const { button, readout } = addMic(widget, FEEDBACK_LABELS);
  return createVoiceCapture({
    button,
    indicator: readout,
    spaceHotkey: false,
    getContext: () => ({ surface: 'board' }),
    send: async (text) =>
      (await widget.postNewThread({ kind: 'subject' }, text))
        ? { route: 'feedback', ack: `Sent as Workspaces feedback: “${text}”` }
        : null,
    ...opts,
  });
}

/** The board's `loadWidget`. The import upgrades the element the shell
 *  rendered, which builds its buttons, so the mic has a slot to take. */
export function mountFeedbackWidget(doc: Document): void {
  const el = doc.querySelector('claude-feedback-widget');
  if (el instanceof FeedbackWidgetEl) mountFeedbackMic(el);
}
