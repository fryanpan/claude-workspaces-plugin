/**
 * What a test reads as a meeting's notes once the meeting has stopped: the
 * topic it wrote under, and the decisions and follow-ups the stop gathers out
 * of that topic into a section of their own (`notes-recap-shape.ts`). A note
 * moved there at the stop is still a note the meeting kept, so a reader of
 * the topic alone counts it as lost.
 */
import type * as Y from 'yjs';
import { RECAP_ACTIONS_HEADING } from '../src/notes-recap-shape.ts';
import { noteLines, sectionBody } from './notes-doc-helpers.ts';

/** The meeting's notes under `topic` and the gathered section, as markdown. */
export function meetingNotes(ydoc: Y.Doc, topic: string): string {
  return [sectionBody(ydoc, RECAP_ACTIONS_HEADING), sectionBody(ydoc, topic)]
    .filter((s) => s.length > 0)
    .join('\n\n');
}

/** The same notes one per line, list markers stripped — the unit a test
 *  counts when it wants to know whether a note appeared twice. */
export function meetingNoteLines(ydoc: Y.Doc, topic: string): string[] {
  return [...noteLines(ydoc, RECAP_ACTIONS_HEADING), ...noteLines(ydoc, topic)];
}
