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
