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
 * 4. keeps the reader's unsent drafts across a reload of the frame
 *    (`draft-store.ts`) in this page's own `sessionStorage`, filed under the
 *    doc the server named, and hands them back when the frame asks. Only
 *    draft keys, only this doc's, and each one capped: the frame's scripts
 *    can write here, and the most they can reach is this doc's drafts.
 * 5. runs the Comments button in the board's bar above the frame: a tap
 *    opens or closes the comment view inside it, and the view says back
 *    whether it is open and whether anything is new, which the button shows
 *    as pressed and as a steady dot. It also keeps what the reader has
 *    opened (`cfw:seen:<doc>`, `comment-seen-store.ts`) in this page's
 *    `localStorage`, for this doc's key alone and capped, and seeds it into
 *    the next load.
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

/** The keys a frame may keep here (`draft-store.ts`), and how much of them:
 *  16K chars a draft, 50 a doc, and 256K chars across every doc's drafts on
 *  this page, so a frame cannot fill the page's ~5MB of storage. */
const DRAFT = 'cfw:draft:';
const DRAFT_KEY_MAX = 2048;
const DRAFT_VALUE_MAX = 16 * 1024;
const DRAFTS_PER_DOC = 50;
const DRAFTS_TOTAL_MAX = 256 * 1024;
const SHELVES = 'cw-frame-draft:';
/** The one seen record a frame may keep here, and its size. */
const SEEN = 'cfw:seen:';
const SEEN_MAX = 64 * 1024;

/** What the host reaches for on the page: the window's own, handed in so a test can stand in. */
export interface HostEnv {
  script: HTMLScriptElement | null;
  placeholder: HTMLIFrameElement | null;
  location: { host: string; protocol: string; hash?: string };
  storage: () => Pick<Storage, 'getItem'>;
  /** Where the seen record is written: the page's own `localStorage`. */
  keep?: () => Pick<Storage, 'setItem' | 'removeItem'>;
  /** The Comments button in the bar above the frame, when the page drew one. */
  bar?: HTMLElement | null;
  /** Where the frame's drafts are kept: the page's own `sessionStorage`. */
  session: () => Storage;
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
  const seenKey = `${SEEN}${scope.docId}`;
  for (const k of [...SEEDED_KEYS, seenKey]) {
    try {
      const v = env.storage().getItem(k);
      if (v !== null) seed[k] = v;
    } catch {}
  }
  // A browsing context takes its name when it is made: renaming the server's
  // iframe now would leave the frame's `window.name` empty. So the frame that
  // loads is a copy, named before it joins the page.
  const frame = placeholder.cloneNode(false) as HTMLIFrameElement;
  // And where this page is: a frame on the frame-only hostname
  // (`server/src/frame-host.ts`) has an origin of its own, and posts to this
  // one by name.
  seed['cw:board-origin'] = `${location.protocol}//${location.host}`;
  frame.name = `cw-mock:${JSON.stringify(seed)}`;
  // The server wrote the page's query into the src; the fragment never
  // reaches a server, so it is added here, where the page can read it.
  frame.src = `${placeholder.dataset.src ?? '?cw-frame=1'}${location.hash ?? ''}`;
  placeholder.replaceWith(frame);

  const wsBase = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;

