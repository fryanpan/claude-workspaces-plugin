/**
 * A check the agent was REFUSED permission to run, and the one kind of hold
 * that must never be handed back for one.
 *
 * The incident (2026-09-16): a lead reported an `owner` line whose proof said
 * the check had been refused by this machine's permission classifier. The
 * quality gate held it twice, and the second hold read *"the agent blocked by
 * the classifier can work around it by having a separate agent call …"* — the
 * product, in its own words, telling an agent to launder a permission denial
 * through a second agent. A compliant agent would have done it.
 *
 * The gate's general rule is right and stays: a fact an agent can read for
 * itself is not the reader's to read. What was missing is that "I was refused"
 * is a TERMINAL answer — it is not laziness and there is no harder push that
 * turns it into a check — so the gate had no word for it and its only lever
 * was to push. This module is that word, in two halves:
 *
 *  - `refusalProof` — the line says the check was refused, either because the
 *    reporter marked the proof `refused` (the expressible form, which is what
 *    `report_done_when` now takes) or because the proof's own words name a
 *    permission refusal (the form the lead had, having no field for it).
 *  - `isGetItAnywayHold` — the hold tells the filer to obtain the fact by
 *    another route. Both of the two real holds are matched by their opening
 *    (`OWNER_CHECK_SELF_PREFIX`); the "another agent / work around it" clause
 *    is here because that is the sentence the defect is actually named for,
 *    and a judge that writes it without the opening is writing the same
 *    instruction.
 *
 * Pure, and in core, because all three sides read it: the gate suppresses
 * such a hold on a refused line, the item template says why the reader is
 * being asked, and the prompt is told the refusal is final.
 *
 * **It is the reporter's word, and that is the same trust the board already
 * extends.** An agent could mark a check refused that was never refused, and
 * so skip a hold it would otherwise earn — exactly as it could report a line
 * `met` with proof it invented. Neither is defended in code: what the board
 * does instead is put the claim where the reader sees it, so the card says in
 * its own words that the machine refused the check, and `Not met` sends it
 * back. A gate that could tell a real refusal from a claimed one would need
 * to run the refused command, which is the thing that cannot happen.
 */

import type { DoneWhenLine, DoneWhenProof } from './done-when.ts';
import { OWNER_CHECK_SELF_PREFIX } from './review-judge-prompt.ts';

/**
 * A word that says something did not happen because it was not allowed.
 *
 * Paired with `PERMISSION_WORD` below, and BOTH are required — on its own
 * "blocked" is what a modal does to a click and "refused" is what a server
 * does to a request, neither of which is a permission refusal.
 */
const REFUSAL_WORD =
  /\b(refus\w*|den(?:y|ied|ies|ial)|disallow\w*|block(?:ed|s)?|not\s+(?:allowed|permitted|authori[sz]ed))\b/i;

/** A word that says WHO did not allow it. See `REFUSAL_WORD`. */
const PERMISSION_WORD =
  /\b(permissions?|classifier|sandbox\w*|polic(?:y|ies)|approvals?|allowlist|authori[sz]\w*)\b/i;

/**
 * Do these words report a permission refusal?
 *
 * Deliberately narrow — two words, not one — because the cost of each
 * direction is not the same. A false positive lets one owner check reach the
 * reader that the gate might have held, which is the fail-open direction this
 * whole gate is built to err in ("when unsure, pass it"). A false negative
 * hands an agent an instruction to route around a denial, which is the defect.
 */
export function namesPermissionRefusal(text: string | undefined): boolean {
  if (!text) return false;
  return REFUSAL_WORD.test(text) && PERMISSION_WORD.test(text);
}

/** Is this one proof a report of a refusal — marked, or in its own words? */
export function proofReportsRefusal(proof: DoneWhenProof): boolean {
  return proof.refused === true || namesPermissionRefusal(proof.text);
}

/**
 * The proof on this line that says the check was refused, or `undefined` when
 * none does. The FIRST such proof: it is what the card quotes, and a line
 * that attaches two refusals is still one refused line.
 */
export function refusalProof(line: DoneWhenLine | undefined): DoneWhenProof | undefined {
  return (line?.proof ?? []).find(proofReportsRefusal);
}

/**
 * Does this hold tell the filer to go and get the fact another way?
 *
 * The prefix is the gate's own opening for "an agent can check this itself",
 * which is the whole family of holds a refusal answers. The second clause
 * catches the sentence without the opening — another agent, another session,
 * a workaround — because that phrasing is the defect by name and a hold
 * carrying it is never one a refused check can act on.
 */
export function isGetItAnywayHold(reason: string | undefined): boolean {
  if (!reason) return false;
  if (reason.trimStart().startsWith(OWNER_CHECK_SELF_PREFIX)) return true;
  return /\b(?:another|separate|different|second|other)\s+(?:agent|session|process|peer|tool|account)\b|\bwork(?:ing)?[\s-]?around\b/i.test(
    reason,
  );
}

/**
 * What the gate records instead when it drops such a hold. A verdict of its
 * own words, not the judge's: the judge's sentence is the one thing that must
 * not reach the filer.
 */
export const REFUSED_CHECK_PASS_REASON =
  'The agent was refused permission to run this check, which is terminal, so the reader’s own check is the only one left.';
