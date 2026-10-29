/**
 * The page half of the fresh-sign-in check: hold a refused action, send the
 * person to sign in again, and offer the action once more when they return.
 *
 * Driven with a fake `fetch` and an in-memory sessionStorage, so each case
 * names exactly what the server answered and reads what the page then asked
 * and sent. The whole flow through a real server and browser is
 * `fresh-signin-browser.test.ts`.
 *
 * All fixtures are synthetic.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type CountedRequest, resumeHeld, sendCounted } from '../src/fresh-signin-client.ts';

const ARCHIVE: CountedRequest = {
  method: 'POST',
  url: '/workspaces/w-1/docs/d-1/archive',
  body: {},
  verb: 'Archive',
  gerund: 'Archiving',
  noun: 'archive',
  name: 'Riverbend launch notes',
};
const PAGE = '/workspaces/w-1/docs/d-1';

const refused = () =>
  new Response(JSON.stringify({ error: 'confirm-required', window: 600 }), { status: 403 });
const ok = () => new Response('{"ok":true}', { status: 200 });

function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    size: () => m.size,
  };
}

/** The card on screen, or null. */
function card(): { title: string; buttons: string[] } | null {
  const c = document.querySelector('.fresh-signin-prompt .identity-card');
  if (!c) return null;
  return {
    title: c.querySelector('h2')?.textContent ?? '',
    buttons: [...c.querySelectorAll('button')].map((b) => b.textContent ?? ''),
  };
}

/** Wait for a card titled `title`, then press `label` on it. */
async function answer(title: string, label: string): Promise<void> {
  await vi.waitFor(() => expect(card()?.title).toBe(title));
  const b = [...document.querySelectorAll<HTMLButtonElement>('.fresh-signin-prompt button')].find(
    (x) => x.textContent === label,
  );
  if (!b) throw new Error(`no ${label} on ${title}`);
  b.click();
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('sendCounted', () => {
  it('answers a request the server did not refuse exactly as fetch did, asking nothing', async () => {
    const fetchImpl = vi.fn(async () => ok());
    const toast = vi.fn();
    const res = await sendCounted(ARCHIVE, { toast, fetchImpl, storage: memoryStorage() });
    expect(res?.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(card()).toBeNull();
    expect(toast).not.toHaveBeenCalled();
  });

  it('passes on a 403 that is not the stale-sign-in refusal', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"error":"forbidden"}', { status: 403 }));
    const res = await sendCounted(ARCHIVE, { toast: vi.fn(), fetchImpl });
    expect(res?.status).toBe(403);
    expect(card()).toBeNull();
  });

  it('on a refusal asks "Confirm it\'s you"; Cancel changes nothing and holds nothing', async () => {
    const fetchImpl = vi.fn(async () => refused());
    const storage = memoryStorage();
    const leave = vi.fn();
    const toast = vi.fn();
    const pending = sendCounted(ARCHIVE, { toast, fetchImpl, storage, leave, here: () => PAGE });
    await vi.waitFor(() =>
      expect(card()).toEqual({ title: "Confirm it's you", buttons: ['Cancel', 'Sign in again'] }),
    );
    expect(document.querySelector('.fresh-signin-prompt b')?.textContent).toBe(ARCHIVE.name);
    await answer("Confirm it's you", 'Cancel');
    expect(await pending).toBeNull();
    expect(toast).toHaveBeenCalledWith('Nothing changed');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(storage.size()).toBe(0);
    expect(leave).not.toHaveBeenCalled();
    expect(card()).toBeNull();
  });

  it('Cancel on the second card goes back to the first, not away', async () => {
    const leave = vi.fn();
    const toast = vi.fn();
    const pending = sendCounted(ARCHIVE, {
      toast,
      fetchImpl: async () => refused(),
      storage: memoryStorage(),
      leave,
    });
    await answer("Confirm it's you", 'Sign in again');
    await answer('Sign in again', 'Cancel');
    await answer("Confirm it's you", 'Cancel');
    expect(await pending).toBeNull();
    expect(leave).not.toHaveBeenCalled();
  });

  it('"Go to sign-in" holds the action for this page, then leaves through reauth', async () => {
    const storage = memoryStorage();
    const leave = vi.fn();
    void sendCounted(ARCHIVE, {
      toast: vi.fn(),
      fetchImpl: async () => refused(),
      storage,
      leave,
      here: () => `${PAGE}?thread=t-1`,
      now: () => 1_000,
    });
    await answer("Confirm it's you", 'Sign in again');
    await answer('Sign in again', 'Go to sign-in');
    await vi.waitFor(() => expect(leave).toHaveBeenCalledTimes(1));
    expect(leave).toHaveBeenCalledWith(
      `/api/auth/reauth?next=${encodeURIComponent(`${PAGE}?thread=t-1`)}`,
    );
    expect(storage.size()).toBe(1);
    const held = JSON.parse(storage.getItem('cw-held-action') ?? 'null');
    expect(held).toEqual({ request: ARCHIVE, page: `${PAGE}?thread=t-1`, at: 1_000, who: null });
  });
});

