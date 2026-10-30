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
 * On the frame-only hostname (`server/src/frame-host.ts`) the frame has a
 * real origin of its own instead, never the board's. The calls still go
 * through the host, so the frame needs the host's origin to post to, which
 * the host names in the seed below, and every call names a path, not this
 * hostname.
 *
 * Three smaller jobs sit here because they are the frame's too:
 *
 * - Storage. An opaque origin throws on `localStorage`; the widget reads it at
 *   startup. It gets an in-memory stand-in, seeded with the reader's display
 *   name and guest id from the host (through `window.name`, which the host sets
 *   before the frame loads). Nothing written there goes back to the host — a
 *   mock that could write the reader's stored name could rename them. The one
 *   exception is the reader's unsent drafts (`draft-store.ts`): keys under
 *   `cfw:draft:` in the `sessionStorage` stand-in go to the host, which keeps
 *   them for this doc alone, and come back when the frame loads again, so a
 *   reload of the frame does not take a half-typed comment with it. On the
 *   frame-only hostname storage is real, that hostname's own, and the seed is
 *   written into it.
 * - Links. A tap on a link to another board page opens it at the top, rather
 *   than as a sandboxed page inside the mock.
 * - A direct visit to the frame's address, with nothing holding it, goes to
 *   the host page instead.
 * - A link to one thread (`?thread=`, `server/src/page-thread.ts`). The
 *   widget reads it at start, then the address drops it, and the thread's pin
 *   is tapped for the reader.
 * - The board's Comments button, in the bar the host draws above the frame.
 *   A tap there reaches the widget as a `cw-comments` event, and the comment
 *   view tells the host through `window.cwHostBar` whether it is open and
 *   whether anything is new, for the button's steady dot
 *   (`widget-page-list.ts`). What the reader has opened, under
 *   `cfw:seen:` in the storage stand-in, goes to the host like the drafts do,
 *   so a thread read once is not new again on the next load.
 *
 * Plain script, no imports: it is written into the frame's own bytes, and runs
 * before anything the mock declares. The work is `installBridge`, handed the
 * frame's window so a test can hand it a stand-in.
 */

/** The seed key the host names its own origin under (`mock-host.ts`). */
const BOARD_ORIGIN = 'cw:board-origin';

/** An http(s) origin, or null. */
function originOf(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null;
  } catch {
    return null;
  }
}

/**
 * What the host is asked to call: the path and query alone, which the host
 * resolves against the board's own hostname (`mock-relay-policy.ts`). This
 * frame may be on the frame-only hostname, whose name the board's calls never
 * carry.
 */
const pathOf = (u: URL): string => u.pathname + u.search;

