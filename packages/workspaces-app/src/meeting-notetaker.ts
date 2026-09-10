/**
 * THE "NOTE-TAKER" FOLD — which of the three note-takers this doc's minutes
 * are written by, chosen from the same sheet that starts a recording.
 *
 * ONE fold, in the start chooser, below Advanced Options and above Start
 * Recording, collapsed by default with the current choice on its own line.
 * That is the whole of the surface: nothing method-related appears anywhere
 * else at rest, because a person who never opens the fold has no decision to
 * make — the default is the original note-taker and it composes exactly as it
 * did before any of this existed.
 *
 * REACHABLE WHILE RECORDING TOO, from the same sheet. Picking a row mid-
 * meeting does not rewrite a word: the next tick composes with the new
 * note-taker, and the doc gets one line saying which one and who asked
 * (`notesMethodTraceLine` in core, written server-side).
 *
 * IT REUSES THE ADVANCED PANEL'S CHROME on purpose — `.meeting-adv`,
 * `.meeting-adv-headrow`, `.meeting-adv-head`, `.meeting-adv-chev`,
 * `.meeting-adv-body`, and the chooser's own `.meeting-choice` cards for the
 * rows. Two folds in one sheet that opened differently would read as two
 * different kinds of control. The one rule this adds is
 * `.meeting-adv-value`, the summary on the head line.
 *
 * Its own module rather than more of `meeting-chooser.ts` for the ordinary
 * reason: that file is near the 500-line bar, and this is a section with its
 * own state and no dependency on the rest of the form.
 */

import {
  type NotesMethod,
  OFFERED_NOTES_METHODS,
  notesMethodInfo,
  parseNotesMethod,
} from '@claude-workspaces/core';
import { currentWorkspaceId } from './doc-path.ts';

export interface NotetakerFoldOpts {
  /** The doc's note-taker as it stands. */
  method: NotesMethod;
  /** Whether the fold is unfolded. Collapsed is the default and the state a
   *  fresh sheet opens in. */
  open: boolean;
  /**
   * When the current note-taker was picked, as the strip would show a clock
   * — "10:38". Present only for a change made during THIS meeting, which is
   * the one case a reader needs placing against the notes above it; absent
   * for a doc that has simply always been on this note-taker.
   */
  since?: string;
  onToggleOpen(): void;
  /** A row was picked. The same row as the current one is still reported:
   *  what the server does with a repeat is the server's rule, not the
   *  sheet's. */
  onPick(method: NotesMethod): void;
  /**
   * The rows to offer, defaulting to the ones that ship.
   *
   * A parameter rather than a straight read of the constant so the tests can
   * drive the fold with every method in the vocabulary: the surface has to
   * stay proven while the shipping list is short, or the day a method is
   * added would be the first day anybody found out the rows still render.
   */
  offered?: readonly NotesMethod[];
}

/** The fold, ready to append to the chooser. */
export function buildNotetakerFold(opts: NotetakerFoldOpts): HTMLElement {
  const section = document.createElement('div');
  section.className = `meeting-adv meeting-notetaker${opts.open ? ' is-open' : ''}`;

  const headRow = document.createElement('div');
  headRow.className = 'meeting-adv-headrow';
  const head = document.createElement('button');
  head.type = 'button';
  head.className = 'meeting-adv-head';
  head.setAttribute('aria-expanded', opts.open ? 'true' : 'false');
  const chev = document.createElement('span');
  chev.className = 'meeting-adv-chev';
  chev.textContent = opts.open ? '▾' : '▸';
  const title = document.createElement('span');
  title.textContent = 'Note-taker';
  // The summary is the reason the fold can stay shut: closed, the line still
  // answers "which note-taker is this?" without costing a tap.
  const value = document.createElement('span');
  value.className = 'meeting-adv-value';
  value.textContent = notesMethodInfo(opts.method).label;
  head.append(chev, title, value);
  head.addEventListener('click', () => opts.onToggleOpen());
  headRow.append(head);
  section.append(headRow);

  if (!opts.open) return section;

  const body = document.createElement('div');
  body.className = 'meeting-adv-body';
  for (const id of opts.offered ?? OFFERED_NOTES_METHODS) {
    const info = notesMethodInfo(id);
    const current = id === opts.method;
    const label = document.createElement('label');
    label.className = current ? 'meeting-choice is-selected' : 'meeting-choice';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'meeting-notetaker';
    input.value = id;
    input.checked = current;
    const cardBody = document.createElement('span');
    cardBody.className = 'meeting-choice-body';
    const name = document.createElement('span');
    name.className = 'meeting-choice-title';
    name.textContent = info.label;
    const detail = document.createElement('span');
    detail.className = 'meeting-choice-detail';
    // The price is part of the choice, so it rides the row rather than a
    // footnote; "since" only ever hangs off the row that is already on.
    detail.textContent =
      current && opts.since ? `${info.detail} · since ${opts.since}` : info.detail;
    cardBody.append(name, detail);
    label.append(input, cardBody);
    // On the input's `change`, not the label's click — the same binding the
    // chooser's own cards use. A click listener on the label fires twice,
    // because activating a label re-dispatches the click from the input.
    input.addEventListener('change', () => {
      if (input.checked) opts.onPick(id);
    });
    body.append(label);
  }
  section.append(body);
  return section;
}

