/**
 * One JSON-RPC message of an established `/mcp` session, answered.
 *
 * Everything after initialize: the handshake itself creates the session, so
 * it is host.ts's, and a second initialize on a live session is refused here.
 * Null means the message needs no answer — a notification, or a response from
 * the client.
 */
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import type { ConnectorSession } from '../../../mcp/src/connector-session.ts';
import { RPC, isRecord, rpcError, rpcIdOf, rpcResult } from './protocol.ts';

export async function answerSessionMessage(
  msg: unknown,
  connector: ConnectorSession,
  log: (...args: unknown[]) => void,
): Promise<Record<string, unknown> | null> {
  const id = rpcIdOf(msg);
  if (!isRecord(msg) || msg.jsonrpc !== '2.0')
    return rpcError(id ?? null, RPC.invalidRequest, 'Invalid Request');
  // A response from the client (to a request this endpoint never sends) or
  // a notification: nothing to answer.
  if (typeof msg.method !== 'string') return null;
  if (id === undefined) {
    if (msg.method === 'notifications/initialized') void connector.ensureWatchesRestored();
    return null;
  }
  switch (msg.method) {
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, connector.listTools());
    case 'tools/call': {
      const params = msg.params;
      if (!isRecord(params) || typeof params.name !== 'string') {
        return rpcError(id, RPC.invalidParams, 'tools/call needs params.name');
      }
      try {
        return rpcResult(id, await connector.callTool(msg as unknown as CallToolRequest));
      } catch (err) {
        log('[connector] tools/call threw:', err);
        return rpcError(id, RPC.internalError, 'Internal error');
      }
    }
    case 'initialize':
      return rpcError(id, RPC.invalidRequest, 'This session is already initialized');
    default:
      return rpcError(id, RPC.methodNotFound, `Method not found: ${msg.method}`);
  }
}
