/**
 * The connector host's public shapes (host.ts): what it is built from, what
 * it builds each hosted connector from, and what it offers the route.
 */
import type { AgentAuthor } from '../../../mcp/src/author.ts';
import type { ChannelNotification } from '../../../mcp/src/channel-messages.ts';
import type { ConnectorSession } from '../../../mcp/src/connector-session.ts';
import type { ConnectorIdentity, IdentityHeaders } from './identity.ts';

/** What a hosted connector is built from. */
export interface HostedSessionSpec {
  author: AgentAuthor;
  cwd: string;
  processId: string;
  notify: (n: ChannelNotification) => Promise<void>;
  pluginVersion: () => string;
  defaultWorkspaceId: () => string;
  /** The board whose socket the session was opened on, or undefined. */
  boardId?: string;
}

/** Where a request arrived: a board's own socket, or (undefined) TCP. */
export interface ConnectorDoor {
  boardId: string;
}

export interface ConnectorHostDeps {
  createSession: (spec: HostedSessionSpec) => ConnectorSession;
  /** The plugin version to report when the client's headers name none. */
  fallbackPluginVersion: () => string;
  log: (...args: unknown[]) => void;
  now?: () => number;
  epoch?: string;
  newSessionId?: () => string;
  keepaliveMs?: number;
  /** How often idle sessions and identities are swept. 0 disables the timer. */
  sweepEveryMs?: number;
}

export interface ConnectorHost {
  /** `door` names the board socket the request arrived on; omit it for TCP. */
  handle(req: Request, door?: ConnectorDoor): Promise<Response>;
  /** Subscribe every identity a previous process was serving, synchronously. */
  restore(identities: IdentityHeaders[]): number;
  /** The identities worth bringing back after a restart. */
  snapshot(): IdentityHeaders[];
  /** Retire idle sessions and identities. Runs on a timer; exposed for tests. */
  sweep(): void;
  counts(): { identities: number; sessions: number; streams: number };
  /** The identity a live session was opened as, for the route's agent gate. */
  sessionIdentity(sid: string): ConnectorIdentity | undefined;
  stop(): void;
}
