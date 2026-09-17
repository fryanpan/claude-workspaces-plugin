/**
 * The outline entries the regroup tests are built from — shared by the scan's
 * own file and by `notes-regroup-ask.test.ts`, which reads the words those
 * counts are said in.
 *
 * Builders only: nothing here reads a source file, a bundle or a stylesheet,
 * so every importer is still asserting behaviour.
 */
import type { prose } from '@claude-workspaces/core';
import type { NotesComposeInput } from '../src/meeting-notes.ts';
import { NOTES_AUTHOR_ID } from '../src/notes-doc-access.ts';

let seq = 0;
export function heading(text: string, level = 3): prose.OutlineEntry {
  return { id: `h${++seq}`, kind: 'heading', nodeName: 'heading', level, text };
}
export function bullet(
  text: string,
  opts: { depth?: number; theirs?: boolean; under?: string } = {},
): prose.OutlineEntry {
  return {
    id: `b${++seq}`,
    kind: 'listItem',
    nodeName: 'listItem',
    text,
    depth: opts.depth ?? 0,
    ...(opts.theirs === true ? {} : { author: NOTES_AUTHOR_ID }),
    ...(opts.under !== undefined ? { underHeadingId: opts.under } : {}),
  };
}
export function bullets(n: number, prefix = 'point'): prose.OutlineEntry[] {
  return Array.from({ length: n }, (_, i) => bullet(`${prefix} ${i + 1}`));
}

/**
 * A live meeting's section heading is the one the note-taker is writing under
 * RIGHT NOW, and the scan used to begin one block after it — so the first
 * topic of every meeting read as a wall with no heading over it, and the
 * meeting's second topic ended the scope outright. Every case here is about
 * the scoped path, which is the path production takes and the one no test
 * reached.
 */
export function ownHeading(text: string, level = 2): prose.OutlineEntry {
  return {
    id: `h${++seq}`,
    kind: 'heading',
    nodeName: 'heading',
    level,
    text,
    author: NOTES_AUTHOR_ID,
  };
}

export function composeInput(outline: prose.OutlineEntry[]): NotesComposeInput {
  return {
    outline,
    tick: {
      reason: 'pause',
      turns: [{ speaker: 'Dana', speakerLabel: 'B', text: 'and one more thing' }],
    },
  } as unknown as NotesComposeInput;
}