/** The slice of the chooser's state this fold reads and moves. */
export interface NotetakerFoldState {
  chooseMethod: NotesMethod;
  methodOpen: boolean;
  methodSince: string;
}

/**
 * Append the fold to the sheet, below Advanced Options and above Start
 * Recording, collapsed with its current choice on the head line. Reachable
 * whether or not a meeting is running: a switch mid-meeting is honoured by
 * the next tick, and the sheet is the only place either case is made.
 */
export function appendNotetakerFold(
  pop: HTMLElement,
  state: NotetakerFoldState,
  deps: { renderPop(): void; onPick(method: NotesMethod): void; offered?: readonly NotesMethod[] },
): void {
  // A chooser with one row is a control that does nothing, so the fold is not
  // drawn at all while only one note-taker is offered. Everything else —
  // the route, the socket frame, the composer, the trace line — still works,
  // which is what lets a held method be measured before it is offered.
  const offered = deps.offered ?? OFFERED_NOTES_METHODS;
  if (offered.length < 2) return;
  pop.append(
    buildNotetakerFold({
      offered,
      method: state.chooseMethod,
      open: state.methodOpen,
      ...(state.methodSince ? { since: state.methodSince } : {}),
      onToggleOpen: () => {
        state.methodOpen = !state.methodOpen;
        deps.renderPop();
      },
      onPick: (method) => {
        deps.onPick(method);
        deps.renderPop();
      },
    }),
  );
}

/**
 * WHAT THE FOLD SHOWS, AND WHO IS ALLOWED TO MOVE IT.
 *
 * Three things move this row and they do not arrive in a fixed order: the
 * mount's GET of the doc's current note-taker, a person's pick, and the
 * server's answer to that pick. Held as one value with one rule each, because
 * every bug this shape exists to close was an ordering rather than logic.
 *
 * - `shown` is the row. It moves the moment somebody picks, because a
 *   preference must not sit on a spinner.
 * - `confirmed` is the last method the server is KNOWN to hold — moved only
 *   by an answer, never by a pick. A change that is refused goes back to it.
 * - `picked` closes the mount question for good: once a person has chosen,
 *   the doc's state as it was BEFORE they chose is not news.
 * - `pending` is every pick asked for and not yet answered.
 */
export interface NotetakerChoice {
  readonly shown: NotesMethod;
  readonly confirmed: NotesMethod;
  readonly picked: boolean;
  /** The number the next pick takes; the last pick's own number. */
  readonly seq: number;
  /**
   * THE PICKS STILL OUT, oldest first. Two writes can be in flight at once —
   * a person changes their mind while the first is still going — and neither
   * path answers in the order it was asked: `fetch` promises settle when
   * responses arrive, and the two paths can even be mixed across a socket
   * that opened between picks.
   *
   * Holding them is what lets an answer speak for its OWN pick and nothing
   * else. Reading the row instead is how the last bug here worked: pick B
   * then C before either answers, B succeeds and C fails, and an answer read
   * against the row confirmed C on B's success and then rolled back to C on
   * C's failure — while the server had kept B.
   */
  readonly pending: readonly NotetakerPick[];
}

/** One pick that has been asked for: its number and what it asked for. */
export interface NotetakerPick {
  readonly seq: number;
  readonly method: NotesMethod;
}

/**
 * WHICH PICK AN ANSWER IS FOR, and the reason there are two forms.
 *
 * The REST path knows the number, because it holds the promise for its own
 * write. The socket path does not: the server's `notes_method` frame carries
 * the METHOD it recorded and no number, so the pick is found by what was
 * asked for — the oldest one still out that asked for that method, since the
 * one socket delivers its answers in the order it was asked.
 */
export type NotetakerAck = { readonly seq: number } | { readonly method: NotesMethod };

/** The row before anything has been asked or answered. */
export function notetakerChoiceAtMount(method: NotesMethod): NotetakerChoice {
  return { shown: method, confirmed: method, picked: false, seq: 0, pending: [] };
}

/**
 * The mount GET came back.
 *
 * IGNORED ONCE SOMEBODY HAS PICKED. The fetch is issued at mount and a person
 * can pick before it lands, so its answer describes the doc as it was before
 * the pick — writing it in would show the old note-taker while the PUT or the
 * socket frame carrying the new one had already reached the server, and the
 * next tick would then use a method the fold denies.
 */
