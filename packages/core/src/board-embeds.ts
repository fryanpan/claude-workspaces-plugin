/**
 * Board embeds: a doc paragraph whose whole text is `::name{block="x"}` shows
 * a live frame of one of the board's apps beneath it.
 *
 * The board holds the mapping from directive name to app and path; the doc
 * only names a block. The server checks a mapping's shape before it stores
 * it, and the editor builds the frame's address here, so both read one rule.
 * Only `block` ever reaches a URL, and only after it matches `BLOCK_RE`.
 *
 * An entry names either an app door (`appDocId`, `{mount}`) or an https
 * origin (`origin`, `{origin}`), never both. An origin entry loads that site
 * directly, so its page keeps its own origin and its requests carry its own
 * address as the Referer — what a referrer-restricted key such as a Google
 * Maps one needs. The server stores one only when the origin is on its
 * allowlist (`embedOriginsFrom`), which must never name the board's own
 * origin: a same-origin frame given `allow-same-origin` can lift its sandbox.
 *
 * A third kind needs no mapping: `::html{src="map/index.html"}` frames a page
 * from the doc's own folder (`parseFileEmbedDirective`, below).
 */
import { MOCK_FRAME_PARAM } from './page-thread-link.ts';

export type BoardEmbedTarget =
  | {
      /** The app door the frame loads from: `/workspaces/<ws>/apps/<appDocId>`. */
      appDocId: string;
      /** The path under it, e.g. `{mount}/embed/bike/{block}/`. */
      pathTemplate: string;
    }
  | {
      /** An allowlisted https origin, e.g. `https://harborlight.example`. */
      origin: string;
      /** The path on it, e.g. `{origin}/embed/bike/{block}/`. */
      pathTemplate: string;
    };

export type BoardEmbeds = Record<string, BoardEmbedTarget>;

export const EMBED_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;
export const BLOCK_RE = /^[a-z0-9-]{1,64}$/;
const APP_DOC_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** `{mount}` first, then plain path characters and `{block}`; no `..`. */
const TEMPLATE_RE = /^\{mount\}(?:\/[A-Za-z0-9_.{}-]*)*$/;
/** The same rule rooted at `{origin}`, so the host can never change. */
const ORIGIN_TEMPLATE_RE = /^\{origin\}(?:\/[A-Za-z0-9_.{}-]*)*$/;
export const MAX_EMBEDS = 16;
/** Asks the app door to leave the comment widget out of an embed's page. */
export const EMBED_PARAM = 'cw-embed';

/**
 * The frame heights an embed may ask for. The frame does not scroll on its
 * own, so the ceiling only stops a runaway report: 2,000 cut off the bottom
 * of a 41-row table on a phone.
 */
export const EMBED_MIN_HEIGHT = 80;
export const EMBED_MAX_HEIGHT = 10000;

/** An https origin written exactly: no path, no wildcard, no credentials. */
export function isExactHttpsOrigin(s: string): boolean {
  if (!/^https:\/\/[a-z0-9.-]+(?::\d{1,5})?$/.test(s)) return false;
  try {
    return new URL(s).origin === s;
  } catch {
    return false;
  }
}

/**
 * The allowlist names a deployment's partner sites, so the repo ships none.
 * The server reads it from `<dataDir>/embed-origins.json`, a JSON array the
 * owner writes; `CW_EMBED_ORIGINS`, comma-separated, overrides the file.
 * An entry that is not an exact https origin is dropped.
 */
export function embedOriginsFrom(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(isExactHttpsOrigin);
}

/** The allowlist file's parsed JSON; anything but an array of strings allows none. */
export function embedOriginsFromJson(parsed: unknown): string[] {
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((s): s is string => typeof s === 'string' && isExactHttpsOrigin(s));
}

export function clampEmbedHeight(h: number): number {
  return Math.min(EMBED_MAX_HEIGHT, Math.max(EMBED_MIN_HEIGHT, Math.round(h)));
}

