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
import { type HostEnv, hostMock } from '../src/mock-host.ts';

const BOARD = 'http://harborlight.test';
const MOCK = '/workspaces/w-harbor/mockups/d-moorings';
const THREADS = '/workspaces/w-harbor/docs/d-moorings/threads';

/**
 * An event target that calls only its listeners, as a browser's does — happy-dom's
 * also calls a matching `on<type>` property, which would fire the bridge's
 * handlers twice.
 */
class PlainTarget {
  private readonly heard = new Map<string, EventListenerOrEventListenerObject[]>();
  addEventListener(type: string, fn: EventListenerOrEventListenerObject | null) {
    if (fn) this.heard.set(type, [...(this.heard.get(type) ?? []), fn]);
  }
  dispatchEvent(ev: Event): boolean {
    for (const fn of this.heard.get(ev.type) ?? []) {
      if (typeof fn === 'function') fn.call(this, ev);
      else fn.handleEvent(ev);
    }
    return true;
  }
}

class HostSocket {
  static made: HostSocket[] = [];
  readyState = 0;
  binaryType = 'blob';
  sent: unknown[] = [];
  closed = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  constructor(readonly url: string) {
    HostSocket.made.push(this);
  }
  send(d: unknown) {
    this.sent.push(d);
  }
  close() {
    this.closed += 1;
  }
}

class HostStream {
  static made: HostStream[] = [];
  heard = new Map<string, (e: MessageEvent) => void>();
  closed = 0;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  constructor(readonly url: string) {
    HostStream.made.push(this);
  }
  addEventListener(type: string, fn: (e: MessageEvent) => void) {
    this.heard.set(type, fn);
  }
  close() {
    this.closed += 1;
  }
}

/** A stand-in for whatever the frame's own window would reach off the board. */
class NativeSocket {
  constructor(readonly url: string) {}
}

function build(opts: { activated?: boolean } = {}) {
  HostSocket.made = [];
  HostStream.made = [];
  document.body.innerHTML = '';
  const placeholder = document.createElement('iframe');
  placeholder.setAttribute('data-cw-mock-frame', '');
  placeholder.dataset.src = '?v=2&cw-frame=1';
  const script = document.createElement('script');
  script.dataset.workspaceId = 'w-harbor';
  script.dataset.docId = 'd-moorings';
  script.dataset.items = JSON.stringify([['t-berths', 'r-rates']]);
  document.body.append(placeholder, script);

  const hostFetch = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response('{"ok":true}', { status: 201, headers: { 'content-type': 'application/json' } }),
  );
  const captures: Array<{ stops: number }> = [];
  let hostListener: ((ev: MessageEvent) => void) | null = null;
  const env: HostEnv = {
    script,
    placeholder,
    location: { host: 'harborlight.test', protocol: 'http:' },
    storage: () => ({
      getItem: (k: string) => (k === 'feedback-user-name' ? 'Riverbend Reviewer' : null),
    }),
    fetch: hostFetch as unknown as typeof fetch,
    WebSocket: HostSocket as unknown as HostEnv['WebSocket'],
    EventSource: HostStream as unknown as HostEnv['EventSource'],
    onMessage: (fn) => {
      hostListener = fn;
    },
    activated: () => opts.activated ?? true,
    startCapture: async () => {
      const c = { stops: 0 };
      captures.push(c);
      return { ok: true, capture: { stop: () => void (c.stops += 1) } };
    },
  };
  hostMock(env);
  const frame = document.querySelector<HTMLIFrameElement>('iframe[data-cw-mock-frame]');

  const nativeFetch = vi.fn(async () => new Response('elsewhere'));
  const replace = vi.fn();
  const throwing = () => {
    throw new DOMException('opaque origin', 'SecurityError');
  };
  const win = {
    name: frame?.name ?? '',
    location: Object.assign(new URL(`${BOARD}${MOCK}?cw-frame=1`), { replace }),
    document,
    fetch: nativeFetch,
    WebSocket: NativeSocket,
    EventSource: NativeSocket,
    EventTarget: PlainTarget,
    parent: {
      postMessage: (data: unknown, _origin: string, transfer: MessagePort[]) =>
        hostListener?.({ source: frame?.contentWindow ?? null, data, ports: transfer } as never),
    },
  } as Record<string, unknown>;
  Object.defineProperty(win, 'localStorage', { get: throwing, configurable: true });
  Object.defineProperty(win, 'sessionStorage', { get: throwing, configurable: true });
  installBridge(win as unknown as Window & typeof globalThis);
  const w = win as unknown as Window & typeof globalThis;
  return { w, frame, hostFetch, nativeFetch, replace, captures, hostListener: () => hostListener };
}

// The host sets the frame's address; happy-dom would go and load it.
const happy = (
  window as unknown as { happyDOM?: { settings: { navigation: Record<string, boolean> } } }
).happyDOM;
if (happy) happy.settings.navigation.disableChildFrameNavigation = true;

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
    expect(h.w.localStorage.getItem('feedback-user-name')).toBe('Riverbend Reviewer');
    expect(h.w.name).toBe('');
    h.w.localStorage.setItem('cfw:showResolved', '1');
    expect([h.w.localStorage.length, h.w.localStorage.key(1)]).toEqual([2, 'cfw:showResolved']);
    h.w.localStorage.removeItem('cfw:showResolved');
    h.w.localStorage.clear();
    expect(h.w.localStorage.getItem('feedback-user-name')).toBeNull();
    expect(h.w.sessionStorage.length).toBe(0);
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
