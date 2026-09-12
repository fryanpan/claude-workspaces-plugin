/**
 * Is there somewhere to go, and is the ask sending the reader there?
 *
 * Two pure predicates and one verb list, lifted out of `review-item-check.ts`
 * whole. They are the only part of the gate that is a HEURISTIC about English
 * rather than a reading of a declared field, they answer no question about
 * limits, and between them they carry more prose than code — which is what
 * made them the seam when the gate crossed 500 lines. Nothing here refuses
 * anything: both feed the two advisory gaps, `detailLinkless` and
 * `lookAskLinkless`.
 */
/**
 * Does this text give a reader somewhere to go?
 *
 * Two forms, because those are the two an agent writes: an inline markdown
 * link, which is the house style for a workspace path, and a bare absolute
 * URL. A bare relative path deliberately does NOT count — nothing renders it
 * as a link, so a reader cannot act on it either.
 */
export function hasLink(s: string): boolean {
  return /\[[^\]]*\]\([^)\s]+\)/.test(s) || /https?:\/\/\S/.test(s);
}

/**
 * Verbs of PERCEIVING. Deliberately a small closed class — this is the set of
 * things you can ask someone to do to an artifact without changing it — and
 * it is extended only with another verb of the same kind, never with the
 * nouns of whatever artifact is in fashion (`mockup`, `PR`, `staging`).
 * Matching artifact nouns is the over-fit: the vocabulary is open-ended, it
 * dates immediately, and it fires on asks that merely MENTION the thing.
 */
const PERCEIVE_VERBS =
  'look|read|review|check|see|watch|open|try|visit|browse|inspect|compare|test';

/**
 * Is this ask telling the READER to go and perceive something?
 *
 * Two constraints do the work, and both are about precision rather than
 * coverage — the cost asymmetry runs the other way from most checks. A false
 * positive spends one sentence in a tool result. A false NEGATIVE is Bryan
 * hunting for a link, which is the whole reason this exists. But advice that
 * fires on asks with nothing to link is worse than either: it trains agents
 * to skim past the channel, and then the true positives stop landing too.
 * So this is tuned to be quiet and right, not thorough.
 *
 * 1. The verb is in its BASE form. "Read the draft" is a directive; "I read
 *    the draft", "reviewed", "checking" are reports about work already done,
 *    and a report is the commonest way one of these words appears in a
 *    detail that needs no link at all. `\b` after the stem does this for
 *    free: "looked", "reviews" and "checking" have no boundary there.
 *
 * 2. The verb sits where a request sits — opening a sentence, a line or a
 *    bullet, or following an explicit request marker ("please", "can you",
 *    "take a"). A verb buried mid-clause is almost always narration.
 *
 * 3. It TAKES AN OBJECT: the next word introduces one, being a determiner, a
 *    pronoun, a possessive or a preposition. Position alone is not enough,
 *    because every word in the list above is also a noun or an adjective and
 *    card titles are written as noun phrases — "Open question: what should we
 *    call it?", "Review complete", "Test results" all opened with a listed
 *    word and all were advised to add a link to an artifact that does not
 *    exist (codex review). A noun use is followed by another noun; a
 *    directive is followed by the thing it directs you at.
 *
 * What it deliberately misses: an ask that implies a target without naming
 * the act ("thoughts on the new nav?"). Catching those means guessing, and
 * guessing fires on every open question — the "what should we call it?"
 * family, which is complete with nothing to link. A decision whose options
 * are described in full carries no directive either, and is silent here by
 * construction rather than by a special case.
 */
export function asksReaderToLook(s: string): boolean {
  const opener = String.raw`^|[.!?;:)\]]\s+|\n\s*(?:[-*>]\s*)?`;
  const marker = String.raw`\b(?:please|kindly)\s+|\b(?:can|could|would|will)\s+you\s+(?:please\s+)?|\byou\s+(?:can|should|could|might|may)\s+|\b(?:take|have)\s+a\s+`;
  // What an object of the directive starts with: a determiner, a pronoun, a
  // possessive ("Bryan's draft"), or a preposition. Anything else after the
  // verb and the word was a noun.
  const object = String.raw`at|the|a|an|this|that|these|those|it|them|my|our|your|its|his|her|their|through|over|into|whether|both|each|either|[\w-]+'s`;
  return new RegExp(`(?:${opener}|${marker})(?:${PERCEIVE_VERBS})\\s+(?:${object})\\b`, 'i').test(
    s,
  );
}