/** A mapping the server may store, or the sentence saying why not. */
export function parseBoardEmbeds(
  raw: unknown,
  allowedOrigins: readonly string[] = [],
): { ok: true; embeds: BoardEmbeds } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'embeds must be an object of name → {appDocId, pathTemplate}' };
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > MAX_EMBEDS) return { ok: false, error: `at most ${MAX_EMBEDS} embeds` };
  const embeds: BoardEmbeds = {};
  for (const [name, v] of entries) {
    if (!EMBED_NAME_RE.test(name)) {
      return { ok: false, error: `embed name ${JSON.stringify(name)} must match ${EMBED_NAME_RE}` };
    }
    const target = parseTarget(name, v, allowedOrigins);
    if (typeof target === 'string') return { ok: false, error: target };
    embeds[name] = target;
  }
  return { ok: true, embeds };
}

/** One entry, or the sentence saying why not. */
function parseTarget(
  name: string,
  v: unknown,
  allowedOrigins: readonly string[],
): BoardEmbedTarget | string {
  const t = v as { appDocId?: unknown; origin?: unknown; pathTemplate?: unknown } | null;
  if (!t || typeof t !== 'object') {
    return `${name}: must be {appDocId, pathTemplate} or {origin, pathTemplate}`;
  }
  if (t.appDocId !== undefined && t.origin !== undefined) {
    return `${name}: name an appDocId or an origin, not both`;
  }
  const tpl = typeof t.pathTemplate === 'string' ? t.pathTemplate : '';
  const tplOk = (re: RegExp): boolean => tpl.length <= 200 && re.test(tpl) && !tpl.includes('..');
  if (t.origin !== undefined) {
    if (typeof t.origin !== 'string' || !isExactHttpsOrigin(t.origin)) {
      return `${name}: origin must be an exact https origin, with no path`;
    }
    if (!allowedOrigins.includes(t.origin)) {
      return `${name}: origin ${t.origin} is not on this server's embed allowlist`;
    }
    if (!tplOk(ORIGIN_TEMPLATE_RE)) {
      return `${name}: pathTemplate must start with {origin}/ and hold only path characters and {block}`;
    }
    return { origin: t.origin, pathTemplate: tpl };
  }
  if (typeof t.appDocId !== 'string' || !APP_DOC_ID_RE.test(t.appDocId)) {
    return `${name}: appDocId must match ${APP_DOC_ID_RE}`;
  }
  if (!tplOk(TEMPLATE_RE)) {
    return `${name}: pathTemplate must start with {mount} and hold only path characters, {mount} and {block}`;
  }
  return { appDocId: t.appDocId, pathTemplate: tpl };
}

/** Drop the origin entries no longer on the allowlist, so a stored one cannot outlive it. */
export function allowedEmbeds(embeds: BoardEmbeds, allowedOrigins: readonly string[]): BoardEmbeds {
  const out: BoardEmbeds = {};
  for (const [name, t] of Object.entries(embeds)) {
    if ('origin' in t && !allowedOrigins.includes(t.origin)) continue;
    out[name] = t;
  }
  return out;
}

/**
 * A file embed: `::html{src="map/index.html"}` frames an HTML file that sits
 * beside the doc's own bound file, named by a path relative to that file the
 * way a relative image is. No board mapping is needed; the server serves the
 * page and its sibling files from the doc's folder
 * (`server/src/routes/doc-files.ts`) under the doc's own access.
 */
export const FILE_EMBED_NAME = 'html';
/** The route segment a doc's folder is served under. */
export const DOC_FILES_SEGMENT = 'files';
const FILE_SRC_MAX = 512;

/**
 * `src` as path segments, or null unless it is a relative path to an `.html`
 * file inside the doc's folder: no scheme, no leading `/`, no backslash, no query
 * or fragment, and no segment that is empty, `..` or starts with a dot. A
 * leading `./` is allowed. The server judges the path again; this only keeps
 * the editor from building an address it would refuse.
 */
