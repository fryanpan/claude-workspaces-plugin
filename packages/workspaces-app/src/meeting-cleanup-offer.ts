/**
 * The offer, at the end of a meeting, to read the notes once more.
 *
 * WHY IT IS AN OFFER AND NOT A STEP. The pass rewrites notes people have been
 * reading all meeting, on a doc they may be sharing. Doing that unasked is the
 * one thing the feature must not do, so nothing happens until somebody presses
 * the button — the press IS the approval, and there is no setting that turns
 * it into a default.
 *
 * WHAT IT SAYS. One button and a way to dismiss it. No caption explaining what
 * a tidy-up is, no chip naming the meeting: the notes are on screen above it
 * and the button says what pressing it does. It appears when a recording ends,
 * sits at the end of the prose where the notes are, and leaves on the first of
 * three things — the pass finishing, a dismissal, or the next recording
 * starting.
 *
 * WHY IT IS A ROW AND NOT A DIALOG. The offer is about the notes directly
 * above it, so it sits beside them and leaves them readable. A modal over the
 * page would grey out the very thing the question is asking about. The shape
 * is approved (Bryan, 2026-09-03/04) and the thing that went wrong was never
 * the shape: see the note below.
 *
 * ITS VISIBILITY IS CSS, AND THAT IS WHERE IT FAILED. `root.hidden` is set
 * correctly on every path here, and the row stood at the end of EVERY doc
 * anyway — `doc.css` had `.cleanup-offer { display: flex }` and no
 * `.cleanup-offer[hidden]` pair, and an author rule outranks the UA's
 * `[hidden]` whatever its specificity. Pressing it then did nothing, because
 * `run()` returns on a null meeting id and no meeting had ever named itself.
 * Every case in `meeting-cleanup-offer.test.ts` passed throughout: they read
 * the PROPERTY. The computed value is read in `cleanup-offer-css.test.ts`, and
 * that is the case this module's correctness now rests on.
 *
 * WHILE IT RUNS. The row stays and reports, because the pass is a request over
 * a whole transcript and a button that only greyed out would leave nothing on
 * screen saying anything was happening. Both controls are refused while it is
 * on the wire — this is the one moment where dismissing would be a lie, since
 * the writes are already coming.
 *
 * THE TINT. Notes the pass writes arrive over the doc stream like any other
 * remote edit, and `settle-wash.ts` decides whether to tint one by asking the
 * live zone whether a meeting is live AT THE MOMENT IT LANDS. A pass asked for
 * five minutes after the stop is long past `WASH_GRACE_MS`, so the offer holds
 * the wash open across the request (`liveZone.holdWash`). Without that the
 * tidy-up's own writing is the only note of the meeting that never highlights
 * and never reaches the recent-edits list — which is criterion three of the
 * feature, so it is held here rather than left to the grace window.
 */

import { api } from './doc-path.ts';
import type { MeetingLiveZone } from './meeting-live-zone.ts';

/** What the route answers with; every field optional to a hostile reader. */
interface CleanupReply {
  ok?: boolean;
  error?: string;
  touched?: number;
  refused?: number;
  proposed?: number;
}

/**
 * How long the wash is held open around a pass.
 *
 * The request itself is one model call over the whole transcript — seconds,
 * not minutes — and the writes land inside it. The hold covers the request
 * plus a beat for the doc stream to deliver what the server wrote; a note
 * that lands after it has run out simply arrives untinted, which is the same
 * outcome as not holding at all.
 */
export const CLEANUP_WASH_HOLD_MS = 90_000;

/** The line beside the button, while the pass is on the wire. */
const WORKING_NOTE = 'Tidying up these notes…';
/** What a failure says when the server sends no sentence of its own. */
const FAILED_NOTE = 'The tidy-up could not run. The notes are unchanged.';

export interface MeetingCleanupOffer {
  /** A recording just ended: offer a pass over this meeting. */
  offer(meetingId: string): void;
  /** Take the offer down — a new recording, or the doc going away. */
  withdraw(): void;
  destroy(): void;
}

