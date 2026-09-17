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
 * WHAT IT SAYS. One loud line, the answers, and a report that appears only
 * when there is something to report. No caption explaining what a tidy-up is:
 * the notes are on screen behind it and "Tidy up" says what pressing it does.
 * It leaves on the first of four things — the pass LANDING, the dismiss
 * answer, Escape or the scrim, or the next recording starting.
 *
 * THE LOUD LINE IS WHATEVER MATTERS NOW, and it is one line rather than two.
 * It asks the question, then says the pass is running, then names what
 * happened. This shipped as a fixed 17px question with the outcome under it
 * at 13px muted, which left the loudest text on screen the one thing the
 * reader had already answered — quieter even than the recovery line beneath
 * it. The three states are on `data-phase`, so the stylesheet can dress the
 * answers for each without a second copy of the logic.
 *
 * WHAT A FAILURE SAYS, WHICH IS THE POINT OF THE REPORT (2026-09-16). On
 * 2026-09-15 a pass read 355 turns, proposed sixteen edits, had every one
 * refused, and this dialog said nothing a person could act on. Three lines
 * now stand in its place, and `readCleanupReply` in `@claude-workspaces/core`
 * decides all three so that this dialog and `meeting:rerun`'s report cannot
 * drift apart:
 *
 * - the HEADLINE names which of the four happened — it changed the notes, it
 *   found nothing to improve, every edit was out of reach, or it never ran;
 * - the REASONS list every rule that dropped an edit, with how many it
 *   dropped. Grouped by rule and not listed per edit: block ids are not
 *   something a reader can act on and sixteen of them are sixteen things to
 *   read past on the way to the one sentence that is;
 * - the RECOVERY line says what to do or what will not happen on its own —
 *   and never names a button, because the button says it. The primary answer
 *   relabels to "Try again" exactly when another press could answer
 *   differently (`retry`), and is REMOVED when it could not: a control that
 *   can never be pressed is one more thing to weigh on the way to the only
 *   one that can. The remaining answer then says "Close" rather than "Not
 *   now", which is an answer to a question the pass has already answered.
 *
 * WHILE IT RUNS. The dialog stays up and the loud line says so, because the
 * pass is a request over a whole transcript and a dialog that vanished on the
 * press would leave nothing on screen saying anything was happening. Both
 * answers are refused while it is on the wire — this is the one moment where
 * "Not now" would be a lie, since the writes are already coming. The primary
 * carries a spinner for that window: refused-for-ever and on-the-wire used to
 * be the same filled blue at 0.6 opacity, and on a touch screen there is no
 * hover to correct the guess.
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

import {
  type NotesCleanupReply,
  cleanupReasonLine,
  readCleanupReply,
} from '@claude-workspaces/core';
import { api } from './doc-path.ts';
import type { MeetingLiveZone } from './meeting-live-zone.ts';

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

/** The question, before anything has been pressed. */
const ASKING = 'Tidy up these notes?';
/** What the loud line says while the pass is on the wire. */
const WORKING = 'Tidying up these notes…';
/** What the one live control says once the pass has run. "Not now" is an
 *  answer to a question, and by then the question has been answered — on a
 *  pass that found nothing to improve it is the ONLY control, so it has to
 *  say what it does rather than defer something already done. */
const DISMISS_WORDS = { asking: 'Not now', reported: 'Close' };
/**
 * What a request that never arrived says. A reply that ARRIVED says its own
 * words through `readCleanupReply`; this is the one case with no reply at
 * all, so the recovery has to be written here.
 *
 * Exported because the strip's idle-line offer is the second surface that can
 * fail to reach the server, and two surfaces writing this sentence twice is
 * the drift `readCleanupReply` exists to stop — the only difference being
 * that this one reply never came, so core has nothing to read.
 */
