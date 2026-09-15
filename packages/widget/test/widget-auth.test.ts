import * as encoding from 'lib0/encoding';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { SIGN_IN_NOTE } from '../src/widget-mic.ts';

/**
 * The widget half of the popup-token handshake.
 *
 * The load-bearing behaviors, each pinned both ways:
 *   - the sign-in offer exists on embeds that opted in (`auth-offer`) and on
 *     any embed whose workspace REQUIRES a signed-in writer — and nowhere
 *     else, so a production-site embed against an open workspace never
 *     shows it
 *   - the postMessage listener accepts the token only from the server origin
 *     and only from the popup window it opened
 *   - posts carry the token; a 401 clears it and retries anonymously, so a
 *     revoked session costs the comment its attribution, not its text
 */

interface FetchCall {
  url: string;
  init?: RequestInit;
}

let fetchCalls: FetchCall[];
let fetchResponder: (url: string, init?: RequestInit) => Response;
/** The subprotocols each socket the widget opened offered, in order. */
let socketProtocols: Array<string | string[] | undefined>;
/** Every socket the widget opened, in order. */
let sockets: FakeSocket[];
/**
 * `answer`: each socket opens and the server's sync step 2 lands, as a doc
 * the server holds answers. `drive`: nothing happens until the test fires it.
 */
let socketMode: 'answer' | 'drive';

interface FakeSocket {
  protocols?: string | string[];
  fire(type: string, data?: ArrayBuffer): void;
}

/** The server's half of a sync: step 2 of an empty doc, as the socket delivers it. */
function syncStep2(): ArrayBuffer {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, 0);
  syncProtocol.writeSyncStep2(enc, new Y.Doc());
  return encoding.toUint8Array(enc).slice().buffer;
}

function stubGlobals() {
  fetchCalls = [];
  fetchResponder = () =>
    new Response(JSON.stringify({ ok: true }), {
      headers: { 'content-type': 'application/json' },
    });
  (globalThis as unknown as { fetch: unknown }).fetch = (async (
    url: string,
    init?: RequestInit,
  ) => {
    fetchCalls.push({ url: String(url), init });
    return fetchResponder(String(url), init);
  }) as unknown as typeof fetch;
  socketProtocols = [];
  sockets = [];
  socketMode = 'answer';
  class FakeWS implements FakeSocket {
    static OPEN = 1;
    readyState = 1;
    binaryType = 'arraybuffer';
    listeners = new Map<string, ((ev: { data?: ArrayBuffer }) => void)[]>();
    constructor(
      _url: string,
      public protocols?: string | string[],
    ) {
      socketProtocols.push(protocols);
      sockets.push(this);
      if (socketMode === 'answer') {
        queueMicrotask(() => {
          this.fire('open');
          this.fire('message', syncStep2());
        });
      }
    }
    fire(type: string, data?: ArrayBuffer) {
      for (const cb of this.listeners.get(type) ?? []) cb({ data });
    }
    addEventListener(type: string, cb: (ev: { data?: ArrayBuffer }) => void) {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), cb]);
    }
    removeEventListener() {}
    send() {}
    close() {}
  }
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWS;
}

async function importWidget() {
  stubGlobals();
  return import('../src/widget.ts');
}

