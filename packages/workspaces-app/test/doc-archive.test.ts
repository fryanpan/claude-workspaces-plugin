/**
 * "Archive this doc" in the doc's More menu, the "Put it back" that undoes
 * it, and the bar an archived doc's open page shows.
 *
 * The page's own markup, a fake `fetch` and a stand-in socket, so each case
 * reads what the page sent and showed. The stale-sign-in ask in front of the
 * archive is `fresh-signin-client.test.ts`; the whole flow through a real
 * server and browser is `fresh-signin-browser.test.ts`.
 *
 * All fixtures are synthetic.
 */
import { getMeta } from '@claude-workspaces/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { ARCHIVED_CLOSE_REASON, mountDocArchive } from '../src/doc/doc-archive.ts';
import { MountScope } from '../src/mount-scope.ts';

const BOARD = 'w-1';
/** The address's id, an alias; the canonical id is in the doc's meta. */
const ALIAS = 'riverbend-launch-notes';
const CANONICAL = 'd-1';

function markup(): void {
  document.body.innerHTML = `
    <button id="doc-more" hidden>⋯</button>
    <div id="more-menu" class="more-menu hidden" aria-hidden="true">
      <button id="menu-archive">Archive this doc</button>
    </div>
    <div id="archived-bar" hidden><button id="archived-undo">Put it back</button></div>`;
}

function ydocWith(meta: Record<string, string>): Y.Doc {
  const ydoc = new Y.Doc();
  for (const [k, v] of Object.entries(meta)) getMeta(ydoc).set(k, v);
  return ydoc;
}

/** A client whose socket can be closed, and whose status can be reported. */
function fakeClient() {
  let ws = new EventTarget() as WebSocket;
  const statusFns: Array<(s: string) => void> = [];
  return {
    client: {
      get ws() {
        return ws;
      },
      onStatus: (fn: (s: string) => void) => {
        statusFns.push(fn);
        return () => {};
      },
    },
    /** The server closes this page's socket. */
    close(reason: string) {
      const e = new Event('close') as Event & { reason: string };
      Object.defineProperty(e, 'reason', { value: reason });
      ws.dispatchEvent(e);
    },
    /** A new socket opens. */
    reopen() {
      ws = new EventTarget() as WebSocket;
      for (const fn of statusFns) fn('open');
    },
  };
}

type Toast = { message: string; action?: { label: string; onAction: () => void } };

function mount(opts: { canWrite?: boolean; meta?: Record<string, string> } = {}) {
  markup();
  const toasts: Toast[] = [];
  const sock = fakeClient();
  const scope = new MountScope();
  mountDocArchive({
    docId: ALIAS,
    // biome-ignore lint/suspicious/noExplicitAny: a stand-in client, only `ws` and `onStatus` are read
    client: sock.client as any,
    ydoc: ydocWith(opts.meta ?? { docId: CANONICAL, title: 'Riverbend launch notes' }),
    scope,
    canWrite: opts.canWrite ?? true,
    toast: (message, action) => toasts.push({ message, ...(action ? { action } : {}) }),
  });
  return { toasts, sock, scope };
}

const el = (id: string) => document.getElementById(id) as HTMLElement;
const barShown = () => !el('archived-bar').hidden;

let calls: Array<{ url: string; method: string }>;
let answer: (url: string) => Response;

