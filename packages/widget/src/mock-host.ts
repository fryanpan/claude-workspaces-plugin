/**
 * The page that holds a served mock's sandboxed frame, and the only thing that
 * makes a board call for it.
 *
 * `server/src/mockup-frame.ts` renders this page with one empty iframe and
 * this script, whose data attributes name the workspace, the doc and the
 * ticket items docked on it — ids the server resolved, so the frame has no say
 * in them. The script:
 *
 * 1. hands the frame the reader's display name and guest id through
 *    `window.name`, then loads it. The frame's storage is in memory (an opaque
 *    origin has none), and without this every mock visit would ask a known
 *    reader to name themselves again. One-way: nothing comes back.
 * 2. answers the bridge's relay requests (`mock-bridge.ts`) — only from that
 *    frame, only for calls `mock-relay-policy.ts` allows, with the reader's
 *    cookie, keeping only `content-type` and `accept` from what was asked, and
 *    stamping every one so the server records the write as sent from inside
 *    the mock.
 * 3. holds the microphone for voice feedback on the mock, which the frame's
 *    opaque origin cannot open (`mock-host-mic.ts`). The frame asks for it and
 *    lets go of it over its voice socket; the audio goes from here to the
 *    server and never into the frame.
 */
import { createHostMic, tapConfirmed } from './mock-host-mic.ts';
import { type RelayScope, relayHeaders, relayTarget } from './mock-relay-policy.ts';
import type { PcmCaptureOpts, PcmCaptureStart } from './voice/voice-audio.ts';
import { micRefusal, startPcmCapture } from './voice/voice-audio.ts';

/** The keys the frame's widget reads its identity from (`core/src/identity.ts`). */
const SEEDED_KEYS = [
  'feedback-user-name',
  'feedback-anon-id',
  'feedback-name-prompt-dismissed',
  'cfw:showResolved',
];

const REFUSED = new TextEncoder().encode('{"error":"mock_relay_refused"}').buffer;

/** What the host reaches for on the page: the window's own, handed in so a test can stand in. */
export interface HostEnv {
  script: HTMLScriptElement | null;
  placeholder: HTMLIFrameElement | null;
  location: { host: string; protocol: string };
  storage: () => Pick<Storage, 'getItem'>;
  fetch: (path: string, init: RequestInit) => Promise<Response>;
  WebSocket: new (url: string) => WebSocket;
  EventSource: new (url: string) => EventSource;
  onMessage: (fn: (ev: MessageEvent) => void) => void;
  activated: () => boolean;
  startCapture: (opts: PcmCaptureOpts) => Promise<PcmCaptureStart>;
}