/** The server origin the widget defaults to in these tests (same host). */
function serverOrigin(): string {
  return location.origin;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

/** Arm feedback mode and click the page, the way a person opens the composer. */
function openComposer(el: HTMLElement): HTMLElement {
  const root = el.shadowRoot!;
  document.elementFromPoint = () => document.getElementById('hello') as HTMLElement;
  (root.querySelector('.fab') as HTMLButtonElement).click();
  window.dispatchEvent(new PointerEvent('pointerup', { clientX: 10, clientY: 10 }));
  return root.querySelector('.composer') as HTMLElement;
}

function authHeaderOf(call: FetchCall): string | null {
  const headers = (call.init?.headers ?? {}) as Record<string, string>;
  const entry = Object.entries(headers).find(([k]) => k.toLowerCase() === 'authorization');
  return entry?.[1] ?? null;
}

beforeEach(() => {
  document.body.innerHTML = '<main><button id="hello">Hello</button></main>';
  document.head.querySelectorAll('style').forEach((s) => s.remove());
  localStorage.clear();
});

afterEach(() => {
  document.querySelectorAll('claude-feedback-widget').forEach((el) => el.remove());
  document.querySelectorAll('.cfw-overlay, #cfw-light-styles').forEach((el) => el.remove());
});

describe('the sign-in offer', () => {
  it('does NOT exist without auth-offer on a workspace that does not require it', async () => {
    const mod = await importWidget();
    const el = mod.FeedbackWidget.init({ workspaceId: 'w-1', docId: 'doc-auth-off' });
    await flush();
    expect(el.shadowRoot!.querySelector('.auth-signin')).toBeNull();
  });

  it('exists on an embed that opted in', async () => {
    const mod = await importWidget();
    const el = mod.FeedbackWidget.init({
      workspaceId: 'w-1',
      docId: 'doc-auth-on',
      authOffer: true,
    });
    expect(el.shadowRoot!.querySelector('.auth-signin')).toBeTruthy();
  });

  it('reads the auth-offer attribute in the declarative embed', async () => {
    await importWidget();
    const host = document.createElement('claude-feedback-widget');
    host.setAttribute('doc-id', 'doc-auth-attr');
    host.setAttribute('workspace-id', 'w-1');
    host.setAttribute('auth-offer', '');
    document.body.appendChild(host);
    expect((host as HTMLElement).shadowRoot!.querySelector('.auth-signin')).toBeTruthy();
  });
});

describe('the popup handshake', () => {
  it('opens the popup on the server origin, naming this page as recipient', async () => {
    const mod = await importWidget();
    const opened: string[] = [];
    (window as unknown as { open: unknown }).open = (url: string) => {
      opened.push(String(url));
      return {} as Window;
    };
    const el = mod.FeedbackWidget.init({
      workspaceId: 'w-1',
      docId: 'doc-auth-popup',
      authOffer: true,
    });
    (el.shadowRoot!.querySelector('.auth-signin') as HTMLButtonElement).click();
    expect(opened.length).toBe(1);
    const url = new URL(opened[0] as string);
    expect(url.origin).toBe(serverOrigin());
    expect(url.pathname).toBe('/widget-auth');
    expect(url.searchParams.get('origin')).toBe(location.origin);
  });

  it('adopts a token only from the popup it opened, on the server origin', async () => {
    const mod = await importWidget();
    const popup = {} as Window;
    (window as unknown as { open: unknown }).open = () => popup;
    const el = mod.FeedbackWidget.init({
      workspaceId: 'w-1',
      docId: 'doc-auth-msg',
      authOffer: true,
    });
    (el.shadowRoot!.querySelector('.auth-signin') as HTMLButtonElement).click();

    const user = { id: 'user-abc', name: 'Reviewer', kind: 'known', color: '#2e7dd7' };
    const send = (origin: string, source: unknown, data: unknown) =>
      window.dispatchEvent(new MessageEvent('message', { origin, source: source as Window, data }));

    // Wrong origin: ignored even with the right shape and source.
    send('https://evil.example.com', popup, { type: 'cw-widget-auth', token: 'wt1.x', user });
    expect(localStorage.getItem('cfw:authToken')).toBeNull();

    // Right origin, wrong source (not our popup): ignored.
    send(serverOrigin(), {} as Window, { type: 'cw-widget-auth', token: 'wt1.x', user });
    expect(localStorage.getItem('cfw:authToken')).toBeNull();

    // The real handshake.
    send(serverOrigin(), popup, { type: 'cw-widget-auth', token: 'wt1.real-token', user });
    expect(localStorage.getItem('cfw:authToken')).toBe('wt1.real-token');
    // The offer collapses into the signed-in identity.
    expect(el.shadowRoot!.querySelector('.auth-signin')).toBeNull();
    expect(el.shadowRoot!.querySelector('.me')?.textContent).toContain('Reviewer');
  });
});

describe('a page on the tailnet widget door', () => {
  // The server this page's widget talks to is the tailnet hostname, and the
  // popup cannot sign in there: it opens on the public host the door's 401
  // names, and that host is then the ONLY origin a token is taken from.
  const SIGN_IN = 'https://operator.example.com';
  const user = { id: 'user-abc', name: 'Reviewer', kind: 'known', color: '#2e7dd7' };
  const doorRefusal = () =>
    new Response(
      JSON.stringify({ error: 'sign_in_required', signInToWrite: true, signInOrigin: SIGN_IN }),
      { status: 401, headers: { 'content-type': 'application/json' } },
    );

  async function signInOnDoor() {
    const mod = await importWidget();
    fetchResponder = (url) =>
      url.includes('/api/auth/session') ? doorRefusal() : new Response('{}');
    const opened: string[] = [];
    const popup = {} as Window;
    (window as unknown as { open: unknown }).open = (url: string) => {
      opened.push(String(url));
      return popup;
    };
    const el = mod.FeedbackWidget.init({ workspaceId: 'w-riverbend', docId: 'doc-door' });
    await flush();
    (el.shadowRoot!.querySelector('.auth-signin') as HTMLButtonElement).click();
    const send = (origin: string, token: string) =>
      window.dispatchEvent(
        new MessageEvent('message', {
          origin,
          source: popup,
          data: { type: 'cw-widget-auth', token, user },
        }),
      );
    return { el, opened, send };
  }

  it('opens the popup on the sign-in origin, naming this page and its board', async () => {
    const { opened } = await signInOnDoor();
    expect(opened.length).toBe(1);
    const url = new URL(opened[0] as string);
    expect(url.origin).toBe(SIGN_IN);
    expect(url.pathname).toBe('/widget-auth');
    expect(url.searchParams.get('origin')).toBe(location.origin);
    expect(url.searchParams.get('workspace')).toBe('w-riverbend');
  });

  it('ignores a token message from any origin but the sign-in origin', async () => {
    const { el, send } = await signInOnDoor();
    // The widget's own server origin is no longer the sender it trusts.
    send(serverOrigin(), 'wt2.from-the-server-origin');
    send('https://evil.example.com', 'wt2.from-elsewhere');
    send(`${SIGN_IN}:8443`, 'wt2.from-another-port');
    expect(localStorage.getItem('cfw:authToken')).toBeNull();
    expect(el.shadowRoot!.querySelector('.auth-signin')).toBeTruthy();
    send(SIGN_IN, 'wt2.real-token');
    expect(localStorage.getItem('cfw:authToken')).toBe('wt2.real-token');
  });

  it('reconnects with the token at once, and posts the held draft once that socket has synced', async () => {
    // On the door a socket without a token is refused, so a page nobody has
    // opened has no doc on the server, and a post to it would 404. The held
    // post has to wait for the socket the token opens.
    const mod = await importWidget();
    socketMode = 'drive';
    let posts = 0;
    fetchResponder = (url, init) => {
      if (url.includes('/api/auth/session')) return doorRefusal();
      if (url.includes('/threads')) {
        posts += 1;
        return authHeaderOf({ url, init }) ? new Response('{}') : doorRefusal();
      }
      return new Response('{}');
    };
    const popup = {} as Window;
    (window as unknown as { open: unknown }).open = () => popup;
    const el = mod.FeedbackWidget.init({ workspaceId: 'w-riverbend', docId: 'doc-door-new' });
    await flush();
    sockets[0]?.fire('close');
    const composer = openComposer(el);
    (composer.querySelector('textarea') as HTMLTextAreaElement).value = 'the header overlaps';
    (composer.querySelector('.submit') as HTMLButtonElement).click();
    await flush();
    expect(posts, 'CONTROL: the post was refused without a token').toBe(1);
    (composer.querySelector('.auth-signin') as HTMLButtonElement).click();
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: SIGN_IN,
        source: popup,
        data: { type: 'cw-widget-auth', token: 'wt2.real-token', user },
      }),
    );
    await flush();
    expect(socketProtocols.at(-1), 'a socket with the token, not at the end of a backoff').toBe(
      'wt2.real-token',
    );
    expect(posts, 'nothing posted before the doc exists').toBe(1);
    sockets.at(-1)?.fire('open');
    sockets.at(-1)?.fire('message', syncStep2());
    await flush();
    expect(posts).toBe(2);
    const retry = fetchCalls.filter((c) => c.url.includes('/threads'))[1] as FetchCall;
    expect(authHeaderOf(retry)).toBe('Bearer wt2.real-token');
  });

  /** A board token's shape: its fifth segment is the board, base64url. */
  const boardToken = (board: string) =>
    `wt2.user-abc.1.2.${btoa(board).replace(/=+$/, '')}.${btoa(location.origin).replace(/=+$/, '')}.sig`;

  it('offers the held token as the socket subprotocol', async () => {
    localStorage.setItem('cfw:authToken', boardToken('w-1'));
    localStorage.setItem('cfw:authUser', JSON.stringify(user));
    const mod = await importWidget();
    mod.FeedbackWidget.init({ workspaceId: 'w-1', docId: 'doc-door-socket', authOffer: true });
    expect(socketProtocols).toEqual([boardToken('w-1')]);
  });

  it('never offers a session token on the socket, so a localhost embed opens as it did', async () => {
    localStorage.setItem('cfw:authToken', 'wt1.stored-token');
    localStorage.setItem('cfw:authUser', JSON.stringify(user));
    const mod = await importWidget();
    const el = mod.FeedbackWidget.init({ workspaceId: 'w-1', docId: 'doc-local', authOffer: true });
    expect(
      el.shadowRoot!.querySelector('.auth-signout'),
      'CONTROL: the token is held',
    ).toBeTruthy();
    expect(socketProtocols).toEqual([undefined]);
  });

  it("does not hold another board's token that a page on this origin stored", async () => {
    localStorage.setItem('cfw:authToken', boardToken('w-saltmarsh'));
    localStorage.setItem('cfw:authUser', JSON.stringify(user));
    const mod = await importWidget();
    // The door's refusal is what makes the widget adopt a stored token, and a
    // live-looking probe answer is what would keep it.
    fetchResponder = (url) =>
      url.includes('/api/auth/session')
        ? doorRefusal()
        : new Response(JSON.stringify({ authenticated: true, user }), {
            headers: { 'content-type': 'application/json' },
          });
    const el = mod.FeedbackWidget.init({ workspaceId: 'w-riverbend', docId: 'doc-door-other' });
    await flush();
    expect(
      fetchCalls.some((c) => c.url.includes('/api/auth/session')),
      'CONTROL: asked',
    ).toBe(true);
    expect(fetchCalls.some((c) => authHeaderOf(c))).toBe(false);
    expect(el.shadowRoot!.querySelector('.auth-signin')).toBeTruthy();
    expect(el.shadowRoot!.querySelector('.me')?.textContent).not.toContain(user.name);
  });
});

