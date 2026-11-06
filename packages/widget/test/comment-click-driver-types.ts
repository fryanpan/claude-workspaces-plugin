/** The readings `comment-click-driver.ts` prints. Apart from the driver,
 *  because importing the driver would run it. */

/** The app's clickable things, by how the app listens for them. */
export const TARGETS = ['link', 'routed', 'direct', 'delegated', 'pressed'] as const;
export type Target = (typeof TARGETS)[number];

export type Pointer = 'mouse' | 'finger';

/** What one press on one target did. */
export interface Press {
  /** The app's handlers that ran. */
  ran: string[];
  /** The address after the press, which a followed link changes. */
  hash: string;
  /** What the open composer is about, or null when none opened. */
  subject: string | null;
}

export interface Reading {
  pointer: Pointer;
  /** The FAB armed the mode, and Done left it: the control for the rest. */
  armed: boolean;
  left: boolean;
  off: Record<Target, Press>;
  on: Record<Target, Press>;
  after: Record<Target, Press>;
}
