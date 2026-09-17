/**
 * The sentences the gate says to a FILER: the hold, and the two ways an item
 * can reach the reader without the judge passing it.
 *
 * Pure, and out of `review-gate.ts` rather than in it, because what a hold is
 * allowed to contain is now a rule with a test of its own: a hold may carry
 * the judge's diagnosis, the item's own words quoted back, and fixed text
 * written here — and nothing else. Every figure in the finished message is
 * therefore one the item already carried, which is what
 * `packages/core/src/review-hold.ts` bounds and what the gate suite asserts
 * end to end.
 *
 * The gate composes; it does not phrase. That split is what keeps the
 * no-invented-specifics rule checkable without booting a server.
 */
import { judgeReasonSentence } from '@claude-workspaces/core';
import { REVIEW_HOLD_REREAD, holdCountWord } from '@claude-workspaces/core/review-hold';

export interface HoldMessageInput {
  /** The judge's one sentence, already bounded — see `boundHoldWords`. */
  reason: string;
  /** The item's own offending words, when the judge quoted any. */
  quote?: string;
  /** The paste-ready call that lifts the hold, per surface. */
  reviseCall: string;
  /** The item hands over a done-when line, so the remedy is to CHECK rather
   *  than to reword. */
  ownerCheck: boolean;
  /** `thread` or `ticket` — where the words live, for the one clause that
   *  has to name it. */
  surface: 'thread' | 'ticket';
  /** How many holds this item now carries, THIS one included. */
  holds: number;
  /** The cap, past which the gate stops holding. */
  maxHolds: number;
}

/**
 * What a filing route says when the gate held the item.
 *
 * It names the gap, quotes the item's own words the gap is about, says what
 * the answer is — go back to the source — and gives the one call that lifts
 * the hold. It proposes NO replacement text, which is the whole change: the
 * draft sentence this used to carry was where the gate's invented specifics
 * came from, and a filer handed a ready-to-paste sentence pastes it.
 */
export function holdMessage(input: HoldMessageInput): string {
  const { reason, quote, reviseCall, ownerCheck, surface, holds, maxHolds } = input;
  // At the cap, "it reaches the queue when it passes" stops being the whole
  // truth — the next revision reaches the reader whether it passes or not.
  // Saying so is the difference between one more edit and a filer bracing for
  // a fourth round and giving up.
  const last = holds >= maxHolds;
  return [
    `Held off the reader's queue — ${judgeReasonSentence(reason)}`,
    // The item's own words, never the gate's. A filer who cannot find the
    // words a hold is about fixes the wrong sentence, which is a whole
    // revision spent.
    quote ? `The words this is about: “${quote}”` : '',
    REVIEW_HOLD_REREAD,
    ownerCheck
      ? `It is the done-when check you handed over; check the line yourself and report it met with what you read, or report it again with what the reader needs: ${reviseCall}.`
      : `It is on the ${surface}; revise it with ${reviseCall}.`,
    // The escape hatch, named in the hold itself. Without it the only answer
    // the gate visibly accepts is a concrete specific, and a fabricated one
    // reads as more responsive than a vague truth — the loop this whole
    // change is against.
    'If the source does not support what this asks for, say so on that call: pass “lessSpecific” with your reason, in your own words. Your revision is judged as usual, but THIS gap is not raised again, and your note is shown to the reader on the card.',
    last
      ? 'This is the last hold: the next revision goes to the reader UNJUDGED, with nothing on their card saying so, whatever it says.'
      : 'Every revision is judged again, and the item reaches the queue when it passes.',
    'Left unrevised for an hour, it goes to the reader as filed.',
  ]
    .filter((line) => line !== '')
    .join(' ');
}

/**
 * What the filer is told when the last-hold rule let the item through.
 *
 * The rule used to fire silently: the revise answered 200 with no `held`, and
 * a filer reading that saw an item that passed. It did not pass — nobody
 * judged these words good — so the filer was the one person not being told.
 *
 * The READER is not told either, and that is deliberate (Bryan, 2026-09-16):
 * their card shows the hold count and nothing about how the holding ended. So
 * this sentence is the only place the fact exists, which makes it worth more
 * than it was when it merely echoed a badge.
 */
export function admittedUnjudgedMessage(holds: number): string {
  return `The gate held this ${holdCountWord(holds)} and has stopped holding it: the item is on the reader's queue UNJUDGED. Their card shows the hold count and nothing else — nothing on it says these words were admitted unjudged, so you are the only one who knows nobody judged them good. If the standing concern is real, the honest move is to revise it anyway or withdraw it.`;
}

/** What the filer is told when the gap they answered with "the honest answer
 *  is less specific than that" came back and was admitted. The note is theirs,
 *  so the sentence says where it will be read rather than restating it. */
export function admittedLessSpecificMessage(): string {
  return "The gate raised that gap again and it is admitted on your note: the item is on the reader's queue, with your note shown on the card in your words. It will not be raised again.";
}
