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
 * NOTHING FROM THE BODY IS EVER RE-EMITTED. `classify` answers a boolean and
 * the callers build their own message from the status. A refusal body can
 * carry request echoes, and a message assembled out of one is a message that
 * eventually carries a credential into a log or a doc.
 */

/**
 * Phrases an Anthropic refusal uses when the account, not the request, is
 * the problem. Matched case-insensitively against the whole body, because
 * the wording sits inside a JSON error object rather than on its own.
 */
const QUOTA_PHRASES = [
  'credit balance',
  'usage limit',
  'quota',
  'billing',
  'spend limit',
  'rate_limit',
  'rate limit',
  'insufficient_quota',
] as const;

/**
 * Is this refusal the account being out of quota?
 *
 * `body` may be empty — a response whose body could not be read is still a
 * 429 if it was one, and a 400 nobody could read is judged as an ordinary
 * request error rather than guessed at.
 */
export function isQuotaRefusal(status: number, body: string): boolean {
  if (status === 429) return true;
  if (status !== 400) return false;
  const haystack = body.toLowerCase();
  return QUOTA_PHRASES.some((phrase) => haystack.includes(phrase));
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
 * The one message shape a refused model call is described by: the status,
 * and the quota mark when it earned one. `what` names the call so a log with
 * several kinds of request in it can still be read.
 */
export function refusalMessage(what: string, status: number, body: string): string {
  const quota = isQuotaRefusal(status, body) ? ` — ${QUOTA_REFUSAL_MARK}` : '';
  return `${what} HTTP ${status}${quota}`;
}
