/**
 * WHICH NOTE-TAKER a meeting doc is using, as a value both ends agree on.
 *
 * The exploration behind this (`scripts/notes-eval-variants.ts`) measured a
 * spread the owner decided not to collapse: the shipped one-pass note-taker
 * loses about a third of the ideas voiced at $0.60 a meeting-hour, and a
 * two-pass ledger buys most of that back at up to nine times the price. No
 * single answer is right for every meeting, so the choice is the person's and
 * this module is the vocabulary for it.
 *
 * IN CORE, NOT THE SERVER, because the id travels: the chooser renders these
 * rows, the audio socket carries the id mid-meeting, the notes carry the
 * label in their trace line, and the server picks a composer from it. One
 * table, so a rename cannot make the strip say a different thing from the
 * record.
 *
 * THE COPY IS PART OF THE CONTRACT. The detail line is what a person reads
 * while deciding, and it says the two things they can act on — how complete
 * the notes are, and what an hour costs.
 *
 * AND THE PRICE HALF IS NO LONGER A CONSTANT. It used to be three strings
 * typed out of one old eval run, and the live pipeline had moved past them:
 * the row said sixty cents an hour for a meeting whose compose alone billed
 * about two dollars and whose task-capture call was not counted at all. So
 * the row now carries the eval's figure as an ESTIMATE and the server hands
 * down a per-hour figure measured on real finished meetings; `notesMethodDetail`
 * picks the measured one where there is one and marks the guess `est.` where
 * there is not, because a person choosing between two rows needs to know
 * which of the numbers was billed and which was predicted.
 */

import { formatPerHour } from './model-cost.ts';

/**
 * The methods, in the order the chooser offers them: cheapest and least
 * complete first, so the list reads as a ladder rather than a menu.
 */
export const NOTES_METHODS = ['original', 'ledger-haiku', 'ledger-opus'] as const;

export type NotesMethod = (typeof NOTES_METHODS)[number];

/**
 * What a doc uses until somebody says otherwise.
 *
 * THE ORIGINAL, on the owner's call (2026-09-09): the ledger halves the lost
 * ideas but no ledger variant has yet held the speaker-attribution bar the
 * original holds at 100%, and a default is the one choice nobody makes on
 * purpose. A meeting that wants the completeness asks for it.
 */
export const DEFAULT_NOTES_METHOD: NotesMethod = 'original';

/**
 * The methods the CHOOSER OFFERS, which is deliberately not every method that
 * works.
 *
 * A method reaches this list when the eval has measured it over the AMI
 * corpus, behaviour judges on, twice, and it held every bar the original
 * holds — the shipping bar the owner set. Everything else here is built,
 * tested, reachable over the API and the socket, and simply not offered:
 * holding an unmeasured note-taker out of a person's list costs nothing,
 * while offering one and finding out later that it drops speakers costs the
 * notes of whoever picked it.
 *
 * TODAY THAT IS THE ORIGINAL ALONE, and the reason is a measurement that has
 * not been finished rather than a method that failed: one complete run of the
 * original exists and neither ledger method has two clean runs on the shipped
 * prompt. Adding the two ledger ids back is this one line, once they do.
 *
 * DO NOT WRITE A DATE HERE. This paragraph carried one for a while — a spend
 * limit said to lift on a named day — and it was wrong within a day of being
 * written, because that is a fact about a key rather than about the
 * note-takers this module describes. What gates the list is the eval's own
 * output, which is checkable; anything else read here is a claim nobody
 * re-reads.
 *
 * The FOLD HIDES ITSELF when this holds fewer than two methods, because a
 * chooser with one row is a control that does nothing.
 */
export const OFFERED_NOTES_METHODS: readonly NotesMethod[] = ['original'];

