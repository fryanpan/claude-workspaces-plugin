/**
 * Trace privacy: the pure, shared floor that keeps a Sentry payload down to
 * shapes, counts and timings — never doc content, titles, comment text, or
 * file paths.
 *
 * It lives in `@claude-workspaces/core` rather than beside the server's Sentry init
 * because BOTH sides send events now. The server has sent scrubbed traces
 * since PR #487; the browser started sending them once docs, mockups and the
 * landing page were instrumented too, and a browser event
 * carries the same hazards through different doors — `request.url` is the
 * page URL, an `http.client` span's description is the fetch URL, and a
 * navigation breadcrumb's `from`/`to` are raw paths. One copy of the rules,
 * imported by `packages/server/src/sentry.ts` (which re-exports it, so its
 * own callers and tests are unchanged) and by the browser's Sentry entry.
 *
 * Nothing in here touches the network, the filesystem, or a Sentry SDK — it
 * is string and object work only, which is what makes it safe to bundle into
 * a browser build.
 *
 * The route table a span name is reduced against — and `routePatternForSpan`
 * itself — moved to `route-templates.ts`, and is re-exported here so every
 * caller's import is unchanged.
 */
import { routePatternForSpan } from './route-templates.ts';

export { routePatternForSpan };

/**
 * Key-targeted, not content-targeted: this walks the whole event tree and
 * drops the VALUE of any key whose name looks like it carries a URL, query
 * string, cookie, or referrer — `url`, `request.url`, `url.full`,
 * `http.url`, `query_string`, `headers`, `referer`/`referrer`, `cookie(s)`.
 * It deliberately does NOT pattern-match string CONTENT (e.g. "starts with
 * /"), because that would also catch legitimate, harmless data this same
 * event carries — most importantly `exception.values[].stacktrace.frames[].
 * filename`, an absolute path into OUR OWN source tree that a debugging
 * agent needs to find where the error happened. Naming the key is the safer
 * floor: every URL-shaped attribute Sentry's conventions define is named
 * with one of these substrings, and nothing else in an event is.
 */
const SCRUB_KEY_SUBSTRINGS = ['url', 'href', 'referer', 'referrer', 'cookie', 'query_string'];

function shouldScrubKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (lower === 'headers') return true;
  return SCRUB_KEY_SUBSTRINGS.some((needle) => lower.includes(needle));
}

/**
 * Second floor, sitting under the key-targeted pass above: a VALUE-shaped
 * scan for this repo's own minted-id shape. The key-targeted pass only looks
 * at ATTRIBUTE NAMES — it does nothing for an id that leaks through an
 * ordinary string under an ordinary key: a transaction/span `name` (if
 * anything ever names one by raw path instead of routePatternForSpan), an
 * exception `message` ("doc t-... not found"), a breadcrumb message, or a
 * future `extra` string nobody thought to redact. A key list has to be right
 * about every key anyone will ever add; a value-shaped check does not.
 *
 * Every id this codebase MINTS (doc-ids.ts's newDocId, tasks.ts's cryptoId,
 * …) has the same shape: a short lowercase prefix, a dash, then 10+
 * base64url characters — the same shape scripts/scrub-check.py's own
 * denylist matches for the pre-push gate (`\bt-[A-Za-z0-9_-]{10,}\b`,
 * generalized here to any prefix, not just task ids). Redacting that SHAPE
 * wherever it appears in a string, independent of which key it's under,
 * closes the gap a key list can never fully enumerate.
 *
 * What this does NOT catch: a caller-chosen docId that's a bound file's
 * relative path or a `task:<id>` alias (see routePatternForSpan) embedded in
 * free text — those read as ordinary words ("roadmap", "internal"), and no
 * shape pattern can single them out of a message without also redacting
 * ordinary English. routePatternForSpan already keeps that shape out of
 * every span/transaction NAME; keeping a raw docId out of a hand-written
 * message string is a code-review concern (don't interpolate one into an
 * Error message), not something a generic scrubber can enforce.
 */
const MINTED_ID_SHAPE = /\b[a-z]{1,3}-[A-Za-z0-9_-]{10,}\b/g;

function redactMintedIdShapes(text: string): string {
  return text.replace(MINTED_ID_SHAPE, '[id]');
}

