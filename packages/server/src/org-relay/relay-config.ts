/**
 * The relay's config: which organizations exist, which project servers each
 * one runs, and which seats sit on those servers.
 *
 * **Organization comes from the server, never from the seat.** A seat names
 * the server it lives on, and the server names its organization, so a seat
 * cannot be configured into an organization its server is not in, and
 * nothing a message carries can move it.
 *
 * **The file holds credentials**: each server's Access service-token pair
 * and the relay's board-scoped bearer for that server. So it must be mode
 * 600, and any group or world bit refuses the start. Fails closed: one bad
 * part refuses the whole file.
 *
 * ```json
 * {"servers": {"<server id>": {
 *    "organization": "<org id>",
 *    "baseUrl": "https://<the one address>",
 *    "serviceToken": {"clientId": "…", "clientSecret": "…"},
 *    "bearer": "<that server's board-scoped agent token for the relay>"}},
 *  "seats": {"<seat id>": {
 *    "server": "<server id>", "board": "<board id>", "agentId": "<agent id>",
 *    "outboxDoc": "<doc the seat posts messages on>",
 *    "inboxDoc": "<doc the relay delivers this seat's messages on>",
 *    "crossOrganization": false, "untrusted": false}}}
 * ```
 *
 * `baseUrl` may be plain http only on a loopback host (a co-located server,
 * or a test); anything else is https and must carry a service token.
 */
import { readFileSync, statSync } from 'node:fs';

export interface RelayServiceToken {
  clientId: string;
  clientSecret: string;
}

export interface RelayServer {
  id: string;
  organization: string;
  /** A bare origin, no trailing slash. */
  baseUrl: string;
  serviceToken: RelayServiceToken | null;
  /** Opaque to the relay: presented as `Authorization: Bearer <value>`. */
  bearer: string;
}

export interface RelaySeat {
  id: string;
  server: string;
  /** Derived from the seat's server; never configured on the seat. */
  organization: string;
  board: string;
  agentId: string;
  outboxDoc: string;
  inboxDoc: string;
  /** May send to, and be sent from, another organization. */
  crossOrganization: boolean;
  /** Every message FROM this seat passes the filter, even inside its org. */
  untrusted: boolean;
}

export interface RelayConfig {
  servers: Map<string, RelayServer>;
  seats: Map<string, RelaySeat>;
}

const ID = /^[A-Za-z0-9_-]{1,128}$/;
/** A doc id may carry a `task:` prefix. */
const DOC_ID = /^[A-Za-z0-9_:.-]{1,200}$/;
const TOKEN_PART = /^[A-Za-z0-9._-]{1,512}$/;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

function parseServer(id: string, raw: unknown): RelayServer | string {
  if (!ID.test(id)) return `server id "${id}" is not a plain id`;
  if (!isObject(raw)) return `server ${id} is not an object`;
  const organization = raw.organization;
  if (typeof organization !== 'string' || !ID.test(organization)) {
    return `server ${id} names no valid organization`;
  }
  let url: URL;
  try {
    url = new URL(String(raw.baseUrl));
  } catch {
    return `server ${id} baseUrl is not a URL`;
  }
  if (url.origin !== String(raw.baseUrl).replace(/\/$/, '')) {
    return `server ${id} baseUrl must be a bare origin`;
  }
  const loopback = LOOPBACK_HOSTS.has(url.hostname) || LOOPBACK_HOSTS.has(`[${url.hostname}]`);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    return `server ${id} baseUrl must be https unless it is loopback`;
  }
  let serviceToken: RelayServiceToken | null = null;
  if (raw.serviceToken !== undefined && raw.serviceToken !== null) {
    const t = raw.serviceToken;
    if (
      !isObject(t) ||
      typeof t.clientId !== 'string' ||
      typeof t.clientSecret !== 'string' ||
      !TOKEN_PART.test(t.clientId) ||
      !TOKEN_PART.test(t.clientSecret)
    ) {
      return `server ${id} serviceToken is malformed`;
    }
    serviceToken = { clientId: t.clientId, clientSecret: t.clientSecret };
  }
  if (!loopback && !serviceToken) return `server ${id} is remote and carries no service token`;
  if (typeof raw.bearer !== 'string' || !TOKEN_PART.test(raw.bearer)) {
    return `server ${id} bearer is missing or malformed`;
  }
  return { id, organization, baseUrl: url.origin, serviceToken, bearer: raw.bearer };
}

function parseSeat(
  id: string,
  raw: unknown,
  servers: Map<string, RelayServer>,
): RelaySeat | string {
  if (!ID.test(id)) return `seat id "${id}" is not a plain id`;
  if (!isObject(raw)) return `seat ${id} is not an object`;
  if ('organization' in raw) return `seat ${id} names an organization; its server decides that`;
  const server = typeof raw.server === 'string' ? servers.get(raw.server) : undefined;
  if (!server) return `seat ${id} names no configured server`;
  const ids = ['board', 'agentId'] as const;
  for (const k of ids) {
    if (typeof raw[k] !== 'string' || !ID.test(raw[k] as string))
      return `seat ${id} ${k} is invalid`;
  }
  const docs = ['outboxDoc', 'inboxDoc'] as const;
  for (const k of docs) {
    if (typeof raw[k] !== 'string' || !DOC_ID.test(raw[k] as string)) {
      return `seat ${id} ${k} is invalid`;
    }
  }
  if (raw.outboxDoc === raw.inboxDoc) return `seat ${id} outboxDoc and inboxDoc must differ`;
  for (const k of ['crossOrganization', 'untrusted'] as const) {
    if (raw[k] !== undefined && typeof raw[k] !== 'boolean')
      return `seat ${id} ${k} is not a boolean`;
  }
  return {
    id,
    server: server.id,
    organization: server.organization,
    board: raw.board as string,
    agentId: raw.agentId as string,
    outboxDoc: raw.outboxDoc as string,
    inboxDoc: raw.inboxDoc as string,
    crossOrganization: raw.crossOrganization === true,
    untrusted: raw.untrusted === true,
  };
}

export function parseRelayConfig(raw: string): RelayConfig | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: 'not JSON' };
  }
  if (!isObject(parsed) || !isObject(parsed.servers) || !isObject(parsed.seats)) {
    return { error: 'servers and seats must be objects' };
  }
  const servers = new Map<string, RelayServer>();
  for (const [id, value] of Object.entries(parsed.servers)) {
    const server = parseServer(id, value);
    if (typeof server === 'string') return { error: server };
    servers.set(id, server);
  }
  const seats = new Map<string, RelaySeat>();
  const outboxes = new Set<string>();
  for (const [id, value] of Object.entries(parsed.seats)) {
    const seat = parseSeat(id, value, servers);
    if (typeof seat === 'string') return { error: seat };
    // Two seats reading one outbox would each claim the other's messages.
    const outbox = `${seat.server}/${seat.board}/${seat.outboxDoc}`;
    if (outboxes.has(outbox)) return { error: `seat ${id} shares an outbox with another seat` };
    outboxes.add(outbox);
    seats.set(id, seat);
  }
  return { servers, seats };
}

/**
 * The config at `path`, or the reason it was refused. A file with any group
 * or world permission bit is refused before it is read.
 */
export function loadRelayConfig(path: string): RelayConfig | { error: string } {
  let mode: number;
  try {
    mode = statSync(path).mode;
  } catch {
    return { error: `${path} could not be read` };
  }
  if ((mode & 0o077) !== 0) return { error: `${path} is readable by others; chmod 600 it` };
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { error: `${path} could not be read` };
  }
  return parseRelayConfig(text);
}
