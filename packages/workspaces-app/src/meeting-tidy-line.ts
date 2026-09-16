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

import { api } from './doc-path.ts';
import { CLEANUP_WASH_HOLD_MS } from './meeting-cleanup-offer.ts';
import type { MeetingLiveZone } from './meeting-live-zone.ts';

/** The control's label at rest. */
export const TIDY_LABEL = 'Tidy up the notes';
/** And while the pass is on the wire. */
export const TIDY_WORKING_LABEL = 'Tidying up these notes…';
/**
 * What a pass that could not run says.
 *
 * Shorter than the dialog's sentence, and that is the surface talking rather
 * than drift: this one shares a 36px strip row with the ending's own
 * sentence, where the dialog has a card to itself.
 */
export const TIDY_FAILED_NOTE = 'The tidy-up could not run — the notes are unchanged.';
/** A pass whose every edit was refused: it TRIED, and pressing again after
 *  moving the notes is a reasonable thing to do. */
export const TIDY_NOTHING_LANDED_NOTE = 'Nothing changed — none of the edits could be made.';
/** And a pass that read the notes and found them finished, which is a
 *  documented success of the feature rather than a fault to chase. */
export const TIDY_NOTHING_TO_CHANGE_NOTE = 'Nothing changed — the notes needed nothing.';

/**
 * What one pass did, in the three shapes the line has to say differently.
 *
 * `changed` is the only one that ends the offer: the notes themselves are the
 * receipt, so there is nothing left for the line to report. The other two
 * leave the offer standing, because in both of them pressing again is a thing
 * a person might reasonably want.
 */
export type MeetingTidyOutcome =
  | { kind: 'changed' }
  | { kind: 'unchanged'; note: string }
  | { kind: 'failed'; note: string };

/** What the route answers with; every field optional to a hostile reader. */
interface CleanupReply {
  ok?: boolean;
  error?: string;
  /** The server's own sum over every kind of change a pass can make. A server
   *  that predates the field sends nothing, and nothing is not a claim. */
  changed?: boolean;
  proposed?: number;
}

/**
 * Ask the server to re-read one meeting's notes.
 *
 * Never throws: a request that never arrived is a `failed` outcome like any
 * other, because the line has to say something either way.
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
    const body = (await res.json().catch(() => ({}))) as CleanupReply;
    if (!res.ok || body.ok !== true)
      return { kind: 'failed', note: body.error ?? TIDY_FAILED_NOTE };
    // RAN IS NOT THE SAME AS CHANGED, and the two nothings are different news.
    if (body.changed === false) {
      return {
        kind: 'unchanged',
        note: (body.proposed ?? 0) > 0 ? TIDY_NOTHING_LANDED_NOTE : TIDY_NOTHING_TO_CHANGE_NOTE,
      };
    }
    return { kind: 'changed' };
  } catch {
    return { kind: 'failed', note: TIDY_FAILED_NOTE };
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
  /** What the last press had to report, or null. It REPLACES the ending's
   *  sentence: the news is now the pass, not the timeout. */
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

  async function press(): Promise<void> {
    const id = meetingId;
    if (id === null || busy) return;
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
      // the control saying "Tidying up…" for the rest of the session.
      outcome = { kind: 'failed', note: TIDY_FAILED_NOTE };
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
    opts.onChange();
  }

  return {
    offer(id) {
      meetingId = id;
      report = null;
      busy = false;
    },
    withdraw() {
      meetingId = null;
      report = null;
      busy = false;
    },
    view() {
      if (meetingId === null) return null;
      return {
        label: busy ? TIDY_WORKING_LABEL : TIDY_LABEL,
        busy,
        press: () => void press(),
      };
    },
    report: () => report,
  };
}
