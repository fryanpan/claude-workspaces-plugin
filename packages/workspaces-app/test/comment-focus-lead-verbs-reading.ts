/**
 * What `comment-focus-lead-verbs-driver.ts` prints, read by
 * `comment-focus-lead-verbs-browser.test.ts`.
 */
import type { ComposerKind, FocusReading } from './comment-focus-remote-edit-reading.ts';

export interface LeadVerbsReading extends FocusReading {
  /** The reader's typed phrases found in the doc's own prose. Any entry is
   *  words that went into the document instead of the comment. */
  leaked: string[];
  /** The mermaid block's height, or null when it is not drawn. */
  diagramHeight: number | null;
}

export interface LeadVerbStep {
  where:
    | 'far-paragraph'
    | 'table-row'
    | 'replace-block'
    | 'suggest'
    | 'accept-all'
    | 'offscreen'
    | 'set-content';
  before: LeadVerbsReading;
  /** The edit is on the page and the page has settled; nothing typed yet. */
  landed: LeadVerbsReading;
  /** After the next chunk of typing. */
  after: LeadVerbsReading;
  /** The words the reader had typed by the time of `after`. */
  typed: string;
}

export interface LeadVerbsScenario {
  width: number;
  kind: ComposerKind;
  opened: LeadVerbsReading;
  steps: LeadVerbStep[];
}

export interface LeadVerbsRun {
  scenarios: LeadVerbsScenario[];
}
