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
