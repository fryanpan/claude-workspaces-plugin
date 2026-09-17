/**
 * The offer to re-read a finished meeting's notes, made ON THE STRIP'S IDLE
 * LINE rather than in a dialog.
 *
 * WHY THERE IS A SECOND SURFACE FOR THIS AT ALL. `meeting-cleanup-offer.ts`
 * raises a modal the moment a recording ends, and that is right for the
 * ending a person asked for: they pressed Stop, they are looking at the
 * screen, and the question lands while the meeting is still in their head. A
 * recording that timed ITSELF out is the opposite case by construction —
 * fifteen minutes of nothing said is fifteen minutes of nobody there — so the
 * modal sits over a dimmed doc waiting for somebody to come back and dismiss
 * it before they can read anything. The notes are real, so the offer is still
 * worth making; what is wrong is making it as a question nobody is present to
 * answer.
 *
 * So the offer waits where the ending's own sentence already waits: the strip
 * carries "Recording stopped after 15 minutes without speech." on an idle
 * line for exactly this reader, and the tidy-up becomes a control beside it.
 * Nothing is dimmed, nothing has to be dismissed before the doc can be read,
 * and the offer is still one press away whenever they get back.
 *
 * WHAT THE PRESS MEANS IS UNCHANGED. The pass rewrites notes people have been
 * reading, so nothing happens until somebody presses — the press IS the
 * approval here exactly as it is in the dialog, and there is no setting that
 * makes it a default.
 */

import { type NotesCleanupReply, readCleanupReply } from '@claude-workspaces/core';
import { api } from './doc-path.ts';
import { CLEANUP_UNREACHABLE, CLEANUP_WASH_HOLD_MS } from './meeting-cleanup-offer.ts';
import type { MeetingLiveZone } from './meeting-live-zone.ts';

/** The control's label at rest. */
export const TIDY_LABEL = 'Tidy up the notes';
/** And while the pass is on the wire. */
export const TIDY_WORKING_LABEL = 'Tidying up these notes…';
/**
 * And once a pass has run and left the offer standing.
 *
 * The dialog's primary says the same word for the same reason: by then the
 * question has been answered, so the control is a repeat rather than a first
 * ask, and the recovery line beside it therefore never names a button.
 */
export const TIDY_RETRY_LABEL = 'Try again';

/**
 * What one pass did, in the two shapes the line has to act on differently.
 *
 * `changed` is the only one that ends the offer: the notes themselves are the
 * receipt, so there is nothing left for the line to report. Everything else is
 * a sentence plus the one bit that decides whether a control survives it.
 *
 * THE WORDS ARE NOT CHOSEN HERE. They come from `readCleanupReply`, which is
 * the same reader the dialog uses, so the two surfaces cannot name the same
 * reply differently — see `runMeetingTidyUp`.
 */
export type MeetingTidyOutcome =
  | { kind: 'changed' }
  /** What happened, and whether another press could plausibly answer
   *  differently. `retry: false` takes the control down for good. */
  | { kind: 'reported'; note: string; retry: boolean };

/**
 * Ask the server to re-read one meeting's notes.
 *
 * ONE READER FOR BOTH SURFACES. The reply is handed to `readCleanupReply` in
 * core — the same call the dialog makes, including for a non-2xx, which
 * carries the same shape and the same `reason`. This line used to read
 * `body.error`, a field the route does not send for a refusal: `no-composer`,
 * `recording`, `no-transcript` and `no-section` all collapsed into one
 * sentence that named no cause, and the control came back live after every
 * one of them. A server with no model key offered a press that failed
 * identically for ever with nothing on screen saying why.
 *
 * THE STRIP IS ONE LINE, so it takes the report's headline and its `retry`
 * and leaves the grouped per-edit reasons to the dialog, which has a card.
 * The headline is the cause in the dialog's own words; `retry` is what stops
 * an offer standing in front of an answer that cannot change.
 *
 * Never throws: a request that never arrived is a report like any other,
 * because the line has to say something either way.
 */
