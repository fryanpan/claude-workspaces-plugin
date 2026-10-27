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
 * So the frame fetches nothing from the board by itself: the bridge, the
 * widget, the live-update script and any board script or stylesheet the mock
 * names are written into the frame's own bytes (`injectFrameScripts`), and
 * the rest — voice feedback's script, a round's page — comes through the
 * host. The host, a normal top-level page, loads its script by URL.
 */
import { existsSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { WriteVia } from '@claude-workspaces/core';
import { MOCK_FRAME_PARAM } from '@claude-workspaces/core/page-thread-link';
import { FRAME_TICKET_PARAM } from './frame-ticket.ts';
import { isWithinRoot } from './safe-path.ts';

/** The query parameter that asks for the mock itself rather than its host. */
export { MOCK_FRAME_PARAM };

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

/**
 * The sandbox on the frame-only hostname (`frame-host.ts`): the same flags
 * plus `allow-same-origin`, which there grants the FRAME hostname's origin —
 * never the board's, which is a different hostname.
 */
export const FRAME_HOST_SANDBOX = `${MOCK_FRAME_SANDBOX} allow-same-origin`;

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
  const rest = searchWithoutFrameParam(url.search);
  return rest === '' ? `?${MOCK_FRAME_PARAM}=1` : `${rest}&${MOCK_FRAME_PARAM}=1`;
}

/**
 * `search` with every frame flag and frame ticket removed and every other
 * byte as the browser sent it. Re-serialising through `URLSearchParams` would re-encode the rest
 * (`,` becomes `%2C`, a bare `a` becomes `a=`), and a page that keeps its
 * state in the query reads its own string back.
 */
export function searchWithoutFrameParam(search: string): string {
  const parts = search
    .replace(/^\?/, '')
    .split('&')
    .filter((part) => {
      const name = queryParamName(part);
      return part !== '' && name !== MOCK_FRAME_PARAM && name !== FRAME_TICKET_PARAM;
    });
  return parts.length === 0 ? '' : `?${parts.join('&')}`;
}

/**
 * One `name=value` pair's name, decoded exactly as `URLSearchParams` decodes
 * it (`+` as a space, `%2D` as `-`). The ticket is READ through
 * `URLSearchParams`, so it must be REMOVED by the same reading: compared raw,
 * `cw%2Dft=<ticket>` is redeemed and still kept in the address.
 */
export function queryParamName(part: string): string {
  return new URLSearchParams(part).keys().next().value ?? '';
}

const escapeAttr = (v: string): string =>
  v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const TITLE = /<title[^>]*>([\s\S]*?)<\/title\s*>/i;

/** A ticket item the host may answer on the reader's behalf. */
export interface HostItem {
  taskId: string;
  reviewItemId: string;
}

/** The visitor's way back to the board: a fixed pill over the frame. */
const BOARD_LINK = (workspaceId: string): { style: string; anchor: string } => ({
  style:
    '.cw-board-link{position:fixed;top:8px;left:8px;z-index:2147483646;padding:4px 10px;' +
    'border-radius:999px;border:1px solid rgba(0,0,0,.14);background:rgba(255,255,255,.94);' +
    'color:#1f2328;font:500 13px/18px system-ui,-apple-system,sans-serif;text-decoration:none;' +
    'box-shadow:0 1px 3px rgba(0,0,0,.12)}',
  anchor:
    `<a class="cw-board-link" href="/workspaces/${escapeAttr(encodeURIComponent(workspaceId))}"` +
    ' aria-label="Back to the board">← Board</a>',
});

/**
 * The host page. It draws one frame the size of the window — and, for a
 * share visitor only, one link over it back to the board the mock is filed
 * on: a reader who arrived on a mock or a dev server from a share link had no
 * way to the board but the address bar. The owner's page draws nothing of
 * its own, so the link never sits over the owner's mock; it loads the
 * coach's card (`coachHref`), which the sandboxed frame cannot show, and the
 * card stops itself for anyone but the owner. Its script builds
 * the frame, so it can hand the frame the reader's display name before the
 * widget inside reads it (see `mock-host.ts`).
 */
