/**
 * The two ends of a served mock's line to the board, joined as the browser
 * joins them: the frame's bridge posts to its parent, and the host answers
 * over the port it was handed.
 *
 * The real sandbox — that the frame cannot reach the board any other way — is
 * `mock-sandbox.test.ts`, in a browser. This file drives what each end does
 * with a call: which ones the host makes, what it adds and drops, and what the
 * frame's widget gets back. The host's own fetch, sockets and microphone are
 * stand-ins that record what they were asked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installBridge } from '../src/mock-bridge.ts';
import {
  BOARD,
  HostSocket,
  HostStream,
  MOCK,
  NativeSocket,
  THREADS,
  build,
  sessionStore,
} from './mock-bridge-harness.ts';

let h: ReturnType<typeof build>;
beforeEach(() => {
  h = build();
});
afterEach(() => {
  document.body.innerHTML = '';
});

describe('the frame is made by the host', () => {
  it("loads the server's frame address, named with the reader's stored name, which the frame then reads", () => {
    expect(h.frame?.getAttribute('src')).toBe('?v=2&cw-frame=1');
    expect(h.w.localStorage.getItem('feedback-user-name')).toBe('Sample Reader');
    expect(h.w.name).toBe('');
    h.w.localStorage.setItem('cfw:showResolved', '1');
    expect([h.w.localStorage.length, h.w.localStorage.key(1)]).toEqual([2, 'cfw:showResolved']);
    h.w.localStorage.removeItem('cfw:showResolved');
    h.w.localStorage.clear();
    expect(h.w.localStorage.getItem('feedback-user-name')).toBeNull();
    expect(h.w.sessionStorage.length).toBe(0);
  });

  it("hands the frame the page's fragment, which never reached the server", () => {
    const withHash = build({ hash: '#map' });
    expect(withHash.frame?.getAttribute('src')).toBe('?v=2&cw-frame=1#map');
  });

  it('sends a direct visit to the frame address to the host page', () => {
    const replace = vi.fn();
    const top = {
      location: Object.assign(new URL(`${BOARD}${MOCK}?v=1&cw-frame=1`), { replace }),
      document,
    } as Record<string, unknown>;
    top.parent = top;
    installBridge(top as unknown as Window & typeof globalThis);
    expect(replace).toHaveBeenCalledWith(`${BOARD}${MOCK}?v=1`);
  });
});

describe('fetch', () => {
  it("makes this mock's own call for the frame, stamped, with only content-type and accept kept", async () => {
    const r = await h.w.fetch(`${BOARD}${THREADS}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer planted' },
      body: '{"text":"Saltmarsh"}',
    });
    expect([r.status, await r.text()]).toEqual([201, '{"ok":true}']);
    const [path, init] = h.hostFetch.mock.calls[0] ?? [];
    expect(path).toBe(THREADS);
    const headers = new Headers(init?.headers);
    expect([headers.get('x-cw-via'), headers.get('authorization')]).toEqual(['mock-frame', null]);
    expect(new TextDecoder().decode(init?.body as ArrayBuffer)).toBe('{"text":"Saltmarsh"}');
  });

  it('refuses a call on another doc without making it, and leaves calls off the board alone', async () => {
    const r = await h.w.fetch(`${BOARD}/workspaces/w-harbor/docs/d-other/threads`, {
      method: 'POST',
      body: '{}',
    });
    expect([r.status, h.hostFetch.mock.calls.length]).toEqual([403, 0]);
    expect(await (await h.w.fetch('https://tiles.riverbend.test/a.png')).text()).toBe('elsewhere');
  });

  it('answers a HEAD with no body, and a failed call as a TypeError', async () => {
    const head = await h.w.fetch(`${BOARD}${MOCK}`, { method: 'HEAD' });
    expect([head.status, await head.text()]).toEqual([201, '']);
    h.hostFetch.mockRejectedValueOnce(new Error('offline'));
    await expect(h.w.fetch(`${BOARD}${THREADS}`)).rejects.toThrow(TypeError);
  });

  it('ignores a relay request from anything but its own frame', async () => {
    const port = new MessageChannel();
    const seen = vi.fn();
    port.port1.onmessage = seen;
    h.hostListener()?.({
      source: {},
      data: { cw: 'relay', kind: 'fetch', url: THREADS },
      ports: [port.port2],
    } as never);
    h.hostListener()?.({
      source: h.frame?.contentWindow ?? null,
      data: { cw: 'nope' },
      ports: [port.port2],
    } as never);
    await new Promise((r) => setTimeout(r, 20));
    expect([seen.mock.calls.length, h.hostFetch.mock.calls.length]).toEqual([0, 0]);
    port.port1.close();
  });
});

describe('sockets', () => {
  it("opens this mock's live socket for the frame, stamped, and carries both directions", async () => {
    const ws = new h.w.WebSocket('ws://harborlight.test/workspaces/w-harbor/docs/d-moorings/y');
    const events: string[] = [];
    ws.addEventListener('open', () => events.push('open'));
    ws.onmessage = (e) => events.push(e.data instanceof Blob ? 'blob' : String(e.data));
    ws.onerror = () => events.push('error');
    ws.onclose = (e) => events.push(`close ${e.code}`);
    await vi.waitFor(() => expect(HostSocket.made).toHaveLength(1));
    const sock = HostSocket.made[0] as HostSocket;
    expect(new URL(sock.url).searchParams.get('cw-via')).toBe('mock-frame');
    expect(() => ws.send('early')).toThrow();

    sock.readyState = 1;
    sock.onopen?.();
    await vi.waitFor(() => expect(ws.readyState).toBe(1));
    sock.onmessage?.({ data: new ArrayBuffer(3) });
    sock.onmessage?.({ data: 'awareness' });
    sock.onerror?.();
    ws.send('hello');
    ws.send(new Uint8Array([7, 8]));
    await vi.waitFor(() => expect(sock.sent).toHaveLength(2));
    expect(sock.sent[0]).toBe('hello');
    expect([...new Uint8Array(sock.sent[1] as ArrayBuffer)]).toEqual([7, 8]);
    ws.close();
    ws.close();
    await vi.waitFor(() => expect(sock.closed).toBe(1));
    sock.onclose?.({ code: 1000, reason: '' });
    await vi.waitFor(() =>
      expect(events).toEqual(['open', 'blob', 'awareness', 'error', 'close 1000']),
    );
  });

  it('closes a socket on another doc as refused, and leaves one off the board alone', async () => {
    const ws = new h.w.WebSocket('ws://harborlight.test/workspaces/w-harbor/docs/d-other/y');
    const code = await new Promise((r) => {
      ws.onclose = (e) => r(e.code);
    });
    expect([code, HostSocket.made.length]).toEqual([1008, 0]);
    expect(new h.w.WebSocket('wss://tides.saltmarsh.test/live')).toBeInstanceOf(NativeSocket);
  });

  it('holds the microphone on the voice socket, and passes on only words from the frame', async () => {
    const ws = new h.w.WebSocket(
      'ws://harborlight.test/workspaces/w-harbor/docs/d-moorings/voice',
    ) as WebSocket & {
      cwMic(on: boolean, heard?: () => void): Promise<{ ok: boolean; message?: string }>;
    };
    await vi.waitFor(() => expect(HostSocket.made).toHaveLength(1));
    const sock = HostSocket.made[0] as HostSocket;
    sock.readyState = 1;
    sock.onopen?.();
    await vi.waitFor(() => expect(ws.readyState).toBe(1));
    expect(await ws.cwMic(true)).toEqual({ ok: true });
    ws.send(new ArrayBuffer(8));
    ws.send('{"type":"pin","target":3}');
    await vi.waitFor(() => expect(sock.sent).toEqual(['{"type":"pin","target":3}']));
    expect(await ws.cwMic(false)).toEqual({ ok: true });
    await vi.waitFor(() => expect(h.captures[0]?.stops).toBe(1));

    const waiting = ws.cwMic(true);
    sock.onclose?.({ code: 1006, reason: '' });
    expect(await waiting).toEqual({ ok: false, message: '' });
  });

  it("passes on the host's refusal when the page has no user activation", async () => {
    h = build({ activated: false });
    const ws = new h.w.WebSocket(
      'ws://harborlight.test/workspaces/w-harbor/docs/d-moorings/voice',
    ) as WebSocket & {
      cwMic(on: boolean): Promise<{ ok: boolean; message?: string }>;
    };
    const answer = await ws.cwMic(true);
    expect(answer.ok).toBe(false);
    expect(answer.message).toBeTruthy();
    expect(h.captures).toHaveLength(0);
  });
});

describe('event streams', () => {
  it("opens this mock's stream for the frame and forwards the event types it listens for", async () => {
    const es = new h.w.EventSource(`${BOARD}/workspaces/w-harbor/docs/d-moorings/events:stream`);
    const got: string[] = [];
    es.onopen = () => got.push('open');
    es.onerror = () => got.push('error');
    es.addEventListener('thread.created', (e) => got.push(`created ${(e as MessageEvent).data}`));
    es.addEventListener('thread.created', () => {});
    await vi.waitFor(() => expect(HostStream.made[0]?.heard.has('thread.created')).toBe(true));
    const stream = HostStream.made[0] as HostStream;
    stream.onopen?.();
    stream.onerror?.();
    stream.heard.get('thread.created')?.(new MessageEvent('thread.created', { data: 't-9' }));
    await vi.waitFor(() => expect(got).toEqual(['open', 'error', 'created t-9']));
    es.close();
    await vi.waitFor(() => expect(stream.closed).toBe(1));
  });

  it('errors a stream on another doc, and leaves one off the board alone', async () => {
    const es = new h.w.EventSource(`${BOARD}/workspaces/w-harbor/docs/d-other/events:stream`);
    await new Promise<void>((r) => {
      es.onerror = () => r();
    });
    expect(HostStream.made).toHaveLength(0);
    expect(new h.w.EventSource('https://tides.saltmarsh.test/feed')).toBeInstanceOf(NativeSocket);
  });
});

describe('links', () => {
  const tap = (href: string, target = '') => {
    const a = document.createElement('a');
    a.href = href;
    if (target) a.target = target;
    a.addEventListener('click', (e) => e.preventDefault());
    document.body.append(a);
    a.click();
    return a;
  };

  it('opens a board page at the top, keeps another round of the mock in the frame, and leaves the rest', () => {
    expect(tap(`${BOARD}/workspaces/w-harbor/home`).target).toBe('_top');
    expect(new URL(tap(`${BOARD}${MOCK}?v=1`).href).searchParams.get('cw-frame')).toBe('1');
    expect(tap(`${BOARD}${MOCK}?cw-frame=1`).target).toBe('');
    expect(tap('https://tides.saltmarsh.test/').target).toBe('');
    expect(tap(`${BOARD}/workspaces/w-harbor/home`, '_blank').target).toBe('_blank');
  });
});

describe("the reader's drafts", () => {
  const KEY = 'cfw:draft:comment:d-moorings:/workspaces/w-harbor/mockups/d-moorings?cw-frame=1';
  const SHELF = 'cw-frame-draft:d-moorings:';

  it('keeps a draft the frame writes on the host, under this doc, and forgets it when the frame does', () => {
    h.w.sessionStorage.setItem(KEY, '{"t":"Saltmarsh first"}');
    h.w.sessionStorage.setItem('mock-own-state', 'kept in the frame');
    expect([h.session.length, h.session.getItem(SHELF + KEY)]).toEqual([
      1,
      '{"t":"Saltmarsh first"}',
    ]);
    h.w.sessionStorage.removeItem(KEY);
    expect(h.session.length).toBe(0);
  });

  it("hands this doc's drafts to the frame that loads next, and says they have arrived", async () => {
    const session = sessionStore();
    session.setItem(SHELF + KEY, '{"t":"Riverbend"}');
    session.setItem(`cw-frame-draft:d-other:${KEY}`, '{"t":"another mock"}');
    const next = build({ session });
    await vi.waitFor(() => expect(next.announced).toEqual(['cw-drafts']));
    expect(next.w.sessionStorage.getItem(KEY)).toBe('{"t":"Riverbend"}');
    expect(next.w.sessionStorage.length).toBe(1);
    // Taken in without being written back.
    expect(session.length).toBe(2);
  });

  it('refuses a draft too large, a key that is not a draft, and a message from anything but its frame', () => {
    h.w.sessionStorage.setItem(KEY, 'x'.repeat(16 * 1024 + 1));
    h.hostListener()?.({
      source: h.frame?.contentWindow ?? null,
      data: { cw: 'draft', k: 'feedback-user-name', v: 'Mallory' },
      ports: [],
    } as never);
    h.hostListener()?.({
      source: {},
      data: { cw: 'draft', k: KEY, v: '{"t":"planted"}' },
      ports: [],
    } as never);
    expect(h.session.length).toBe(0);
  });

  it('keeps at most fifty drafts for one doc', () => {
    for (let i = 0; i < 60; i++) h.w.sessionStorage.setItem(`${KEY}#${i}`, '{}');
    expect(h.session.length).toBe(50);
  });

  it("keeps no draft that would take this page's drafts past their total, whichever doc holds them", () => {
    const session = sessionStore();
    session.setItem(`cw-frame-draft:d-other:${KEY}`, 'x'.repeat(250 * 1024));
    const next = build({ session });
    next.w.sessionStorage.setItem(KEY, 'y'.repeat(8 * 1024));
    expect(session.getItem(SHELF + KEY)).toBeNull();
    next.w.sessionStorage.setItem(KEY, 'y'.repeat(4 * 1024));
    expect(session.getItem(SHELF + KEY)).toHaveLength(4 * 1024);
    // Freeing room elsewhere is counted too: replacing the draft with a
    // shorter one leaves room for a longer one again.
    next.w.sessionStorage.setItem(KEY, '{}');
    next.w.sessionStorage.setItem(KEY, 'y'.repeat(5 * 1024));
    expect(session.getItem(SHELF + KEY)).toHaveLength(5 * 1024);
  });

  it('reads the page storage once, not again on every keystroke', () => {
    const session = sessionStore();
    const next = build({ session });
    const scan = vi.spyOn(session, 'key');
    for (let i = 0; i < 20; i++) next.w.sessionStorage.setItem(KEY, `{"t":"${'R'.repeat(i)}"}`);
    expect(scan).not.toHaveBeenCalled();
    expect(session.getItem(SHELF + KEY)).toBe(`{"t":"${'R'.repeat(19)}"}`);
  });
});
