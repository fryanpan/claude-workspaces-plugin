/**
 * An open ask that no longer applies, read off its thread.
 *
 * Bryan, 2026-10-07: "Why are there invalid review items still on my board
 * from text that's been orphaned and is no longer needed?" An item was
 * anchored on a mock's button; the agent removed the button and said so on
 * the thread, and the item stayed on Home. Two rules decide it, both read
 * from the thread as it stands, so an item filed before this existed is
 * judged the same way and nothing is rewritten:
 *
 *  - **orphaned** — the thread's anchor is orphaned: the words or element it
 *    was about are gone from the doc. A re-anchor brings the ask back.
 *  - **settled** — a LATER comment by the asker itself, carrying no
 *    declaration of its own, says the ask is moot ("this is no longer
 *    needed", "never mind"), or says something was removed in a sentence
 *    that names a word of the ask's headline or names it by a pronoun ("I
 *    removed it") (`settlesAsk`). Only the
 *    asker's own words count: a person replying is answering, which is a
 *    different exit.
 *
 * The item is not destroyed. Its words stay on the thread, marked as no
 * longer asked, and the queue stops carrying it. The asker is told once, so it
 * can withdraw the item or file a fresh one.
 *
 * `settlesAsk` is a narrow phrase rule, not a model, so it can be tested and
 * costs nothing per reply. Progress on something else ("the retry error is
 * now fixed") never matches: a moot phrase must name the ask, and a removal
 * must share a word with its headline or name its object by a pronoun ("I
 * removed it") — on the asker's own thread the pronoun is the ask's subject.
 * An offer to redo the work later ("I'll do that only if you want it") does
 * not block; a question mark does, and so does a negation ahead of the
 * removal words in their sentence ("I don't think I deleted it"). What it
 * misses: a paraphrase outside its phrases ("the button's gone", "all
 * sorted"), a removal that a negation happens to precede ("No, I removed
 * it"), a bare "done", work done rather than removed, a settling reply from a different agent, and an
 * anchor the server never marks orphaned (an element removed from a mock is
 * found missing by the widget, not the server). What it can wrongly catch: a
 * removal of something else that happens to share a headline word, or that
 * the asker names only as "it", in a reply with no question mark and no
 * "still need".
 */

/** Why an ask stopped applying. */
export type StaleAskRule = 'orphaned' | 'settled';

export interface StaleAsk {
  rule: StaleAskRule;
  /** When it stopped applying: the settling comment's time, or the time the
   *  anchor was last seen. */
  at: number;
  /** The asker's comment that settled it, for `settled`. */
  commentId?: string;
}

/** The fixed line the thread shows on a stale ask, and the asker is told. */
export const STALE_ASK_NOTE: Record<StaleAskRule, string> = {
  orphaned: 'No longer asked: what it was about is gone from the page.',
  settled: 'No longer asked: its asker said this was settled.',
};

interface CommentLike {
  id: string;
  ts: number;
  text: string;
  author: { id?: string; name?: string };
  review?: unknown;
}

interface ThreadLike {
  anchor?: { kind: string; lastSeenAt?: number };
  comments?: ReadonlyArray<CommentLike>;
}

/** Phrases that say THE ASK itself is moot: each names it ("this", "the
 *  question"), so progress on something else never matches. */
