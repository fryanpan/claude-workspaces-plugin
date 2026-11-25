/**
 * `#general` says who can read it. It is the board owner's chat with the
 * lead: a share visitor's read is refused with a 403 and its frames are
 * dropped from their stream (`redact-board-events.ts` on the server), so the
 * channel's old line, "Everyone on this board and <lead>", was wrong for
 * every person the board was shared with.
 */
import { describe, expect, it } from 'vitest';
import { GENERAL_REFUSED, generalSub } from '../src/lead-chat/lead-chat-channel-wiring.ts';
import { createLeadChatClient } from '../src/lead-chat/lead-chat-client.ts';

class QuietStream {
  readyState = 1;
  addEventListener() {}
  close() {}
}

function clientAnswering(status: number, body: unknown) {
  const fetchFake = (async () =>
    new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  return createLeadChatClient({
    workspaceId: 'w-harbor',
    fetch: fetchFake,
    stream: new QuietStream() as unknown as EventSource,
  });
}

const settled = async (client: ReturnType<typeof clientAnswering>) => {
  for (let i = 0; i < 20 && !client.state().loaded; i++) await new Promise((r) => setTimeout(r, 0));
  return client.state();
};

describe('who #general says can read it', () => {
  it('tells the owner the people they share with do not see it', async () => {
    const s = await settled(
      clientAnswering(200, { lead: { agentId: 'a', name: 'Lead' }, messages: [], canTalk: true }),
    );
    expect(s.ownersOnly).toBeUndefined();
    expect(generalSub('Lead', s.ownersOnly === true)).toBe(
      'You and Lead. People you share this board with don’t see it.',
    );
  });

  it('tells a reader the server refused that it is the owner’s, and stops loading', async () => {
    const s = await settled(clientAnswering(403, { error: 'out_of_share_scope' }));
    expect(s.loaded).toBe(true);
    expect(s.ownersOnly).toBe(true);
    expect(s.canTalk).toBe(false);
    expect(generalSub('Lead', true)).toBe(
      'The board owner’s chat with Lead. Only the owner can open it.',
    );
    expect(GENERAL_REFUSED).toContain('Only the board’s owner can read this chat');
  });

  it('a failure that is not a refusal still reads as loading', async () => {
    const client = clientAnswering(500, { error: 'boom' });
    await new Promise((r) => setTimeout(r, 0));
    expect(client.state().loaded).toBe(false);
    expect(client.state().ownersOnly).toBeUndefined();
  });
});