describe('resumeHeld', () => {
  const holdFor = (storage: ReturnType<typeof memoryStorage>, page: string, at: number) =>
    storage.setItem('cw-held-action', JSON.stringify({ request: ARCHIVE, page, at }));

  it('offers the held action on its own page, and sends it once on the verb', async () => {
    const storage = memoryStorage();
    holdFor(storage, PAGE, 1_000);
    const fetchImpl = vi.fn(async () => ok());
    const pending = resumeHeld({
      toast: vi.fn(),
      fetchImpl,
      storage,
      here: () => PAGE,
      now: () => 2_000,
    });
    await vi.waitFor(() =>
      expect(card()).toEqual({
        title: 'Archive Riverbend launch notes now?',
        buttons: ['Not now', 'Archive'],
      }),
    );
    // Taken before it is asked, so a reload while the card is up asks nothing.
    expect(storage.size()).toBe(0);
    await answer('Archive Riverbend launch notes now?', 'Archive');
    const held = await pending;
    expect(held?.request).toEqual(ARCHIVE);
    expect(held?.response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      ARCHIVE.url,
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('drops a held action dated ahead of the clock, or aimed off this origin or at another verb, unasked', async () => {
    const planted = [
      { request: ARCHIVE, page: PAGE, at: 9_000_000 },
      { request: { ...ARCHIVE, url: 'https://evil.example/x' }, page: PAGE, at: 1_000 },
      { request: { ...ARCHIVE, url: '//evil.example/x' }, page: PAGE, at: 1_000 },
      { request: { ...ARCHIVE, method: 'PATCH' }, page: PAGE, at: 1_000 },
      { request: { ...ARCHIVE, verb: 7 }, page: PAGE, at: 1_000 },
      { request: { ...ARCHIVE, url: '/api/auth/logout' }, page: PAGE, at: 1_000 },
      { request: { ...ARCHIVE, url: '/workspaces/../api/auth/logout' }, page: PAGE, at: 1_000 },
      { request: { ...ARCHIVE, url: '/workspaces/%2e%2e/api/auth/logout' }, page: PAGE, at: 1_000 },
      { request: { ...ARCHIVE, url: '/workspaces/./w-1/docs/d-1' }, page: PAGE, at: 1_000 },
      {
        request: { ...ARCHIVE, url: '/workspaces/w-1/docs/d-1/archive/../../d-2/archive' },
        page: PAGE,
        at: 1_000,
      },
      { request: { ...ARCHIVE, url: '/workspaces/w-1/tasks/t-1' }, page: PAGE, at: 1_000 },
      { request: { ...ARCHIVE, method: 'DELETE' }, page: PAGE, at: 1_000 },
      { request: ARCHIVE, page: PAGE, at: 1_000, who: 'id-bob' },
    ];
    for (const held of planted) {
      const storage = memoryStorage();
      storage.setItem('cw-held-action', JSON.stringify(held));
      const fetchImpl = vi.fn(async () => ok());
      const res = await resumeHeld({
        toast: vi.fn(),
        fetchImpl,
        storage,
        here: () => PAGE,
        now: () => 2_000,
      });
      expect(res).toBeNull();
      expect(card()).toBeNull();
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(storage.size()).toBe(0);
    }
  });

  it('is offered only to the person the server proved when it was held', async () => {
    const storage = memoryStorage();
    const fetchImpl = vi.fn(async () => refused());
    const leave = vi.fn();
    void sendCounted(ARCHIVE, {
      toast: vi.fn(),
      fetchImpl,
      storage,
      leave,
      here: () => PAGE,
      now: () => 1_000,
      whoAmI: async () => 'id-alice',
    });
    await answer("Confirm it's you", 'Sign in again');
    await answer('Sign in again', 'Go to sign-in');
    await vi.waitFor(() => expect(leave).toHaveBeenCalled());
    document.body.innerHTML = '';
    const raw = storage.getItem('cw-held-action');
    const asBob = await resumeHeld({
      toast: vi.fn(),
      fetchImpl,
      storage,
      here: () => PAGE,
      now: () => 2_000,
      whoAmI: async () => 'id-bob',
    });
    expect(asBob).toBeNull();
    expect(card()).toBeNull();
    // The same hold, back as the person who made it, is offered.
    storage.setItem('cw-held-action', raw ?? '');
    void resumeHeld({
      toast: vi.fn(),
      fetchImpl,
      storage,
      here: () => PAGE,
      now: () => 2_000,
      whoAmI: async () => 'id-alice',
    });
    await vi.waitFor(() => expect(card()?.title).toBe('Archive Riverbend launch notes now?'));
  });

  it('"Not now" sends nothing', async () => {
    const storage = memoryStorage();
    holdFor(storage, PAGE, 1_000);
    const fetchImpl = vi.fn(async () => ok());
    const toast = vi.fn();
    const pending = resumeHeld({ toast, fetchImpl, storage, here: () => PAGE, now: () => 2_000 });
    await answer('Archive Riverbend launch notes now?', 'Not now');
    expect(await pending).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith('Nothing changed');
  });

  it('leaves an action held on another page where it is, and asks nothing', async () => {
    const storage = memoryStorage();
    holdFor(storage, '/workspaces/w-1/docs/d-2', 1_000);
    const fetchImpl = vi.fn(async () => ok());
    expect(await resumeHeld({ toast: vi.fn(), fetchImpl, storage, here: () => PAGE })).toBeNull();
    expect(storage.size()).toBe(1);
    expect(card()).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('drops an action held more than thirty minutes ago without asking', async () => {
    const storage = memoryStorage();
    holdFor(storage, PAGE, 0);
    const fetchImpl = vi.fn(async () => ok());
    const out = await resumeHeld({
      toast: vi.fn(),
      fetchImpl,
      storage,
      here: () => PAGE,
      now: () => 30 * 60 * 1000 + 1,
    });
    expect(out).toBeNull();
    expect(storage.size()).toBe(0);
    expect(card()).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('asks again if the sign-in it came back from is still refused', async () => {
    const storage = memoryStorage();
    holdFor(storage, PAGE, 1_000);
    const pending = resumeHeld({
      toast: vi.fn(),
      fetchImpl: async () => refused(),
      storage,
      here: () => PAGE,
      now: () => 2_000,
    });
    await answer('Archive Riverbend launch notes now?', 'Archive');
    await answer("Confirm it's you", 'Cancel');
    expect(await pending).toBeNull();
  });
});
