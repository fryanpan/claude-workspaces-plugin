/**
 * The board a session joined, for a hook whose launch env names none.
 *
 * Every hook posts under `/workspaces/{id}/agents/{name}`, and both come from
 * the launch env (`CW_WORKSPACE_ID`, `CW_AGENT_NAME`). A session started with
 * its name but no board — a Remote Control session, a terminal opened by
 * hand — posted no prompt marks and no turn notes all day even after it
 * called `attach_agent`, because a hook cannot see what the session's MCP
 * connection did. The attach is recorded on the server, so the hook asks
 * there: `GET /api/voice/agents` lists every live board with the agents
 * attached to it and whether each holds a stream now. It is the voice page's
 * list, served to a caller on this machine without sign-in like every board
 * route, and it names no machine detail.
 *
 * The board is the one where an agent of this name is listening now. Two
 * such boards is a session working both, and the hook cannot tell which this
 * turn belongs to, so it posts nothing rather than guess; an attachment with
 * no stream is often yesterday's and does not count.
 *
 * A session with no name has no board to find: the server refuses to attach
 * the shared identity, and the prompt and note routes refuse its name.
 *
 * Spelled here rather than imported because the installed plugin cannot
 * import the monorepo. Never throws.
 */

/** How long the lookup may take; a hook must not hold a prompt. */
export const JOINED_BOARD_TIMEOUT_MS = 1_500;

interface ListedBoard {
  id?: unknown;
  agents?: Array<{ name?: unknown; listening?: unknown }>;
}

/** The one board where `agent` is listening, from the list's JSON. */
export function joinedBoardOf(list: unknown, agent: string): string | undefined {
  const boards = (list as { boards?: unknown } | null)?.boards;
  if (!Array.isArray(boards)) return undefined;
  const ids = (boards as ListedBoard[]).flatMap((b) =>
    typeof b.id === 'string' &&
    Array.isArray(b.agents) &&
    b.agents.some((a) => a.name === agent && a.listening === true)
      ? [b.id]
      : [],
  );
  return ids.length === 1 ? ids[0] : undefined;
}

/** Ask the server which board this agent joined. */
export async function findJoinedBoard(
  baseUrl: string,
  agent: string,
  fetchImpl: typeof fetch,
): Promise<string | undefined> {
  try {
    const res = await fetchImpl(`${baseUrl}/api/voice/agents`, {
      signal: AbortSignal.timeout(JOINED_BOARD_TIMEOUT_MS),
    });
    if (!res.ok) return undefined;
    return joinedBoardOf(await res.json(), agent);
  } catch {
    return undefined;
  }
}
