/**
 * Direct messages between two people on a board, and the channel list the
 * chat's picker draws (M10).
 *
 * The server keeps one log per pair (`server/src/direct-messages.ts`) and
 * sends each new message on both people's own `person~<id>` stream, which
 * only that person's proof opens. A page reads the list of people it may
 * write to from the same route it sends on (`/workspaces/<id>/me/dm`).
 */

/** The frame a direct message arrives in, on each person's own stream. */
export const DIRECT_MESSAGE_EVENT = 'direct.message';

/** The frame a private message to or from the reader's own lead agent
 *  arrives in (`server/src/routes/private-messages.ts`). */
export const PRIVATE_MESSAGE_EVENT = 'private.message';

/** The longest direct message accepted, in characters. */
export const MAX_DIRECT_MESSAGE = 8000;

export interface DirectMessage {
  id: string;
  /** Who wrote it, with the name the server holds for them. */
  author: { id: string; name: string };
  /** The person it was written to. */
  to: string;
  text: string;
  ts: number;
}

/** One person the reader may write to. */
export interface DirectPeer {
  id: string;
  name: string;
}

/** What `GET /workspaces/<id>/me/dm` answers: who the reader is, the board's
 *  other people, and the reader's own lead agent when they linked one. */
export interface DirectChannels {
  /** Null for a caller that proves no person: no channels. */
  me: DirectPeer | null;
  people: DirectPeer[];
  lead: { agentId: string; name: string } | null;
}

/** One page of a pair's log, oldest first. */
export interface DirectMessagePage {
  messages: DirectMessage[];
  more: boolean;
}
