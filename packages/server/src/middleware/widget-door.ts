/**
 * The tailnet widget door: the whole of what this server answers on the
 * tailnet hostname while every browser-facing hostname sits behind
 * Cloudflare Access.
 *
 * The shape of the problem (2026-09-14). An app page served on the tailnet
 * hostname embeds the widget. Under access-only that hostname classified
 * `deny`, so the bundle itself 403'd and nothing ran. The public Access host
 * was no way round it either: a cross-site script, fetch or socket carries no
 * Access cookie (Safari blocks third-party cookies, and CORS here never grants
 * credentials), so Access answers 302 before the request reaches us.
 *
 * Bryan's call is a DOOR on the tailnet hostname rather than reopening it: the
 * widget's own routes and nothing else, each behind a board-scoped widget
 * token (`wt2`, auth/widget-token.ts). The token is minted by the sign-in
 * popup, which opens on the PUBLIC host as a top-level window — the one
 * cross-site shape Safari still sends the Access cookie with — and proves the
 * person through Access before handing the token back over postMessage.
 *
 * What the door admits, and it is an allowlist: a route added to this server
 * tomorrow is 404 on the tailnet hostname by default.
 *
 * 1. `GET /widget.iife.js`, `GET /widget/mic.js` and `GET /widget/voice.js` —
 *    the bundle, the microphone it fetches at DOMContentLoaded
 *    (`widget/src/widget-mic-inject.ts`) and the voice chunk the mic fetches
 *    on its first tap. Static, and the same bytes every embed gets; the three
 *    requests that need no token, because none can carry one. The widget
 *    cannot ask for a token before it has run, and a `<script src>` sets no
 *    Authorization header at all (`widget/src/voice/voice-loader.ts`). All
 *    three are already public to a share visitor, so admitting them here
 *    widens nothing. Named one by one rather than as a `/widget/` prefix: the
 *    mock host and bridge sit in that directory too, and an allowlist that
 *    grew with the build output would not be one.
 * 2. `GET /api/auth/session` and `GET /api/auth/widget-session` — the two
 *    probes the widget makes on load. Without a token they answer the 401 that
 *    tells the widget to offer sign-in, and where to; with one they answer.
 * 3. One doc's comment routes and its two sockets, under the board the token
 *    names: `threads` (read and post), a thread's `comments`, `answer`,
 *    `resolve`, `reopen`, `edit-comment` and `reanchor`, and `y`.
 * 4. The same doc's voice feedback: the `voice` socket the recorder streams
 *    into, and one recording, `voice-feedback/seg-<N>.wav`. The recordings
 *    are the speaker's own voice, so they keep the board token every other
 *    route here asks for — which is why the widget fetches a clip rather
 *    than handing its URL to an `<audio>`, an element that sends no header.
 *    The log beside them, `voice-feedback.md`, is NOT on the door: no widget
 *    code reads it.
 *
 * A pure predicate so it can be unit-tested without a server, and exercised
 * again at the HTTP layer in `widget-door-http.test.ts`.
 */
import { safeDecodeSegment } from '../workspace-path.ts';

/** What one door request addresses, or null for everything the door refuses. */
export type WidgetDoorRoute =
  | { kind: 'bundle' }
  | { kind: 'probe' }
  | { kind: 'doc'; workspaceId: string; docId: string };

const PROBES: ReadonlySet<string> = new Set(['/api/auth/session', '/api/auth/widget-session']);

/** The widget's own static bytes: the bundle, and the chunk it fetches. */
const SCRIPTS: ReadonlySet<string> = new Set([
  '/widget.iife.js',
  '/widget/mic.js',
  '/widget/voice.js',
]);

/** The thread verbs the widget posts, and nothing a doc page does beyond them.
 *  `edit-comment` and `reanchor` are the two a SPOKEN comment adds: the words
 *  are rewritten as the speaker keeps talking, and the note follows the
 *  element it is about (`widget/src/voice/voice-post.ts`). */
const THREAD_VERBS = '(?:comments|answer|resolve|reopen|edit-comment|reanchor)';