/** One row of the chooser: the id, what it is called, and what it costs. */
export interface NotesMethodInfo {
  id: NotesMethod;
  /** The name shown on the row and written into the notes' trace line. */
  label: string;
  /** The first half of the line under the name: how complete the notes are. */
  completeness: string;
  /**
   * What an hour was expected to cost, from `scripts/notes-eval-variants.ts`.
   *
   * A PREDICTION, and it is labelled as one wherever it is shown. It covers
   * the compose call alone, on a corpus of AMI meetings, at one moment in the
   * prompt's life — none of which is the bill a person gets. It is here
   * because a method nobody has run yet still has to say something, and a
   * blank row is a worse answer than a marked guess.
   */
  estimatedPerHourUsd: number;
}

export const NOTES_METHOD_INFO: readonly NotesMethodInfo[] = [
  {
    id: 'original',
    label: 'Original',
    completeness: 'Least complete, shorter text',
    estimatedPerHourUsd: 0.6,
  },
  {
    id: 'ledger-haiku',
    label: 'Ledger · Haiku',
    completeness: 'In between',
    estimatedPerHourUsd: 0.95,
  },
  {
    id: 'ledger-opus',
    label: 'Ledger · Opus',
    completeness: 'Most complete, longer text',
    estimatedPerHourUsd: 5.55,
  },
];

/**
 * The row for a method. Total over `NotesMethod`, so a method added to the
 * union without a row is a type error rather than a blank line in the UI.
 */
export function notesMethodInfo(method: NotesMethod): NotesMethodInfo {
  const row = NOTES_METHOD_INFO.find((m) => m.id === method);
  // Unreachable while the table covers the union; thrown rather than
  // defaulted, because a silent fallback to `original` would show the wrong
  // name beside a method that IS running.
  if (!row) throw new Error(`no chooser row for notes method ${method}`);
  return row;
}

/**
 * The line under a method's name, given whatever the server has measured.
 *
 * `measuredPerHourUsd` is a rate computed from the token counts of finished
 * meetings that ran on this method. With one, the row states it plainly.
 * Without one, the row states the eval's prediction and appends `est.` — one
 * word, because the row is a control a person reads in a glance and a
 * sentence of hedging there is a sentence nobody reads.
 */
export function notesMethodDetail(method: NotesMethod, measuredPerHourUsd?: number): string {
  const info = notesMethodInfo(method);
  const measured =
    measuredPerHourUsd !== undefined &&
    Number.isFinite(measuredPerHourUsd) &&
    measuredPerHourUsd > 0;
  const rate = measured ? (measuredPerHourUsd as number) : info.estimatedPerHourUsd;
  return `${info.completeness} · ${formatPerHour(rate)}${measured ? '' : ' est.'}`;
}

/** What the trace line and the fold's summary call this method. */
export function notesMethodLabel(method: NotesMethod): string {
  return notesMethodInfo(method).label;
}

/**
 * A method id off the wire, or `undefined` for anything else.
 *
 * `undefined` rather than the default, so a caller can tell "this client did
 * not say" from "this client asked for the original" — a stored choice must
 * not be reset to the default by a client too old to name one.
 */
export function parseNotesMethod(raw: unknown): NotesMethod | undefined {
  if (typeof raw !== 'string') return undefined;
  return (NOTES_METHODS as readonly string[]).includes(raw) ? (raw as NotesMethod) : undefined;
}

/**
 * Whether this method runs the extract pass before it composes.
 *
 * The one behavioural fork in the server: a ledger method pays a cheap
 * enumeration of the tick's speech and hands the composer that list as a
 * checklist, and the original does not.
 */
export function notesMethodUsesLedger(method: NotesMethod): boolean {
  return method === 'ledger-haiku' || method === 'ledger-opus';
}

/**
 * The one line a method change writes into the notes.
 *
 * "10:38 Note-taker Ledger · Opus — Maya". It is the whole of what the doc
 * says about methods: the approved design shows nothing method-related in the
 * notes at rest, so a reader only ever sees the moments somebody changed it,
 * in the order they happened.
 *
 * Here rather than in the server because the strip renders the same sentence
 * optimistically before the write lands, and two spellings of it would read
 * as two different events.
 */
export function notesMethodTraceLine(label: string, by: string | undefined, at: number): string {
  const d = new Date(at);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const who = by?.trim();
  return `${hh}:${mm} Note-taker ${label}${who ? ` — ${who}` : ''}`;
}
