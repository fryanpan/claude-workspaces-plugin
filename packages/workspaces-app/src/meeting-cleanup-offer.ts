/**
 * The offer, at the end of a meeting, to read the notes once more.
 *
 * WHY IT IS AN OFFER AND NOT A STEP. The pass rewrites notes people have been
 * reading all meeting, on a doc they may be sharing. Doing that unasked is the
 * one thing the feature must not do, so nothing happens until somebody presses
 * the button — the press IS the approval, and there is no setting that turns
 * it into a default.
 *
 * WHY IT IS A MODAL. It used to be a row at the end of the prose, and that
 * shape is what let it fail in the field: a row in the flow has to be hidden
 * by CSS, `.cleanup-offer { display: flex }` outranked the UA's `[hidden]`
 * rule, and so the offer stood at the end of EVERY doc — on docs that had
 * never held a recording — overlapping the notes and doing nothing when it
 * was pressed, because no meeting had named itself to tidy. A modal asks its
 * question once, at the moment a recording stops, and there is no state in
 * which it is part of the page. It is raised by `offer()` and by nothing
 * else; a doc that mounts this and never records shows a scrim-free page.
 *
 * WHAT IT SAYS. A question, two answers, and one line that reports. No
 * caption explaining what a tidy-up is: the notes are on screen behind it and
 * "Tidy up" says what pressing it does. It leaves on the first of four
 * things — the pass finishing, "Not now", Escape or the scrim, or the next
 * recording starting.
 *
 * WHILE IT RUNS. The dialog stays up and the report line says so, because the
 * pass is a request over a whole transcript and a dialog that vanished on the
 * press would leave nothing on screen saying anything was happening. Both
 * answers are refused while it is on the wire — this is the one moment where
 * "Not now" would be a lie, since the writes are already coming.
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

/** The line under the question, while the pass is on the wire. */
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
  /**
   * Where the dialog is appended. The default is the document body, which is
   * what every caller wants: the scrim is `position: fixed`, and a transform
   * or a filter anywhere up the editor's ancestry would make it fixed to that
   * ancestor's box instead of the viewport.
   */
  parent?: HTMLElement;
  liveZone?: MeetingLiveZone;
  fetchImpl?: typeof fetch;
}): MeetingCleanupOffer {
  const doFetch = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));

  const root = document.createElement('div');
  root.className = 'cleanup-offer';
  root.hidden = true;

  const card = document.createElement('div');
  card.className = 'cleanup-offer-card';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  card.setAttribute('aria-labelledby', 'cleanup-offer-title');

  const title = document.createElement('h2');
  title.id = 'cleanup-offer-title';
  title.className = 'cleanup-offer-title';
  title.textContent = 'Tidy up these notes?';

  // One line, doing both jobs a person needs from it: saying the pass is
  // running, and saying why it did not. A success needs no line — the notes
  // behind the dialog are the receipt, and the wash above says which ones.
  const note = document.createElement('p');
  note.className = 'cleanup-offer-note';
  note.hidden = true;
  // Read out when it changes: the working line and the refusal both appear
  // without the focus moving, so nothing else would announce them.
  note.setAttribute('role', 'status');

  const actions = document.createElement('div');
  actions.className = 'cleanup-offer-actions';

  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'cleanup-offer-dismiss';
  dismiss.textContent = 'Not now';

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'cleanup-offer-go';
  button.textContent = 'Tidy up';

  actions.append(dismiss, button);
  card.append(title, note, actions);
  root.append(card);
  (opts.parent ?? document.body).append(root);

  let meetingId: string | null = null;
  // Keyed on the MEETING rather than a bare flag. It is what stops a second
  // press re-sending the same pass — and, because the offer can move to the
  // next meeting while the last one's POST is still on the wire, a bare flag
  // would leave the new offer's button live-looking and inert until the old
  // request finally answered.
  const inFlight = new Set<string>();
  /** Whose focus to give back when the dialog closes. */
  let returnFocus: HTMLElement | null = null;

  const running = (): boolean => meetingId !== null && inFlight.has(meetingId);

  const close = (): void => {
    meetingId = null;
    root.hidden = true;
    const back = returnFocus;
    returnFocus = null;
    back?.focus?.();
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
    // withdraws this offer, and Not now retires it, and either can happen
    // while the POST is still in flight. This offer is about the meeting it
    // was pressed for: answering for it afterwards would put a dialog back on
    // screen that, pressed, tidies the PREVIOUS meeting in the middle of the
    // one now recording.
    const superseded = (): boolean => meetingId !== id;
    inFlight.add(id);
    say(WORKING_NOTE);
    button.disabled = true;
    // Refused for as long as the writes are coming: "Not now" after the pass
    // has started would close over notes that are about to change anyway.
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
      // Done: the notes themselves are the receipt, so the dialog gets out of
      // the way of the thing the person asked to see.
      close();
    } catch {
      if (!superseded()) fail(FAILED_NOTE);
    } finally {
      inFlight.delete(id);
    }
  }

  button.addEventListener('click', () => void run());
  // No `running()` guard here, and that is deliberate: the button is
  // `disabled` for exactly that window, and a disabled button dispatches no
  // click. A guard nothing can reach reads as a promise somebody will later
  // rely on. The scrim and Escape below are a different case — both are live
  // while the pass runs, so both are guarded, and both are tested.
  dismiss.addEventListener('click', () => close());
  // A scrim press is "Not now" — but only a press on the scrim itself, never
  // one that started inside the card and happened to end on it.
  root.addEventListener('click', (ev) => {
    if (ev.target === root && !running()) close();
  });
  /**
   * Keep Tab inside the dialog.
   *
   * `aria-modal="true"` is a promise to assistive tech and nothing more — it
   * moves no focus on its own, and `thread-modal.ts` carries the same trap for
   * the same reason. The window that matters most here is the one while the
   * pass runs: BOTH answers are disabled then, so there is nothing in the card
   * to hold the focus and a Tab would land on the prose under the scrim, where
   * every control is unreachable to the eye and unclosable to the keyboard.
   *
   * Bound to `document`, not to the card, so the branch that matters still
   * fires: focus already outside gets pulled back, which a listener scoped to
   * the dialog could never see.
   */
  const trapTab = (ev: KeyboardEvent): void => {
    const stops = [dismiss, button].filter((b) => !b.disabled);
    const first = stops[0];
    const last = stops[stops.length - 1];
    if (first === undefined || last === undefined) {
      // Nothing to hold it: the request is on the wire and both answers are
      // refused. Tab stays where it is rather than leaving.
      ev.preventDefault();
      return;
    }
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !root.contains(active)) {
      ev.preventDefault();
      (ev.shiftKey ? last : first).focus();
      return;
    }
    // Anywhere but the two ends the browser's own order is right; only the
    // edges need turning back.
    if (ev.shiftKey && active === first) {
      ev.preventDefault();
      last.focus();
    } else if (!ev.shiftKey && active === last) {
      ev.preventDefault();
      first.focus();
    }
  };
  const onKeydown = (ev: KeyboardEvent): void => {
    if (root.hidden) return;
    if (ev.key === 'Tab') {
      trapTab(ev);
      return;
    }
    if (ev.key !== 'Escape' || running()) return;
    ev.preventDefault();
    // Not `stopPropagation`: the doc chrome's own Escape handler is bound to
    // `document` too, and stopping propagation does nothing to another
    // listener on the SAME node. One press must close this and nothing under
    // it.
    ev.stopImmediatePropagation();
    close();
  };
  // CAPTURE, and that is the whole answer to "which modal does this Escape
  // belong to". The thread modal and the thread view keep their own Escape
  // handlers on `document`, in the bubble phase, and between two listeners on
  // one node the winner is whichever was ADDED first — an order no surface
  // here controls. A keystroke is targeted at the focused control inside this
  // card, so the capture phase reaches `document` on the way DOWN, before any
  // of them: while this dialog is up it is the layer the person is looking at
  // (`z-index` above the modal stack), so it is the layer one press closes.
  document.addEventListener('keydown', onKeydown, true);

  return {
    offer(id) {
      meetingId = id;
      say(null);
      button.disabled = false;
      dismiss.disabled = false;
      const active = document.activeElement;
      returnFocus = active instanceof HTMLElement ? active : null;
      root.hidden = false;
      button.focus?.();
    },
    withdraw() {
      // Taken even while a request is in flight. The offer belongs to the
      // meeting that ended; once the next one starts it is gone from the
      // screen at once, and `run` sees itself superseded rather than putting
      // it back.
      close();
    },
    destroy() {
      document.removeEventListener('keydown', onKeydown, true);
      root.remove();
    },
  };
}