export function renderMockHost(args: {
  workspaceId: string;
  docId: string;
  /** The mock's own bytes, read only for its `<title>`. */
  html: string;
  url: URL;
  items: HostItem[];
  /** A share visitor, admitted by the gate; draws the link to the board. */
  visitor: boolean;
  /** The coach card's script, on every page but a share visitor's. */
  coachHref?: string;
  /**
   * The frame-only hostname (`frame-host.ts`), when this page frames its
   * attachment there: the frame's address is the same path on that origin
   * with the board's frame ticket, and its sandbox adds `allow-same-origin`,
   * which there grants the frame hostname's origin and never the board's.
   * Unset, the frame is the opaque same-host one.
   */
  frame?: { origin: string; ticket: string } | null;
}): string {
  const title = TITLE.exec(args.html)?.[1]?.trim() ?? '';
  const boardLink = args.visitor ? BOARD_LINK(args.workspaceId) : { style: '', anchor: '' };
  const items = JSON.stringify(args.items.map((i) => [i.taskId, i.reviewItemId]));
  const sandbox = args.frame ? FRAME_HOST_SANDBOX : MOCK_FRAME_SANDBOX;
  const src = args.frame
    ? `${args.frame.origin}${args.url.pathname}${frameSrcFor(args.url)}` +
      `&${FRAME_TICKET_PARAM}=${encodeURIComponent(args.frame.ticket)}`
    : frameSrcFor(args.url);
  const coach =
    args.coachHref && !args.visitor
      ? `<script type="module" src="${escapeAttr(args.coachHref)}" data-coach-page` +
        ` data-workspace-id="${escapeAttr(args.workspaceId)}" data-doc-id="${escapeAttr(args.docId)}"></script>`
      : '';
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    // `<` escaped: a browser ends <title> at `</title/>` or `</title x>`,
    // which TITLE does not stop at, and this page is unsandboxed on the
    // board's origin. Entities in the mock's title still read as written.
    `<title>${title.replace(/</g, '&lt;')}</title>` +
    '<style>html,body{margin:0;height:100%;overflow:hidden;background:#fff}' +
    `iframe{border:0;width:100%;height:100%;display:block}${boardLink.style}</style></head><body>` +
    boardLink.anchor +
    `<iframe data-cw-mock-frame sandbox="${sandbox}" allow="microphone"` +
    ` title="${escapeAttr(title || 'Mock')}" data-src="${escapeAttr(src)}"></iframe>` +
    `<script src="/widget/mock-host.js" data-workspace-id="${escapeAttr(args.workspaceId)}"` +
    ` data-doc-id="${escapeAttr(args.docId)}" data-items="${escapeAttr(items)}"></script>` +
    coach +
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

/** One attribute's value off a tag, quoted either way or bare. */
function attrOf(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3] ?? '') : null;
}

/** The widget's bundles at the root, by the file each one serves. */
const ROOT_WIDGET_FILES: Record<string, string> = {
  '/widget.iife.js': 'widget.iife.js',
  '/widget.js': 'widget.esm.js',
  '/widget.esm.js': 'widget.esm.js',
};

/**
 * The built file a board address names, when it is one this server serves
 * from a build and it is on the page's own host: `/app/…` from the app,
 * `/widget/…` and the root widget bundles from the widget. `ext` is the one
 * extension asked for. A path that decodes out of its build is not a file.
 */
function boardAssetOf(
  href: string,
  page: URL,
  ext: '.js' | '.css',
  roots: { app: string | null; widget: string | null },
): { file: string; widget: boolean } | null {
  let u: URL;
  try {
    u = new URL(href, page);
  } catch {
    return null;
  }
  if (u.host !== page.host || !u.pathname.endsWith(ext)) return null;
  const root = ROOT_WIDGET_FILES[u.pathname];
  if (root && roots.widget) return { file: join(roots.widget, root), widget: true };
  const under = u.pathname.startsWith('/app/')
    ? { dir: roots.app, rest: u.pathname.slice('/app/'.length), widget: false }
    : u.pathname.startsWith('/widget/')
      ? { dir: roots.widget, rest: u.pathname.slice('/widget/'.length), widget: true }
      : null;
  if (!under?.dir) return null;
  let file: string;
  try {
    file = join(under.dir, decodeURIComponent(under.rest));
  } catch {
    return null;
  }
  return isWithinRoot(under.dir, file) ? { file, widget: under.widget } : null;
}

