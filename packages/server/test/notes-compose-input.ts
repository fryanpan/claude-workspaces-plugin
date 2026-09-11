/**
 * One tick's compose input, as the session would hand it over: two settled
 * turns, a notes section already open with one bullet under it, and the
 * project context a board supplies.
 *
 * Shared by the two suites that grew out of one file — what the prompt SAYS
 * (`notes-prompt-build.test.ts`) and what the HTTP seam DOES with it
 * (`meeting-notes-composer.test.ts`). One fixture, because a prompt
 * assertion and a request assertion that disagreed about the input would
 * disagree silently.
 *
 * All fixtures are synthetic. The repo is public.
 */
import type { NotesComposeInput } from '../src/meeting-notes.ts';

export const input: NotesComposeInput = {
  docId: 'doc-a',
  meetingId: 'm-doc-a-1',
  tick: {
    tick: 2,
    reason: 'pause',
    turns: [
      { turn: 3, text: 'The sync is the bottleneck.' },
      { turn: 4, text: 'Measure before rewriting.' },
    ],
  },
  outline: [
    {
      id: 'h1',
      kind: 'heading',
      nodeName: 'heading',
      level: 2,
      text: 'Meeting notes',
      author: 'meeting-notes',
    },
    {
      id: 'b1',
      kind: 'listItem',
      nodeName: 'listItem',
      text: 'earlier point',
      author: 'meeting-notes',
      underHeadingId: 'h1',
    },
  ],
  notesHeadingId: 'h1',
  context: {
    docTitle: 'Q3 planning',
    taskTitles: ['Bryan can hear his meeting become notes'],
    repoRoot: '/repo/planning',
  },
};

/**
 * The same tick against a doc `n` bullets long — a meeting far enough in that
 * the outline has a settled part as well as a live end.
 *
 * A two-block doc is entirely live, so a prompt built from `input` alone has
 * one cached chunk and one tail whatever the cutting rule is. Every assertion
 * about the CUTTING needs a doc the rule actually cuts, or it passes on a
 * builder that does not cut at all.
 */
export function withBullets(n: number): NotesComposeInput {
  return {
    ...input,
    outline: [
      input.outline[0] as (typeof input.outline)[number],
      ...Array.from({ length: n }, (_, i) => ({
        id: `b${i}`,
        kind: 'listItem' as const,
        nodeName: 'listItem',
        text: `point ${i}`,
        author: 'meeting-notes',
        underHeadingId: 'h1',
      })),
    ],
  };
}
