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
 *  - **admitted unjudged.** An item that ran out of holds reached the queue
 *    because the gate stopped holding, not because anybody judged the words
 *    good. Drawing that as a pass is the gate claiming a verdict it never
 *    reached.
 *  - **the filer's own note**, verbatim, when they answered a hold by saying
 *    the honest answer is less specific than the gate asked for. It is a
 *    claim about what the source supports, made by the person who read the
 *    source, so it is quoted rather than paraphrased.
 *
 * Nothing renders at all for an item the gate simply passed — `gateNoteOf`
 * answers `undefined` there. A line on every card is a line nobody reads.
 */
import type { ReviewGateNote } from '@claude-workspaces/core/review-hold';
import { holdCountWord } from '@claude-workspaces/core/review-hold';

/** The badge that sits beside the kind badge on an item nobody judged. Its
 *  own element rather than a modifier of the kind badge: it is a warning
 *  about the words, not a second opinion about what kind of ask they are. */
export function GateUnjudgedBadge(props: { gate?: ReviewGateNote; prefix: string }) {
  if (props.gate?.admitted !== 'holds') return null;
  return <span class={`${props.prefix}-k ${props.prefix}-k-unjudged`}>Admitted unjudged</span>;
}

/** The hold count, and one clause saying how the item got past the gate. */
export function GateHoldLine(props: { gate?: ReviewGateNote; prefix: string }) {
  const gate = props.gate;
  if (!gate || gate.holds === 0) return null;
  const how =
    gate.admitted === 'holds'
      ? ' The gate stopped holding it and sent it to you without a passing verdict.'
      : gate.admitted === 'less-specific'
        ? ' It came to you on the filer’s note below.'
        : ' The filer revised it and it passed.';
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
