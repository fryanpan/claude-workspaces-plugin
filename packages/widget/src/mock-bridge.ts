/**
 * The first script in a served mock's frame: it hands the widget's board-bound
 * calls to the page holding the frame.
 *
 * The frame is sandboxed with an opaque origin (`server/src/mockup-frame.ts`),
 * so a call it makes itself reaches the board without the reader's session and
 * with `Origin: null`, and every write is refused. That is the point for the
 * mock's own scripts; the widget inside the same frame still has to read and
 * post. So `fetch`, `WebSocket` and `EventSource` aimed at this board go to the
 * host over a `MessageChannel`, and the host decides (`mock-relay-policy.ts`).
 * A mock's script can use this bridge exactly as the widget does, which is why
 * the host allows only this mock's own calls and stamps every one.
 *
 * Three smaller jobs sit here because they are the frame's too:
 *
 * - Storage. An opaque origin throws on `localStorage`; the widget reads it at
 *   startup. It gets an in-memory stand-in, seeded with the reader's display
 *   name and guest id from the host (through `window.name`, which the host sets
 *   before the frame loads). Nothing written here goes back to the host — a
 *   mock that could write the reader's stored name could rename them.
 * - Links. A tap on a link to another board page opens it at the top, rather
 *   than as a sandboxed page inside the mock.
 * - A direct visit to the frame's address, with nothing holding it, goes to
 *   the host page instead.
 *
 * Plain script, no imports: it is written into the frame's own bytes, and runs
 * before anything the mock declares.
 */

