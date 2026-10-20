import { isRecoveredMockCollision } from '@claude-workspaces/core/mock-swap-noise';
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
 * NAMED IMPORTS ONLY. `import * as Sentry` with the namespace parked on
 * `window` kept every export alive — replay, feedback, the lot — and was
 * about 100 KB of the 157 KB. Tracing (19 KB) and profiling (5 KB) went too: nothing
 * reads a browser span, because page load times are the server's
 * `/load-reports` and its two-second alarm. Errors and console logs are what
 * is left, and are what this file is for.
 */
import { consoleLoggingIntegration, init } from '@sentry/browser';
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
  init({
    dsn,
    // The deploy, not the bundle — see browser-sentry.ts. Omitted rather
    // than guessed at when the shell names none (dev, staging).
    release: meta('sentry-release') || undefined,
    // Same string the server stamps, so one `environment` filter reads both
    // Sentry projects.
    environment: meta('sentry-environment') || undefined,
    integrations: [
      // console.warn / console.error become Sentry log lines. Not
      // `log`/`info`: the app narrates too much there for the volume to be
      // worth its bandwidth on an iPad.
      consoleLoggingIntegration({ levels: ['warn', 'error'] }),
    ],
    // Sentry's defaults, stated so a future SDK cannot silently flip them.
    enableLogs: true,
    enableMetrics: true,
    // Default (false), stated: no IPs, no cookies, no headers.
    sendDefaultPii: false,
    initialScope: {
      tags: {
        // What makes "which page type is this error from" a GROUP BY.
        page_type: meta('sentry-page-type') || UNKNOWN,
        // Kept as a tag now that `release` names the deploy: the build id is
        // a content hash of the built assets, so it still answers "which
        // bundle was this browser running" — which a deploy string cannot,
        // since a tab keeps whatever it loaded across a restart.
        build_id: BUILD_ID || UNKNOWN,
      },
    },
    // Two questions on the way out, in this order.
    //
    // Is this the redeclaration a mockup's live reload has ALREADY recovered
    // from? A round that re-runs the mock's own top-level `const` is rejected
    // by the browser, retried inside a block by the widget's swap, and lands —
    // but Chrome reports that early error globally on its way past, and this
    // handler was registered before the widget ever loaded. Nine events in one
    // day for a failure nothing needs to look at is how a real client error
    // gets lost. `isRecoveredMockCollision` drops one only while the insert
    // that will be retried is on the stack, so a collision nothing recovers
    // still files; see mock-swap-noise.ts for why it cannot be a listener.
    //
    // Then the privacy floor, shared with the server (PR #487) and extended
    // for the shapes only a browser event has. A page URL, a fetch span's
    // description and a navigation breadcrumb all carry a doc id — which can
    // be a bound file's relative PATH. Nothing leaves this browser without
    // going through here.
    beforeSend: (event) =>
      isRecoveredMockCollision(event) ? null : (scrubBrowserEvent(event) as typeof event),
    // Logs and metrics travel in their own envelopes and never pass the
    // hook above; a console line or a metric attribute is exactly where a
    // doc path would be pasted, mid-sentence, which is the one shape the
    // event floor cannot see. See scrubTelemetryItem.
    beforeSendLog: (log) => scrubTelemetryItem(log) as typeof log,
    beforeSendMetric: (metric) => scrubTelemetryItem(metric) as typeof metric,
  });
}
