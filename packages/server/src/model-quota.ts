/**
 * Telling "the model account is out of quota" apart from every other refusal.
 *
 * The distinction is not decorative. A 500, a timeout or a malformed reply is
 * one tick's bad luck and the next tick is the next chance; a quota refusal
 * will refuse every tick until somebody tops the account up, so it is the one
 * failure a person in the room has to be told about. On 2026-09-09 the shared
 * key hit its monthly limit, the server logged `[summarize] HTTP 400` per
 * tick, and a live meeting produced no notes with nobody in the room aware.
 *
 * TWO SHAPES, because the API refuses on quota two ways. A 429 is the rate
 * and usage-limit family outright. A 400 is normally a caller's own mistake
 * — a bad prompt, an unknown model — EXCEPT when the body says the account
 * has nothing left to spend, which is the shape that produced the incident.
 * So a 400 is classified by reading its body, and nothing else about the
 * body is kept.
 *
 * NOTHING FROM THE BODY IS EVER RE-EMITTED. The classification answers with
 * OUR OWN CONSTANT or with nothing, and the callers build their own message
 * from the status. A refusal body can carry request echoes, and a message
 * assembled out of one is a message that eventually carries a credential into
 * a log or a doc. `quotaPhrase` returns a member of `QUOTA_PHRASES` — a
 * string this file wrote, chosen by the body rather than taken from it — so
 * naming it in a message keeps that property exactly.
 *
 * WHY NAME IT AT ALL. "Out of quota" collapses three account failures that
 * want three different responses from a person: a spend cap somebody can
 * raise, a billing problem somebody must fix, and a rate limit that clears on
 * its own. On 2026-09-17 a run reported `HTTP 400 — out of quota` for the
 * ninth day running and nobody could tell which of the three it was without
 * the body, which this module deliberately throws away. The phrase that
 * matched is the smallest thing that separates them.
 */

/**
 * Phrases an Anthropic refusal uses when the account, not the request, is
 * the problem. Matched case-insensitively against the whole body, because
 * the wording sits inside a JSON error object rather than on its own.
 *
 * ORDER IS THE TIE-BREAK, and it is the order as it already stood: a body
 * naming two of these is reported as the first one listed, which puts
 * `credit balance` above `billing` and `usage limit` above `quota`. It was
 * never chosen for that job, so a refusal saying both `spend limit` and
 * `quota` reports the vaguer one. Whether the list is the right partition at
 * all is a separate question — see the PR that added this comment.
 */
export const QUOTA_PHRASES = [
  'credit balance',
  'usage limit',
  'quota',
  'billing',
  'spend limit',
  'rate_limit',
  'rate limit',
  'insufficient_quota',
] as const;

/** One of the phrases above, and nothing else can be one. */
export type QuotaPhrase = (typeof QUOTA_PHRASES)[number];

/**
 * Which of our phrases classified this refusal, or `null` when none did.
 *
 * `null`, never `''`: "no phrase" and "a phrase that is empty" are different
 * answers, and a caller that has to tell them apart should not have to know
 * that one of them is falsy for two reasons.
 *
 * ONLY WHERE THE BODY IS ALREADY READ. A 429 is quota by its status alone and
 * this answers `null` for one, which is not an omission: the status has
 * already said which family it is, and reading a 429's body here would start
 * consulting a body the module does not consult today.
 */
export function quotaPhrase(status: number, body: string): QuotaPhrase | null {
  if (status !== 400) return null;
  const haystack = body.toLowerCase();
  return QUOTA_PHRASES.find((phrase) => haystack.includes(phrase)) ?? null;
}

/**
 * Is this refusal the account being out of quota?
 *
 * `body` may be empty — a response whose body could not be read is still a
 * 429 if it was one, and a 400 nobody could read is judged as an ordinary
 * request error rather than guessed at.
 */
export function isQuotaRefusal(status: number, body: string): boolean {
  if (status === 429) return true;
  return quotaPhrase(status, body) !== null;
}

/**
 * The suffix a quota refusal's error message carries, and the only channel
 * between the caller that made the request and the caller that reacts to it.
 *
 * A marker in the message rather than a custom Error subclass because the
 * message is what already crosses the composer seam: `NotesComposer.compose`
 * is contracted to throw, and every existing reader of that failure reads
 * `err.message`. Adding a class would leave the marker invisible to a
 * composer implemented anywhere else, including the eval harness's.
 */
export const QUOTA_REFUSAL_MARK = 'out of quota';

/** Did this failure message come from a quota refusal? */
export function isQuotaFailure(message: string): boolean {
  return message.includes(QUOTA_REFUSAL_MARK);
}

/**
 * The one message shape a refused model call is described by: the status, the
 * quota mark when it earned one, and the phrase that earned it when a phrase
 * did. `what` names the call so a log with several kinds of request in it can
 * still be read.
 *
 * The parenthesised phrase is OUR constant, never the body's wording, and it
 * is absent rather than empty when the status classified the refusal on its
 * own. `isQuotaFailure` reads the mark and is unaffected by what follows it.
 */
export function refusalMessage(what: string, status: number, body: string): string {
  if (!isQuotaRefusal(status, body)) return `${what} HTTP ${status}`;
  const phrase = quotaPhrase(status, body);
  const named = phrase === null ? '' : ` (${phrase})`;
  return `${what} HTTP ${status} — ${QUOTA_REFUSAL_MARK}${named}`;
}