(() => {
  const here = new URL(location.href);
  if (window.parent === window) {
    if (here.searchParams.get('cw-frame') === '1') {
      here.searchParams.delete('cw-frame');
      location.replace(here.href);
    }
    return;
  }
  const boardOrigin = here.origin;

  /** A URL on this board, or null for anywhere else. */
  const onBoard = (raw: string | URL): URL | null => {
    try {
      const u = new URL(String(raw), location.href);
      return u.host === here.host ? u : null;
    } catch {
      return null;
    }
  };

  /** One call's private line to the host. */
  const open = (msg: Record<string, unknown>, transfer: Transferable[] = []): MessagePort => {
    const ch = new MessageChannel();
    window.parent.postMessage({ cw: 'relay', ...msg }, boardOrigin, [ch.port2, ...transfer]);
    return ch.port1;
  };

  // --- Storage ---
  const seed: Record<string, string> = {};
  if (window.name.startsWith('cw-mock:')) {
    try {
      const got = JSON.parse(window.name.slice(8)) as Record<string, unknown>;
      for (const [k, v] of Object.entries(got)) if (typeof v === 'string') seed[k] = v;
    } catch {}
    window.name = '';
  }
  const memory = (init: Record<string, string>): Storage => {
    const m = new Map(Object.entries(init));
    return {
      getItem: (k: string) => m.get(String(k)) ?? null,
      setItem: (k: string, v: string) => void m.set(String(k), String(v)),
      removeItem: (k: string) => void m.delete(String(k)),
      clear: () => m.clear(),
      key: (i: number) => [...m.keys()][i] ?? null,
      get length() {
        return m.size;
      },
    };
  };
  for (const k of ['localStorage', 'sessionStorage'] as const) {
    try {
      void window[k].length;
    } catch {
      Object.defineProperty(window, k, {
        value: memory(k === 'localStorage' ? seed : {}),
        configurable: true,
      });
    }
  }

  // --- fetch ---
  const nativeFetch = window.fetch.bind(window);
  const relayFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    const u = onBoard(req.url);
    if (!u) return nativeFetch(input, init);
    const body = req.method === 'GET' || req.method === 'HEAD' ? null : await req.arrayBuffer();
    return new Promise((resolve, reject) => {
      const port = open(
        { kind: 'fetch', url: u.href, method: req.method, headers: [...req.headers], body },
        body ? [body] : [],
      );
      port.onmessage = (e) => {
        const d = e.data as {
          error?: string;
          status: number;
          headers: [string, string][];
          body: ArrayBuffer | null;
        };
        port.close();
        if (d.error) return reject(new TypeError(d.error));
        const empty = req.method === 'HEAD' || [204, 205, 304].includes(d.status);
        resolve(new Response(empty ? null : d.body, { status: d.status, headers: d.headers }));
      };
    });
  };
  window.fetch = relayFetch as typeof fetch;

  /** Fire an event the way a native socket does: listeners, then `on<type>`. */
  const emit = (target: EventTarget, ev: Event): void => {
    target.dispatchEvent(ev);
    const h = (target as unknown as Record<string, unknown>)[`on${ev.type}`];
    if (typeof h === 'function') h.call(target, ev);
  };

  // --- WebSocket ---
  const NativeWS = window.WebSocket;
  class RelayWS extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    url = '';
    readyState = 0;
    binaryType: BinaryType = 'blob';
    protocol = '';
    extensions = '';
    bufferedAmount = 0;
    private port: MessagePort | null = null;
    constructor(url: string | URL, protocols?: string | string[]) {
      super();
      const u = onBoard(String(url).replace(/^ws/, 'http'));
      // biome-ignore lint/correctness/noConstructorReturn: a socket to anywhere else is the real one
      if (!u) return new NativeWS(url, protocols) as unknown as RelayWS;
      this.url = String(url);
      const port = open({ kind: 'ws', url: u.href });
      this.port = port;
      port.onmessage = (e) => {
        const d = e.data as { t: string; data?: unknown; code?: number; reason?: string };
        if (d.t === 'open') {
          this.readyState = 1;
          emit(this, new Event('open'));
        } else if (d.t === 'msg') {
          const data =
            d.data instanceof ArrayBuffer && this.binaryType === 'blob'
              ? new Blob([d.data])
              : d.data;
          emit(this, new MessageEvent('message', { data }));
        } else if (d.t === 'error') {
          emit(this, new Event('error'));
        } else if (d.t === 'mic') {
          const m = d as { heard?: boolean; ok?: boolean; message?: string };
          if (m.heard) this.onHeard?.();
          else {
            this.micAnswer?.({ ok: m.ok === true, ...(m.message ? { message: m.message } : {}) });
            this.micAnswer = null;
          }
        } else if (d.t === 'close') {
          this.readyState = 3;
          emit(this, new CloseEvent('close', { code: d.code, reason: d.reason }));
          this.micAnswer?.({ ok: false, message: '' });
          this.micAnswer = null;
          port.close();
        }
      };
    }
    private micAnswer: ((r: { ok: boolean; message?: string }) => void) | null = null;
    private onHeard: (() => void) | null = null;
    /**
     * Voice feedback's microphone, which the page around the mock holds: this
     * frame cannot have one (`widget/src/mock-host-mic.ts`). The audio goes
     * from there straight into this socket; `heard` is told of the first
     * frame, and nothing else of the audio comes here.
     */
    cwMic(on: boolean, heard?: () => void): Promise<{ ok: boolean; message?: string }> {
      if (!on) {
        this.onHeard = null;
        this.port?.postMessage({ t: 'mic', on: false });
        return Promise.resolve({ ok: true });
      }
      return new Promise((resolve) => {
        this.micAnswer = resolve;
        this.onHeard = heard ?? null;
        this.port?.postMessage({ t: 'mic', on: true });
      });
    }
    send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
      if (this.readyState !== 1) throw new DOMException('not open', 'InvalidStateError');
      const out = ArrayBuffer.isView(data)
        ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
        : data;
      this.port?.postMessage({ t: 'send', data: out });
    }
    close(code?: number, reason?: string): void {
      if (this.readyState >= 2) return;
      this.readyState = 2;
      this.port?.postMessage({ t: 'close', code, reason });
    }
  }
  Object.assign(RelayWS.prototype, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  window.WebSocket = RelayWS as unknown as typeof WebSocket;

  // --- EventSource ---
  const NativeES = window.EventSource;
  class RelayES extends EventTarget {
    url = '';
    readyState = 0;
    withCredentials = false;
    private port: MessagePort | null = null;
    constructor(url: string | URL, opts?: EventSourceInit) {
      super();
      const u = onBoard(url);
      // biome-ignore lint/correctness/noConstructorReturn: a stream from anywhere else is the real one
      if (!u) return new NativeES(url, opts) as unknown as RelayES;
      this.url = u.href;
      const port = open({ kind: 'sse', url: u.href });
      this.port = port;
      port.onmessage = (e) => {
        const d = e.data as { t: string; type?: string; data?: string; lastEventId?: string };
        if (d.t === 'open') {
          this.readyState = 1;
          emit(this, new Event('open'));
        } else if (d.t === 'error') {
          emit(this, new Event('error'));
        } else if (d.t === 'ev' && d.type) {
          emit(this, new MessageEvent(d.type, { data: d.data, lastEventId: d.lastEventId }));
        }
      };
    }
    override addEventListener(
      type: string,
      fn: EventListenerOrEventListenerObject | null,
      o?: boolean | AddEventListenerOptions,
    ): void {
      super.addEventListener(type, fn, o);
      if (type !== 'open' && type !== 'error' && type !== 'message') {
        this.port?.postMessage({ t: 'listen', type });
      }
    }
    close(): void {
      this.readyState = 2;
      this.port?.postMessage({ t: 'close' });
    }
  }
  window.EventSource = RelayES as unknown as typeof EventSource;

  // --- Links ---
  // Capture phase, before the default action, so the tap that follows the
  // link is still the user activation the sandbox asks for to move the top.
  document.addEventListener(
    'click',
    (ev) => {
      const a = ev
        .composedPath()
        .find((n): n is HTMLAnchorElement => n instanceof HTMLAnchorElement && !!n.href);
      if (!a) return;
      const u = onBoard(a.href);
      if (!u || (a.target && a.target !== '_self')) return;
      if (u.pathname === here.pathname) {
        // The mock itself: an in-page anchor stays as it is, and another
        // query on the mock stays in the frame, as the frame.
        if (u.search === here.search) return;
        u.searchParams.set('cw-frame', '1');
        a.href = u.href;
        return;
      }
      a.target = '_top';
    },
    true,
  );
})();
