/**
 * A question a PERSON asked on a document that no agent has answered.
 *
 * The board has always been able to see the other direction. `review-queue.ts`
 * walks every open thread for an agent's unanswered comment — the `unreplied`
 * band — and for a declaration awaiting a person — the `declared` band. Both
 * end at a person: `unansweredRun` collects the trailing run of AGENT comments
 * and stops at the first author who is not one, so a thread whose last speaker
 * is Bryan yields an empty run and emits no row in either band. That is not a
 * bug in the queue; it is the queue answering the question it was built for.
 * It leaves this direction with no surface at all, which is what this module
 * is.
 *
 * **Structural, not textual.** `ask-detection.ts` reads the words, and over
 * this board's 86 agent comments a question mark fires on 19 and the two
 * signals together on 1, missing two of the three real questions. "A person
 * spoke and no agent has spoken since" needs no reading of the words, and the
 * comment it catches best — one with no question mark anywhere in it — is
 * precisely the one a text pass drops.
 *
 * **Who hears it.** Nobody here reaches Bryan. The row goes into the board's
 * stall snapshot and the lead is woken with it, exactly like a held item or an
 * asked-back one, because the remedy is an agent's reply and the lead is who
 * assigns that. A doc on no board produces nothing at all, which is the
 * structural half of the same rule: `stall-wiring.ts` bounds the walk to
 * `workspace.docIds`.
 *
 * Sized against one measured document (2026-09-16): 3 of its 28 open threads
 * are person-last, all three quiet for 17 days. A huddle doc is the case where
 * an agent replies to nearly everything, so 11% reads as a floor rather than a
 * typical value — low hundreds across the corpus as an order of magnitude, not
 * a number.
 */
import type { Comment, Thread } from '@claude-workspaces/core';
import { authorFields, classifyActor } from './actor-identity.ts';

/**
 * How long a person's question stands before the lead is told about it.
 *
 * A day, and the number is a judgement rather than a measurement. An hour
 * would fire while somebody is still typing their second comment; a week is
 * past the point where an answer still means anything. The three measured
 * casualties had been waiting seventeen days, so anything under a fortnight
 * catches them and the floor is set by the false positives instead.
 */
export const UNANSWERED_THREAD_DEFAULT_MS = 24 * 60 * 60 * 1000;

/** How much of the person's comment the lead is shown, so deciding whether
 *  the thread is theirs costs no doc read. */
const EXCERPT_CHARS = 140;

/** The person's ask, as `personAwaitingReply` reads it off one thread. */
export interface UnansweredAsk {
  /** The FIRST comment of the trailing person run — the one to answer, and
   *  the moment the answer became owed. */
  commentId: string;
  askedBy: string;
  askedAt: number;
  /** The newest comment in that run. Carried separately from `askedAt` so a
   *  fresh comment on an old conversation can be news to the stall stamp
   *  while the age the lead is shown stays the true one. */
  latestAt: number;
  /** The opening of what they wrote, trimmed to one line. */
  excerpt: string;
}

/** One doc thread waiting on an agent, before the window has been applied. */
export interface UnansweredThreadInput extends UnansweredAsk {
  /** The DOC's id — the surface the lead opens, and what the stall stamp
   *  dedupes the board's other findings against. */
  id: string;
  title: string;
  docId: string;
  threadId: string;
}

/** One doc thread waiting on an agent, as the wake names it. */
export interface UnansweredThreadRow extends UnansweredThreadInput {
  /** How long the person has been waiting, from `askedAt`. */
  askedMs: number;
  /** The paste-ready call that answers it. Spelled here, once, for the same
   *  reason `reviseCallFor` is: three copies of an address is how one of them
   *  comes to name a verb that refuses. */
  reply: string;
}

/** One line of a comment's text, bounded. Newlines collapse because the frame
 *  is read as a list and a pasted diff would run down the reader's terminal. */
function excerptOf(text: unknown): string {
  const flat = (typeof text === 'string' ? text : '').replace(/\s+/g, ' ').trim();
  return flat.length > EXCERPT_CHARS ? `${flat.slice(0, EXCERPT_CHARS - 1)}…` : flat;
}

/**
 * The trailing run of PERSON comments on an open thread, or `undefined` when
 * the thread is not waiting on an agent at all.
 *
 * The mirror of `unansweredRun` in `review-queue.ts`, and deliberately not a
 * reuse of it: that function breaks at the first author who is not an agent,
 * which is the very thread this one is looking for.
 *
 * Sorted by `ts` before anything is read off the end. A thread's comments are
 * a CRDT array in INSERTION order, which is not clock order — taking
 * `comments[length - 1]` would call a thread person-last on the strength of a
 * replayed edit and wake the lead over an answer the agent had already given.
 *
 * An author `classifyActor` cannot read — no `kind` field, or stored as a bare
 * string, about 1.4% of stored comments — classifies as an agent, so a thread
 * ending in one is silent here. That is the safe direction: the cost is a
 * thread nobody is told about, and the alternative is waking the lead over an
 * agent's own comment.
 */
export function personAwaitingReply(thread: Thread): UnansweredAsk | undefined {
  if (thread.status !== 'open') return undefined;
  const byTime: Comment[] = [...(thread.comments ?? [])].sort((a, b) => a.ts - b.ts);
  const newest = byTime[byTime.length - 1];
  if (newest === undefined || classifyActor(newest.author) !== 'person') return undefined;
  let first = newest;
  for (let i = byTime.length - 2; i >= 0; i -= 1) {
    const c = byTime[i];
    if (c === undefined || classifyActor(c.author) !== 'person') break;
    first = c;
  }
  return {
    commentId: first.id,
    askedBy: authorFields(first.author).name ?? 'Somebody',
    askedAt: first.ts,
    latestAt: newest.ts,
    excerpt: excerptOf(first.text),
  };
}

/**
 * The waiting threads the LEAD is told about: a person's question standing
 * longer than the window, oldest first — the one most at risk of never being
 * answered at all leads the list.
 *
 * Measured from `askedAt`, not `latestAt`: a person who asked twenty-five
 * hours ago and nudged a minute ago has been waiting twenty-five hours, and
 * billing the clock to the nudge would let a conversation stay fresh forever
 * by being nudged.
 */
export function overdueUnansweredThreads(
  items: readonly UnansweredThreadInput[],
  now: number,
  windowMs: number = UNANSWERED_THREAD_DEFAULT_MS,
): UnansweredThreadRow[] {
  return items
    .map((item) => ({
      ...item,
      askedMs: now - item.askedAt,
      reply: `post_reply(docId="${item.docId}", threadId="${item.threadId}", text="…")`,
    }))
    .filter((item) => item.askedMs > windowMs)
    .sort((a, b) => b.askedMs - a.askedMs);
}
