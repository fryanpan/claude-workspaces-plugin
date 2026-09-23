/**
 * Which of a mock frame's board-bound calls the host page will make for it.
 *
 * A served mock runs in a sandboxed frame with an opaque origin, so it cannot
 * reach the board with the reader's cookie at all (`server/src/mockup-frame.ts`
 * has the whole shape). The widget inside it still needs to: read the page's
 * threads, post on them, answer the ticket items docked on this mock, record
 * voice. `mock-bridge.ts` hands each such call to the host, and this module is
 * the host's whole decision about it. Pure, so the list is tested on its own.
 *
 * Every id in the scope comes from the server's own page, never from the
 * frame, so the frame cannot choose which doc or ticket it speaks for. A call
 * that is not on the list is refused whole; nothing is rewritten into an
 * allowed shape.
 */

/** What the server told the host about this mock. */
export interface RelayScope {
  /** The board's host (`location.host` of the host page). */
  host: string;
  workspaceId: string;
  /** The mock's canonical doc id. */
  docId: string;
  /** The ticket items the server docked on this mock: `[taskId, reviewItemId]`. */
  items: ReadonlyArray<readonly [string, string]>;
}

export type RelayKind = 'fetch' | 'ws' | 'sse';

/** The mark the host puts on every relayed request (`server/src/mockup-frame.ts`). */
export const VIA_HEADER = 'x-cw-via';
export const VIA_PARAM = 'cw-via';
export const VIA_VALUE = 'mock-frame';

/** The only request headers a relayed fetch keeps from what the frame asked. */
const KEPT_HEADERS = new Set(['content-type', 'accept']);

/**
 * What the widget does to a thread on its own page. `edit-comment` and
 * `reanchor` are voice feedback's — a spoken comment's words are tidied and
 * its pin moved while the person talks — and the server lets a relayed one
 * touch only a comment or thread that was itself written from inside the mock
 * (`server/src/mockup-frame.ts`), so they reach nothing typed on the board.
 */
const THREAD_VERBS = ['comments', 'answer', 'resolve', 'reopen', 'edit-comment', 'reanchor'];

const enc = encodeURIComponent;

/**
 * The address the host should call, or null to refuse. `raw` is whatever URL
 * the frame named; it is parsed here, so `..`, a different host and an
 * encoded dot segment all land on the path they really name before the list
 * is consulted. A socket's address gets the frame's `sourceUrl` dropped (the
 * doc's source is the server's to seed, and a frame naming one would be
 * choosing it) and the via mark added.
 */
export function relayTarget(
  scope: RelayScope,
  kind: RelayKind,
  method: string,
  raw: string,
): URL | null {
  let u: URL;
  try {
    u = new URL(raw, `http://${scope.host}/`);
  } catch {
    return null;
  }
  if (u.host !== scope.host) return null;
  if (u.username || u.password) return null;
  const p = u.pathname;
  const docBase = `/workspaces/${enc(scope.workspaceId)}/docs/${enc(scope.docId)}`;
  const mockBase = `/workspaces/${enc(scope.workspaceId)}/mockups/${enc(scope.docId)}`;
  // An attached dev server's own pages, files and reload stream, when the
  // page is one (`server/src/routes/apps.ts`). Reads only, under this doc's
  // app prefix, which the server serves for an app doc and nothing else.
  const appBase = `/workspaces/${enc(scope.workspaceId)}/apps/${enc(scope.docId)}/`;
  if (kind === 'ws') {
    if (p !== `${docBase}/y` && p !== `${docBase}/voice`) return null;
    u.searchParams.delete('sourceUrl');
    u.searchParams.set(VIA_PARAM, VIA_VALUE);
    return u;
  }
  if (kind === 'sse') return p === `${docBase}/events:stream` || p.startsWith(appBase) ? u : null;
  const m = method.toUpperCase();
  if (m === 'GET' || m === 'HEAD') {
    return p === '/api/auth/session' ||
      p === mockBase ||
      p.startsWith(appBase) ||
      p.startsWith(`${docBase}/`) ||
      p.startsWith('/widget/')
      ? u
      : null;
  }
  if (m !== 'POST') return null;
  if (p === `${docBase}/threads`) return u;
  const rest = p.startsWith(`${docBase}/threads/`) ? p.slice(docBase.length + 9).split('/') : [];
  if (rest.length === 2 && rest[0] !== '' && THREAD_VERBS.includes(rest[1] ?? '')) {
    return u;
  }
  for (const [taskId, itemId] of scope.items) {
    if (
      p ===
      `/workspaces/${enc(scope.workspaceId)}/tasks/${enc(taskId)}/review-items/${enc(itemId)}/answer`
    ) {
      return u;
    }
  }
  return null;
}

/** The request headers a relayed fetch sends: the kept few, plus the mark. */
export function relayHeaders(asked: ReadonlyArray<readonly [string, string]>): [string, string][] {
  const out: [string, string][] = asked
    .filter(([k]) => KEPT_HEADERS.has(k.toLowerCase()))
    .map(([k, v]) => [k, v]);
  out.push([VIA_HEADER, VIA_VALUE]);
  return out;
}
