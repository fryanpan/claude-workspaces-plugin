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
 * THE COPY IS PART OF THE CONTRACT. `detail` is what a person reads while
 * deciding, and it says the two things they can act on — how complete the
 * notes are, and what an hour costs. Both come from the measured table, not
 * from an estimate; when the eval moves them, this moves with it.
 */

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

/** One row of the chooser: the id, what it is called, and what it costs. */
export interface NotesMethodInfo {
  id: NotesMethod;
  /** The name shown on the row and written into the notes' trace line. */
  label: string;
  /** The one line under the name: completeness first, then price. */
  detail: string;
}

export const NOTES_METHOD_INFO: readonly NotesMethodInfo[] = [
  { id: 'original', label: 'Original', detail: 'Least complete, shorter text · $0.60/hr' },
  { id: 'ledger-haiku', label: 'Ledger · Haiku', detail: 'In between · $0.95/hr' },
  {
    id: 'ledger-opus',
    label: 'Ledger · Opus',
    detail: 'Most complete, longer text · $5.55/hr',
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
