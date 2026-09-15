/**
 * `/mcp` — the hosted MCP connector, for Claude Code sessions on this machine.
 *
 * What answers is connector/host.ts. This module decides only the path and who
 * may reach it, and the answer to the second is: an agent process on this
 * machine, and nothing else.
 *
 * The endpoint is every agent-only door at once. Through it a caller reads
 * the event stream of whatever agent its headers name and calls every tool as
 * that agent, so it takes the refusals those doors take — never through the
 * edge, never from off this machine, never from a page — in the same function
 * (`refuseNonLocalAgentCaller`), so a check added there reaches this door too.
 * A share visitor is refused before any of them, as the agent stream refuses
 * one: nothing here is scoped to a board.
 *
 * What it does not ask for is an agent token. The token proves to a REST
 * route that a caller is the agent it names; a loopback caller can mint one
 * for any agent, so on this door it would prove nothing a loopback address
 * does not. The hosted connector still mints and presents one for every REST
 * call it makes on the agent's behalf, so those routes are gated exactly as
 * they were for the stdio child.
 */
import { refuseNonLocalAgentCaller } from '../auth/agent-token.ts';
import type { ConnectorHost } from '../connector/host.ts';

export interface McpConnectorRouteContext {
  host: ConnectorHost;
  j: (status: number, body: unknown) => Response;
  /** The request's SOCKET address, never a header. */
  requestAddress: (req: Request) => string | undefined;
}

export const MCP_CONNECTOR_PATH = '/mcp';

export async function handleMcpConnectorRoute(
  ctx: McpConnectorRouteContext,
  input: { req: Request; pathname: string; visitor: unknown },
): Promise<Response | null> {
  if (input.pathname !== MCP_CONNECTOR_PATH) return null;
  if (input.visitor) return ctx.j(403, { error: 'not available to share visitors' });
  const refused = refuseNonLocalAgentCaller(input.req, ctx.requestAddress(input.req));
  if (refused) return ctx.j(refused.status, refused.body);
  return ctx.host.handle(input.req);
}
