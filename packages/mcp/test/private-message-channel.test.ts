/**
 * `private.message`: a person's private message to this session, its linked
 * lead agent (`routes/private-messages.ts` on the server). One line naming
 * who wrote it and how to answer; the queue row is acked like any comment
 * row; and an agent's own message never comes back to it.
 *
 * All fixtures synthetic.
 */
import { describe, expect, it } from 'vitest';
import { SELF, harness, only } from './channel-harness.ts';

const fromAlice = (over: Record<string, unknown> = {}) => ({
  workspaceId: 'w-harbor',
  messageId: 'pm-1',
  personId: 'user-alice',
  agentId: SELF,
  from: 'person',
  author: { id: 'user-alice', name: 'Alice' },
  text: 'Can you check the Harborlight export?',
  ...over,
});

describe('private.message', () => {
  it('names the person, the words and the verb that answers them', async () => {
    const { frames, messages } = harness();
    await messages.emitChannelMessage('private.message', fromAlice());
    const f = only(frames);
    expect(f.content).toBe(
      '[private] Alice (your person): Can you check the Harborlight export? Answer with reply_private(personId="user-alice").',
    );
    expect(f.meta).toMatchObject({
      workspace_id: 'w-harbor',
      person_id: 'user-alice',
      event: 'private.message',
      author: 'Alice',
    });
  });

  it('says nothing about a message this agent wrote', async () => {
    const { frames, messages } = harness();
    await messages.emitChannelMessage(
      'private.message',
      fromAlice({ from: 'agent', author: { id: SELF, name: 'me' } }),
    );
    expect(frames).toEqual([]);
  });
});
