/**
 * A served mock's bridge when its frame is on the frame-only hostname: it
 * posts to the board's page by the origin the host named, relays the board's
 * calls by path, and keeps the reader's name in its own storage.
 *
 * The same frame in a real browser, where the board's cookies and storage are
 * another origin's, is `frame-host.test.ts`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { BOARD, THREADS, build, sessionStore } from './mock-bridge-harness.ts';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('a frame on the frame-only hostname', () => {
  const FRAMES = 'http://frames.harborlight.test';
  const own = () => sessionStore();

  it("posts to the board's page by its origin, which the host named, never its own", async () => {
    const f = build({ frameOrigin: FRAMES, frameStorage: own() });
    await f.w.fetch(`${FRAMES}${THREADS}`);
    expect(f.postedTo.length).toBeGreaterThan(0);
    expect(new Set(f.postedTo)).toEqual(new Set([BOARD]));
  });

  it("has the board's own call made for it, by path, on the board's hostname", async () => {
    const f = build({ frameOrigin: FRAMES, frameStorage: own() });
    const r = await f.w.fetch(`${FRAMES}${THREADS}`, { method: 'POST', body: '{}' });
    expect(r.status).toBe(201);
    expect(f.hostFetch).toHaveBeenCalledTimes(1);
    expect(f.hostFetch.mock.calls[0]?.[0]).toBe(THREADS);
    expect(f.nativeFetch).not.toHaveBeenCalled();
  });

  it("writes the reader's stored name into its own storage, and not where the board is", () => {
    const store = own();
    const f = build({ frameOrigin: FRAMES, frameStorage: store });
    expect(f.w.localStorage).toBe(store);
    expect(store.getItem('feedback-user-name')).toBe('Sample Reader');
    expect(store.getItem('cw:board-origin')).toBeNull();
  });

  it("opens a board page at the top on the board's hostname", () => {
    build({ frameOrigin: FRAMES, frameStorage: own() });
    const a = document.createElement('a');
    a.href = `${FRAMES}/workspaces/w-harbor/home?tab=goals#top`;
    a.addEventListener('click', (e) => e.preventDefault());
    document.body.append(a);
    a.click();
    expect([a.target, a.href]).toEqual(['_top', `${BOARD}/workspaces/w-harbor/home?tab=goals#top`]);
  });
});
