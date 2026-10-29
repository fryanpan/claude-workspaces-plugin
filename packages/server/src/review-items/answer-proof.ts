/**
 * PERSON PROOF FOR AN ANSWER. Bryan, 29 Oct: his answer is approval, so only
 * he may give it, and an agent cannot approve its own ask.
 *
 * Every answer door takes its author from `authorFor`, and on a loopback
 * request with no proof that is whatever the body claimed. Every agent on
 * this machine is a loopback caller, so `{ id: 'known-bryan', kind: 'person' }`
 * in a body used to record an answer as the owner's. This is the check that
 * stops it: an answer whose author is a person is recorded only when the
 * request itself proved that person.
 *
 * Two proofs count, and a body's claim is never one of them:
 *  - The Access email or the signed session cookie (`provenIdentityFor`)
 *    naming the author, sent from this server's own page:
 *    `Sec-Fetch-Site: same-origin` and an `Origin` equal to its own. That is
 *    `share/owner-proof.ts`'s test, for any person rather than only the
 *    owner. The board page sends both on every press, on a Mac and an iPad.
 *  - A widget token (`wt2`) naming the author. It is minted only to a signed-in
 *    person and is bound to the page origin it was minted for, so it proves
 *    the person on a dev server page, where the widget dock answers.
 *
 * An agent's answer needs neither: it is recorded as the agent's, and an
 * agent's answer approves nothing (`approver.ts`). The owner's id, and any id
 * the roster holds as a person's, counts as a person whatever `kind` the body
 * gave it, so a claim of either with `kind: 'agent'` is refused too.
 */
import type { User } from '@claude-workspaces/core';
import { classifyActor, isOwnerActor, isRosterPerson } from '../actor-identity.ts';
import type { IdentityRecord } from '../identities.ts';

/** What one request proved, read lazily: most requests never answer. */
export interface AnswerProofInputs {
  req: Request;
  /** The Access email or session cookie's identity, or null. */
  provenIdentityFor: () => IdentityRecord | null;
  /** The identity a verified widget token named, or null. */
  widgetIdentity: IdentityRecord | null;
  /** This server's own origin for the request, scheme included. */
  requestOrigin: () => string;
}

/** The refusal an answer door gives an unproven person author. */
export const PERSON_PROOF_REQUIRED = {
  error: 'person-proof-required',
  message:
    "a person's answer is recorded only from that person's own signed-in page — an agent answers as itself, and an author named in the body is not proof",
} as const;

/** Does an answer by `author` need a person's proof? */
export function answersAsPerson(author: Pick<User, 'id' | 'name'> & { kind?: string }): boolean {
  return (
    classifyActor(author) === 'person' ||
    isOwnerActor(author) ||
    (typeof author.id === 'string' && isRosterPerson(author.id))
  );
}

/** Did this request prove `author` is the person answering? */
export function provesPerson(author: User, inputs: AnswerProofInputs): boolean {
  if (inputs.widgetIdentity && inputs.widgetIdentity.id === author.id) return true;
  const proven = inputs.provenIdentityFor();
  if (!proven || proven.id !== author.id) return false;
  const origin = inputs.req.headers.get('origin');
  return (
    inputs.req.headers.get('sec-fetch-site') === 'same-origin' &&
    origin !== null &&
    origin === inputs.requestOrigin()
  );
}

/**
 * True when `author` is a person this request did not prove: the answer must
 * not be recorded. `inputs` undefined (a caller that did not wire the proof)
 * fails closed.
 */
export function unprovenPersonAnswer(author: User, inputs: AnswerProofInputs | undefined): boolean {
  if (!answersAsPerson(author)) return false;
  return !inputs || !provesPerson(author, inputs);
}

/**
 * Spoken answers. The voice router records an answer as the actor it was
 * handed, and two of its doors take that actor from a request's own claim:
 * `POST /workspaces/<ws>/voice` (the body's author) and the spoken-reply
 * socket when its upgrade proved nobody (the start frame's author). Each door
 * marks such an actor here, and the router refuses to record an answer for a
 * marked one. A WeakSet rather than a field, so the mark is never written
 * into a comment's author.
 */
const unprovenActors = new WeakSet<object>();

/** Mark `actor` as one this request did not prove, and return it. */
export function markUnprovenActor<T extends object>(actor: T): T {
  unprovenActors.add(actor);
  return actor;
}

/** Did the door that built `actor` fail to prove it? */
export function isUnprovenActor(actor: object): boolean {
  return unprovenActors.has(actor);
}