export function installBridge(window: Window & typeof globalThis): void {
  const { location, document, EventTarget } = window;
  const here = new URL(location.href);
  if (window.parent === window) {
    if (here.searchParams.get('cw-frame') === '1') {
      here.searchParams.delete('cw-frame');
      location.replace(here.href);
    }
    return;
  }
  // --- Storage seed, and where the board is ---
  const seed: Record<string, string> = {};
  if (window.name.startsWith('cw-mock:')) {
    try {
      const got = JSON.parse(window.name.slice(8)) as Record<string, unknown>;
      for (const [k, v] of Object.entries(got)) if (typeof v === 'string') seed[k] = v;
    } catch {}
    window.name = '';
  }
  // The page holding this frame. On the board's hostname that is this
  // address's own origin; on the frame-only hostname (`server/src/
  // frame-host.ts`) it is another one, which the host names in the seed.
  const boardOrigin = originOf(seed[BOARD_ORIGIN]) ?? here.origin;
  delete seed[BOARD_ORIGIN];

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
  /** `told` hears every write, so the drafts can go to the host. */
  const memory = (
    m: Map<string, string>,
    told?: (k: string, v: string | null) => void,
  ): Storage => {
    const tell = (k: string, v: string | null) => told?.(k, v);
    return {
      getItem: (k: string) => m.get(String(k)) ?? null,
      setItem: (k: string, v: string) => {
        m.set(String(k), String(v));
        tell(String(k), String(v));
      },
      removeItem: (k: string) => {
        m.delete(String(k));
        tell(String(k), null);
      },
      clear: () => {
        for (const k of [...m.keys()]) tell(k, null);
        m.clear();
      },
      key: (i: number) => [...m.keys()][i] ?? null,
      get length() {
        return m.size;
      },
    };
  };
  const DRAFT = 'cfw:draft:';
  const SEEN = 'cfw:seen:';
  const session = new Map<string, string>();
  const keepDraft = (k: string, v: string | null): void => {
    if (k.startsWith(DRAFT)) window.parent.postMessage({ cw: 'draft', k, v }, boardOrigin, []);
  };
  const keepSeen = (k: string, v: string | null): void => {
    if (k.startsWith(SEEN)) window.parent.postMessage({ cw: 'seen', k, v }, boardOrigin, []);
  };
  for (const k of ['localStorage', 'sessionStorage'] as const) {
    try {
      void window[k].length;
      // Real storage — the frame-only hostname's own. The reader's name
      // still comes from the board, so the widget does not ask again.
      if (k === 'localStorage') {
        // What the reader has opened is this hostname's own to keep.
        for (const [sk, sv] of Object.entries(seed)) {
          if (!sk.startsWith(SEEN)) window.localStorage.setItem(sk, sv);
        }
      }
    } catch {
      Object.defineProperty(window, k, {
        value:
          k === 'localStorage'
            ? memory(new Map(Object.entries(seed)), keepSeen)
            : memory(session, keepDraft),
        configurable: true,
      });
      if (k === 'sessionStorage') askForDrafts();
    }
  }
  /** The drafts the host kept for this doc, into the stand-in without being
   *  sent back, then announced: the page has started by the time they come. */
  function askForDrafts(): void {
    const ch = new MessageChannel();
    window.parent.postMessage({ cw: 'drafts' }, boardOrigin, [ch.port2]);
    ch.port1.onmessage = (e) => {
      ch.port1.close();
      const got: unknown = e.data;
      if (!Array.isArray(got)) return;
      for (const pair of got) {
        const [k, v] = Array.isArray(pair) ? pair : [];
        if (typeof k === 'string' && typeof v === 'string' && k.startsWith(DRAFT))
          session.set(k, v);
      }
      window.dispatchEvent(new Event('cw-drafts'));
    };
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
        { kind: 'fetch', url: pathOf(u), method: req.method, headers: [...req.headers], body },
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
      const port = open({ kind: 'ws', url: pathOf(u) });
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
      const port = open({ kind: 'sse', url: pathOf(u) });
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

  // --- The board's Comments button ---
  (window as unknown as { cwHostBar: unknown }).cwHostBar = {
    tell: (state: { open?: unknown; fresh?: unknown }) =>
      window.parent.postMessage(
        { cw: 'comments-state', open: state.open === true, fresh: state.fresh === true },
        boardOrigin,
        [],
      ),
  };
  if (typeof window.addEventListener === 'function') {
    window.addEventListener('message', (ev) => {
      const d = ev.data as { cw?: unknown } | null;
      if (ev.source === window.parent && d?.cw === 'comments') {
        window.dispatchEvent(new Event('cw-comments'));
      }
    });
  }

  // --- A link to one thread ---
  // The widget pins a thread only where the address equals the one it was
  // made on, so `thread` has to leave the address once the widget has read it
  // (it opens a review item's dock with it), at DOMContentLoaded. A review
  // item is the dock's to open; any other thread is opened at its pin.
  const linked = here.searchParams.get('thread');
  if (linked) {
    const tap = (pin: HTMLElement): void => {
      if (pin.dataset.state === 'review') return;
      const b = pin.getBoundingClientRect();
      const at = { clientX: b.left + b.width / 2, clientY: b.top + b.height / 2 };
      pin.dispatchEvent(new MouseEvent('click', { bubbles: true, ...at }));
    };
    const settle = (): void => {
      const rest = here.search
        .replace(/^\?/, '')
        .split('&')
        .filter((part) => part !== '' && part.split('=')[0] !== 'thread');
      const query = rest.length === 0 ? '' : `?${rest.join('&')}`;
      window.history.replaceState(window.history.state, '', here.pathname + query + location.hash);
      const pinOf = () =>
        document.querySelector<HTMLElement>(`.cfw-pin[data-thread-id="${CSS.escape(linked)}"]`);
      const now = pinOf();
      if (now) {
        tap(now);
        return;
      }
      // Pins are drawn once the doc syncs, and a words anchor once edit.js has loaded.
      const watch = new MutationObserver(() => {
        const pin = pinOf();
        if (!pin) return;
        watch.disconnect();
        tap(pin);
      });
      watch.observe(document.documentElement, { childList: true, subtree: true });
      setTimeout(() => watch.disconnect(), 20_000);
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', settle, { once: true });
    } else settle();
  }

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
      // Opened at the top on the board's hostname, which is where its page is.
      if (boardOrigin !== here.origin) a.href = `${boardOrigin}${u.pathname}${u.search}${u.hash}`;
      a.target = '_top';
    },
    true,
  );
}

installBridge(window);