export function notetakerMountAnswer(
  choice: NotetakerChoice,
  answer: NotesMethod | null | undefined,
): NotetakerChoice {
  if (choice.picked || !answer) return choice;
  return { ...choice, shown: answer, confirmed: answer };
}

/** Somebody picked. Optimistic: the row moves now and the answer settles it. */
export function notetakerPicked(choice: NotetakerChoice, method: NotesMethod): NotetakerChoice {
  const seq = choice.seq + 1;
  return {
    shown: method,
    // NOT moved by the pick. What the server holds is a fact only an answer
    // can report, and a pick that is refused has to land back on it.
    confirmed: choice.confirmed,
    picked: true,
    seq,
    pending: [...choice.pending, { seq, method }],
  };
}

/** The pick an answer is for, or `null` when it is for none of those out. */
export function notetakerPendingPick(
  choice: NotetakerChoice,
  ack: NotetakerAck,
): NotetakerPick | null {
  const found =
    'seq' in ack
      ? choice.pending.find((p) => p.seq === ack.seq)
      : choice.pending.find((p) => p.method === ack.method);
  return found ?? null;
}

/**
 * Whether an answer is the one the ROW is waiting on — the pick the person is
 * looking at rather than one they have already replaced. Only that one may
 * raise an error: a complaint about an abandoned pick names a note-taker the
 * sheet no longer shows.
 */
export function notetakerAnswersShownPick(choice: NotetakerChoice, ack: NotetakerAck): boolean {
  const pick = notetakerPendingPick(choice, ack);
  return pick !== null && pick.seq === choice.seq;
}

/**
 * The server answered a pick — `ack` says WHICH, and an answer for a pick
 * that is not out decides nothing.
 *
 * `false` is a record that could not be written — a data dir that is full,
 * read-only or gone, or a socket that may not write the doc at all. The write
 * is swallowed there so that losing a preference never fails a tick, which is
 * right, and it is exactly why the row has to come back: the session goes on
 * composing with the method it had.
 *
 * The row itself only settles once NOTHING is out: while a later pick is
 * still unanswered the person is looking at that pick, and an earlier answer
 * moves only what the server is known to hold. When the last answer lands,
 * the row becomes that known method — which is the pick if it was kept, and
 * whatever survived if it was not.
 */
export function notetakerAcknowledged(
  choice: NotetakerChoice,
  recorded: boolean,
  ack: NotetakerAck,
): NotetakerChoice {
  const pick = notetakerPendingPick(choice, ack);
  if (!pick) return choice;
  // WHAT ELSE THIS ANSWER SETTLES, and the two paths differ.
  //
  // A socket answer settles everything sent before it: one socket answers
  // every frame it was given, in order, so anything older is either already
  // answered or went down with the socket. Left pending, a frame whose
  // answer never comes would hold the row open for good.
  //
  // A `fetch` answering says NOTHING about another `fetch`. The response
  // order is not the order the server applied the writes, so an older
  // request still out may be the one the doc keeps — and its answer is the
  // only thing that can say so. Dropping it here is how the row came to show
  // the newer method over a server holding the older one.
  const settlesOlder = 'method' in ack;
  const pending = choice.pending.filter((p) =>
    settlesOlder ? p.seq > pick.seq : p.seq !== pick.seq,
  );
  const confirmed = recorded ? pick.method : choice.confirmed;
  return {
    shown: pending.length > 0 ? choice.shown : confirmed,
    confirmed,
    picked: true,
    seq: choice.seq,
    pending,
  };
}

/** "10:38" — the clock the trace line and the "since" row both read as. */
export function clockLabel(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Where the doc's note-taker is read and written. */
function methodUrl(docId: string): string {
  return `/workspaces/${currentWorkspaceId() ?? ''}/docs/${encodeURIComponent(docId)}/notes-method`;
}

/**
 * The doc's note-taker as the server holds it, or `undefined` where it could
 * not be asked — an old server with no such route, or a share visitor. The
 * caller keeps the default it started with rather than showing a guess.
 */
export async function fetchNotesMethod(docId: string): Promise<NotesMethod | undefined> {
  try {
    const res = await fetch(methodUrl(docId));
    if (!res.ok) return undefined;
    const body = (await res.json()) as { method?: unknown };
    return parseNotesMethod(body.method);
  } catch {
    return undefined;
  }
}

/** Write it, answering whether it landed. A refusal is the caller's cue to
 *  put the row back rather than leave the sheet claiming a choice. */
export async function putNotesMethod(
  docId: string,
  method: NotesMethod,
  by: string | undefined,
): Promise<boolean> {
  try {
    const res = await fetch(methodUrl(docId), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method, ...(by ? { by } : {}) }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
