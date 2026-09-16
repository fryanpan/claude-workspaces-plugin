/**
 * One line per comment that reached this server, so a lost one can be told
 * from one that was never written.
 *
 * On 15 September 2026 a comment was left on a board and answered by nobody.
 * It was on no board afterwards, and the server held no record of it having
 * been attempted — so "the post failed in the browser" and "the comment was
 * never typed" were the same evidence: none. The browser half of that is the
 * composer's own "Not sent" state (workspaces-app `not-sent.ts`); this is the
 * other half, and it is what makes the next occurrence answerable rather than
 * arguable.
 *
 * **The words are never logged.** A length is enough to recognise the write
 * in a log next to a person saying what they wrote, and a log file is the
 * wrong place for anybody's sentences — this repo is public and the log is
 * read over a shoulder.
 *
 * Stamped (`log-stamp.ts`) because "when" is the whole question asked of these
 * lines, and `console.log` rather than `warn`/`error` because the squelch
 * (`log-squelch.ts`) collapses identical lines at those levels and a stamp
 * would defeat its ceiling. These lines are not a loop: one per human act.
 */

import { stamped } from './log-stamp.ts';

export interface CommentAttempt {
  docId: string;
  /** The thread replied to, or null when the write is a NEW thread. */
  threadId: string | null;
  /** Who wrote it. The id, not the display name — names repeat. */
  authorId: string;
  /** How many characters arrived. Never the characters. */
  chars: number;
  /** The thread the write landed in, or null when nothing was written. */
  landedThreadId: string | null;
  /** The comment id inside it, or null when nothing was written. */
  landedCommentId: string | null;
}

/**
 * `<iso> [comment] doc=… onto=… author=… chars=… → …`.
 *
 * `onto=new` is a thread being opened; `-> refused` is a write the store
 * turned away, which is the line somebody hunting a lost comment is looking
 * for — it says the comment ARRIVED and did not land, a state that otherwise
 * left no trace anywhere.
 */
export function commentLogLine(a: CommentAttempt, now: number = Date.now()): string {
  const outcome =
    a.landedThreadId && a.landedCommentId
      ? `-> thread=${a.landedThreadId} comment=${a.landedCommentId}`
      : '-> refused';
  return stamped(
    `[comment] doc=${a.docId} onto=${a.threadId ?? 'new'} author=${a.authorId} ` +
      `chars=${a.chars} ${outcome}`,
    now,
  );
}

/** Write the line. `sink` is injectable so a test reads what it wrote. */
export function logCommentAttempt(
  a: CommentAttempt,
  sink: (line: string) => void = console.log,
  now?: number,
): void {
  sink(commentLogLine(a, now));
}
