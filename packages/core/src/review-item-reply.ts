/**
 * The reply readers: what the TEXT of a person's reply says about an open
 * review item — whether it asks back (`answerAsksBack`) and whether it
 * answers, and with which option (`answerFromReply`).
 *
 * Out of `review-item.ts`, which re-exports both under the names callers
 * already import. They read the words a person typed and the options the item
 * offered, and nothing the payload lifecycle there keeps, so they live apart
 * from it.
 */

import type { ReviewPayload } from './review-item-types.ts';

/**
 * Does this reply ASK BACK rather than answer — a question typed where an
 * answer goes?
 *
 * The incident this exists for (2026-08-30): a reviewer answered the decision
 * "How should boards share work?" with "Why is this important?", and the board
 * recorded that as the decision's answer. The item closed, `revise` refused it
 * ("the answer is to the words it has"), and the only way to keep asking was a
 * duplicate row. A question typed into an answer box is the most natural way
 * to ask for more information, and nothing distinguished it from a decision.
 *
 * The rule is the ENDING alone: the text's last sentence ends in "?" (closing
 * markdown/quote marks skipped, the way `review-queue.ts`'s sentence rule
 * skips them). Deliberately narrower than `findAsk` — that matcher judges
 * agent PROSE, where a bare "?" fires on URLs and code and needs a direct
 * address to mean anything; here the text is what a person typed into an
 * answer composer, where ending on a question mark is the asking. A "?" mid-
 * text with a statement after it ("Option A? No — B.") reads as an answer,
 * which is the safe failure: the words are recorded verbatim either way.
 *
 * Callers gate on WHO typed it (a person, not an agent relaying words) and on
 * whether an option was tapped — a tapped option is an answer whatever its
 * label ends in. Those are the caller's facts; this judges only the text.
 */
const TRAILING_CLOSERS = new Set(['*', '`', '"', "'", '_', ')', ']', '}', '”', '’']);
export function answerAsksBack(text: string): boolean {
  let s = text.trim();
  while (s.length > 0 && TRAILING_CLOSERS.has(s[s.length - 1] as string)) {
    s = s.slice(0, -1).trimEnd();
  }
  return s.endsWith('?');
}

/**
 * Is this person's plain reply the ASK's answer, and which option did it come
 * from?
 *
 * The gap this closes was measured on this project's own stored docs: 152
 * comment-borne declarations, 123 of them answered, and 12 unanswered ones
 * with a person's reply sitting directly underneath. The answer path is not
 * unused and a better queue would not help — three surfaces render an Answer
 * composer and route to the answer endpoint, and every OTHER door a reply can
 * come through (a task panel's discussion composer, a widget, an agent
 * relaying words, an older bundle) posts a plain comment. On those doors a
 * person answers in their own words and the row stays queued behind them.
 *
 * So the reply is read as the answer — but only where reading it that way
 * cannot INVENT one:
 *
 * - **Nothing offered → the words are the answer.** An open question has no
 *   vocabulary of its own; prose is the only shape its answer can take, and a
 *   person who typed prose under it has answered it.
 * - **Options offered → only the label answers.** A decision's options ARE
 *   the answer's vocabulary, and prose under one is as often a question back
 *   ("is there a reason to trigger it?") as a pick. Guessing which option
 *   prose meant is the regression this codebase already shipped once, when
 *   "a person spoke" was itself the record of an answer and one line of small
 *   talk retired a decision and took its card with it. Typing the label is
 *   still a pick, because that is how a person picks with no buttons in front
 *   of them — a phone keyboard, a widget, an agent passing the words along.
 *
 * Trimmed and case-folded, and nothing looser. Anything fuzzier is the
 * inference the second rule exists to refuse. Measured against the 12: this
 * captures the 4 with no options, and leaves the 8 prose answers on decisions
 * where they are — visible, unanswered, and a decision for the owner rather
 * than a guess by the server.
 *
 * `null` means "this reply answered nothing" and the caller posts an ordinary
 * comment. `{}` — an answer that picked no option — is not a lesser answer;
 * see `answeredWith`.
 */
export function answerFromReply(review: ReviewPayload, text: string): { optionId?: string } | null {
  const words = text.trim();
  if (words === '') return null;
  // Keyed on what was OFFERED rather than on `shape`, because the options are
  // what a reader saw and could have typed back. A `decision` that carries
  // none offers no vocabulary, so prose is the only answer it could ever get —
  // unless the prose is a QUESTION. Without that guard, "Why is this
  // important?" under an open question folded as its answer and closed it —
  // the same wrong reading the explicit answer routes refuse
  // (`answerAsksBack`). The guard sits in THIS branch only: with options
  // offered, typing a label back is a pick even when the label itself ends in
  // "?" ("Ship now?"), so the label match below must run first — and its
  // no-match case already leaves prose, questions included, as a comment.
  const options = review.options ?? [];
  if (options.length === 0) return answerAsksBack(words) ? null : {};
  // EXACTLY one, never the first of several. Trimming and case-folding is what
  // lets a person type a label back, and it is also what can make two DIFFERENT
  // options ("Yes" and " yes ") indistinguishable from the words typed. Taking
  // the first would stamp a coin toss as the reader's answer, on the one field
  // they cannot see is wrong. Zero matches and two matches are the same state
  // here — nothing was picked — and the words stay a comment on an item the
  // reader can still answer.
  const wanted = words.toLowerCase();
  const matches = options.filter((o) => o.label.trim().toLowerCase() === wanted);
  const picked = matches.length === 1 ? matches[0] : undefined;
  return picked ? { optionId: picked.id } : null;
}
