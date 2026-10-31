/**
 * A framed page's folder as a small static site: the HTML a `::html{src="…"}`
 * line frames, and the scripts, stylesheets and data beside it
 * (`routes/doc-files.ts` is the route; `doc-file-scope.ts` decides which
 * folder a doc may serve; `core/src/board-embeds.ts` is the directive).
 *
 * ── What may be read ──
 *
 * `readDocFile` is the one reader. A file is served only when every one of
 * these holds, each checked before the bytes are read:
 *
 *  - it sits under the serving folder (`doc-file-scope.ts`), as asked for and
 *    where a symlink lands;
 *  - its extension is on `DOC_FILE_TYPES`, both as asked for and where a
 *    symlink lands;
 *  - no segment starts with a dot or is `node_modules`, as asked for or as
 *    resolved, so `.env`, `.git/config` and a link named `data.json` that
 *    points at `.env` are all refused;
 *  - git lists it, and the file a link lands on, under the serving folder
 *    (`doc-file-listing.ts`): a gitignored file and a credential-shaped name
 *    are refused, and outside a git work tree nothing is listed;
 *  - its real path sits under the real path of the serving folder, judged
 *    again on the open descriptor (`landsInside`), so a link swapped in after
 *    the check reads nothing outside and nothing dot-led;
 *  - a walled lead's guard, where one covers the folder, admits it.
 *
 * ── Why the frame's scripts and styles are written into the page ──
 *
 * The page runs in a sandboxed frame with an opaque origin, the shape every
 * mock and app door has (`mockup-frame.ts`), so it cannot script the board.
 * A browser sends no Lax cookie on a subresource request from such a frame,
 * and every cookie that gets a request past Cloudflare Access or a share
 * session is Lax. So over the tunnel a `<script src>` in the frame would come
 * back a sign-in page. The frame document itself does carry the cookie, so
 * `frameHtml` writes each relative script in as a `data:` URL (which keeps
 * `defer`, `async` and `type="module"` meaning what they did) and each
 * relative stylesheet in as a `<style>` element. Each distinct file is read
 * once, one at a time, every occurrence counts toward the page's size, and a
 * page past `PAGE_MAX` is refused as soon as it passes, rather than built.
 *
 * A `fetch` has the same problem and an extra one: from an opaque origin it
 * is a cross-origin request, and this server sends no CORS grant to
 * `Origin: null`. So the first script in the page (`FETCH_RELAY`) hands a GET
 * for a path under the PAGE'S OWN folder to the doc page holding the frame,
 * which fetches it with the reader's session and passes back the status, type
 * and bytes (`workspaces-app/src/doc/board-embed-frames.ts`). The doc page
 * fetches only under that folder's address, so the relay reaches nothing the
 * frame's own address could not. It also answers only an ask carrying the
 * key it put in the frame address's fragment (`#cw-relay=`), which the relay
 * reads and removes before any of the page's own scripts run: a link in the
 * page that navigates the frame to another site leaves that site in the same
 * window, sandboxed and with the same opaque origin, and the key is what it
 * does not have. A fragment is never sent in a request or a Referer.
 *
 * ── The page's own policy ──
 *
 * `DOC_PAGE_CSP` keeps the mock frame's sandbox and adds a fetch policy:
 * scripts and styles only as written into the page, images and fonts only
 * from this server or inline, and no `connect-src` at all, so a page cannot
 * send what it read anywhere. The relay is a `postMessage`, which no fetch
 * directive governs.
 *
 * Not covered: an `<img>`, a CSS `url()` or a module's own `import` loads
 * from the frame directly, and every answer here is
 * `Cross-Origin-Resource-Policy: same-origin`, which an opaque frame's
 * request is not; so those do not load. Write them in or relay them.
 */
import { realpathSync } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { extname, join, sep } from 'node:path';
import { GuardRefused, readBytesChecked } from './bound-path-guard.ts';
import { isGitListed } from './doc-file-listing.ts';
import { resolveInside } from './doc-image-store.ts';
import { MOCK_FRAME_SANDBOX } from './mockup-frame.ts';
import { realPathUnder } from './safe-path.ts';
import { boundFiles } from './slow-fs.ts';

/** The extensions served from a doc's folder, and the type each goes out as. */
export const DOC_FILE_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};

/** The most one served file reads into memory. */
export const DOC_FILE_MAX = 16 * 1024 * 1024;
/** The most a built page may weigh, its written-in files included. */
export const PAGE_MAX = 32 * 1024 * 1024;

/** A framed page's policy; see the header. */
export const DOC_PAGE_CSP =
  `sandbox ${MOCK_FRAME_SANDBOX}; frame-ancestors 'self'; default-src 'none'; ` +
  "script-src 'unsafe-inline' data:; style-src 'unsafe-inline'; " +
  "img-src 'self' data: blob:; font-src 'self' data:; connect-src 'none'";

