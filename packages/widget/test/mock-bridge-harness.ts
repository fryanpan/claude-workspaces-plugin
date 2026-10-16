/**
 * The two ends of a served mock's line to the board, joined as the browser
 * joins them, for the bridge tests: `build()` installs the host on a page and
 * the bridge in a stand-in frame window, and returns what each end was asked.
 * The host's own fetch, sockets and microphone are stand-ins that record it.
 */
import { vi } from 'vitest';
import { installBridge } from '../src/mock-bridge.ts';
import { type HostEnv, hostMock } from '../src/mock-host.ts';

export const BOARD = 'http://harborlight.test';
export const MOCK = '/workspaces/w-harbor/mockups/d-moorings';
export const THREADS = '/workspaces/w-harbor/docs/d-moorings/threads';

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

export class HostSocket {
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

export class HostStream {
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
export class NativeSocket {
  constructor(readonly url: string) {}
}

/** The host page's own `sessionStorage`, which outlives the frame's reloads. */
export function sessionStore(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  };
}

export function build(
  opts: {
    activated?: boolean;
    hash?: string;
    session?: Storage;
    /** The frame is on the frame-only hostname, with real storage of its own. */
    frameOrigin?: string;
    frameStorage?: Storage;
  } = {},
) {
  const session = opts.session ?? sessionStore();
  const announced: string[] = [];
  const postedTo: string[] = [];
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
    location: { host: 'harborlight.test', protocol: 'http:', hash: opts.hash ?? '' },
    storage: () => ({
      getItem: (k: string) => (k === 'feedback-user-name' ? 'Sample Reader' : null),
    }),
    session: () => session,
    fetch: hostFetch as unknown as HostEnv['fetch'],
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
    location: Object.assign(new URL(`${opts.frameOrigin ?? BOARD}${MOCK}?cw-frame=1`), { replace }),
    document,
    fetch: nativeFetch,
    WebSocket: NativeSocket,
    EventSource: NativeSocket,
    EventTarget: PlainTarget,
    dispatchEvent: (ev: Event) => announced.push(ev.type) > 0,
    parent: {
      postMessage: (data: unknown, origin: string, transfer: MessagePort[]) => {
        postedTo.push(origin);
        hostListener?.({ source: frame?.contentWindow ?? null, data, ports: transfer } as never);
      },
    },
  } as Record<string, unknown>;
  if (opts.frameStorage) {
    const own = opts.frameStorage;
    const ownSession = sessionStore();
    Object.defineProperty(win, 'localStorage', { get: () => own, configurable: true });
    Object.defineProperty(win, 'sessionStorage', { get: () => ownSession, configurable: true });
  } else {
    Object.defineProperty(win, 'localStorage', { get: throwing, configurable: true });
    Object.defineProperty(win, 'sessionStorage', { get: throwing, configurable: true });
  }
  installBridge(win as unknown as Window & typeof globalThis);
  const w = win as unknown as Window & typeof globalThis;
  return {
    w,
    frame,
    hostFetch,
    nativeFetch,
    replace,
    captures,
    session,
    announced,
    postedTo,
    hostListener: () => hostListener,
  };
}

// The host sets the frame's address; happy-dom would go and load it.
const happy = (
  window as unknown as { happyDOM?: { settings: { navigation: Record<string, boolean> } } }
).happyDOM;
if (happy) happy.settings.navigation.disableChildFrameNavigation = true;
