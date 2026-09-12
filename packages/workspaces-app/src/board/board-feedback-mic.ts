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
import { SIGN_IN_NOTE, addMic } from '@claude-workspaces/widget/mic';
import { FEEDBACK_MIC_ICON } from '../icons.ts';
import {
  type OriginFacts,
  type RecognitionLike,
  VOICE_SEND_FAILED,
  type VoiceAck,
  type VoiceCapture,
  createVoiceCapture,
} from '../voice-capture.ts';

/**
 * What each button says on hover — whose feedback it takes.
 *
 * All three carry "not this project", because that is the thing a reader gets
 * wrong: the buttons sit on a board about somebody's work, and they are about
 * the app the board is drawn in. Two of them said so and the history button
 * did not, which made it read as the odd one that WAS about the project.
 */
export const FEEDBACK_LABELS = {
  comment: 'Feedback on the Workspaces app, not this project — click anything',
  voice: 'Voice feedback on the Workspaces app, not this project — hold to talk',
  history: 'Feedback on the Workspaces app, not this project — what has been said so far',
  icon: FEEDBACK_MIC_ICON,
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
  /**
   * Post what was heard — and, when the workspace refuses it because nobody
   * is signed in, KEEP it.
   *
   * A refusal used to come back as a bare `null`, which the capture reports as
   * "Voice request failed — try again", and the sentence was gone: saying it
   * again is the whole of the retry, and on a phone that is the most expensive
   * thing the app can ask for. The typed composer has never done this — it
   * holds the draft and says so — so the spoken one says the same sentence and
   * posts itself once the sign-in lands.
   *
   * `signInToWrite` is set by the widget's own 401 handling before this
   * resolves, so the two cases are told apart by what the widget now knows
   * rather than by guessing from a boolean.
   */
  const post = async (text: string): Promise<VoiceAck | null> => {
    if (await widget.postNewThread({ kind: 'subject' }, text)) {
      return { route: 'feedback', ack: `Sent as Workspaces feedback: “${text}”` };
    }
    if (!widget.signInToWrite || widget.authToken) return null;
    // Chained, never assigned over. The widget holds ONE retry slot and the
    // typed composer arms it too, so a plain assignment here would answer
    // "your draft is kept" to two people and keep the later one — which is
    // the sentence-losing bug this whole change exists to end, rebuilt one
    // layer up. Held utterances run oldest first, and the widget clears the
    // slot once the chain has run.
    const earlier = widget.retryAfterSignIn;
    widget.retryAfterSignIn = () => {
      earlier?.();
      void post(text).then((ack) => capture.say(ack ? ack.ack : VOICE_SEND_FAILED));
    };
    return { route: 'feedback', ack: SIGN_IN_NOTE };
  };
  const capture = createVoiceCapture({
    button,
    indicator: readout,
    spaceHotkey: false,
    getContext: () => ({ surface: 'board' }),
    send: (text) => post(text),
    ...opts,
  });
  return capture;
}

/** The board's `loadWidget`. The import upgrades the element the shell
 *  rendered, which builds its buttons, so the mic has a slot to take. */
export function mountFeedbackWidget(doc: Document): void {
  const el = doc.querySelector('claude-feedback-widget');
  if (el instanceof FeedbackWidgetEl) mountFeedbackMic(el);
}
