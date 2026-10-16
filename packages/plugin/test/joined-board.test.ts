/**
 * A hook in a session launched without a board posts to the board the
 * session joined with `attach_agent`: the one board where an agent of its
 * name holds a stream now, as the server lists it. None, or two, and it
 * posts nothing rather than guess.
 */
import { describe, expect, it } from 'vitest';
import { runHook } from '../hooks/lib/agent-notes.ts';
import { findJoinedBoard, joinedBoardOf } from '../hooks/lib/joined-board.ts';

const board = (id: string, name: string, listening: boolean) => ({
  id,
  name: id,
  agents: [{ agentId: `a-${id}`, name, listening, lead: false }],
});

describe('the joined board', () => {
  it('is the one board where the agent is listening', () => {
    const list = {
      boards: [
        board('w-harbor', 'Harborlight lead', true),
        board('w-river', 'Riverbend lead', true),
      ],
    };
    expect(joinedBoardOf(list, 'Riverbend lead')).toBe('w-river');
    expect(joinedBoardOf(list, 'Saltmarsh lead')).toBeUndefined();
  });

  it('is nothing when attached without a stream, or listening on two', () => {
    expect(
      joinedBoardOf({ boards: [board('w-river', 'Riverbend lead', false)] }, 'Riverbend lead'),
    ).toBeUndefined();
    const two = {
      boards: [board('w-harbor', 'Riverbend lead', true), board('w-river', 'Riverbend lead', true)],
    };
    expect(joinedBoardOf(two, 'Riverbend lead')).toBeUndefined();
    expect(joinedBoardOf(null, 'Riverbend lead')).toBeUndefined();
    expect(joinedBoardOf({ boards: 'x' }, 'Riverbend lead')).toBeUndefined();
  });

  it('never throws on a server that is down or refuses', async () => {
    const down = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    expect(await findJoinedBoard('http://127.0.0.1:1', 'Riverbend lead', down)).toBeUndefined();
    const refused = (async () => new Response('', { status: 401 })) as unknown as typeof fetch;
    expect(await findJoinedBoard('http://127.0.0.1:1', 'Riverbend lead', refused)).toBeUndefined();
  });

  it('lets the Stop hook post a turn note to the joined board', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      if (url.endsWith('/api/voice/agents')) {
        return Response.json({ boards: [board('w-river', 'Riverbend lead', true)] });
      }
      return new Response('{"ok":true}', { status: 202 });
    }) as unknown as typeof fetch;
    await runHook(
      'turn',
      JSON.stringify({ hook_event_name: 'Stop', last_assistant_message: 'Charted the berths.' }),
      {
        env: { CW_BASE_URL: 'http://localhost:1', CW_AGENT_NAME: 'Riverbend lead' },
        fetch: fetchImpl,
        now: () => 1,
        joinedBoard: true,
      },
    );
    expect(urls).toEqual([
      'http://localhost:1/api/voice/agents',
      'http://localhost:1/workspaces/w-river/agents/Riverbend%20lead/notes',
    ]);
  });
});
