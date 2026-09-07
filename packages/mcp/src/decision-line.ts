/**
 * How `decision.answered` reads to the agent that receives it.
 *
 * Kept out of mcp.ts — a bundle entry point that exports nothing — for the
 * same reason `nudge-line.ts` and `voice-line.ts` are: the
 * wording is a decision, and inline in a 3,000-line switch it cannot be
 * asserted against the payload the server really emits.
 */

/** The fields this line reads off the board frame. */
export interface DecisionAnsweredPayload {
  taskId?: string;
  answer?: string;
  actor?: { name?: string };
  /** The answered task's own links. Emitted on every `decision.answered` and
   *  routinely EMPTY — a decision does not have to annotate anything. */
  links?: unknown[];
  /** What was asked — the item's headline, or the legacy decision's title.
   *  Absent from a server older than the field. */
  headline?: string;
}

/** Mirrors mcp.ts's helper of the same name. Duplicated rather than shared
 *  because mcp.ts exports nothing; the copy is what lets the rendered line be
 *  asserted from a test. */
function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/**
 * Render `decision.answered` — a decision has its answer.
 *
 * The answer's words lead, because they are what the reader acts on. The
 * propagation clause follows them ONLY when the task actually has links: the
 * store emits `links` on every answer and most decisions annotate nothing, so
 * the clause used to send readers off to walk an empty list — an instruction
 * that cannot be followed and cannot be told apart from one that can.
 * A checklist nobody can find is how a real one stops being read.
 *
 * The question follows the answer when the frame carries it. An answer is
 * an option label as often as a sentence — "You merge it", "Option B" — and
 * a label with no question is orphaned on a row that asked two things.
 */
export function decisionAnsweredLine(p: DecisionAnsweredPayload): string {
  const by = p.actor?.name ? ` by ${p.actor.name}` : '';
  const asked = p.headline ? ` to "${truncate(p.headline, 100)}"` : '';
  const walk =
    Array.isArray(p.links) && p.links.length > 0
      ? ' — walk its links as the propagation checklist'
      : '';
  return `[decision.answered] ${p.taskId}${by}: "${truncate(p.answer ?? '', 120)}"${asked}${walk}`;
}
