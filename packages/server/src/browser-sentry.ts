/**
 * The browser half of Sentry: what every served shell has to carry so that a
 * page load shows up as a trace, tagged with WHICH KIND of page it was.
 *
 * ## Why a page type at all
 *
 * Asked on 2026-08-29: "I want to understand the load time for each page
 * (home page, doc, mockup, board) and see if there are issues sometimes."
 * Only the board could answer. There was exactly one browser Sentry init, in
 * `board-app.ts`, reading a meta tag only `renderBoardShell` emitted — so every
 * transaction Sentry held was a `/workspaces/...` path and every other
 * surface was silent. "Docs load fine" was not a finding anyone had made; it
 * was a question nobody could ask.
 *
 * Instrumenting the other three shells is only half of it. Their URLs carry
 * ids, so grouping by URL would neither compare across kinds nor be safe to
 * send — see `routePatternForSpan` and the scrub floor in
 * `@claude-workspaces/core/trace-privacy`. The `page_type` tag is what makes the
 * comparison a GROUP BY rather than a path-prefix guess: four values, one
 * median and p95 each, side by side.
 *
 * ## Why a separate script rather than an import in each app
 *
 * `/app/sentry.js` is its own build entry, loaded by a `<script type=
 * "module">` that a shell emits ONLY when a DSN is configured. Three reasons
 * it is not an `import()` inside app.js / board.js / the widget:
 *
 * - `app.ts` and the widget build with `splitting: false`, so a dynamic
 *   `import('@sentry/browser')` inside either is INLINED into the entry —
 *   the SDK would ship in the bundle every doc load and every mockup fetches,
 *   configured or not. The widget bundle size is a hard project constraint.
 * - A page with no DSN then has no script tag at all, which is a stronger
 *   version of the "no DSN, no SDK, no outbound request" contract than a
 *   runtime `if`: there is nothing to fetch and nothing to run.
 * - The mockup surface is somebody else's HTML with the widget injected into
 *   it. It has no bundle of ours to put an import inside.
 *
 * ## Why it is `async`, and what holds errors until it arrives
 *
 * It was a plain module script ahead of the page's own, and module scripts
 * run in document order: every page's script waited for the SDK to download.
 * At 157 KB gzipped that was a 5.5 s Home load on the owner's iPad (20 Oct
 * 2026) for HTML the server answered in under 400 ms. `async` takes it out of
 * the order — it runs whenever it arrives, before or after the page's script
 * — and `fetchpriority="low"` keeps it from competing with the page's own
 * bundle for a slow link.
 *
 * Loading late would lose the errors that matter most, the ones thrown while
 * a page boots. So the shell carries `EARLY_ERROR_BUFFER` inline, ahead of
 * every script: it holds each uncaught error and rejection until the SDK has
 * initialised, and `sentry-boot.ts` files them. Inline because it must run
 * before anything else and cost no request; a few hundred bytes. Console
 * lines from before the SDK loads are not held — they are logs, not errors.
 *
 * The DSN itself is box config (`CW_SENTRY_DSN`), never the repo.
 */
import { type AssetManifest, assetHref } from '@claude-workspaces/core/asset-manifest';
import { SWAP_SCOPE_KEYS } from '@claude-workspaces/core/mock-swap-noise';

/**
 * The kinds of page whose load times are compared. One value per surface a
 * human opens, not per route: `/workspaces/<id>/home`, `/tasks` and
 * `/activity` are all the board.
 */
export type PageType = 'board' | 'doc' | 'mockup' | 'landing' | 'signin' | 'settings';

export interface BrowserSentryConfig {
  /** `CW_SENTRY_DSN`. Absent config is `null`, not an empty string. */
  dsn: string;
  /**
   * What the browser bundle should call this deploy. The same string the
   * server stamps on its own events (`bin.ts` → `initServerSentry`), which is
   * `git describe`-derived provenance from the published release — so a
   * regression can be attributed to the deploy it arrived with, and a
   * browser trace and the server span it continues agree on the release.
   *
   * Deliberately NOT the client build id, which is a content hash of the
   * built assets: it tells you the bundle changed, never which commit it
   * came from. The build id is still sent, as a `build_id` TAG.
   */
  release?: string | null;
  /** Sentry `environment` — `production`, `staging`, `development`. The
   *  server sends the same string, so one filter reads both projects. */
  environment?: string | null;
}