export function mountMeetingCleanupOffer(opts: {
  docId: string;
  /** Rendered as `parent`'s last child, after the editor's content. */
  parent: HTMLElement;
  liveZone?: MeetingLiveZone;
  fetchImpl?: typeof fetch;
}): MeetingCleanupOffer {
  const doFetch = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));

  const root = document.createElement('div');
  root.className = 'cleanup-offer';
  root.hidden = true;

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'cleanup-offer-go';
  button.textContent = 'Tidy up these notes';

  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'cleanup-offer-dismiss';
  dismiss.setAttribute('aria-label', 'Dismiss');
  dismiss.textContent = '×';

  // One line, doing both jobs a person needs from it: saying the pass is
  // running, and saying why it did not. A pass that worked says so by the
  // notes changing, and the wash above says which ones — a line reporting
  // "3 blocks touched" is a readout of a thing the reader can already see.
  const note = document.createElement('div');
  note.className = 'cleanup-offer-note';
  note.hidden = true;
  // Read out when it changes: the working line and the refusal both appear
  // without the focus moving, so nothing else would announce them.
  note.setAttribute('role', 'status');

  root.append(button, dismiss, note);
  opts.parent.append(root);

  let meetingId: string | null = null;
  // Keyed on the MEETING rather than a bare flag. It is what stops a second
  // press re-sending the same pass — and, because the offer can move to the
  // next meeting while the last one's POST is still on the wire, a bare flag
  // would leave the new offer's button live-looking and inert until the old
  // request finally answered.
  const inFlight = new Set<string>();

  const show = (visible: boolean): void => {
    root.hidden = !visible;
  };

  const say = (message: string | null): void => {
    note.textContent = message ?? '';
    note.hidden = message === null;
  };

  const fail = (message: string): void => {
    say(message);
    button.disabled = false;
    dismiss.disabled = false;
  };

  async function run(): Promise<void> {
    const id = meetingId;
    if (id === null || inFlight.has(id)) return;
    // SUPERSEDED WHILE THE REQUEST WAS ON THE WIRE. A new recording starting
    // withdraws this offer, and Dismiss retires it, and either can happen
    // while the POST is still in flight. This offer is about the meeting it
    // was pressed for: answering for it afterwards would put a button back on
    // screen that, pressed, tidies the PREVIOUS meeting in the middle of the
    // one now recording.
    const superseded = (): boolean => meetingId !== id;
    inFlight.add(id);
    say(WORKING_NOTE);
    button.disabled = true;
    // Refused for as long as the writes are coming: dismissing after the pass
    // has started would retire a question whose answer is already arriving.
    dismiss.disabled = true;
    // Held BEFORE the request, not after it: the first note can land while
    // the response is still on the wire.
    opts.liveZone?.holdWash(CLEANUP_WASH_HOLD_MS);
    try {
      const res = await doFetch(
        api(
          `docs/${encodeURIComponent(opts.docId)}/meetings/${encodeURIComponent(id)}/notes-cleanup`,
        ),
        { method: 'POST' },
      );
      const body = (await res.json().catch(() => ({}))) as CleanupReply;
      if (superseded()) return;
      if (!res.ok || body.ok !== true) {
        fail(body.error ?? FAILED_NOTE);
        return;
      }
      // Done: the notes themselves are the receipt.
      meetingId = null;
      show(false);
    } catch {
      if (!superseded()) fail(FAILED_NOTE);
    } finally {
      inFlight.delete(id);
    }
  }

  button.addEventListener('click', () => void run());
  // No `inFlight` guard: the button is `disabled` for exactly that window, and
  // a disabled button dispatches no click. A guard nothing can reach reads as
  // a promise somebody will later rely on.
  dismiss.addEventListener('click', () => {
    meetingId = null;
    show(false);
  });

  return {
    offer(id) {
      meetingId = id;
      say(null);
      button.disabled = false;
      dismiss.disabled = false;
      show(true);
    },
    withdraw() {
      // Taken even while a request is in flight. The offer belongs to the
      // meeting that ended; once the next one starts it is gone from the
      // screen at once, and `run` sees itself superseded rather than putting
      // it back.
      meetingId = null;
      show(false);
    },
    destroy() {
      root.remove();
    },
  };
}
