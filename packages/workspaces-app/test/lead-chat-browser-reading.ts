/** What `lead-chat-browser-driver.ts` prints, read by `lead-chat-browser.test.ts`. */

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** One surface at one width, in Chat first. */
export interface SurfaceRun {
  surface: string;
  width: number;
  buttonBefore: Rect | null;
  /** Nothing of the page covers the button's centre. */
  buttonOnTop: boolean;
  buttonOpen: Rect | null;
  composerFocused: boolean;
  pane: Rect | null;
  viewport: { width: number; height: number };
  leadHeard: string | null;
  /** The surface the lead was told the message came from. */
  context: string | null;
  answerShown: boolean;
  /** From the answer's POST to its appearing on the page. Reported, not asserted. */
  answerMs: number;
  closedAfter: boolean;
}

/** Voice first on the board at one width. */
export interface VoiceRun {
  width: number;
  /** The Settings Voice row as it first showed, and what choosing Voice first stored. */
  settingsDefault: string;
  settingsStored: string;
  button: Rect | null;
  bar: Rect | null;
  barText: string;
  viewport: { width: number; height: number };
  recognitionStarts: number;
  recognitionStops: number;
  leadHeard: string | null;
  storedVia: string | null;
  barGone: boolean;
}

export interface LeadChatRun {
  surfaces: SurfaceRun[];
  voice: VoiceRun[];
}