export async function runMeetingTidyUp(opts: {
  docId: string;
  meetingId: string;
  liveZone?: MeetingLiveZone;
  fetchImpl?: typeof fetch;
}): Promise<MeetingTidyOutcome> {
  const doFetch = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  // Held BEFORE the request, not after it: the first note can land while the
  // response is still on the wire, and a note that arrives untinted never
  // reaches the recent-edits list. Same hold, same window, as the dialog's.
  opts.liveZone?.holdWash(CLEANUP_WASH_HOLD_MS);
  try {
    const res = await doFetch(
      api(
        `docs/${encodeURIComponent(opts.docId)}/meetings/${encodeURIComponent(
          opts.meetingId,
        )}/notes-cleanup`,
      ),
      { method: 'POST' },
    );
    const body = (await res.json().catch(() => ({}))) as NotesCleanupReply;
    const outcome = readCleanupReply(res.ok ? body : { ...body, ok: false });
    // RAN IS NOT THE SAME AS CHANGED, and only a pass that moved the document
    // has a receipt of its own.
    if (outcome.kind === 'changed') return { kind: 'changed' };
    return { kind: 'reported', note: outcome.headline, retry: outcome.retry };
  } catch {
    // No reply at all, so core has nothing to read and nothing said anything
    // about the notes: they are untouched, and the writes happen inside the
    // request this never completed. The dialog's own words for the same case.
    return { kind: 'reported', note: CLEANUP_UNREACHABLE.headline, retry: true };
  }
}

/** The control the strip draws beside the ending's sentence. */
export interface MeetingTidyView {
  label: string;
  /** True while the pass is on the wire: the press already happened. */
  busy: boolean;
  press(): void;
}

export interface MeetingTidyLine {
  /** There are notes from this meeting worth re-reading. */
  offer(meetingId: string): void;
  /** Take the offer down — a new recording, or the line tapped away. */
  withdraw(): void;
  /** The control to draw, or null when there is nothing to offer. */
  view(): MeetingTidyView | null;
  /**
   * What the last press had to report, or null.
   *
   * It sits BESIDE the ending's own sentence, never over it. It used to
   * replace it, which spent the one thing a returning reader came back for —
   * that the recording stopped itself after fifteen minutes of silence — to
   * say how a tidy-up they had just pressed went. Both are news, and they are
   * news about different things.
   */
  report(): string | null;
}

export function createMeetingTidyLine(opts: {
  run: (meetingId: string) => Promise<MeetingTidyOutcome>;
  /** Something the line shows has changed: draw it again. */
  onChange(): void;
  /** The notes moved, so the line has nothing left to say. */
  onDone(): void;
}): MeetingTidyLine {
  let meetingId: string | null = null;
  let busy = false;
  let report: string | null = null;
  /**
   * The last pass said another press could not answer differently, so the
   * control is gone while its sentence stays.
   *
   * A SEPARATE FLAG FROM `meetingId` BECAUSE THE TWO HALVES PART COMPANY
   * HERE: the report has to keep saying why there is no longer anything to
   * press, and clearing the meeting would take the sentence with it. This is
   * the same call the dialog makes when it REMOVES its primary rather than
   * greying it — a control that can never be pressed is one more thing to
   * weigh on the way to the only one that can.
   */
  let retired = false;

  async function press(): Promise<void> {
    const id = meetingId;
    if (id === null || busy || retired) return;
    busy = true;
    // The pass is the news now; whatever the last one reported is stale.
    report = null;
    opts.onChange();
    let outcome: MeetingTidyOutcome;
    try {
      outcome = await opts.run(id);
    } catch {
      // `runMeetingTidyUp` answers rather than throws, but the runner is an
      // injected function and a rejected promise here would otherwise leave
      // the control saying "Tidying up…" for the rest of the session. A
      // runner that threw ran nothing, so another press is worth allowing.
      outcome = { kind: 'reported', note: CLEANUP_UNREACHABLE.headline, retry: true };
    }
    busy = false;
    // SUPERSEDED WHILE THE REQUEST WAS ON THE WIRE. A new recording withdraws
    // this offer, and so does a tap on the sentence. Answering afterwards
    // would put a control back on the line for a meeting that is no longer
    // the one this strip is about.
    if (meetingId !== id) return;
    if (outcome.kind === 'changed') {
      meetingId = null;
      opts.onDone();
      return;
    }
    report = outcome.note;
    // THE ANSWER GOES IN THE CONTROL, not in a sentence about the control.
    retired = !outcome.retry;
    opts.onChange();
  }

  return {
    offer(id) {
      meetingId = id;
      report = null;
      busy = false;
      retired = false;
    },
    withdraw() {
      meetingId = null;
      report = null;
      busy = false;
      retired = false;
    },
    view() {
      if (meetingId === null || retired) return null;
      return {
        // "Try again" once a pass has run, exactly as the dialog's primary
        // does: by then the question has been answered.
        label: busy ? TIDY_WORKING_LABEL : report === null ? TIDY_LABEL : TIDY_RETRY_LABEL,
        busy,
        press: () => void press(),
      };
    },
    report: () => report,
  };
}
