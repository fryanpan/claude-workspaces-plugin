/**
 * The contract for the inbox post (`route-contract.ts` says what a contract
 * is). `inbox.ts` serves it and refuses any key this body does not declare.
 * `post_inbox_rows` passes the answer to the agent whole.
 */
import { Hono } from 'hono';
import { contractOnly, json } from './route-contract.ts';

/** Each row and dismiss entry is checked by `validateRow` / `parseDismiss`. */
export interface InboxPostBody {
  agentId: string;
  pass: string;
  rows: unknown[];
  run?: unknown;
  dismiss?: unknown;
}

export const inboxContract = new Hono().post('/inbox/rows', json<InboxPostBody>(), contractOnly);

export type InboxContract = typeof inboxContract;
