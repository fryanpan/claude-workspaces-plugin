/**
 * Which door may record an answer on a `secret` or `grant` item.
 *
 * Both shapes are answered by something other than words: a secret by the
 * values form, which stores them and records only their names; a grant by the
 * owner's Approve, which writes their settings. Any other door that records
 * text on one is a leak (a spoken or typed value lands in the feed) or a lie
 * (a grant card closed with nothing written). The routes refuse early, before
 * their own writes; this is the check in the store underneath them, so a door
 * added later — voice was one — is refused without having to remember.
 */

/**
 * What every FREE-TEXT answer door says to a secret ask.
 *
 * The shape's whole claim is that a value reaches the store and nothing else.
 * An answer recorded as words is the opposite of that in every particular: it
 * is written onto the item, into the task file, into the events log and into
 * the activity feed, it is read back by the asking agent, and it closes the
 * ask so nobody comes looking. A surface that renders this item as an ordinary
 * question — and one did, on the task page — hands the reader a box that does
 * all of that with a real value in it.
 *
 * So the refusal lives at the doors and in the store beneath them, not in the
 * card. A card can be got wrong on one surface and right on another; a door
 * cannot. It names the route
 * that does take the values, because the caller refused here is either a
 * person's browser on a surface that has not caught up or an agent that read
 * the wrong tool, and both need to be sent somewhere rather than stopped.
 */
export const SECRET_ANSWER_DENIAL = {
  error: 'secret-item',
  message:
    "a 'secret' ask is answered by handing the values to its own route (POST …/review-items/<id>/secrets), not by recording words — an answer recorded here is stored, echoed to the feed and read back by the agent",
} as const;

/**
 * What every free-text answer door says to a grant card. Approving one
 * writes allow rules into the owner's user settings, so it is answered only
 * by the owner's own Approve in the browser, through its own route — never by
 * words an agent or anyone else records on the owner's behalf.
 */
export const GRANT_ANSWER_DENIAL = {
  error: 'grant-item',
  message:
    "a 'grant' card is answered only by the board's owner pressing Approve or Decline on the card in the browser (POST …/review-items/<id>/grant) — an answer recorded here cannot approve it",
} as const;

/**
 * What every free-text answer door says to an ACCESS item. Approving one
 * changes who may be in the board, so it is answered only by the owner's own
 * Approve or Reject in the browser, through its own route.
 */
export const ACCESS_ANSWER_DENIAL = {
  error: 'access-item',
  message:
    "an access change is answered only by the board's owner pressing Approve or Reject on the card in the browser (POST …/review-items/<id>/access) — an answer recorded here cannot approve it",
} as const;

/** The doors that may answer their own kind of item, and nothing else. */
export type AnswerDoor = 'grant' | 'secret' | 'access';

/**
 * The refusal for recording an answer on an item of `shape` through `door`
 * (undefined for every free-text door), or undefined when it may be recorded.
 * `access` is whether the item carries an access change, whatever its shape.
 */
export function answerDoorRefusal(
  shape: string | undefined,
  door: AnswerDoor | undefined,
  access = false,
):
  | typeof SECRET_ANSWER_DENIAL
  | typeof GRANT_ANSWER_DENIAL
  | typeof ACCESS_ANSWER_DENIAL
  | undefined {
  if (access) return door === 'access' ? undefined : ACCESS_ANSWER_DENIAL;
  if (shape === 'secret' && door !== 'secret') return SECRET_ANSWER_DENIAL;
  if (shape === 'grant' && door !== 'grant') return GRANT_ANSWER_DENIAL;
  return undefined;
}