  // The frame's drafts, filed under this doc in the page's own session. Read
  // once here and kept in step, so a keystroke costs one write, not a scan.
  const shelf = `${SHELVES}${scope.docId}:`;
  const mine = new Map<string, string>();
  let total = 0;
  try {
    const s = env.session();
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      const v = k?.startsWith(SHELVES) ? s.getItem(k) : null;
      if (!k || v === null) continue;
      total += v.length;
      if (k.startsWith(shelf)) mine.set(k.slice(shelf.length), v);
    }
  } catch {}
  const keepDraft = (k: unknown, v: unknown): void => {
    if (typeof k !== 'string' || !k.startsWith(DRAFT) || k.length > DRAFT_KEY_MAX) return;
    const had = mine.get(k);
    const rest = total - (had?.length ?? 0);
    try {
      if (v === null) {
        env.session().removeItem(shelf + k);
        mine.delete(k);
        total = rest;
      } else if (
        typeof v === 'string' &&
        v.length <= DRAFT_VALUE_MAX &&
        rest + v.length <= DRAFTS_TOTAL_MAX &&
        (had !== undefined || mine.size < DRAFTS_PER_DOC)
      ) {
        env.session().setItem(shelf + k, v);
        mine.set(k, v);
        total = rest + v.length;
      }
    } catch {}
  };

  const keepSeen = (k: unknown, v: unknown): void => {
    if (k !== seenKey || !env.keep) return;
    try {
      if (v === null) env.keep().removeItem(k);
      else if (typeof v === 'string' && v.length <= SEEN_MAX) env.keep().setItem(k, v);
    } catch {}
  };
  const bar = env.bar ?? null;
  const barState = (st: { open?: unknown; fresh?: unknown }): void => {
    if (!bar) return;
    bar.setAttribute('aria-pressed', String(st.open === true));
    const dot = bar.querySelector<HTMLElement>('[data-cw-new]');
    if (dot) dot.hidden = st.fresh !== true;
  };
  // The frame's origin is opaque, or the frame hostname's: either way the
  // message names no secret, so it is posted to whatever the frame holds.
  bar?.addEventListener('click', () => frame.contentWindow?.postMessage({ cw: 'comments' }, '*'));

  env.onMessage((ev) => {
    if (ev.source !== frame.contentWindow) return;
    const m = ev.data as {
      cw?: string;
      kind?: string;
      url?: string;
      method?: string;
      headers?: [string, string][];
      body?: ArrayBuffer | null;
      k?: unknown;
      v?: unknown;
    };
    const port = ev.ports[0];
    if (m?.cw === 'draft') return keepDraft(m.k, m.v);
    if (m?.cw === 'seen') return keepSeen(m.k, m.v);
    if (m?.cw === 'comments-state') return barState(m as { open?: unknown; fresh?: unknown });
    if (m?.cw === 'drafts') return port?.postMessage([...mine]);
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

/** How long the frame may take to load before the report says it never did:
 *  the app's `PAGE_LOAD_DEADLINE_MS`, so "never arrived" means the same. */
const LOAD_DEADLINE_MS = 15_000;

/**
 * The mock page's load report: one per page load, its content stamp the
 * frame's `load` event. The shape is the app's (`page-load-report.ts` in
 * workspaces-app), written out here because this bundle cannot import the
 * app; the server judges it like every other page's (`slow-load-alarm.ts`).
 */
export function reportMockLoad(
  frame: HTMLIFrameElement | null,
  workspaceId: string,
  post: (path: string, init: RequestInit) => Promise<Response>,
): void {
  if (!frame || !workspaceId) return;
  const msToBoot = Math.round(performance.now());
  let sent = false;
  const send = (msToContent: number | null): void => {
    if (sent) return;
    sent = true;
    clearTimeout(deadline);
    post(`/workspaces/${encodeURIComponent(workspaceId)}/load-reports`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({
        page: 'mock',
        msToBoot,
        ...(msToContent === null ? {} : { msToContent }),
      }),
    }).catch(() => {});
  };
  const deadline = setTimeout(() => send(null), LOAD_DEADLINE_MS);
  frame.addEventListener('load', () => send(Math.round(performance.now())), { once: true });
}

const hostScript = document.currentScript as HTMLScriptElement | null;
hostMock({
  script: hostScript,
  placeholder: document.querySelector<HTMLIFrameElement>('iframe[data-cw-mock-frame]'),
  location: window.location,
  storage: () => window.localStorage,
  keep: () => window.localStorage,
  bar: document.querySelector<HTMLElement>('[data-cw-comments]'),
  session: () => window.sessionStorage,
  fetch: (input, init) => window.fetch(input, init),
  WebSocket: window.WebSocket,
  EventSource: window.EventSource,
  onMessage: (fn) => window.addEventListener('message', fn),
  activated: () => tapConfirmed(navigator),
  startCapture: startPcmCapture,
});
reportMockLoad(
  document.querySelector<HTMLIFrameElement>('iframe[data-cw-mock-frame]'),
  hostScript?.dataset.workspaceId ?? '',
  (path, init) => window.fetch(path, init),
);
