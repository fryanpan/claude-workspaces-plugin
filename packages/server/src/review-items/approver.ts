/**
 * The APPROVER RECORD on a person's answer, and the line an agent quotes.
 *
 * Bryan, 29 Oct: any member's answer approves, so what the record has to say
 * is WHO. A person's answer records their identity id and, when the request
 * proved it, their address; `decision.answered` then carries `approvalLine`,
 * the sentence the agent puts in the PR body, Jira comment or message the
 * approval covers. An agent's answer records neither — an agent approves
 * nothing on a person's behalf.
 *
 * The address comes only from the request's own proof (the Access email or
 * the signed session cookie, `provenIdentityFor`), never from a body, so a
 * line naming an address is one the server saw that person sign in as.
 */
import type { ReviewItemAnswer } from '@claude-workspaces/core';
import { classifyActor } from '../actor-identity.ts';

/** `answeredBy` for this actor, or undefined for an agent. */
export function approverOf(
  actor: { id: string; name: string; kind?: string },
  provenEmail: string | undefined,
): ReviewItemAnswer['answeredBy'] {
  if (classifyActor(actor) !== 'person') return undefined;
  return { id: actor.id, ...(provenEmail ? { email: provenEmail } : {}) };
}

/** "Approved by Alice (alice@harborlight.example) on the board, 2026-10-29." */
export function approvalLine(
  name: string,
  approver: ReviewItemAnswer['answeredBy'],
  ts: number,
): string | undefined {
  if (!approver) return undefined;
  const who = approver.email ? `${name} (${approver.email})` : name;
  return `Approved by ${who} on the board, ${new Date(ts).toISOString().slice(0, 10)}.`;
}

/** The answer-record and event fields for one answer, spread into both. */
export function approverFields(
  actor: { id: string; name: string; kind?: string },
  provenEmail: string | undefined,
  ts: number,
): { record: { answeredBy?: ReviewItemAnswer['answeredBy'] }; event: { approvalLine?: string } } {
  const answeredBy = approverOf(actor, provenEmail);
  const line = approvalLine(actor.name, answeredBy, ts);
  return {
    record: answeredBy ? { answeredBy } : {},
    event: line ? { approvalLine: line } : {},
  };
}

/**
 * The address this request PROVED, when the proof is the answering actor
 * itself: an Access email or a signed session cookie whose identity is the
 * author. Anything else — a body's claim, an agent, a proof for somebody
 * other than the author — records no address.
 */
export function provenEmailFor(
  provenIdentityFor: (() => { id: string; email?: string } | null) | undefined,
  authorId: string,
): string | undefined {
  const proven = provenIdentityFor?.() ?? null;
  if (!proven || proven.id !== authorId) return undefined;
  return proven.email;
}
