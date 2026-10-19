/**
 * `/review` asks for its queue as it boots, not after the session lookup.
 *
 * The page used to read `/api/auth/session` for the write gate, read it again
 * for the identity, and only then ask for the queue: three round trips in a
 * row before the first card, on a phone over the tunnel. Here the session
 * read is held open, and the queue must already have been asked for, with
 * the session read once. Fixtures are invented.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let releaseSession: (body: unknown) => void = () => {};
const requested: string[] = [];

beforeEach(() => {
  vi.resetModules();
  requested.length = 0;
  document.body.innerHTML =
    '<div id="board-walkthrough"></div><span id="board-ws-name-text"></span>';
  const session = new Promise<unknown>((resolve) => {
    releaseSession = resolve;
  });
  vi.stubGlobal('EventSource', undefined);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requested.push(url);
      if (url === '/api/auth/session') {
        const body = await session;
        return new Response(JSON.stringify(body), { status: 200 });
      }
      if (url === '/api/review-queue') {
        return new Response(JSON.stringify({ items: [], projects: [] }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    }),
  );
});

afterEach(() => {
  releaseSession({ authenticated: false });
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('the /review boot', () => {
  it('asks for the queue while the session lookup is still open, and reads the session once', async () => {
    await import('../src/reviews/reviews-app.ts');
    await vi.waitFor(() => expect(requested).toContain('/api/review-queue'));
    expect(requested.filter((u) => u === '/api/auth/session')).toHaveLength(1);

    releaseSession({ authenticated: true, user: { id: 'known-riverbend', name: 'Riverbend' } });
    // The identity answer comes out of the same read: once the page has
    // painted, nothing has asked for the session a second time.
    await vi.waitFor(() =>
      expect(document.getElementById('board-walkthrough')?.innerHTML).not.toBe(''),
    );
    expect(requested.filter((u) => u === '/api/auth/session')).toHaveLength(1);
  });
});
