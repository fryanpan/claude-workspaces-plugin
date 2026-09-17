/**
 * WHEN a meeting's quality item reaches a person, and how many of them there
 * are.
 *
 * THE FAILURE THIS MODULE EXISTS TO END. The pass that judges a meeting's
 * notes runs inside `notes.end()`, and `notes.end()` runs at the end of a
 * RECORDING LEG rather than at the end of a MEETING. A socket that drops
 * mid-sentence ends a leg; the browser reconnects, `MeetingStore.resume`
 * picks the same meeting back up, and the conversation carries on. So the
 * item filed at that leg's stop reached Bryan's queue while he was still in
 * the room — and the resumed leg's own stop filed a SECOND item about the
 * same meeting, because the filing path had no memory and the module that
 * owned it reasoned, correctly for the world it was written in, that "a
 * meeting stops once".
 *
 * THE FIX IS A SCHEDULER, NOT A SECOND FILING PATH. Every reading still goes
 * through `fileNotesQualityReview` exactly as it did; what changed is that
 * the pass hands its reading here instead of filing it, and this module
 * decides when the meeting is over:
 *
 *  - A leg that ended the way a person ends a meeting — the Stop button, the
 *    silence deadline, a tab closing — is the end of the meeting, and the
 *    item files at once. That is the common case and it is not delayed.
 *  - A leg that ended the way a network ends one holds the reading for
 *    {@link RESUME_GRACE_MS}. A resume inside that window cancels the hold
 *    and throws the reading away, because the next stop will read the whole
 *    meeting's notes again and that reading is the true one. No resume, and
 *    the hold expires and the item files.
 *
 * ONE ITEM PER MEETING, and the memory is what makes that true where the old
 * reasoning no longer is. The first filing is remembered; a later reading of
 * the same meeting REVISES those words through the same revise path the
 * stall escalation uses, so a reader's queue never carries two items about
 * one meeting with the older, wronger one still reading as live.
 *
 * A REFUSED REVISION IS NOT A REASON TO FILE A SECOND ITEM. That is the one
 * outcome this module must never produce, so a refusal is logged and the
 * standing item is left as it is.
 *
 * AN ITEM WHOSE CLAIM STOPPED BEING TRUE IS TAKEN BACK, which is why EVERY
 * reading reaches this module rather than only the flagged ones. A reading
 * that crossed no bar used to stop at the pass, so the leg where a flag
 * DISAPPEARED reached nothing and the item filed at the bad leg went on
 * claiming a meeting had come out badly after the meeting had read clean.
 * What this module does with an unflagged reading, in full:
 *
 *  - The meeting has no item: nothing. A clean reading of a meeting nobody
 *    was told about is not news, and it files nothing, says nothing and
 *    leaves no memory behind.
 *  - The meeting has an item: the item is WITHDRAWN — the asker's own exit,
 *    the same one the stall escalation takes, which retires the ask without
 *    destroying it or touching the words a person may have replied with.
 *    The memory of where it went is dropped with it, so a later leg that
 *    goes wrong again files a fresh item rather than revising a withdrawn
 *    one.
 *  - A refused withdrawal is logged and the item is LEFT STANDING. An item a
 *    person has already answered refuses, and so it should: withdrawing it
 *    would retract their answer.
 *
 * AND THE WITHDRAWAL IS HELD EXACTLY AS THE FILING IS. It is decided at
 * commit, on the last reading of the meeting, never at the moment a flag
 * clears — a clean leg can be followed by another bad one, and withdrawing
 * mid-grace would take the item off a reader's queue and put it back. So a
 * meeting that ends clean withdraws once, and a meeting that ends badly
 * never withdraws at all.
 *
 * AND IT HOLDS ACROSS A RESTART, WHICH TOOK A FILE. The memory below is a
 * Map in this process, and a restart is the one leg-ending this repo produces
 * itself: it is not held through (`legIsResumable('server-restart')` is
 * false) because a hold is a timer a restarting server exits before it can
 * fire, so the item files at once rather than risking being lost outright.
 * The browser resumes across exactly that gap — `meeting-reconnect.ts` treats
 * a deploy's restart as invisible to the recording — so a meeting whose item
 * was filed BY a restart used to end clean in the NEW process, find no
 * `filed` to take back, and leave the item standing. That was the commonest
 * way one of these reached a person mid-meeting. So `filed` is now mirrored
 * to `notes-quality-filed-store.ts`, one small file in the meeting's own
 * folder, and an entry the map does not have is hydrated from it. What the
 * record's lifetime is, and why a store it cannot read is an empty store
 * rather than a failed filing, are that module's own header.
 *
 * AND A REVISION THAT CHANGES NOTHING IS NOT MADE AT ALL. Revising a review
 * item re-judges it, which puts it back in front of its reader — so a flag
 * that cannot clear would walk a person back to the same unanswerable
 * question at every leg stop, which is what seven identical filings on one
 * meeting looked like from the reader's side (2026-09-15). The VERDICT filed
 * is remembered and compared — the bars crossed, the counts behind them, and
 * the rates behind them to within a band — so a reading that says what the
 * item already says is a re-check rather than a change of verdict. One filing
 * per genuine change, and none for a repeat. What counts as a change, and why
 * it is not the item's words, is `notes-quality-verdict.ts`.
 */

