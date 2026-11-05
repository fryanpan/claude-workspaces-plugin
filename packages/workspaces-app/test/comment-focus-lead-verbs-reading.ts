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
    | 'outline-first'
    | 'far-paragraph'
    | 'table-row'
    | 'after-thread'
    | 'at-anchor'
    | 'under-heading'
    | 'at-end'
    | 'replace-block'
    | 'delete-block'
    | 'suggest'
    | 'accept-all'
    | 'delete-at-anchor'
    | 'delete-range'
    | 'delete-section'
    | 'offscreen'
    | 'set-content';
  /** The reader typed one key at a time while the edit landed, so `landed`
   *  is read after that typing, and the box may have grown by it. */
  typedThrough: boolean;
  before: LeadVerbsReading;
  /** The edit is on the page and the page has settled. */
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
