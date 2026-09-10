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

  // Failures only. A pass that worked says so by the notes changing, and the
  // wash above says which ones — a line reporting "3 blocks touched" is a
  // readout of a thing the reader can already see.
  const note = document.createElement('div');
  note.className = 'cleanup-offer-note';
  note.hidden = true;

  root.append(button, dismiss, note);
  opts.parent.append(root);

  let meetingId: string | null = null;
  let running = false;

  const show = (visible: boolean): void => {
    root.hidden = !visible;
  };

  const fail = (message: string): void => {
    note.textContent = message;
    note.hidden = false;
    button.disabled = false;
    button.textContent = 'Tidy up these notes';
  };

  async function run(): Promise<void> {
    if (running || meetingId === null) return;
    running = true;
    note.hidden = true;
    button.disabled = true;
    button.textContent = 'Tidying up…';
    // Held BEFORE the request, not after it: the first note can land while
    // the response is still on the wire.
    opts.liveZone?.holdWash(CLEANUP_WASH_HOLD_MS);
    try {
      const res = await doFetch(
        api(
          `docs/${encodeURIComponent(opts.docId)}/meetings/${encodeURIComponent(meetingId)}/notes-cleanup`,
        ),
        { method: 'POST' },
      );
      const body = (await res.json().catch(() => ({}))) as CleanupReply;
      if (!res.ok || body.ok !== true) {
        fail(body.error ?? 'The tidy-up could not run. The notes are unchanged.');
        return;
      }
      // Done: the notes themselves are the receipt.
      meetingId = null;
      show(false);
    } catch {
      fail('The tidy-up could not run. The notes are unchanged.');
    } finally {
      running = false;
    }
  }

  button.addEventListener('click', () => void run());
  dismiss.addEventListener('click', () => {
    meetingId = null;
    show(false);
  });

  return {
    offer(id) {
      if (running) return;
      meetingId = id;
      note.hidden = true;
      button.disabled = false;
      button.textContent = 'Tidy up these notes';
      show(true);
    },
    withdraw() {
      if (running) return;
      meetingId = null;
      show(false);
    },
    destroy() {
      root.remove();
    },
  };
}