const MOOT_RE = [
  /\b(?:this|that|it|the (?:question|ask|decision))(?:'s| is| was| has become)\s+(?:now\s+)?(?:no longer (?:needed|necessary|relevant|a question|an issue)|moot)\b/i,
  /\bnever ?mind\b/i,
  /\b(?:disregard|ignore) (?:this|that|the|my) (?:question|ask|decision)\b/i,
];
/** A removal: counts only when its own sentence names what the ask was
 *  about (`sharesSubject`). */
const REMOVED_RE =
  /\b(?:(?:i|we)(?:\s+have|'ve)?\s+(?:removed|deleted|dropped)|(?:is|was|are|were|has been|have been)\s+(?:removed|deleted))\b/i;
/** A removal whose object is a pronoun or "the option": on the ask's own
 *  thread, by its own asker, the pronoun can only mean what was asked about,
 *  so it settles without a shared headline word. */
const REMOVED_PRONOUN_RE =
  /\b(?:(?:i|we)(?:\s+have|'ve)?\s+(?:removed|deleted|dropped)\s+(?:it|this|that|them|the (?:option|choice))|(?:it|this|that|they)(?:'s| is| was| are| were| has been| have been)\s+(?:now\s+)?(?:removed|deleted|dropped))\b/i;
/** A denial ("I don't think I deleted it", "nobody said we removed it") holds
 *  the removal words without the removal, so a sentence carrying one before
 *  them settles nothing. */
const NEGATION_RE = /\b(?:not|never|no|nobody|nothing|none)\b|n't\b/i;

/** Did `sentence` say something was removed, with no denial ahead of it? */
function removedIn(sentence: string, re: RegExp): boolean {
  const m = re.exec(sentence);
  return m !== null && !NEGATION_RE.test(sentence.slice(0, m.index));
}

/** A reply that still asks is not a settlement, whatever else it says. */
const STILL_ASKING_RE = /\?|\bstill (?:need|needs|want|wants|waiting|open|asking)\b/i;

const STOPWORDS = new Set(
  'this that with from have your there their which what when where should would could about keep into them then than these those does they been were will'.split(
    ' ',
  ),
);
const subjectWords = (text: string): Set<string> =>
  new Set(
    (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
      (w) => w.length >= 4 && !STOPWORDS.has(w),
    ),
  );

/** Does `sentence` name a word the ask's headline is about? */
function sharesSubject(sentence: string, headline: string): boolean {
  const about = subjectWords(headline);
  for (const w of subjectWords(sentence)) if (about.has(w)) return true;
  return false;
}

/** Does this text, from the asker, settle its own earlier ask whose headline
 *  is `headline`? */
export function settlesAsk(text: string, headline: string): boolean {
  if (STILL_ASKING_RE.test(text)) return false;
  if (MOOT_RE.some((re) => re.test(text))) return true;
  return text
    .split(/(?<=[.!;])\s+/)
    .some(
      (sentence) =>
        removedIn(sentence, REMOVED_PRONOUN_RE) ||
        (removedIn(sentence, REMOVED_RE) && sharesSubject(sentence, headline)),
    );
}

const sameAuthor = (a: CommentLike['author'], b: CommentLike['author']): boolean =>
  a.id !== undefined && b.id !== undefined ? a.id === b.id : a.name === b.name;

/**
 * Whether the declaration `declaring` on `thread` no longer applies, and why.
 * Orphaned wins over settled: it is the fact about the doc, and it is the one
 * a re-anchor can undo.
 */
export function staleAsk(thread: ThreadLike, declaring: CommentLike): StaleAsk | undefined {
  if (thread.anchor?.kind === 'orphan') {
    return { rule: 'orphaned', at: thread.anchor.lastSeenAt ?? declaring.ts };
  }
  const headline = (declaring.review as { headline?: unknown } | undefined)?.headline;
  if (typeof headline !== 'string') return undefined;
  // Later by clock, or tied to the millisecond and after it in the thread:
  // two posts made back to back read the same `Date.now()`.
  const comments = thread.comments ?? [];
  const at = comments.findIndex((c) => c.id === declaring.id);
  const later = comments
    .filter(
      (c, i) =>
        c.id !== declaring.id &&
        (c.ts > declaring.ts || (c.ts === declaring.ts && at >= 0 && i > at)),
    )
    .sort((a, b) => a.ts - b.ts);
  for (const c of later) {
    if (c.review !== undefined) continue;
    if (!sameAuthor(c.author, declaring.author)) continue;
    if (settlesAsk(c.text, headline)) return { rule: 'settled', at: c.ts, commentId: c.id };
  }
  return undefined;
}