export const docFileType = (name: string): string | undefined =>
  DOC_FILE_TYPES[extname(name).toLowerCase()];

export type DocFileRead =
  | { ok: true; bytes: Uint8Array<ArrayBuffer>; st: BigIntStats; type: string; abs: string }
  | { ok: false; status: 404 | 413 | 415 };

/** A segment no reader is given: a dotfile or dot folder, or `node_modules`. */
const hidden = (segs: string[]): boolean =>
  segs.some((s) => s.startsWith('.') || s === 'node_modules');

/**
 * The judgement made of the open descriptor's real path: under `realRoot`,
 * nothing hidden on the way down, the same type as was asked for, and
 * admitted by `guard` where one covers it.
 */
export function landsInside(
  realRoot: string,
  type: string,
  guard: ((real: string) => boolean) | null,
): (real: string) => boolean {
  return (real) => {
    if (!real.startsWith(`${realRoot}${sep}`)) return false;
    if (hidden(real.slice(realRoot.length + 1).split(sep))) return false;
    if (docFileType(real) !== type) return false;
    return guard === null || guard(real);
  };
}

/**
 * One file under `dir`, the doc's folder, read only when every rule in the
 * header holds. `folder` is the serving folder's segments under `dir`, and
 * `segments` must sit beneath it.
 */
export async function readDocFile(
  dir: string,
  folder: string[],
  segments: string[],
): Promise<DocFileRead> {
  const type = docFileType(segments[segments.length - 1] ?? '');
  if (!type) return { ok: false, status: 415 };
  const inFolder = segments.length > folder.length && folder.every((s, i) => segments[i] === s);
  if (!inFolder || hidden(segments)) return { ok: false, status: 404 };
  const root = join(dir, ...folder);
  let guard: ((real: string) => boolean) | null;
  try {
    guard = boundFiles.guards.landsFor(join(dir, ...segments));
  } catch {
    return { ok: false, status: 404 };
  }
  const abs = resolveInside(root, segments.slice(folder.length));
  if (!abs) return { ok: false, status: 404 };
  const rel = realPathUnder(root, abs);
  if (rel === null || rel === '' || hidden(rel.split('/'))) return { ok: false, status: 404 };
  // Asked again of where a link LANDS: `data.json -> notes.txt` is not JSON.
  if (docFileType(abs) !== type) return { ok: false, status: 415 };
  // Git must list both the name asked for and the file a link lands on.
  const asked = segments.join('/');
  const landed = [...folder, rel].join('/');
  if (!(await isGitListed(dir, folder, asked))) return { ok: false, status: 404 };
  if (landed !== asked && !(await isGitListed(dir, folder, landed))) {
    return { ok: false, status: 404 };
  }
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return { ok: false, status: 404 };
  }
  // The serving folder itself may be a link; it must still land in the doc's.
  const folderRel = realPathUnder(dir, realRoot);
  if (folderRel === null || hidden(folderRel.split('/').filter(Boolean))) {
    return { ok: false, status: 404 };
  }
  try {
    const got = await readBytesChecked(abs, DOC_FILE_MAX, landsInside(realRoot, type, guard));
    if (got === 'too-large') return { ok: false, status: 413 };
    return { ok: true, bytes: got.bytes, st: got.st, type, abs };
  } catch (err) {
    if (err instanceof GuardRefused || (err as NodeJS.ErrnoException).code) {
      return { ok: false, status: 404 };
    }
    throw err;
  }
}

/**
 * A reference in the page, resolved against the page's own folder, as
 * segments under the doc's folder; null for anything absolute, anything with
 * a scheme, and anything that climbs above the doc's folder.
 */
