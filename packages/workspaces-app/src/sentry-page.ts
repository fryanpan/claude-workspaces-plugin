/**
 * The page's Sentry client, if `/app/sentry.js` loaded one.
 *
 * INERT SINCE THE SDK STOPPED TRACING: `sentry-boot.ts` no longer parks
 * anything on `window`, because without a pageload span there is nothing for
 * a measurement to land on, so this answers null on every page. The load
 * numbers themselves still reach the server's `/load-reports`. Removing this
 * and the `sentry` field it feeds is a follow-up.
 *
 * A bundle must NOT import `@sentry/browser` to add a measurement — `app.ts`
 * and the widget build without splitting, so any import of the SDK lands in
 * the entry every page load fetches whether or not a DSN is configured.
 * Everything here is best-effort and returns null when nothing is parked.
 */
export interface PageSentry {
  setMeasurement(name: string, value: number, unit: string): void;
}

export function pageSentry(): PageSentry | null {
  const held = (window as unknown as { __cwSentry?: unknown }).__cwSentry;
  if (!held || typeof held !== 'object') return null;
  const candidate = held as { setMeasurement?: unknown };
  return typeof candidate.setMeasurement === 'function' ? (held as PageSentry) : null;
}
