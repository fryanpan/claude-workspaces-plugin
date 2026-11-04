/**
 * The shape `typing-shortcuts-browser-driver.ts` prints, and the keys it
 * types. Shared by the driver and its test so the two cannot disagree about
 * what was typed.
 *
 * audit: no-text — types and one key list; nothing here reads a file.
 */

/**
 * Every single-key shortcut any surface carrying the agent chat answers:
 * the board's j/k/o/s/a/e/c/?, Incoming Messages' j/k/o/r/b/e/u/?, and the
 * spoken reply's Space. A new single-key shortcut belongs in this list.
 */
export const SHORTCUT_KEYS: readonly string[] = [
  'j',
  'k',
  'o',
  's',
  'a',
  'e',
  'c',
  'r',
  'b',
  'u',
  '?',
  ' ',
  'e',
];

/** What a shortcut could have changed, read off the page. */
export interface PageState {
  href: string;
  /** Incoming Messages lines still open (front page only). */
  inboxOpen: number;
  inboxCursor: boolean;
  inboxDialog: boolean;
  boardRows: number;
  /** A board row holds focus — where `j` puts it. */
  rowFocused: boolean;
  helpShown: boolean;
  composerValue: string | null;
  composerFocused: boolean;
  chatOpen: boolean;
}

export interface SurfaceReading {
  surface: string;
  /** The chat open, cursor in the box, before a key. */
  before: PageState;
  /** After every key in SHORTCUT_KEYS was typed into the box. */
  typed: PageState;
  /** After each control key, pressed with nothing editable focused. */
  control: PageState[];
}

export interface TypingRun {
  readings: SurfaceReading[];
}