export const CLEANUP_UNREACHABLE = {
  headline: 'The tidy-up could not run — the request did not reach the server.',
  recovery: 'The notes are unchanged, and nothing runs it again on its own.',
};

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

  // ONE LOUD LINE, AND IT IS WHATEVER MATTERS NOW. It asks the question, then
  // says the pass is running, then names what happened. It used to be a fixed
  // question with the outcome in a 13px muted paragraph beneath it, which
  // left the loudest text on screen the one thing the reader had already
  // answered — quieter even than the recovery line under it (2026-09-16).
  const title = document.createElement('h2');
  title.id = 'cleanup-offer-title';
  title.className = 'cleanup-offer-title';
  title.textContent = ASKING;
  // Read out when it changes. It is the dialog's own accessible name, so the
  // name and the news stay one thing rather than drifting apart; `aria-live`
  // on a heading announces the change without altering its role.
  title.setAttribute('aria-live', 'polite');

  // WHY A LIST AND NOT A SENTENCE. The rules that drop edits are several at
  // once on a real pass, and a reader wants the one that dropped the most.
  // A list with a count per row answers that at a glance; the same content
  // joined with semicolons does not.
  const reasons = document.createElement('ul');
  reasons.className = 'cleanup-offer-reasons';
  reasons.hidden = true;

  // Said after the reasons, because it is the answer to them.
  const recovery = document.createElement('p');
  recovery.className = 'cleanup-offer-recovery';
  recovery.hidden = true;

  const actions = document.createElement('div');
  actions.className = 'cleanup-offer-actions';

  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'cleanup-offer-dismiss';
  dismiss.textContent = 'Not now';

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'cleanup-offer-go';
  // THE BUSY STATE IS A MARK, NOT A SHADE. Disabled-for-ever and
  // on-the-wire used to be one appearance — filled blue at 0.6 opacity,
  // default cursor — and on an iPad there is no hover to correct the guess.
  // The spinner is `styles.css`'s own, so reduced motion is already answered
  // there; the phase attribute below is what shows it.
  const spinner = document.createElement('span');
  spinner.className = 'voice-spinner cleanup-offer-spinner';
  spinner.setAttribute('aria-hidden', 'true');
  const goLabel = document.createElement('span');
  goLabel.className = 'cleanup-offer-go-label';
  goLabel.textContent = 'Tidy up';
  button.append(spinner, goLabel);

  actions.append(dismiss, button);
  card.append(title, reasons, recovery, actions);
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

  /**
   * Put the dialog into one of its three states, with nothing left over from
   * the last one.
   *
   * The reasons and the recovery belong to ONE reply, so every state change
   * clears them. Leaving them is worse than saying nothing: they explain a
   * run that is no longer the one on screen.
   */
  const say = (phase: 'asking' | 'working' | 'reported', headline: string): void => {
    root.dataset.phase = phase;
    title.textContent = headline;
    reasons.replaceChildren();
    reasons.hidden = true;
    recovery.textContent = '';
    recovery.hidden = true;
    goLabel.textContent = 'Tidy up';
    button.hidden = false;
    dismiss.textContent = DISMISS_WORDS.asking;
  };

  /**
   * Put one finished pass on screen and leave the dialog open.
   *
   * THE HEADLINE TAKES THE LOUD LINE. By now the question has been answered,
   * so what happened is the thing to lead with, and it is also the dialog's
   * accessible name.
   *
   * THE PRIMARY IS THERE WHEN IT CAN BE PRESSED AND GONE WHEN IT CANNOT. It
   * says "Try again" and stays live when another press could answer
   * differently; when the answer would be the same for ever it is removed
   * rather than greyed, because a control that can never be pressed is one
   * more thing to weigh on the way to the only one that can. That leaves
   * exactly one live control on a pass with nothing to retry, which is why
   * it no longer says "Not now" — the pass has already run.
   */
  const report = (r: {
    headline: string;
    reasons: readonly { rule: string; count: number }[];
    recovery: string;
    retry: boolean;
  }): void => {
    say('reported', r.headline);
    reasons.replaceChildren(
      ...r.reasons.map((group) => {
        const row = document.createElement('li');
        row.textContent = cleanupReasonLine(group);
        return row;
      }),
    );
    reasons.hidden = r.reasons.length === 0;
    recovery.textContent = r.recovery;
    recovery.hidden = r.recovery.length === 0;
    goLabel.textContent = 'Try again';
    button.hidden = !r.retry;
    button.disabled = !r.retry;
    dismiss.disabled = false;
    dismiss.textContent = DISMISS_WORDS.reported;
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
    say('working', WORKING);
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
      const body = (await res.json().catch(() => ({}))) as NotesCleanupReply;
      if (superseded()) return;
      // ONE READING FOR EVERY ANSWER, INCLUDING THE HTTP ONE. A non-2xx
      // carries the same shape and the same `reason`, so it is read the same
      // way rather than collapsed into a generic sentence — that collapse is
      // how a refusal naming a live recording used to read as "could not
      // run" with nothing to do about it.
      const outcome = readCleanupReply(res.ok ? body : { ...body, ok: false });
      // RAN IS NOT THE SAME AS CHANGED. The server sums every kind of change
      // one pass can make and says so; only a pass that MOVED the document
      // closes the dialog, because the notes behind it are that pass's
      // receipt and none of the others has one.
      if (outcome.kind === 'changed') {
        close();
        return;
      }
      report(outcome);
    } catch {
      // No reply at all, so nothing said anything about the notes. They are
      // untouched: the writes happen inside the request this never completed.
      if (!superseded()) {
        report({ ...CLEANUP_UNREACHABLE, reasons: [], retry: true });
      }
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
    // `disabled` alone, and that is enough for the primary being REMOVED on a
    // pass that can never be retried: `report` hides and disables it on the
    // same line, so nothing here can reach a button that paints nothing. A
    // second clause for the same state would be a guard no case can exercise,
    // which reads as a promise somebody later relies on.
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
    if (ev.key !== 'Tab' && ev.key !== 'Escape') return;
    // WHILE IT IS UP, THIS DIALOG OWNS BOTH KEYS — every press, including the
    // ones it refuses. Anything less leaks into the layer underneath: a Tab
    // this trap has already placed would be moved on again by the thread
    // modal's own trap, back under the scrim, and an Escape refused here
    // because the pass is running would close that modal invisibly instead.
    // `stopImmediatePropagation`, not `stopPropagation`: those handlers sit on
    // `document` as this one does, and stopping propagation does nothing to
    // another listener on the SAME node.
    ev.stopImmediatePropagation();
    if (ev.key === 'Tab') {
      trapTab(ev);
      return;
    }
    // Refused while the writes are coming — and still consumed.
    if (running()) {
      ev.preventDefault();
      return;
    }
    ev.preventDefault();
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
      say('asking', ASKING);
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