/**
 * Holds the page's uncaught errors until `/app/sentry.js` has initialised.
 *
 * The global name is read by `drainEarlyErrors` in
 * `packages/workspaces-app/src/sentry-boot.ts`, which sets `done` and files
 * what was held. Each entry keeps a copy of the mock swap's window as it stood
 * when the error was raised (`SWAP_SCOPE_KEYS`), so a redeclaration a mock
 * round recovered from is dropped even when it was held here rather than seen
 * by the SDK. Capped at 20, so a page throwing in a loop on a device where the
 * SDK never arrives cannot grow it without bound.
 */
export const EARLY_ERROR_BUFFER = `(function(w){if(w.__cwSentryEarly)return;var q=w.__cwSentryEarly=[],k=${JSON.stringify(SWAP_SCOPE_KEYS)};function keep(kind,error){if(q.done||q.length>=20)return;var s={};for(var i=0;i<k.length;i++)s[k[i]]=w[k[i]];q.push({kind:kind,error:error,scope:s})}w.addEventListener('error',function(e){keep('onerror',e.error||e.message)});w.addEventListener('unhandledrejection',function(e){keep('onunhandledrejection',e.reason)})})(window);`;

const escapeAttr = (v: string): string =>
  v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The head tags a shell needs, or `''` when Sentry is unconfigured.
 *
 * The meta tags are how server config reaches a bundle that the server does
 * not template — the sentry bundle is a static file, identical on every box.
 */
export function sentryHeadTags(
  cfg: BrowserSentryConfig | null,
  pageType: PageType,
  assets: AssetManifest = {},
): string {
  if (!cfg?.dsn) return '';
  const release = cfg.release?.trim();
  const environment = cfg.environment?.trim();
  return [
    `<meta name="sentry-dsn" content="${escapeAttr(cfg.dsn)}" />`,
    `<meta name="sentry-page-type" content="${escapeAttr(pageType)}" />`,
    ...(release ? [`<meta name="sentry-release" content="${escapeAttr(release)}" />`] : []),
    ...(environment
      ? [`<meta name="sentry-environment" content="${escapeAttr(environment)}" />`]
      : []),
    `<script>${EARLY_ERROR_BUFFER}</script>`,
    // `async`: nothing on the page waits for it — see the header. Content-
    // addressed like every other asset a shell names, so a deploy cannot
    // leave a page reporting from last week's monitoring bundle. No manifest
    // (unbuilt dist, or one from before hashing) falls back to the plain
    // name, which is still served.
    `<script type="module" async fetchpriority="low" src="${assetHref(assets, 'sentry.js')}"></script>`,
  ].join('\n    ');
}

/** `</head>`, `<head …>`, and a leading doctype — the three insertion points
 *  below, in the order they are tried. */
const HEAD_CLOSE = /<\/head\s*>/i;
const HEAD_OPEN = /<head(\s[^>]*)?>/i;
const DOCTYPE = /^\s*<!doctype[^>]*>/i;

/**
 * Add the tags to an HTML document that this server did not template — the
 * built `index.html` every doc page is served from, and a mockup's own file.
 *
 * A mockup is somebody's hand-written page and may have no `<head>` at all,
 * so the insertion point degrades: before `</head>`, else just after
 * `<head …>`, else after the doctype (prepending BEFORE a doctype would put
 * the browser in quirks mode and change how the page they are reviewing
 * renders), else at the very start. Returns `html` untouched when Sentry is
 * unconfigured — the no-DSN path adds no bytes and no requests.
 */
export function injectSentryHead(
  html: string,
  cfg: BrowserSentryConfig | null,
  pageType: PageType,
  assets: AssetManifest = {},
): string {
  const tags = sentryHeadTags(cfg, pageType, assets);
  if (!tags) return html;
  const block = `\n    ${tags}\n  `;
  if (HEAD_CLOSE.test(html)) return html.replace(HEAD_CLOSE, (m) => `${block}${m}`);
  if (HEAD_OPEN.test(html)) return html.replace(HEAD_OPEN, (m) => `${m}${block}`);
  const doctype = DOCTYPE.exec(html);
  if (doctype) return `${doctype[0]}${block}${html.slice(doctype[0].length)}`;
  return `${block}${html}`;
}