import type { TickScheduler } from './meeting-notes.ts';
import type {
  NotesQualityFiledStore,
  NotesQualityFiledWhere,
} from './notes-quality-filed-store.ts';
import {
  type HeldMeeting,
  createNotesQualityMeetingMemory,
} from './notes-quality-meeting-memory.ts';
import {
  type NotesQualityBoard,
  type NotesQualityFileInput,
  type NotesQualityFiling,
  buildNotesQualityReview,
  fileNotesQualityReview,
  filingWhere,
} from './notes-quality-review.ts';
import { type NotesQualityVerdict, verdictChanged, verdictOf } from './notes-quality-verdict.ts';

/** A meeting, as every file on this path names one. */
export interface MeetingIds {
  docId: string;
  meetingId: string;
}

/**
 * How long a reading waits for a reconnect that may never come.
 *
 * Two minutes, which is `RECONNECT_WINDOW_MS` in the browser's own
 * `meeting-reconnect.ts`: past it the client gives the meeting up and starts
 * a new recording with its own section, so a resume cannot arrive any more
 * and holding longer only delays an item nobody is waiting on.
 */
export const RESUME_GRACE_MS = 120_000;

/**
 * The words on a withdrawal, which a reader sees beside the retired ask.
 *
 * It says what changed rather than that the server changed its mind: the item
 * was true of the leg it was filed from, and the meeting read clean by the
 * end. A reader who remembers seeing the ask needs that sentence to know
 * nothing was lost.
 */
export const WITHDRAWN_BECAUSE_CLEAN =
  'the notes read clean by the end of this meeting — the reading this item was filed from ' +
  'was one recording leg, and a later one found nothing past a bar';

export interface NotesQualityFilerDeps {
  /** The board the item goes on. Absent, nothing is filed. */
  board?: () => NotesQualityBoard;
  actor: { id: string; name: string; kind?: string };
  /**
   * Where `filed` is mirrored so a restart does not lose it.
   *
   * Absent, the memory is this process's alone — which is what a test that
   * models two meetings in one process wants, and what a server with no data
   * dir has.
   */
  filedStore?: NotesQualityFiledStore;
  /** The resume grace's clock. Injected so a test fires it by hand. */
  schedule?: TickScheduler;
  graceMs?: number;
  /** Where the filing's own line goes. */
  say?: (message: string) => void;
}

/**
 * The pass's filing sink, and the two lifecycle facts that decide when it
 * acts.
 */
export interface NotesQualityFiler {
  /**
   * A reading of this meeting — one that crossed a bar, or one that came out
   * clean. Held rather than acted on: the answer is always `held`, and what
   * the reading means is decided when {@link legEnded} says the meeting is
   * over. A flagged one files or revises the meeting's one item; a clean one
   * withdraws it, or means nothing if there is none.
   */
  file(ids: MeetingIds, input: NotesQualityFileInput): NotesQualityFiling;
  /**
   * A recording leg ended. `resumable` when the way it ended is one the
   * browser tries to reconnect from; false for a stop a person or the server
   * meant.
   */
  legEnded(ids: MeetingIds, opts: { resumable: boolean }): void;
  /** A recording leg began on this meeting — a resume, if the ids are held. */
  legBegan(ids: MeetingIds): void;
  /** How many meetings are holding a reading. Diagnostics and tests. */
  heldCount(): number;
}