export function hostMock(env: HostEnv): void {
  const { script, placeholder, location } = env;
  if (!script || !placeholder) return;
  let items: [string, string][] = [];
  try {
    items = JSON.parse(script.dataset.items ?? '[]');
  } catch {}
  const scope: RelayScope = {
    host: location.host,
    workspaceId: script.dataset.workspaceId ?? '',
    docId: script.dataset.docId ?? '',
    items,
  };

  const seed: Record<string, string> = {};
  for (const k of SEEDED_KEYS) {
    try {
      const v = env.storage().getItem(k);
      if (v !== null) seed[k] = v;
    } catch {}
  }
  // A browsing context takes its name when it is made: renaming the server's
  // iframe now would leave the frame's `window.name` empty. So the frame that
  // loads is a copy, named before it joins the page.
  const frame = placeholder.cloneNode(false) as HTMLIFrameElement;
  frame.name = `cw-mock:${JSON.stringify(seed)}`;
  // The server wrote the page's query into the src; the fragment never
  // reaches a server, so it is added here, where the page can read it.
  frame.src = `${placeholder.dataset.src ?? '?cw-frame=1'}${location.hash}`;
  placeholder.replaceWith(frame);

  const wsBase = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;

  env.onMessage((ev) => {
    if (ev.source !== frame.contentWindow) return;
    const m = ev.data as {
      cw?: string;
      kind?: string;
      url?: string;
      method?: string;
      headers?: [string, string][];
      body?: ArrayBuffer | null;
    };
    const port = ev.ports[0];
    if (!port || m?.cw !== 'relay' || typeof m.url !== 'string') return;

    if (m.kind === 'fetch') {
      const method = typeof m.method === 'string' ? m.method.toUpperCase() : 'GET';
      const u = relayTarget(scope, 'fetch', method, m.url);
      if (!u) {
        port.postMessage({
          status: 403,
          headers: [['content-type', 'application/json']],
          body: REFUSED.slice(0),
        });
        return;
      }
      env
        .fetch(u.pathname + u.search, {
          method,
          headers: relayHeaders(Array.isArray(m.headers) ? m.headers : []),
          body: method === 'GET' || method === 'HEAD' ? undefined : (m.body ?? undefined),
          credentials: 'same-origin',
        })
        .then(async (r) => {
          const body = await r.arrayBuffer();
          port.postMessage({ status: r.status, headers: [...r.headers], body }, [body]);
        })
        .catch((err: unknown) => port.postMessage({ error: String(err) }));
      return;
    }

    if (m.kind === 'ws') {
      const u = relayTarget(scope, 'ws', 'GET', m.url);
      if (!u) {
        port.postMessage({ t: 'close', code: 1008, reason: 'mock_relay_refused' });
        return;
      }
      const sock = new env.WebSocket(`${wsBase}${u.pathname}${u.search}`);
      sock.binaryType = 'arraybuffer';
      // Only the voice socket carries a microphone (`mock-host-mic.ts`).
      const mic = u.pathname.endsWith('/voice')
        ? createHostMic({
            send: (pcm) => sock.readyState === 1 && sock.send(pcm),
            reply: (msg) => port.postMessage(msg),
            startCapture: env.startCapture,
            activated: env.activated,
            refusal: micRefusal({ name: 'NotAllowedError' }),
          })
        : null;
      sock.onopen = () => port.postMessage({ t: 'open' });
      sock.onmessage = (x) => {
        mic?.serverSaid(x.data);
        port.postMessage({ t: 'msg', data: x.data }, x.data instanceof ArrayBuffer ? [x.data] : []);
      };
      sock.onerror = () => port.postMessage({ t: 'error' });
      sock.onclose = (x) => {
        mic?.close();
        port.postMessage({ t: 'close', code: x.code, reason: x.reason });
        port.close();
      };
      port.onmessage = (x) => {
        const d = x.data as { t: string; on?: unknown; data?: string | ArrayBuffer | Blob };
        if (d.t === 'mic') mic?.ask(d.on === true);
        else if (d.t === 'send' && sock.readyState === 1 && d.data !== undefined) {
          if (mic && !mic.passes(d.data)) return;
          sock.send(d.data);
        }
        // The frame's close code is not passed on: a browser throws on most
        // of them, and the server has nothing to learn from it.
        else if (d.t === 'close') {
          mic?.close();
          sock.close();
        }
      };
      return;
    }

    if (m.kind === 'sse') {
      const u = relayTarget(scope, 'sse', 'GET', m.url);
      if (!u) {
        port.postMessage({ t: 'error' });
        return;
      }
      const es = new env.EventSource(u.pathname + u.search);
      const forward = (x: MessageEvent) =>
        port.postMessage({ t: 'ev', type: x.type, data: x.data, lastEventId: x.lastEventId });
      const heard = new Set<string>();
      es.onopen = () => port.postMessage({ t: 'open' });
      es.onerror = () => port.postMessage({ t: 'error' });
      es.onmessage = forward;
      port.onmessage = (x) => {
        const d = x.data as { t: string; type?: unknown };
        if (d.t === 'listen' && typeof d.type === 'string' && !heard.has(d.type)) {
          heard.add(d.type);
          es.addEventListener(d.type, forward as EventListener);
        } else if (d.t === 'close') {
          es.close();
          port.close();
        }
      };
    }
  });
}

hostMock({
  script: document.currentScript as HTMLScriptElement | null,
  placeholder: document.querySelector<HTMLIFrameElement>('iframe[data-cw-mock-frame]'),
  location: window.location,
  storage: () => window.localStorage,
  fetch: (input, init) => window.fetch(input, init),
  WebSocket: window.WebSocket,
  EventSource: window.EventSource,
  onMessage: (fn) => window.addEventListener('message', fn),
  activated: () => tapConfirmed(navigator),
  startCapture: startPcmCapture,
});
