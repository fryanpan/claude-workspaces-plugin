/**
 * The JSON-RPC and Streamable HTTP vocabulary `/mcp` speaks, and nothing else.
 *
 * Written by hand rather than by mounting the SDK's server transport: that
 * transport owns its session table, and the one thing this endpoint has to do
 * differently from it is what happens to a session id it has never seen — the
 * id of a session the previous server process was holding. The SDK answers
 * 404 to every such request; this endpoint answers a GET for one by bringing
 * the session back (see host.ts). The messages themselves are few: initialize,
 * ping, tools/list, tools/call, and the client's notifications.
 *
 * The protocol versions are spelled here rather than imported, so the server
 * does not load the SDK's runtime schemas at boot for a list of five strings.
 * `connector-host.test.ts` asserts they equal the SDK's own list, so an SDK
 * upgrade that adds one fails a test rather than a handshake.
 */

/** Newest first, as the SDK lists them. */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
  '2024-10-07',
];

/** The version a client asking for one we do not speak is offered instead. */
export const LATEST_PROTOCOL_VERSION = '2025-11-25';

/** JSON-RPC error codes this endpoint answers with. */
export const RPC = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  /** The SDK's own code for a bad session header. */
  badRequest: -32000,
  /** The SDK's own code for an unknown session, which makes a client re-initialize. */
  sessionNotFound: -32001,
} as const;

export type RpcId = string | number;

export interface RpcMessage {
  jsonrpc: '2.0';
  id?: RpcId;
  method?: string;
  params?: unknown;
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** The request id, when the message carries a usable one. */
export function rpcIdOf(msg: unknown): RpcId | undefined {
  if (!isRecord(msg)) return undefined;
  const id = msg.id;
  return typeof id === 'string' || typeof id === 'number' ? id : undefined;
}

export function rpcResult(id: RpcId, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

export function rpcError(id: RpcId | null, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/** A whole HTTP answer carrying one JSON-RPC error. */
export function rpcErrorResponse(
  status: number,
  code: number,
  message: string,
  id: RpcId | null = null,
): Response {
  return Response.json(rpcError(id, code, message), { status });
}

/** The version to answer an initialize with: the client's own, when we speak it. */
export function negotiateProtocolVersion(requested: unknown): string {
  return typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
    ? requested
    : LATEST_PROTOCOL_VERSION;
}

/**
 * Whether a session id is one this endpoint would accept back.
 *
 * The spec allows visible ASCII only; the length cap is ours. An id arriving
 * on a GET for an unknown session becomes a table key, so it is checked before
 * anything is built from it.
 */
export function isSessionIdShape(sid: string): boolean {
  return sid.length > 0 && sid.length <= 128 && /^[\x21-\x7e]+$/.test(sid);
}

export const SSE_HEADERS: Record<string, string> = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
};