beforeEach(() => {
  window.history.replaceState(null, '', `/workspaces/${BOARD}/docs/${ALIAS}`);
  sessionStorage.clear();
  calls = [];
  answer = () => new Response('{"ok":true}', { status: 200 });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET' });
      return answer(url);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('the Archive control', () => {
  it('is offered to a reader who can write', () => {
    mount();
    expect(el('doc-more').hidden).toBe(false);
  });

  it('is not offered to a reader who cannot write', () => {
    mount({ canWrite: false });
    expect(el('doc-more').hidden).toBe(true);
  });

  it('is not offered on a member of a review, which is archived with its review', () => {
    mount({ meta: { docId: CANONICAL, setId: 'set-1' } });
    expect(el('doc-more').hidden).toBe(true);
  });

  it('opens and closes the menu', () => {
    mount();
    el('doc-more').click();
    expect(el('more-menu').classList.contains('hidden')).toBe(false);
    expect(el('doc-more').getAttribute('aria-expanded')).toBe('true');
    document.body.click();
    expect(el('more-menu').classList.contains('hidden')).toBe(true);
  });
});

describe('archiving', () => {
  it('archives, shows the bar, and offers "Put it back" on the toast', async () => {
    const { toasts } = mount();
    el('menu-archive').click();
    await vi.waitFor(() => expect(barShown()).toBe(true));
    expect(calls).toEqual([{ url: `/workspaces/${BOARD}/docs/${ALIAS}/archive`, method: 'POST' }]);
    expect(toasts.at(-1)?.message).toBe('Archived Riverbend launch notes');
    expect(toasts.at(-1)?.action?.label).toBe('Put it back');
    expect(document.body.classList.contains('is-archived')).toBe(true);
    expect((el('menu-archive') as HTMLButtonElement).disabled).toBe(true);
  });

  it('"Put it back" unarchives by the canonical id, never the alias, and asks nothing', async () => {
    const { toasts } = mount();
    el('menu-archive').click();
    await vi.waitFor(() => expect(barShown()).toBe(true));
    toasts.at(-1)?.action?.onAction();
    await vi.waitFor(() => expect(barShown()).toBe(false));
    expect(calls.at(-1)).toEqual({
      url: `/workspaces/${BOARD}/docs/${CANONICAL}/unarchive`,
      method: 'POST',
    });
    expect(toasts.at(-1)?.message).toBe('Put back on the board');
    expect(document.querySelector('.fresh-signin-prompt')).toBeNull();
  });

  it('the bar\'s own "Put it back" does the same', async () => {
    mount();
    el('menu-archive').click();
    await vi.waitFor(() => expect(barShown()).toBe(true));
    el('archived-undo').click();
    await vi.waitFor(() => expect(barShown()).toBe(false));
    expect(calls.at(-1)?.url).toBe(`/workspaces/${BOARD}/docs/${CANONICAL}/unarchive`);
  });

  it('a refused archive says so and leaves the page as it was', async () => {
    answer = () => new Response('{"error":"not-found"}', { status: 404 });
    const { toasts } = mount();
    el('menu-archive').click();
    await vi.waitFor(() => expect(toasts.at(-1)?.message).toBe('Could not archive this doc'));
    expect(barShown()).toBe(false);
  });

  it('names a doc with no title by its file', async () => {
    const { toasts } = mount({
      meta: { docId: CANONICAL, sourceUrl: '/notes/riverbend-launch-notes.md' },
    });
    el('menu-archive').click();
    await vi.waitFor(() =>
      expect(toasts.at(-1)?.message).toBe('Archived riverbend-launch-notes.md'),
    );
  });
});

describe('live: an archive made anywhere reaches an open page', () => {
  it('shows the bar when the server closes the socket as archived, and drops it when one reopens', () => {
    const { sock } = mount();
    sock.close('some other reason');
    expect(barShown()).toBe(false);
    sock.close(ARCHIVED_CLOSE_REASON);
    expect(barShown()).toBe(true);
    sock.reopen();
    expect(barShown()).toBe(false);
    // The new socket is watched too.
    sock.close(ARCHIVED_CLOSE_REASON);
    expect(barShown()).toBe(true);
  });

  it('clears the archived look when the page unmounts', () => {
    const { sock, scope } = mount();
    sock.close(ARCHIVED_CLOSE_REASON);
    expect(document.body.classList.contains('is-archived')).toBe(true);
    scope.dispose();
    expect(document.body.classList.contains('is-archived')).toBe(false);
  });
});
