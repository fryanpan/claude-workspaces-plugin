/**
 * Who an agent is, to the collab core. A Worker app's tool dispatch runs a
 * doc or dashboard edit as the agent session that asked for it, so every
 * page sees the edit and the edit's transaction origin names the agent.
 *
 * The convention: one principal per agent session, `agent:<sessionId>`. A
 * person's id never starts with `agent:`; an app that lets people pick
 * their own ids refuses that prefix at sign-up.
 */
import type { Principal } from '../collab/index.ts';

export const AGENT_PREFIX = 'agent:';

const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** The principal for one agent session. Throws on an id that is empty,
 *  over 128 characters, or holds anything but letters, digits, `_` and `-`. */
export function agentPrincipal(sessionId: string, name = 'Agent'): Principal {
  if (!SESSION_ID.test(sessionId)) {
    throw new TypeError(`agentPrincipal: "${sessionId}" is not a session id`);
  }
  return { id: `${AGENT_PREFIX}${sessionId}`, name };
}

export function isAgentPrincipal(who: Principal): boolean {
  return who.id.startsWith(AGENT_PREFIX);
}
