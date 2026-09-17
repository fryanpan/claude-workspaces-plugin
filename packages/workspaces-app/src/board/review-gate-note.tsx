/**
 * What the reader is told about an item's history with the quality gate.
 *
 * Two surfaces draw the same three facts — the Home walkthrough card and the
 * task panel's decide card — so they are one component taking the prefix its
 * surface's classes use, rather than two renderings that can drift into
 * saying different things about one item.
 *
 * The facts, and why each is here:
 *
 *  - **how many times it was held.** A question that took three rounds to get
 *    here is not the same artefact as one that passed first time, and the
 *    reader answering it could not previously tell.
 *  - **the filer's own note**, verbatim, when they answered a hold by saying
 *    the honest answer is less specific than the gate asked for. It is a
 *    claim about what the source supports, made by the person who read the
 *    source, so it is quoted rather than paraphrased.
 *
 * What the card deliberately does NOT say is whether the gate reached a
 * verdict or ran out of holds and gave up (Bryan, 2026-09-16: *"Don't bother
 * implementing this — I'd rather you let it through"*). The reader judges the
 * words in front of them; a badge warning that nobody else judged them is the
 * gate's own bookkeeping, and it spends attention on a doubt the reader can
 * settle by reading. The filer is still told — `admitted` survives on the wire
 * and in the `revise_review_item` response — so the half that changes what an
 * agent does is unchanged, and only the half aimed at Bryan is gone.
 *
 * Nothing renders at all for an item the gate simply passed — `gateNoteOf`
 * answers `undefined` there. A line on every card is a line nobody reads.
 */
import type { ReviewGateNote } from '@claude-workspaces/core/review-hold';
import { holdCountWord } from '@claude-workspaces/core/review-hold';

/** The hold count, plus one clause when the filer's note below is how the item
 *  got here. Every other held item reads the same whatever ended the holding —
 *  a clause claiming a pass would be the gave-up indicator wearing its
 *  absence, and on an item that ran out of holds it would also be false. */
export function GateHoldLine(props: { gate?: ReviewGateNote; prefix: string }) {
  const gate = props.gate;
  if (!gate || gate.holds === 0) return null;
  const how = gate.admitted === 'less-specific' ? ' It came to you on the filer’s note below.' : '';
  return (
    <p
      class={`${props.prefix}-gate`}
    >{`Held ${holdCountWord(gate.holds)} by the quality gate.${how}`}</p>
  );
}

/** The filer's words for why the honest answer is less specific than the gate
 *  asked for — quoted, and attributed, because the reader is being told what
 *  a source supports by the person who read it. */
export function GateLessSpecificNote(props: {
  gate?: ReviewGateNote;
  prefix: string;
  who?: string;
}) {
  const text = props.gate?.lessSpecific;
  if (text === undefined || text === '') return null;
  return (
    <blockquote class={`${props.prefix}-gate-note`}>
      <span class={`${props.prefix}-gate-note-who`}>
        {props.who ? `${props.who} says` : 'The filer says'}
      </span>
      {`“${text}”`}
    </blockquote>
  );
}