export function resolveRef(pageDir: string[], ref: string): string[] | null {
  const path = ref.trim().split(/[?#]/)[0] ?? '';
  if (path === '' || /^[a-z][a-z0-9+.-]*:/i.test(path) || /^[/\\]/.test(path)) return null;
  if (path.includes('\\')) return null;
  const out = [...pageDir];
  for (const raw of path.split('/')) {
    let seg: string;
    try {
      seg = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    if (seg.includes('/') || seg.includes('\0')) return null;
    out.push(seg);
  }
  return out.length > 0 ? out : null;
}

/** Hands a GET under the page's folder to the doc page; see the header. */
const FETCH_RELAY = (base: string): string =>
  `(function(){var B=${JSON.stringify(base).replace(/</g, '\\u003c')};` +
  'var F=window.fetch&&window.fetch.bind(window);if(!F||window.parent===window)return;' +
  'var K=(location.hash.match(/[#&]cw-relay=([A-Za-z0-9-]+)/)||[])[1]||"";' +
  'if(K){try{history.replaceState(history.state,"",location.pathname+location.search)}catch(e){}}' +
  'function rel(i){try{var r=typeof i==="string"?i:i instanceof URL?i.href:i&&i.url;' +
  'var u=new URL(r,location.href);if(u.host!==location.host||u.pathname.indexOf(B)!==0)return null;' +
  'return u.pathname.slice(B.length)+u.search}catch(e){return null}}' +
  'window.fetch=function(i,o){var m=String((o&&o.method)||(i&&i.method)||"GET").toUpperCase();' +
  'var p=m==="GET"?rel(i):null;if(p===null)return F(i,o);' +
  'return new Promise(function(ok,no){var c=new MessageChannel();c.port1.onmessage=function(e){' +
  'var d=e.data;c.port1.close();if(!d||d.error){no(new TypeError("Failed to fetch"));return}' +
  'var empty=d.status===204||d.status===304;ok(new Response(empty?null:d.body,' +
  '{status:d.status,headers:{"content-type":d.type||""}}))};' +
  'window.parent.postMessage({type:"cw-file-fetch",path:p,key:K},"*",[c.port2])})}})();';

const ATTR = (name: string) =>
  new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i');

function attr(tag: string, name: string): string | undefined {
  const m = tag.match(ATTR(name));
  return m ? (m[1] ?? m[2] ?? m[3]) : undefined;
}

const SCRIPT_SRC = /<script\b([^>]*?)\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')([^>]*)>\s*<\/script\s*>/gi;
const LINK = /<link\b[^>]*>/gi;

/** The page's first script goes first in its head, never before a doctype. */
function prepend(html: string, script: string): string {
  const tag = `<script>${script}</script>`;
  for (const re of [/<head\b[^>]*>/i, /<html\b[^>]*>/i, /<!doctype[^>]*>/i]) {
    const m = html.match(re);
    if (m && m.index !== undefined) {
      const end = m.index + m[0].length;
      return html.slice(0, end) + tag + html.slice(end);
    }
  }
  return tag + html;
}

/** The relative stylesheet a `<link>` names, or undefined. */
function stylesheetHref(tag: string): string | undefined {
  const rels = (attr(tag, 'rel') ?? '').toLowerCase().split(/\s+/);
  return rels.includes('stylesheet') ? attr(tag, 'href') : undefined;
}

/**
 * The page as the frame gets it: the fetch relay first, and every relative
 * script and stylesheet `read` returns written in. A reference `read` refuses
 * is left as written, so it fails in the browser the way a missing file does.
 * Each distinct file is read once, one at a time, and every reference to it
 * counts toward the size, since each is written in; null when the page would
 * pass `max`, before the rest is read.
 */
export async function frameHtml(
  html: string,
  page: string[],
  base: string,
  read: (segments: string[]) => Promise<Uint8Array | null>,
  max = PAGE_MAX,
): Promise<string | null> {
  const dir = page.slice(0, -1);
  const want = (ref: string, ext: RegExp): string | null => {
    const segs = resolveRef(dir, ref);
    return segs && ext.test(segs[segs.length - 1] ?? '') ? segs.join('/') : null;
  };
  const scripts = [...html.matchAll(SCRIPT_SRC)].map((m) => want(m[2] ?? m[3] ?? '', /\.m?js$/i));
  const styles = [...html.matchAll(LINK)].map((m) => {
    const href = stylesheetHref(m[0]);
    return href === undefined ? null : want(href, /\.css$/i);
  });
  const got = new Map<string, Uint8Array | null>();
  let size = html.length;
  // Every occurrence counts toward the size, since each is written in; only
  // the first of each reads the disk.
  for (const key of [...scripts, ...styles]) {
    if (key === null) continue;
    if (!got.has(key)) got.set(key, await read(key.split('/')));
    const bytes = got.get(key);
    // Base64 is four bytes for every three; a stylesheet goes in as itself.
    size += bytes ? Math.ceil(bytes.byteLength / 3) * 4 : 0;
    if (size > max) return null;
  }
  let si = 0;
  let out = html.replace(SCRIPT_SRC, (whole, pre: string, _d, _s, post: string) => {
    const key = scripts[si++] ?? null;
    const bytes = key === null ? null : got.get(key);
    if (!bytes) return whole;
    const b64 = Buffer.from(bytes).toString('base64');
    return `<script${pre}src="data:text/javascript;base64,${b64}"${post}></script>`;
  });
  let li = 0;
  out = out.replace(LINK, (tag) => {
    const key = styles[li++] ?? null;
    const bytes = key === null ? null : got.get(key);
    if (!bytes) return tag;
    const css = new TextDecoder().decode(bytes).replace(/<\/style/gi, '<\\/style');
    const media = attr(tag, 'media');
    return `<style${media ? ` media="${media.replace(/"/g, '&quot;')}"` : ''}>${css}</style>`;
  });
  return prepend(out, FETCH_RELAY(base));
}