export function scrubEventForPrivacy(value: unknown, depth = 0): unknown {
  // Fail closed, not open: a subtree this deep is never a real Sentry event
  // shape (envelope objects run a handful of levels deep at most), so
  // returning it unscrubbed on the assumption that "it's probably fine"
  // would be exactly the kind of unproven assumption this whole file exists
  // to replace with a check. Redact instead — the guard is still what stops
  // a pathological/cyclical shape from recursing forever, it just no longer
  // buys an attacker's data a pass on the way out.
  if (depth > 20) return '[scrubbed: too deep]';
  if (typeof value === 'string') {
    return redactMintedIdShapes(value);
  }
  if (Array.isArray(value)) {
    return value.map((v) => scrubEventForPrivacy(v, depth + 1));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = shouldScrubKey(key) ? '[scrubbed]' : scrubEventForPrivacy(v, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * A span/transaction name, reduced to a route pattern.
 *
 * The two floors above are blind to exactly one shape, and it is the shape a
 * BROWSER event is full of: a string that IS a path (or `GET <path>`), under
 * an ordinary key like `transaction` or a span's `description`. The
 * key-targeted pass only looks at attribute NAMES, and `description` is not
 * URL-named; the shape pass only catches this codebase's MINTED ids, and a
 * `docId` can be a bound file's relative path (`docs/product/vision.md`) or a
 * `task:<id>` alias — ordinary words, no shape to match.
 *
 * The server never needed this because `withRouteSpan` names every span it
 * creates through `routePatternForSpan` before the SDK ever sees it. In the
 * browser the names are minted by the SDK's own tracing integration, from
 * `location.pathname` and from every fetch URL, so the only place to fix them
 * is on the way out.
 *
 * A name that is not path-shaped is returned untouched — this is a rewrite of
 * known-safe shapes, not a guess at unknown ones.
 */
export function scrubSpanName(name: string): string {
  const withMethod = /^([A-Z]{3,7}) (\S+)$/.exec(name);
  if (withMethod) {
    const path = pathOf(withMethod[2] ?? '');
    return path === null ? name : `${withMethod[1]} ${routePatternForSpan(path)}`;
  }
  const path = pathOf(name);
  return path === null ? name : routePatternForSpan(path);
}

/**
 * The pathname of a string that is a path or an absolute URL, or null when it
 * is neither. Query and fragment are dropped outright rather than patterned
 * over: a query string is the one part of a URL most likely to carry a title,
 * a search term, or a token, and no span name needs it.
 */
function pathOf(raw: string): string | null {
  if (raw.startsWith('/')) return raw.split(/[?#]/)[0] ?? '/';
  const m = /^https?:\/\/[^/]*(\/[^\s?#]*)?/.exec(raw);
  if (!m) return null;
  return m[1] ?? '/';
}

/** Breadcrumb `data` keys whose value is a raw path. Navigation breadcrumbs
 *  record where the SPA went, which is a doc address. */
const PATH_VALUED_BREADCRUMB_KEYS = ['from', 'to'] as const;

/**
 * The browser's `beforeSend` / `beforeSendTransaction`: the name pass above,
 * then the same two floors the server runs.
 *
 * Order matters. `routePatternForSpan` has to see the real path to match a
 * route template against it, so the names are rewritten FIRST; the key and
 * shape floors then run over the whole event, catching everything the name
 * pass did not visit (`request.url`, `http.url`, a minted id in a message).
 * Running them the other way round would hand the name pass `/[id]/[id]`
 * and reduce every route to the all-`:id` fallback.
 */
export function scrubBrowserEvent(event: unknown): unknown {
  if (event && typeof event === 'object') {
    const e = event as Record<string, unknown>;
    if (typeof e.transaction === 'string') e.transaction = scrubSpanName(e.transaction);
    for (const span of Array.isArray(e.spans) ? e.spans : []) {
      if (!span || typeof span !== 'object') continue;
      const s = span as Record<string, unknown>;
      for (const key of ['description', 'name'] as const) {
        if (typeof s[key] === 'string') s[key] = scrubSpanName(s[key] as string);
      }
    }
    for (const crumb of Array.isArray(e.breadcrumbs) ? e.breadcrumbs : []) {
      if (!crumb || typeof crumb !== 'object') continue;
      const data = (crumb as Record<string, unknown>).data;
      if (!data || typeof data !== 'object') continue;
      const d = data as Record<string, unknown>;
      for (const key of PATH_VALUED_BREADCRUMB_KEYS) {
        if (typeof d[key] === 'string') d[key] = scrubSpanName(d[key] as string);
      }
    }
  }
  return scrubEventForPrivacy(event);
}

/**
 * A log line or a metric, on the way out — the `beforeSendLog` /
 * `beforeSendMetric` floor on both sides.
 *
 * Neither of the two floors above reaches the shape these carry. A log's
 * `message` is FREE TEXT from a console call, and the path a developer pasted
 * into it (`failed to save /workspaces/w-…/docs/quarterly-comp-review.md`)
 * is not a whole-string path, so `scrubSpanName` leaves it alone; and the
 * slug at its end is ordinary words, so the minted-id shape never fires. A
 * metric's attributes are whatever the caller passed, same story. So every
 * string in the item is searched for embedded path tokens — a `/`-led or
 * `http(s)://` run — and each is replaced by its route pattern, and THEN the
 * ordinary floors run over the result.
 */
export function scrubTelemetryItem(item: unknown): unknown {
  return scrubEventForPrivacy(redactPathsInStrings(item));
}

const EMBEDDED_PATH = /(?<=^|[\s"'`(\[])(https?:\/\/[^\s"'`)\]]+|\/[^\s"'`)\]]+)/g;

function redactPathsInText(text: string): string {
  return text.replace(EMBEDDED_PATH, (token) => {
    const path = pathOf(token);
    return path === null ? token : routePatternForSpan(path);
  });
}

function redactPathsInStrings(value: unknown): unknown {
  if (typeof value === 'string') return redactPathsInText(value);
  if (Array.isArray(value)) return value.map(redactPathsInStrings);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactPathsInStrings(v);
    }
    return out;
  }
  return value;
}
