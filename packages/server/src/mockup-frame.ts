/**
 * A served mock runs in a sandboxed frame, and speaks to the board only
 * through the page that holds the frame.
 *
 * ── Why ──
 *
 * A mock is somebody's own HTML, usually agent-written, and it used to be
 * served on the board's origin beside the reader's session. Its scripts could
 * therefore do anything the reader could: post on another doc, answer another
 * ticket, open another doc's live socket. Measured on staging before this
 * existed, a mock planted six threads on a different doc, every one attributed
 * to the signed-in reader.
 *
 * ── The shape ──
 *
 * `/workspaces/<ws>/mockups/<id>` answers a small HOST page. It holds one
 * full-size iframe of the same address plus `?cw-frame=1`, and that FRAME
 * response carries `Content-Security-Policy: sandbox …`, so the mock gets an
 * opaque origin whether it is framed or visited directly. A browser sends
 * `Origin: null` from an opaque origin, and the server already refuses every
 * write and every socket carrying that (`browser-origin.ts`,
 * `routes/upgrade-stream.ts`). The widget inside the frame keeps working
 * because a bridge (`packages/widget/src/mock-bridge.ts`, injected first)
 * hands its board-bound fetch, WebSocket and EventSource calls to the host
 * (`mock-host.ts`), and the host makes only this mock's own calls
 * (`mock-relay-policy.ts`), with the reader's cookie.
 *
 * ── The stamp ──
 *
 * The host adds `x-cw-via: mock-frame` to every request it relays, and
 * `cw-via=mock-frame` to every socket it opens. The frame cannot set or strip
 * either: it cannot reach the server with credentials except through the host
 * (its own Origin is null), and the host builds the request itself, keeping
 * only `content-type` and `accept` from what the frame asked for. A page on
 * the board's own origin COULD send the header — but such a page is already
 * the reader's, and all it can do with the mark is make its own write look
 * less trustworthy. That asymmetry is why an advisory mark needs no signature.
 *
 * ── Why the frame's scripts are inlined ──
 *
 * Chrome does not send a SameSite=Lax cookie on a subresource request from an
 * opaque-origin frame (measured headless: the frame document carried the
 * cookie, its `<script src>` and `<img>` did not). Every cookie that gets a
 * browser past Cloudflare Access or a share session is Lax, so a frame that
 * loaded the widget by URL would get a sign-in redirect instead of a script.
 * The bridge, the widget and the live-update script are therefore written
 * into the frame's own bytes; the host, a normal top-level page, loads its
 * script by URL.
 */
import { existsSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { WriteVia } from '@claude-workspaces/core';
import { isWithinRoot } from './safe-path.ts';

/** The query parameter that asks for the mock itself rather than its host. */
export const MOCK_FRAME_PARAM = 'cw-frame';

/** The frame, not the host: `?cw-frame=1` and nothing else. */
export function isMockFrameRequest(url: URL): boolean {
  return url.searchParams.get(MOCK_FRAME_PARAM) === '1';
}

/**
 * What the mock may still do. Scripts, forms, `alert` and friends, popups
 * (which inherit the sandbox), and navigating the top page on a tap — which is
 * how a board link inside a mock opens the board. Never `allow-same-origin`:
 * that one flag would hand the mock the board's origin back.
 */
export const MOCK_FRAME_SANDBOX =
  'allow-scripts allow-forms allow-popups allow-modals allow-top-navigation-by-user-activation';

/** The frame response's policy: sandboxed, and framed only by the board. */
export const MOCK_FRAME_CSP = `sandbox ${MOCK_FRAME_SANDBOX}; frame-ancestors 'self'`;

/**
 * A served FILE that is not a mock page — a non-HTML mock, a mounted file's
 * bytes — gets a bare sandbox: no scripts at all. An SVG carries script and
 * renders as a document when opened by address, which is the same class of
 * bug as the mock page.
 *
 * Not for PDF: Chrome refuses to render a sandboxed PDF, and a PDF's script
 * runs in the viewer rather than on this origin.
 */
export function fileSandboxHeaders(path: string): Record<string, string> {
  if (extname(path).toLowerCase() === '.pdf') return {};
  return { 'content-security-policy': 'sandbox' };
}

/** `resp` with `extra` set on its headers — a served file's own response. */
export function withHeaders(resp: Response, extra: Record<string, string>): Response {
  for (const [k, v] of Object.entries(extra)) resp.headers.set(k, v);
  return resp;
}

/** The header the host sets on every request it relays out of the frame. */
export const WRITE_VIA_HEADER = 'x-cw-via';
/** The same mark on a socket, which cannot carry a header from a browser. */
export const WRITE_VIA_SOCKET_PARAM = 'cw-via';

/** The mark on a relayed request, or none. Only the one known value counts. */
export function writeViaOf(req: Request): WriteVia | undefined {
  return req.headers.get(WRITE_VIA_HEADER) === 'mock-frame' ? 'mock-frame' : undefined;
}

/** The mark on a relayed socket's address, or none. */
export function socketViaOf(url: URL): WriteVia | undefined {
  return url.searchParams.get(WRITE_VIA_SOCKET_PARAM) === 'mock-frame' ? 'mock-frame' : undefined;
}

/**
 * Whether a write may change `written` — a comment's words, or a thread's
 * anchor through its first comment. A relayed edit reaches only what was
 * itself written from inside the mock: voice feedback tidies and re-pins its
 * own comments there, and a mock's script must not rewrite words someone
 * typed on the board. Any other write is judged as it always was.
 */
export function mayTouchFrom(
  via: WriteVia | undefined,
  written: { via?: WriteVia } | undefined,
): boolean {
  return via === undefined || written?.via === 'mock-frame';
}

/** The frame's address, relative: the page's own query with the frame flag on. */
export function frameSrcFor(url: URL): string {
  const q = new URLSearchParams(url.search);
  q.delete(MOCK_FRAME_PARAM);
  q.set(MOCK_FRAME_PARAM, '1');
  return `?${q.toString()}`;
}

const escapeAttr = (v: string): string =>
  v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const TITLE = /<title[^>]*>([\s\S]*?)<\/title\s*>/i;

/** A ticket item the host may answer on the reader's behalf. */
export interface HostItem {
  taskId: string;
  reviewItemId: string;
}

/**
 * The host page. It draws nothing of its own — one frame the size of the
 * window — and its script builds the frame, so it can hand the frame the
 * reader's display name before the widget inside reads it (see
 * `mock-host.ts`).
 */
export function renderMockHost(args: {
  workspaceId: string;
  docId: string;
  /** The mock's own bytes, read only for its `<title>`. */
  html: string;
  url: URL;
  items: HostItem[];
}): string {
  const title = TITLE.exec(args.html)?.[1]?.trim() ?? '';
  const items = JSON.stringify(args.items.map((i) => [i.taskId, i.reviewItemId]));
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<title>${title}</title>` +
    '<style>html,body{margin:0;height:100%;overflow:hidden;background:#fff}' +
    'iframe{border:0;width:100%;height:100%;display:block}</style></head><body>' +
    `<iframe data-cw-mock-frame sandbox="${MOCK_FRAME_SANDBOX}" allow="microphone"` +
    ` title="${escapeAttr(title || 'Mock')}" data-src="${escapeAttr(frameSrcFor(args.url))}"></iframe>` +
    `<script src="/widget/mock-host.js" data-workspace-id="${escapeAttr(args.workspaceId)}"` +
    ` data-doc-id="${escapeAttr(args.docId)}" data-items="${escapeAttr(items)}"></script>` +
    '</body></html>'
  );
}

/** Headers for the host page. It names bundle URLs, so it is never stored. */
export const MOCK_HOST_HEADERS: Record<string, string> = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  // The host is the board's own page and is framed by nobody.
  'content-security-policy': "frame-ancestors 'self'",
};

/**
 * A script's bytes, safe inside an inline `<script>`: nothing in them may end
 * the element early or switch the parser into its escaped states.
 */
function inlineSafe(js: string): string {
  return js.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
}

/** The bytes of one built widget asset, or null when that bundle is not built. */
function readAsset(widgetDist: string | null, file: string): string | null {
  if (!widgetDist) return null;
  const p = join(widgetDist, file);
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
}

const HEAD_OPEN = /<head\b[^>]*>/i;
const WIDGET_TAG = '<script src="/widget.iife.js"></script>';
const LIVE_TAG =
  /<script src="\/widget\/mockup-live\.js"((?: data-[a-z-]+(?:="[^"]*")?)*)><\/script>/;

/**
 * The frame's HTML: the bridge first in the head, and the widget and
 * live-update tags the server wrote replaced by their bytes. The inlined tags
 * carry `data-feedback-widget`, the marker a round swap keeps rather than
 * re-running (`packages/widget/src/mockup-live.ts`). A tag the mock wrote for
 * itself is left as it is. Without a built bundle the page goes out unchanged
 * apart from the policy header its caller sets, which still sandboxes it.
 */
export function injectFrameScripts(html: string, widgetDist: string | null): string {
  let out = html;
  const bridge = readAsset(widgetDist, 'mock-bridge.js');
  if (bridge !== null) {
    const tag = `<script data-feedback-widget>${inlineSafe(bridge)}</script>`;
    out = HEAD_OPEN.test(out) ? out.replace(HEAD_OPEN, (m) => `${m}${tag}`) : `${tag}${out}`;
  }
  const widget = readAsset(widgetDist, 'widget.iife.js');
  if (widget !== null && out.includes(WIDGET_TAG)) {
    out = out.replace(
      WIDGET_TAG,
      () => `<script data-feedback-widget>${inlineSafe(widget)}</script>`,
    );
  }
  const live = readAsset(widgetDist, 'mockup-live.js');
  if (live !== null) {
    out = out.replace(
      LIVE_TAG,
      (_m, attrs: string) => `<script data-feedback-widget${attrs}>${inlineSafe(live)}</script>`,
    );
  }
  return out;
}

const LINK_TAG = /<link\b[^>]*>/gi;

/** One attribute's value off a tag, quoted either way or bare. */
function attrOf(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3] ?? '') : null;
}

/**
 * The board's own stylesheets a mock links, written into the frame.
 *
 * A mock of a change to an existing surface starts from that surface's markup
 * and stylesheets, so it links `/app/…css`. The frame's request for that file
 * carries no cookie (see "Why the frame's scripts are inlined" above), and
 * behind Access or a share session it comes back a sign-in page rather than
 * CSS: the mock renders unstyled. The server reads those files itself, from
 * the built app it already serves to anyone who can open the mock, and puts
 * them in the page. Only `/app/` stylesheets on this host: anything else a
 * mock links is left as it wrote it, and a path that climbs out of the built
 * app is not read.
 */
export function inlineBoardStylesheets(html: string, page: URL, appDist: string | null): string {
  if (!appDist) return html;
  return html.replace(LINK_TAG, (tag) => {
    const rel = attrOf(tag, 'rel');
    const href = attrOf(tag, 'href');
    if (!rel || !href || !/(?:^|\s)stylesheet(?:\s|$)/i.test(rel)) return tag;
    let u: URL;
    try {
      u = new URL(href, page);
    } catch {
      return tag;
    }
    if (u.host !== page.host || !u.pathname.startsWith('/app/') || !u.pathname.endsWith('.css')) {
      return tag;
    }
    let file: string;
    try {
      file = join(appDist, decodeURIComponent(u.pathname.slice('/app/'.length)));
    } catch {
      return tag;
    }
    if (!isWithinRoot(appDist, file)) return tag;
    let css: string;
    try {
      css = readFileSync(file, 'utf8');
    } catch {
      return tag;
    }
    const media = attrOf(tag, 'media');
    return (
      `<style data-cw-inlined="${escapeAttr(u.pathname)}"${media ? ` media="${escapeAttr(media)}"` : ''}>` +
      `${css.replace(/<\/style/gi, '<\\/style')}</style>`
    );
  });
}