/** One recording, spelled as `clipPath` writes it and `voiceSegmentPath`
 *  re-reads it (`voice-feedback-store.ts`). Matched here as well as there so
 *  a name that is not a recording is refused at the door rather than deeper
 *  in. */
const CLIP = String.raw`voice-feedback/seg-\d{1,6}\.wav`;

/** The parts of a doc a GET addresses: its two sockets, and one recording. */
const DOC_GET = `(?:y|voice|${CLIP})`;

const DOC_ROUTE = new RegExp(
  `^/workspaces/([^/]+)/docs/([^/]+)/(?:(${DOC_GET})|(threads)|threads/[^/]+/${THREAD_VERBS})$`,
);

/**
 * The route a door request addresses, or null.
 *
 * Methods are named per route. A socket and a recording are GETs (an upgrade
 * is one), the thread list is a GET or a POST, and every thread verb is a
 * POST; anything else — a DELETE, a PUT, a HEAD — is refused rather than
 * guessed at.
 */
export function widgetDoorRoute(pathname: string, method: string): WidgetDoorRoute | null {
  if (method === 'GET' && SCRIPTS.has(pathname)) return { kind: 'bundle' };
  if (method === 'GET' && PROBES.has(pathname)) return { kind: 'probe' };
  const m = pathname.match(DOC_ROUTE);
  if (!m) return null;
  const [, rawWorkspace, rawDoc, getOnly, threads] = m;
  const allowed = getOnly
    ? method === 'GET'
    : threads
      ? method === 'GET' || method === 'POST'
      : method === 'POST';
  if (!allowed) return null;
  return {
    kind: 'doc',
    workspaceId: safeDecodeSegment(rawWorkspace ?? ''),
    docId: safeDecodeSegment(rawDoc ?? ''),
  };
}

/**
 * Is `origin` a page served on one of the door's hostnames?
 *
 * The mint's allowlist for a board token, derived rather than configured: the
 * tailnet hostname resolves to THIS machine, so a page on it — on any port,
 * over either scheme — is served by a process on the box, which is inside the
 * trust boundary already. The same reasoning the local origin policy uses for
 * this machine's own names (middleware/browser-origin.ts).
 *
 * Exact on everything the browser writes into an Origin: an http(s) scheme,
 * an exact hostname (no suffix matching — `<tailnet-host>.evil.example` is
 * not it) and no path, query or credentials, because a real Origin never
 * carries them and anything that does was typed by a caller.
 */
export function isWidgetDoorOrigin(origin: string, doorHosts: readonly string[]): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (url.origin !== origin) return false;
  const host = url.hostname.toLowerCase();
  return doorHosts.some((h) => h !== '' && h.toLowerCase() === host);
}

/**
 * The widget token a websocket handshake carries in `Sec-WebSocket-Protocol`,
 * or null.
 *
 * A browser cannot set `Authorization` on a WebSocket, so the widget offers
 * its token as the one subprotocol it asks for. Only a value shaped like ours
 * (`wt1.` / `wt2.`) is read; any other protocol belongs to somebody else and
 * stays invisible, exactly as `widgetBearerOf` ignores a foreign bearer.
 */
export function widgetTokenFromProtocols(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(',')) {
    const value = part.trim();
    if (/^wt[12]\.\S+$/.test(value)) return value;
  }
  return null;
}

/**
 * The refusal a door request without a usable token gets.
 *
 * Spelled as the write gate's `sign_in_required` on purpose, plus the one
 * thing the widget cannot know on its own: WHERE to sign in. The widget reads
 * `signInToWrite` off the load probe and `sign_in_required` off a refused
 * post, and both already turn into the sign-in offer, so the door needs no new
 * vocabulary for "a person has to sign in first".
 */
export function widgetDoorSignInBody(signInOrigin: string | null): Record<string, unknown> {
  return {
    error: 'sign_in_required',
    signInToWrite: true,
    ...(signInOrigin ? { signInOrigin } : {}),
  };
}
