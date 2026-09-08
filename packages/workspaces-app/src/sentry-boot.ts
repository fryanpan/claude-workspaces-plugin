import { scrubBrowserEvent, scrubTelemetryItem } from '@claude-workspaces/core/trace-privacy';
/**
 * The browser's Sentry init — one entry, every page type.
 *
 * Built to `dist/sentry.js` and loaded by a `<script type="module"
 * src="/app/sentry.js">` that a shell emits ONLY when the box has a DSN
 * configured. `packages/server/src/browser-sentry.ts` is the other half and
 * carries the reasoning: why it is a separate script rather than an
 * `import()` inside app.js / board.js / the widget, and why the page type is a
 * TAG rather than something read back off the URL.
 *
 * It is a side-effecting module on purpose. There is no export anything else
 * imports, and nothing waits for it: a module script runs in document order,
 * so this one — emitted in `<head>` — has already called `Sentry.init` by
 * the time the page's own bundle executes. That is also what puts the
 * pageload transaction's start as early as the browser can see it.
 */
import * as Sentry from '@sentry/browser';
import { BUILD_ID } from './stale-client.ts';

/** The value a tag takes when the shell did not name one. Never omitted:
 *  a missing tag is a page that fell through the shell wiring, and it should
 *  be VISIBLE in the same GROUP BY as the four real page types, not absent
 *  from it. */
const UNKNOWN = 'unknown';

function meta(name: string): string {
  return document.querySelector(`meta[name="${name}"]`)?.getAttribute('content')?.trim() ?? '';
}

const dsn = meta('sentry-dsn');

if (dsn) {
  Sentry.init({
    dsn,
    // The deploy, not the bundle — see browser-sentry.ts. Omitted rather
    // than guessed at when the shell names none (dev, staging).
    release: meta('sentry-release') || undefined,
    // Same string the server stamps, so one `environment` filter reads both
    // Sentry projects.
    environment: meta('sentry-environment') || undefined,
    integrations: [
      Sentry.browserTracingIntegration(),
      // Profiles ride along with the traces above: the profiler runs while a
      // sampled root span (pageload, navigation) is open, so a slow board
      // boot shows WHICH function was slow. It needs the page's HTML to have
      // arrived with `Document-Policy: js-profiling` — every shell does, see
      // HTML_SHELL_HEADERS in packages/server/src/shells.ts.
      Sentry.browserProfilingIntegration(),
      // console.warn / console.error become Sentry log lines next to the
      // trace they happened in. Not `log`/`info`: the app narrates too much
      // there for the volume to be worth its bandwidth on an iPad.
      Sentry.consoleLoggingIntegration({ levels: ['warn', 'error'] }),
    ],
    // Low-traffic internal tool: sample everything rather than guess at a
    // rate that would drop the one slow iPad load that matters.
    tracesSampleRate: 1.0,
    // Same reasoning for profiles: every session, whenever a trace is open.
    profileSessionSampleRate: 1.0,
    profileLifecycle: 'trace',
    // Sentry's defaults, stated so a future SDK cannot silently flip them.
    enableLogs: true,
    enableMetrics: true,
    // Default (false), stated: no IPs, no cookies, no headers.
    sendDefaultPii: false,
    initialScope: {
      tags: {
        // What makes "compare load times across page types" a GROUP BY.
        page_type: meta('sentry-page-type') || UNKNOWN,
        // Kept as a tag now that `release` names the deploy: the build id is
        // a content hash of the built assets, so it still answers "which
        // bundle was this browser running" — which a deploy string cannot,
        // since a tab keeps whatever it loaded across a restart.
        build_id: BUILD_ID || UNKNOWN,
      },
    },
    // The privacy floor, shared with the server (PR #487) and extended for
    // the shapes only a browser event has. A page URL, a fetch span's
    // description and a navigation breadcrumb all carry a doc id — which can
    // be a bound file's relative PATH. Nothing leaves this browser without
    // going through here.
    beforeSend: (event) => scrubBrowserEvent(event) as typeof event,
    beforeSendTransaction: (event) => scrubBrowserEvent(event) as typeof event,
    // Logs and metrics travel in their own envelopes and never pass the two
    // hooks above; a console line or a metric attribute is exactly where a
    // doc path would be pasted, mid-sentence, which is the one shape the
    // event floor cannot see. See scrubTelemetryItem.
    beforeSendLog: (log) => scrubTelemetryItem(log) as typeof log,
    beforeSendMetric: (metric) => scrubTelemetryItem(metric) as typeof metric,
  });
  // How `board-app.ts` reaches the SDK for its own load-phase measurements
  // without importing (and so bundling) it a second time. See sentry-page.ts.
  (window as unknown as Record<string, unknown>).__cwSentry = Sentry;
}
