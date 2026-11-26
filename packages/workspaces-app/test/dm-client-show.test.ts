import { describe, expect, it, vi } from 'vitest';
import { createDmClient, personChannel } from '../src/lead-chat/dm-client.ts';

/**
 * The channel wiring asks to show a channel on every model pass until it is
 * loaded, and several passes can land while one read is in flight. Each must
 * share that read rather than start another.
 */
describe('showing a direct channel', () => {
  it('reads a conversation once however many times it is asked while reading', async () => {
    let answer: (r: Response) => void = () => {};
    const reads: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith('/me/dm')) {
        return Response.json({
          me: { id: 'u-alice', name: 'Alice' },
          lead: null,
          people: [{ id: 'u-bob', name: 'Bob' }],
        });
      }
      reads.push(u);
      return new Promise<Response>((r) => {
        answer = r;
      });
    });
    const stream = { addEventListener: () => {}, close: () => {} } as unknown as EventSource;
    const dm = createDmClient({
      workspaceId: 'w-harbor',
      fetch: fetchImpl as unknown as typeof fetch,
      openStream: () => stream,
    });
    await vi.waitFor(() => expect(dm.state().ready).toBe(true));
    const bob = personChannel('u-bob');
    const shows = [dm.show(bob), dm.show(bob), dm.show(bob)];
    await vi.waitFor(() => expect(reads.length).toBe(1));
    answer(Response.json({ messages: [] }));
    await Promise.all(shows);
    expect(reads).toHaveLength(1);
    expect(dm.state().loaded.has(bob)).toBe(true);
    dm.close();
  });
});