describe('posting with a token', () => {
  it('sends the token on thread posts', async () => {
    localStorage.setItem('cfw:authToken', 'wt1.stored-token');
    localStorage.setItem(
      'cfw:authUser',
      JSON.stringify({ id: 'user-abc', name: 'Reviewer', kind: 'known', color: '#2e7dd7' }),
    );
    const mod = await importWidget();
    fetchResponder = (url) =>
      url.includes('/api/auth/widget-session')
        ? new Response(
            JSON.stringify({
              authenticated: true,
              user: { id: 'user-abc', name: 'Reviewer', kind: 'known', color: '#2e7dd7' },
            }),
            { headers: { 'content-type': 'application/json' } },
          )
        : new Response(JSON.stringify({ ok: true }), {
            headers: { 'content-type': 'application/json' },
          });
    const el = mod.FeedbackWidget.init({
      workspaceId: 'w-1',
      docId: 'doc-auth-post',
      authOffer: true,
    });
    await flush();
    fetchCalls = [];
    // biome-ignore lint/suspicious/noExplicitAny: reaching into a private for the test
    await (el as any).postReply('t-1', 'hello');
    const call = fetchCalls.find((c) => c.url.includes('/threads/'));
    expect(call).toBeTruthy();
    expect(authHeaderOf(call as FetchCall)).toBe('Bearer wt1.stored-token');
  });

  it('a 401 clears the token and retries the post anonymously', async () => {
    localStorage.setItem('cfw:authToken', 'wt1.revoked-token');
    localStorage.setItem(
      'cfw:authUser',
      JSON.stringify({ id: 'user-abc', name: 'Reviewer', kind: 'known', color: '#2e7dd7' }),
    );
    const mod = await importWidget();
    // The stored token is live at load, dead by the time the post lands —
    // the way a logout on the workspace looks from a dev-server tab.
    fetchResponder = (url, init) => {
      if (url.includes('/api/auth/widget-session')) {
        return new Response(
          JSON.stringify({
            authenticated: true,
            user: { id: 'user-abc', name: 'Reviewer', kind: 'known', color: '#2e7dd7' },
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      }
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const has = Object.keys(headers).some((k) => k.toLowerCase() === 'authorization');
      return has
        ? new Response(JSON.stringify({ error: 'widget_token_invalid' }), { status: 401 })
        : new Response(JSON.stringify({ ok: true }), {
            headers: { 'content-type': 'application/json' },
          });
    };
    const el = mod.FeedbackWidget.init({
      workspaceId: 'w-1',
      docId: 'doc-auth-401',
      authOffer: true,
    });
    await flush();
    fetchCalls = [];
    // biome-ignore lint/suspicious/noExplicitAny: reaching into a private for the test
    await (el as any).postReply('t-1', 'still lands');
    const posts = fetchCalls.filter((c) => c.url.includes('/threads/'));
    expect(posts.length).toBe(2);
    expect(authHeaderOf(posts[0] as FetchCall)).toBe('Bearer wt1.revoked-token');
    expect(authHeaderOf(posts[1] as FetchCall)).toBeNull();
    // The retry's BODY is rebuilt too: the server trusts a claimed author on
    // the local surface, so re-sending the signed-in identity without its
    // token would let the revoked person keep their name on every comment.
    const authorOf = (c: FetchCall) =>
      (JSON.parse(String(c.init?.body)) as { author: { id: string } }).author.id;
    // biome-ignore lint/suspicious/noExplicitAny: reaching into a private for the test
    const anonId = (el as any).anonUser.id as string;
    expect(anonId).not.toBe('user-abc');
    expect(authorOf(posts[0] as FetchCall)).toBe('user-abc');
    expect(authorOf(posts[1] as FetchCall)).not.toBe('user-abc');
    expect(authorOf(posts[1] as FetchCall)).toBe(anonId);
    // Signed out for real: token gone, offer back.
    expect(localStorage.getItem('cfw:authToken')).toBeNull();
    expect(el.shadowRoot!.querySelector('.auth-signin')).toBeTruthy();
  });
});

describe('a stored token is validated on load', () => {
  it('keeps a live token and shows its user', async () => {
    localStorage.setItem('cfw:authToken', 'wt1.live-token');
    const mod = await importWidget();
    fetchResponder = (url) =>
      url.includes('/api/auth/widget-session')
        ? new Response(
            JSON.stringify({
              authenticated: true,
              user: { id: 'user-abc', name: 'Reviewer', kind: 'known', color: '#2e7dd7' },
            }),
            { headers: { 'content-type': 'application/json' } },
          )
        : new Response(JSON.stringify({ ok: true }), {
            headers: { 'content-type': 'application/json' },
          });
    const el = mod.FeedbackWidget.init({
      workspaceId: 'w-1',
      docId: 'doc-auth-check',
      authOffer: true,
    });
    await flush();
    const probe = fetchCalls.find((c) => c.url.includes('/api/auth/widget-session'));
    expect(probe).toBeTruthy();
    expect(authHeaderOf(probe as FetchCall)).toBe('Bearer wt1.live-token');
    expect(el.shadowRoot!.querySelector('.me')?.textContent).toContain('Reviewer');
  });

  it('clears a dead token and shows the offer again', async () => {
    localStorage.setItem('cfw:authToken', 'wt1.dead-token');
    const mod = await importWidget();
    fetchResponder = (url) =>
      url.includes('/api/auth/widget-session')
        ? new Response(JSON.stringify({ error: 'widget_token_invalid' }), { status: 401 })
        : new Response(JSON.stringify({ ok: true }), {
            headers: { 'content-type': 'application/json' },
          });
    const el = mod.FeedbackWidget.init({
      workspaceId: 'w-1',
      docId: 'doc-auth-dead',
      authOffer: true,
    });
    await flush();
    expect(localStorage.getItem('cfw:authToken')).toBeNull();
    expect(el.shadowRoot!.querySelector('.auth-signin')).toBeTruthy();
  });

  it('neither adopts nor probes a stored token on an open workspace, even without auth-offer', async () => {
    // The stored token is what makes this a real test: with nothing stored
    // the probe returns early for every embed, and "no traffic" would pass
    // whether or not the offer gated it. Seeding the same token that the
    // auth-offer test above proves DOES fire the probe makes this the
    // negative half of that pair. The one call a plain embed may make is
    // the session question itself — asked once, answered "not required".
    localStorage.setItem('cfw:authToken', 'wt1.stored-token');
    localStorage.setItem(
      'cfw:authUser',
      JSON.stringify({ id: 'user-abc', name: 'Reviewer', kind: 'known', color: '#2e7dd7' }),
    );
    const mod = await importWidget();
    fetchResponder = (url) =>
      url.includes('/api/auth/session')
        ? new Response(JSON.stringify({ signInToWrite: false, canWrite: true }), {
            headers: { 'content-type': 'application/json' },
          })
        : new Response('{}');
    const el = mod.FeedbackWidget.init({ workspaceId: 'w-1', docId: 'doc-auth-silent' });
    await flush();
    const authCalls = fetchCalls.filter((c) => c.url.includes('/api/auth/'));
    expect(authCalls.map((c) => new URL(c.url).pathname)).toEqual(['/api/auth/session']);
    // And the stored identity is not adopted either: no offer, no sign-in.
    expect(el.shadowRoot!.querySelector('.me')?.textContent).not.toContain('Reviewer');
    expect(el.shadowRoot!.querySelector('.auth-signout')).toBeNull();
    expect(el.shadowRoot!.querySelector('.auth-signin')).toBeNull();
  });
});

describe('a write the workspace refuses for want of a session', () => {
  /** What the server answers an unsigned write with — see
   *  server/src/middleware/write-gate.ts. */
  const refuse = () =>
    new Response(JSON.stringify({ error: 'sign_in_required', signInUrl: '/signin' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });

  it('does NOT retry anonymously — the retry gets the identical refusal', async () => {
    // The dead-token path clears the token and posts again, which is right
    // for a dead token and a loop for this: nothing about being anonymous
    // makes the second attempt acceptable, and every caller ignores the
    // response, so the comment simply vanished.
    const mod = await importWidget();
    fetchResponder = (url) => (url.includes('/threads') ? refuse() : new Response('{}'));
    const el = mod.FeedbackWidget.init({ workspaceId: 'w-1', docId: 'doc-refused' });
    await flush();
    fetchCalls = [];
    // biome-ignore lint/suspicious/noExplicitAny: reaching into a private for the test
    const posted = await (el as any).postReply('t-1', 'hello');
    expect(fetchCalls.filter((c) => c.url.includes('/threads')).length).toBe(1);
    expect(posted).toBe(false);
  });

  it('tells the person, and keeps the way forward clickable rather than opening it', async () => {
    // Popup blockers: this runs after awaiting a failed request and parsing
    // its body, so the submit click's transient activation is long gone and
    // a `window.open` here would be silently refused.
    const mod = await importWidget();
    const opened: string[] = [];
    (window as unknown as { open: unknown }).open = (url: string) => {
      opened.push(String(url));
      return {} as Window;
    };
    fetchResponder = (url) => (url.includes('/threads') ? refuse() : new Response('{}'));
    const el = mod.FeedbackWidget.init({
      workspaceId: 'w-1',
      docId: 'doc-refused-ui',
      authOffer: true,
    });
    await flush();
    // biome-ignore lint/suspicious/noExplicitAny: reaching into a private for the test
    await (el as any).postReply('t-1', 'hello');
    expect(opened.length).toBe(0);
    const control = el.shadowRoot!.querySelector('.auth-signin') as HTMLElement;
    expect(control).toBeTruthy();
    expect(control.textContent).toContain('Sign in');
    // …and clicking it — which DOES carry an activation — starts the handshake.
    control.click();
    expect(opened.length).toBe(1);
    expect(new URL(opened[0] as string).pathname).toBe('/widget-auth');
  });

  it('offers the popup on an embed with no auth-offer — the refusal is the proof it is needed', async () => {
    // The load-time question may go unanswered (an older server, a route
    // that 500s); the 401 is the backstop, and the offer it raises is the
    // same popup handshake — the workspace sign-in page on its own origin
    // cannot help a page on another origin, because no cookie crosses.
    const mod = await importWidget();
    const opened: string[] = [];
    (window as unknown as { open: unknown }).open = (url: string) => {
      opened.push(String(url));
      return {} as Window;
    };
    fetchResponder = (url) =>
      url.includes('/threads') ? refuse() : new Response('nope', { status: 500 });
    const el = mod.FeedbackWidget.init({ workspaceId: 'w-1', docId: 'doc-refused-link' });
    await flush();
    expect(el.shadowRoot!.querySelector('.auth-signin')).toBeNull();
    // biome-ignore lint/suspicious/noExplicitAny: reaching into a private for the test
    await (el as any).postReply('t-1', 'hello');
    const control = el.shadowRoot!.querySelector('.auth-signin') as HTMLElement;
    expect(control).toBeTruthy();
    control.click();
    expect(new URL(opened[0] as string).pathname).toBe('/widget-auth');
  });

  it('a dead TOKEN still clears and retries — the other 401 is unchanged', async () => {
    // The positive control for the branch above: the same status code, a
    // different body, and the old behaviour has to survive intact.
    localStorage.setItem('cfw:authToken', 'wt1.stored-token');
    localStorage.setItem(
      'cfw:authUser',
      JSON.stringify({ id: 'user-abc', name: 'Reviewer', kind: 'known', color: '#2e7dd7' }),
    );
    const mod = await importWidget();
    let threadPosts = 0;
    fetchResponder = (url) => {
      if (url.includes('/api/auth/widget-session')) {
        return new Response(
          JSON.stringify({
            authenticated: true,
            user: { id: 'user-abc', name: 'Reviewer', kind: 'known', color: '#2e7dd7' },
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/threads')) {
        threadPosts += 1;
        return threadPosts === 1
          ? new Response(JSON.stringify({ error: 'widget_token_invalid' }), { status: 401 })
          : new Response(JSON.stringify({ ok: true }), {
              headers: { 'content-type': 'application/json' },
            });
      }
      return new Response('{}');
    };
    const el = mod.FeedbackWidget.init({
      workspaceId: 'w-1',
      docId: 'doc-dead-token',
      authOffer: true,
    });
    await flush();
    // biome-ignore lint/suspicious/noExplicitAny: reaching into a private for the test
    const posted = await (el as any).postReply('t-1', 'hello');
    expect(threadPosts).toBe(2);
    expect(posted).toBe(true);
    expect(localStorage.getItem('cfw:authToken')).toBeNull();
  });
});

describe('a workspace that requires a signed-in writer', () => {
  const user = { id: 'user-abc', name: 'Reviewer', kind: 'known', color: '#2e7dd7' };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  const required = () => json({ signInToWrite: true, canWrite: false });
  const refuse = () => json({ error: 'sign_in_required', signInUrl: '/signin' }, 401);

  it('asks once on load and offers sign-in without auth-offer', async () => {
    const mod = await importWidget();
    fetchResponder = (url) => (url.includes('/api/auth/session') ? required() : json({}));
    const el = mod.FeedbackWidget.init({ workspaceId: 'w-1', docId: 'doc-req-load' });
    await flush();
    const asks = fetchCalls.filter((c) => c.url.includes('/api/auth/session'));
    expect(asks.length).toBe(1);
    expect(asks[0]?.init?.method ?? 'GET').toBe('GET');
    expect(el.shadowRoot!.querySelector('.auth-signin')).toBeTruthy();
  });

  it('adopts and validates a stored token, so signed-in state survives a reload', async () => {
    localStorage.setItem('cfw:authToken', 'wt1.stored-token');
    localStorage.setItem('cfw:authUser', JSON.stringify(user));
    const mod = await importWidget();
    fetchResponder = (url) => {
      if (url.includes('/api/auth/session')) return required();
      if (url.includes('/api/auth/widget-session')) return json({ authenticated: true, user });
      return json({});
    };
    const el = mod.FeedbackWidget.init({ workspaceId: 'w-1', docId: 'doc-req-stored' });
    await flush();
    const probe = fetchCalls.find((c) => c.url.includes('/api/auth/widget-session'));
    expect(authHeaderOf(probe as FetchCall)).toBe('Bearer wt1.stored-token');
    expect(el.shadowRoot!.querySelector('.me')?.textContent).toContain('Reviewer');
    expect(el.shadowRoot!.querySelector('.auth-signin')).toBeNull();
    expect(el.shadowRoot!.querySelector('.auth-signout')).toBeTruthy();
  });

  it('the composer says why it cannot post, before the first attempt', async () => {
    const mod = await importWidget();
    fetchResponder = (url) => (url.includes('/api/auth/session') ? required() : json({}));
    const el = mod.FeedbackWidget.init({ workspaceId: 'w-1', docId: 'doc-req-composer' });
    await flush();
    const composer = openComposer(el);
    expect(composer.querySelector('.composer-err')?.textContent).toContain('Sign in');
    expect(composer.querySelector('.auth-signin')).toBeTruthy();
    // Reading is untouched: the panel and the pick control are still there.
    expect(el.shadowRoot!.querySelector('.pick-btn')).toBeTruthy();
  });

  it('says the sentence the mic entry hands to a host, word for word', async () => {
    // The mic entry spells this sentence again rather than importing it,
    // because naming it here would cost the budgeted bundle bytes on every
    // mock page. This is what makes the copy safe: the words a host puts in
    // its readout for a REFUSED SPOKEN comment are the words the composer
    // renders for a typed one, or a spoken comment is answered in a language
    // of its own.
    const mod = await importWidget();
    fetchResponder = (url) => (url.includes('/api/auth/session') ? required() : json({}));
    const el = mod.FeedbackWidget.init({ workspaceId: 'w-1', docId: 'doc-req-wording' });
    await flush();
    const note = openComposer(el).querySelector('.composer-err');
    expect(note?.textContent, 'CONTROL: the composer really did say something').toBeTruthy();
    expect(note?.textContent?.startsWith(SIGN_IN_NOTE), SIGN_IN_NOTE).toBe(true);
  });

  it('keeps the draft on refusal and posts it once the person signs in', async () => {
    const mod = await importWidget();
    const popup = {} as Window;
    (window as unknown as { open: unknown }).open = () => popup;
    let posts = 0;
    fetchResponder = (url, init) => {
      if (url.includes('/api/auth/session')) return json({ signInToWrite: false });
      if (url.includes('/threads')) {
        posts += 1;
        const headers = (init?.headers ?? {}) as Record<string, string>;
        return headers.authorization ? json({ ok: true }) : refuse();
      }
      return json({});
    };
    const el = mod.FeedbackWidget.init({ workspaceId: 'w-1', docId: 'doc-req-retry' });
    await flush();
    const composer = openComposer(el);
    // The load-time answer said open; the refusal is what teaches this embed.
    expect(composer.querySelector('.auth-signin')).toBeNull();
    (composer.querySelector('textarea') as HTMLTextAreaElement).value = 'needs work';
    (composer.querySelector('.submit') as HTMLButtonElement).click();
    await flush();
    expect(posts).toBe(1);
    expect(el.shadowRoot!.querySelector('.composer')).toBeTruthy();
    expect((composer.querySelector('textarea') as HTMLTextAreaElement).value).toBe('needs work');
    const control = composer.querySelector('.auth-signin') as HTMLButtonElement;
    expect(control).toBeTruthy();
    expect(composer.querySelector('.composer-err')?.textContent).toContain('Sign in');
    control.click();
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: serverOrigin(),
        source: popup,
        data: { type: 'cw-widget-auth', token: 'wt1.fresh', user },
      }),
    );
    await flush();
    expect(posts).toBe(2);
    const retry = fetchCalls.filter((c) => c.url.includes('/threads'))[1] as FetchCall;
    expect(authHeaderOf(retry)).toBe('Bearer wt1.fresh');
    expect(JSON.parse(String(retry.init?.body)).author.name).toBe('Reviewer');
    expect(el.shadowRoot!.querySelector('.composer')).toBeNull();
  });

  it('a cancelled draft is not posted by a later sign-in', async () => {
    const mod = await importWidget();
    const popup = {} as Window;
    (window as unknown as { open: unknown }).open = () => popup;
    let posts = 0;
    fetchResponder = (url) => {
      if (url.includes('/api/auth/session')) return required();
      if (url.includes('/threads')) {
        posts += 1;
        return refuse();
      }
      return json({});
    };
    const el = mod.FeedbackWidget.init({ workspaceId: 'w-1', docId: 'doc-req-cancel' });
    await flush();
    const composer = openComposer(el);
    (composer.querySelector('textarea') as HTMLTextAreaElement).value = 'second thoughts';
    (composer.querySelector('.submit') as HTMLButtonElement).click();
    await flush();
    expect(posts).toBe(1);
    (composer.querySelector('.auth-signin') as HTMLButtonElement).click();
    (composer.querySelector('.cancel') as HTMLButtonElement).click();
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: serverOrigin(),
        source: popup,
        data: { type: 'cw-widget-auth', token: 'wt1.fresh', user },
      }),
    );
    await flush();
    expect(posts).toBe(1);
  });
});

describe('a workspace that requires a signed-in writer, asked by a browser that already is', () => {
  // Cloudflare Access (and a cookie session) satisfy the write gate without
  // the widget holding a popup token at all. `signInToWrite` alone cannot
  // tell that visitor from a stranger — only `canWrite` can — so arming the
  // offer on the flag alone put "Sign in to post" on every composer of a
  // person whose every post was landing.
  const user = { id: 'user-abc', name: 'Stored Fixture', kind: 'known', color: '#2e7dd7' };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  async function mount(session: unknown, docId: string) {
    const mod = await importWidget();
    fetchResponder = (url) => (url.includes('/api/auth/session') ? json(session) : json({}));
    const el = mod.FeedbackWidget.init({ workspaceId: 'w-1', docId });
    await flush();
    return el;
  }

  it('arms nothing when the server says this browser can write', async () => {
    const el = await mount({ signInToWrite: true, canWrite: true }, 'doc-access-visitor');
    expect((el as unknown as { signInToWrite: boolean }).signInToWrite).toBe(false);
    expect(el.shadowRoot!.querySelector('.auth-signin')).toBeNull();
    const composer = openComposer(el);
    expect(composer.querySelector('.composer-err')).toBeNull();
    expect(composer.querySelector('.auth-signin')).toBeNull();
  });

  it('does not adopt or probe a stored token on that answer either', async () => {
    // The token is what makes this a real negative: with nothing stored the
    // probe returns early whatever the answer was.
    localStorage.setItem('cfw:authToken', 'wt1.stored-token');
    localStorage.setItem('cfw:authUser', JSON.stringify(user));
    const el = await mount({ signInToWrite: true, canWrite: true }, 'doc-access-stored');
    expect(fetchCalls.some((c) => c.url.includes('/api/auth/widget-session'))).toBe(false);
    expect(el.shadowRoot!.querySelector('.me')?.textContent).not.toContain('Stored Fixture');
    expect(el.shadowRoot!.querySelector('.auth-signout')).toBeNull();
  });

  it('still arms the offer when the server says this browser cannot write', async () => {
    const el = await mount({ signInToWrite: true, canWrite: false }, 'doc-access-stranger');
    expect((el as unknown as { signInToWrite: boolean }).signInToWrite).toBe(true);
    expect(el.shadowRoot!.querySelector('.auth-signin')).toBeTruthy();
    expect(openComposer(el).querySelector('.auth-signin')).toBeTruthy();
  });

  it('still arms the offer against a server too old to answer canWrite', async () => {
    // A missing field is not a permission. Reading it as "can write" would
    // silently drop the offer on every deployment that predates the field.
    const el = await mount({ signInToWrite: true }, 'doc-access-old-server');
    expect((el as unknown as { signInToWrite: boolean }).signInToWrite).toBe(true);
    expect(el.shadowRoot!.querySelector('.auth-signin')).toBeTruthy();
  });

  it('a write actually refused still arms the offer, canWrite or not', async () => {
    // The load-time answer is a hint; the 401 is the fact. An Access session
    // that ends mid-visit must still get the way back in.
    const mod = await importWidget();
    fetchResponder = (url) => {
      if (url.includes('/api/auth/session')) return json({ signInToWrite: true, canWrite: true });
      if (url.includes('/threads'))
        return json({ error: 'sign_in_required', signInUrl: '/signin' }, 401);
      return json({});
    };
    const el = mod.FeedbackWidget.init({ workspaceId: 'w-1', docId: 'doc-access-expired' });
    await flush();
    expect((el as unknown as { signInToWrite: boolean }).signInToWrite).toBe(false);
    // biome-ignore lint/suspicious/noExplicitAny: reaching into a private for the test
    const posted = await (el as any).postReply('t-1', 'hello');
    expect(posted).toBe(false);
    expect((el as unknown as { signInToWrite: boolean }).signInToWrite).toBe(true);
    expect(el.shadowRoot!.querySelector('.auth-signin')).toBeTruthy();
  });
});