export function fileEmbedSegments(src: string): string[] | null {
  if (src.length === 0 || src.length > FILE_SRC_MAX) return null;
  if (/[\\\0?#]/.test(src) || src.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(src)) {
    return null;
  }
  const segs = src.startsWith('./') ? src.slice(2).split('/') : src.split('/');
  if (segs.some((s) => s === '' || s.startsWith('.'))) return null;
  return /\.html$/i.test(segs[segs.length - 1] ?? '') ? segs : null;
}

/** The file directive a paragraph's whole text spells, or null. */
export function parseFileEmbedDirective(text: string): { src: string; segments: string[] } | null {
  const m = text.match(/^::html\{([^{}\n]*)\}$/);
  if (!m) return null;
  const src = (m[1] ?? '').match(/(?:^|\s)src="([^"]*)"(?:\s|$)/)?.[1];
  const segments = src === undefined ? null : fileEmbedSegments(src);
  return src !== undefined && segments ? { src, segments } : null;
}

/** Where a doc's folder is served: `/workspaces/<ws>/docs/<doc>/files/`. */
export function docFilesBase(workspaceId: string, docId: string): string {
  return `/workspaces/${encodeURIComponent(workspaceId)}/docs/${encodeURIComponent(docId)}/${DOC_FILES_SEGMENT}/`;
}

/** The frame address for a file directive's segments. */
export function docFileUrl(workspaceId: string, docId: string, segments: string[]): string {
  return docFilesBase(workspaceId, docId) + segments.map((s) => encodeURIComponent(s)).join('/');
}

/** The directive a paragraph's whole text spells, or null. */
export function parseEmbedDirective(text: string): { name: string; block: string } | null {
  const m = text.match(/^::([a-z][a-z0-9-]{0,31})\{([^{}\n]*)\}$/);
  if (!m) return null;
  const block = (m[2] ?? '').match(/(?:^|\s)block="([^"]*)"(?:\s|$)/)?.[1];
  if (block === undefined || !BLOCK_RE.test(block)) return null;
  return { name: m[1] ?? '', block };
}

/**
 * The frame's address for a directive, and the origin its height messages
 * must come from (null for an app door, whose sandboxed page has none), or
 * null when unmapped.
 */
export function embedFrameSpec(
  embeds: BoardEmbeds | null | undefined,
  workspaceId: string,
  name: string,
  block: string,
): { url: string; origin: string | null } | null {
  const target = embeds && Object.hasOwn(embeds, name) ? embeds[name] : undefined;
  if (!target || !BLOCK_RE.test(block)) return null;
  if ('origin' in target) {
    // Checked again here: the editor builds a cross-origin URL from it.
    if (!isExactHttpsOrigin(target.origin) || !ORIGIN_TEMPLATE_RE.test(target.pathTemplate)) {
      return null;
    }
    const path = target.pathTemplate.slice('{origin}'.length).split('{block}').join(block);
    return { url: `${target.origin}${path}`, origin: target.origin };
  }
  const mount = `/workspaces/${encodeURIComponent(workspaceId)}/apps/${encodeURIComponent(target.appDocId)}`;
  // `?cw-frame=1` asks the app door for the app's own page rather than the
  // host page that frames it, so the page's height message reaches this
  // editor as its parent (`mockup-frame.ts` on the server); `cw-embed=1`
  // leaves the comment widget off it.
  const path = target.pathTemplate.split('{mount}').join(mount).split('{block}').join(block);
  return { url: `${path}?${MOCK_FRAME_PARAM}=1&${EMBED_PARAM}=1`, origin: null };
}

/** The frame's address for a directive, or null when unmapped. */
export function embedUrl(
  embeds: BoardEmbeds | null | undefined,
  workspaceId: string,
  name: string,
  block: string,
): string | null {
  return embedFrameSpec(embeds, workspaceId, name, block)?.url ?? null;
}