function readText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * A script element with its body, or a link tag, in one pass: a script's body
 * is consumed whole, so a tag written inside a script's text is never read as
 * one, and nothing written into the page is read again.
 */
const TAG = /<script\b((?:[^>"']|"[^"]*"|'[^']*')*)>[\s\S]*?<\/script\s*>|<link\b[^>]*>/gi;
const SRC_ATTR = /\ssrc\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i;
/** A module that loads others beside it by relative path: `import "./x.js"`, `import("./x.js")`. */
const RELATIVE_IMPORT = /(?:\bfrom|\bimport)\s*\(?\s*["'`]\.\.?\//;

/**
 * The frame's HTML with nothing left for it to fetch from the board: the
 * bridge first in the head, and every script and stylesheet the page names on
 * this board written into the page itself.
 *
 * The frame's own requests carry no cookie (see "Why the frame's scripts are
 * inlined" above), so behind Cloudflare Access or a share session each one
 * comes back a sign-in redirect. A `<script src>` for the widget, a
 * `/widget/…` script or an `/app/…` script on this host becomes the same
 * element with its bytes in place of its `src`, keeping every other attribute
 * (`type="module"` and the live script's `data-*` included). The widget's own
 * get `data-feedback-widget`, the marker a round swap keeps rather than
 * re-runs (`packages/widget/src/mockup-live.ts`). An `/app/` stylesheet link
 * becomes a `<style>`, keeping its `media`.
 *
 * What stays a tag, and so fails behind a sign-in: anything on another host,
 * a file that is not in the build, and an `/app/` module that imports files
 * beside it by relative path — inlined, those imports would resolve against
 * the mock's address instead. The board's split bundles are the only such
 * files, and a mock has no use for them. Images and fonts are not touched.
 * Without either build the page goes out as it came, still sandboxed by the
 * policy header its caller sets.
 */
export function injectFrameScripts(
  html: string,
  page: URL,
  widgetDist: string | null,
  appDist: string | null,
): string {
  const roots = { app: appDist, widget: widgetDist };
  let out = html;
  const bridge = readAsset(widgetDist, 'mock-bridge.js');
  if (bridge !== null) {
    const tag = `<script data-feedback-widget>${inlineSafe(bridge)}</script>`;
    out = HEAD_OPEN.test(out) ? out.replace(HEAD_OPEN, (m) => `${m}${tag}`) : `${tag}${out}`;
  }
  return out.replace(TAG, (tag, attrs: string | undefined) =>
    attrs === undefined
      ? inlineStylesheet(tag, page, appDist)
      : inlineScript(tag, attrs, page, roots),
  );
}

function inlineScript(
  tag: string,
  attrs: string,
  page: URL,
  roots: { app: string | null; widget: string | null },
): string {
  const src = attrOf(`${attrs}>`, 'src');
  const asset = src === null ? null : boardAssetOf(src, page, '.js', roots);
  const js = asset ? readText(asset.file) : null;
  if (!asset || js === null) return tag;
  if (!asset.widget && RELATIVE_IMPORT.test(js)) return tag;
  const kept = attrs.replace(SRC_ATTR, '');
  const mark =
    asset.widget && !/\sdata-feedback-widget\b/i.test(kept) ? ' data-feedback-widget' : '';
  return `<script${mark}${kept}>${inlineSafe(js)}</script>`;
}

function inlineStylesheet(tag: string, page: URL, appDist: string | null): string {
  const rel = attrOf(tag, 'rel');
  const href = attrOf(tag, 'href');
  if (!rel || !href || !/(?:^|\s)stylesheet(?:\s|$)/i.test(rel)) return tag;
  const asset = boardAssetOf(href, page, '.css', { app: appDist, widget: null });
  const css = asset ? readText(asset.file) : null;
  if (!asset || css === null) return tag;
  const media = attrOf(tag, 'media');
  return (
    `<style data-cw-inlined="${escapeAttr(new URL(href, page).pathname)}"${media ? ` media="${escapeAttr(media)}"` : ''}>` +
    `${css.replace(/<\/style/gi, '<\\/style')}</style>`
  );
}
