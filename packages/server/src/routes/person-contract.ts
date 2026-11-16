/**
 * The contract for the routes an agent uses to reach its person
 * (`route-contract.ts` says what a contract is): hear where the board owner's
 * tab lands and send it somewhere, or point its followers at a place
 * (`workspace-point.ts`), confirm which
 * person it works for (`agent-identity.ts`), and answer that person
 * privately (`private-messages.ts`).
 */
import type { PresenceSpot } from '@claude-workspaces/core/workspace-presence';
import { Hono } from 'hono';
import type { LinkResult } from '../person-agent-link.ts';
import type { Landing } from '../person-presence.ts';
import type { PrivateMessage } from '../private-messages.ts';
import { answers, json } from './route-contract.ts';

/**
 * A place on the board, as `point` and `person/show` name one: exactly one
 * of `path`, `docId`, `taskId` or `goalId`, and a position inside it.
 */
export interface PlaceFields {
  path?: string;
  docId?: string;
  taskId?: string;
  goalId?: string;
  threadId?: string;
  blockId?: string;
  quote?: string;
  scroll?: number;
  x?: number;
  y?: number;
}
/** Who is asking: the agent the token speaks for, and its own name for itself. */
export interface AgentCallerFields {
  agentId: string;
  agentName?: string;
}
export interface PersonWatchBody extends AgentCallerFields {
  on?: boolean;
}
export type PersonShowBody = AgentCallerFields & PlaceFields;
/** `point` names a place as `person/show` does, and writes nothing. */
export type PointBody = PersonShowBody;
/** An `email` names the person; `personId: null` clears the link. */
export interface ConfirmPersonBody {
  email?: string;
  personId?: string | null;
}
export interface PrivateReplyBody {
  text: string;
}

export interface PersonWatchAnswer {
  ok: true;
  watching: boolean;
  landing: Landing | null;
}
export interface PersonShowAnswer {
  ok: true;
  spot: PresenceSpot;
}
export type PointAnswer = PersonShowAnswer;
export interface ConfirmPersonAnswer {
  ok: true;
  state: Extract<LinkResult, { ok: true }>['state'];
}
export interface PrivateReplyAnswer {
  ok: true;
  message: PrivateMessage;
}

const PERSON = '/workspaces/:ws/person';
const AGENT = '/api/agents/:agentId';

export const personContract = new Hono()
  .post(`${PERSON}/watch`, json<PersonWatchBody>(), answers<PersonWatchAnswer>())
  .post(`${PERSON}/show`, json<PersonShowBody>(), answers<PersonShowAnswer>())
  .post('/workspaces/:ws/point', json<PointBody>(), answers<PointAnswer>())
  .post(`${AGENT}/person`, json<ConfirmPersonBody>(), answers<ConfirmPersonAnswer>())
  .post(`${AGENT}/messages/:personId`, json<PrivateReplyBody>(), answers<PrivateReplyAnswer>());

export type PersonContract = typeof personContract;
