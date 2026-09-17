/**
 * The cleanup route's replies, in the shape it actually sends them.
 *
 * WHY A FIXTURE AND NOT A BODY PER CASE. The defect this exists for was a
 * client reading `body.error` for a refusal the route answers with `reason`,
 * and a body hand-written to suit the assertion is exactly what let that
 * survive a green suite: every test invented the field it was about to read.
 * One place builds the whole reply — every field
 * `packages/server/src/routes/meetings-calendar.ts` puts on a `notes-cleanup`
 * answer, with `reason` drawn from the `NotesCleanupRefusal` union in
 * `packages/server/src/notes-cleanup-pass.ts` — so a case can only assert
 * against what a server would send.
 *
 * It reads no source file and asserts nothing: everything here returns data.
 *
 * Fictional names throughout; the repo is public.
 */

import type { NotesCleanupReply } from '@claude-workspaces/core';

/**
 * The whole answer, which is WIDER than the reader's view of it.
 *
 * `NotesCleanupReply` declares only the fields `readCleanupReply` reads; the
 * route sends these as well, and a fixture that dropped them would be a
 * narrower thing than the client meets.
 */
export interface RouteCleanupReply extends NotesCleanupReply {
  docId: string;
  meetingId: string;
  applied: number;
  suggested: number;
  touched: number;
  blanks: number;
  merged: number;
  turns: number;
}

/** The counters every answer carries, refusal or not. */
const ZEROES = {
  proposed: 0,
  refused: 0,
  refusals: [] as string[],
  failures: [] as string[],
  applied: 0,
  suggested: 0,
  failed: 0,
  touched: 0,
  blanks: 0,
  merged: 0,
  turns: 0,
} as const;

/**
 * A pass that never got as far as composing.
 *
 * The route answers these 409 with `ok: false` and the code in `reason` — and
 * with no `error`, which is the whole of the bug this fixture guards.
 */
export function routeRefusal(reason: string): RouteCleanupReply {
  return { docId: 'd-riverbend', meetingId: 'm-1', ok: false, changed: false, reason, ...ZEROES };
}

/** The four answers the rework is asked about, each as one reply. */
export const REPLIES = {
  /** No model key on this server: the same answer until somebody sets one. */
  noComposer: { status: 409, body: routeRefusal('no-composer') },
  /** A meeting is recording this doc — a person can clear this one. */
  recording: { status: 409, body: routeRefusal('recording') },
  /** It ran, proposed edits, and the gate dropped every one of them. */
  nothingLanded: {
    status: 200,
    body: {
      docId: 'd-riverbend',
      meetingId: 'm-1',
      ok: true,
      changed: false,
      ...ZEROES,
      proposed: 3,
      refused: 3,
      refusals: [
        'replace_block b-ferry: somebody has commented on the block',
        'replace_block b-levee: somebody has commented on the block',
        'delete_block b-harbor: the block is not in the document',
      ],
      turns: 12,
    } satisfies RouteCleanupReply,
  },
  /** It read the whole meeting and found nothing to improve. */
  nothingToChange: {
    status: 200,
    body: {
      docId: 'd-riverbend',
      meetingId: 'm-1',
      ok: true,
      changed: false,
      ...ZEROES,
      turns: 12,
    } satisfies RouteCleanupReply,
  },
  /** And a pass that moved the document: the notes are its own receipt. */
  changed: {
    status: 200,
    body: {
      docId: 'd-riverbend',
      meetingId: 'm-1',
      ok: true,
      changed: true,
      ...ZEROES,
      proposed: 2,
      applied: 2,
      touched: 2,
      turns: 12,
    } satisfies RouteCleanupReply,
  },
} as const;