const defaultSchedule: TickScheduler = {
  set: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    (handle as unknown as { unref?: () => void }).unref?.();
    return handle;
  },
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createNotesQualityFiler(deps: NotesQualityFilerDeps): NotesQualityFiler {
  const memory = createNotesQualityMeetingMemory(deps.filedStore);
  const schedule = deps.schedule ?? defaultSchedule;
  const graceMs = deps.graceMs ?? RESUME_GRACE_MS;
  const say = deps.say ?? ((message: string) => console.error(message));

  const disarm = (h: HeldMeeting): void => {
    if (h.timer === undefined) return;
    schedule.clear(h.timer);
    h.timer = undefined;
  };

  /** The words a reading would put on the item. */
  const wordsOf = (input: NotesQualityFileInput): Record<string, unknown> | null =>
    input.workspaceId === undefined
      ? null
      : buildNotesQualityReview({
          workspaceId: input.workspaceId,
          docId: input.docId,
          ...(input.docTitle !== undefined ? { docTitle: input.docTitle } : {}),
          report: input.report,
        });

  /**
   * Whether this reading says something the item does not already say.
   *
   * The rule and its reasoning are `notes-quality-verdict.ts`: bars and
   * counts exactly, RATES with a band, and the band measured against the
   * value ON THE ITEM rather than against the previous leg's reading — which
   * is what makes a slow ramp eventually cross instead of sliding under the
   * band forever.
   *
   * Two earlier versions of this comparison were wrong in the same direction,
   * and both are worth knowing before touching it. It compared the item's
   * rendered words, which differ at every leg because the transcript grows.
   * Then it compared the flags — whose TEXT carries those same growing
   * numbers for six of the seven kinds.
   */
  const saysSomethingNew = (filed: NotesQualityVerdict, input: NotesQualityFileInput): boolean =>
    verdictChanged(filed, verdictOf(input.report));

  /**
   * Rewrite the words of the item this meeting already has.
   *
   * `unchanged` is not a failure: it is the answer for a re-check that read
   * the meeting the same way, and it leaves the item exactly where it is
   * rather than re-judging it in front of its reader.
   */
  const revise = (
    ids: MeetingIds,
    filed: NotesQualityFiledWhere,
    input: NotesQualityFileInput,
    mem: HeldMeeting,
  ): 'revised' | 'unchanged' | 'failed' => {
    if (mem.verdict !== undefined && !saysSomethingNew(mem.verdict, input)) return 'unchanged';
    const board = deps.board?.();
    const review = wordsOf(input);
    if (!board || review === null) return 'failed';
    const patch = { headline: review.headline, detail: review.detail };
    const res =
      filed.kind === 'row'
        ? board.reviseReviewItem?.(filed.taskId, filed.itemId, patch, { actor: deps.actor })
        : board.reviseOnDoc?.(filed.docId, filed.threadId, filed.commentId, patch, deps.actor);
    if (res === undefined) {
      say(
        `[meeting-notes] ${ids.docId} meeting ${ids.meetingId}: the quality item cannot be ` +
          'revised on this board — the standing item keeps the reading it was filed with',
      );
      return 'failed';
    }
    if (!res.ok) {
      // Never a second item. The reader's queue carrying one stale ask is
      // better than it carrying two about the same meeting.
      say(
        `[meeting-notes] ${ids.docId} meeting ${ids.meetingId}: quality item revise refused ` +
          `(${res.error}${res.message !== undefined ? `: ${res.message}` : ''})`,
      );
      return 'failed';
    }
    // The item now says THIS, so this is what the next leg is banded
    // against. Never the reading that produced it: a suppressed reading left
    // the item where it was, and banding against the suppressed one is how a
    // slow ramp never crosses.
    mem.verdict = verdictOf(input.report);
    memory.remember(ids, mem);
    return 'revised';
  };

  /**
   * Take the meeting's item back, because its last reading crossed no bar.
   *
   * ONLY ON SUCCESS IS THE MEMORY DROPPED. A refusal leaves `filed` where it
   * is, so the item is still addressable: a later leg that goes wrong revises
   * the ask that is still standing rather than raising a second one beside
   * it, which is the outcome this whole module exists to prevent.
   */
  const withdraw = (
    ids: MeetingIds,
    filed: NotesQualityFiledWhere,
    mem: HeldMeeting,
  ): 'withdrawn' | 'failed' => {
    const board = deps.board?.();
    const res = !board
      ? undefined
      : filed.kind === 'row'
        ? board.withdrawReviewItem?.(filed.taskId, filed.itemId, {
            actor: deps.actor,
            reason: WITHDRAWN_BECAUSE_CLEAN,
          })
        : board.withdrawOnDoc?.(
            filed.docId,
            filed.threadId,
            filed.commentId,
            WITHDRAWN_BECAUSE_CLEAN,
            deps.actor,
          );
    if (res === undefined) {
      say(
        `[meeting-notes] ${ids.docId} meeting ${ids.meetingId}: the quality item cannot be ` +
          'withdrawn on this board — the standing item keeps a reading the meeting outgrew',
      );
      return 'failed';
    }
    if (!res.ok) {
      // An item somebody already answered refuses, and must: withdrawing it
      // would retract their answer. The ASK is repeated at every later clean
      // leg, because an undone answer makes the same item withdrawable again;
      // only the line is said once — see `withdrawRefusalSaid`.
      if (!mem.withdrawRefusalSaid) {
        mem.withdrawRefusalSaid = true;
        say(
          `[meeting-notes] ${ids.docId} meeting ${ids.meetingId}: quality item withdraw refused ` +
            `(${res.error}${res.message !== undefined ? `: ${res.message}` : ''})`,
        );
      }
      return 'failed';
    }
    memory.forget(ids, mem);
    return 'withdrawn';
  };

  /**
   * The meeting is over: act on the last reading it left.
   *
   * A flagged reading files the meeting's item or revises it. A clean one
   * withdraws the item the meeting has, and does nothing at all for a meeting
   * that never had one.
   */
  const commit = (ids: MeetingIds): void => {
    const h = memory.peek(ids);
    if (!h) return;
    disarm(h);
    const input = h.input;
    h.input = undefined;
    if (!input) return;
    // THE SAME VOCABULARY THE STOP'S OWN LINE USES, because the two halves of
    // one meeting's story are now written at two moments and a reader greps
    // for one phrase.
    const line = (where: string): void =>
      say(`[meeting-notes] ${ids.docId} meeting ${ids.meetingId}: quality item ${where}`);
    if (input.report.flags.length === 0) {
      // The meeting's last word is that its notes came out fine. There is
      // nothing to file for that, and exactly one thing to undo.
      if (!h.filed) return;
      if (withdraw(ids, h.filed, h) === 'withdrawn') {
        line('withdrawn — the meeting ended with its notes past no bar');
      }
      return;
    }
    if (h.filed) {
      const outcome = revise(ids, h.filed, input, h);
      if (outcome === 'unchanged') {
        line('unchanged — the reading is the same one it already carries');
        return;
      }
      if (outcome === 'revised') {
        line(
          h.filed.kind === 'row'
            ? `revised on ${filingWhere(
                { filed: true, taskId: h.filed.taskId, itemId: h.filed.itemId },
                input.workspaceId,
              )}`
            : `revised on the doc ${h.filed.docId}`,
        );
      }
      return;
    }
    const board = deps.board?.();
    const filing = board
      ? fileNotesQualityReview(board, deps.actor, input)
      : ({ filed: false, reason: 'no-board' } as NotesQualityFiling);
    line(filingWhere(filing, input.workspaceId));
    if (!filing.filed) return;
    h.filed =
      'taskId' in filing
        ? { kind: 'row', taskId: filing.taskId, itemId: filing.itemId }
        : {
            kind: 'doc',
            docId: filing.docId,
            threadId: filing.threadId,
            commentId: filing.commentId,
          };
    h.verdict = verdictOf(input.report);
    memory.remember(ids, h);
  };

  return {
    file(ids, input) {
      const h = memory.get(ids);
      h.input = input;
      return { filed: false, reason: 'held' };
    },
    legEnded(ids, opts) {
      const h = memory.peek(ids);
      if (!h) return;
      disarm(h);
      if (!opts.resumable) {
        commit(ids);
        return;
      }
      // A drop. The words either side of it are one conversation, so nothing
      // reaches a person until the conversation is done with.
      h.timer = schedule.set(() => commit(ids), graceMs);
    },
    legBegan(ids) {
      const h = memory.peek(ids);
      if (!h) return;
      disarm(h);
      // The meeting is running again, so the reading taken at the drop is
      // about half a meeting. The next stop reads the whole of it.
      h.input = undefined;
    },
    heldCount: () => memory.heldCount(),
  };
}
