/**
 * Signs of a service worker on the keeper's origin, and what removes one.
 *
 * `http://localhost` is a secure context, so a page served there while the
 * port was free can register a worker that answers every keeper URL the
 * owner opens later, and turns the owner's tap on one request into an
 * approval of another. launchd's port job (`keeper-launchd.ts`) keeps the
 * port from being free once it is loaded; this module is for a worker
 * planted before that.
 *
 * Measured in headless Chrome with a worker planted, then the keeper started
 * on the same port (PR 1368's body has the runs):
 *
 * - **A 404 on the worker's script does not remove it.** It still answered
 *   3 of 3 navigations.
 * - **`Clear-Site-Data: "cache", "storage"` on a response removes it** once
 *   the browser receives that response, so every response carries it.
 * - **The update check reaches the keeper** about 1.7s after a navigation the
 *   worker answers, carrying `Service-Worker: script`. The keeper answers it
 *   with a script that unregisters the worker and reloads its pages, and
 *   raises the alarm, which stops approvals and enrollment until the owner
 *   clears it. A worker registered with `updateViaCache: 'all'` and a long
 *   cache lifetime made no update check in the runs; see security.md.
 * - **A navigation a worker passes on arrives as `Sec-Fetch-Mode: navigate`
 *   with `Sec-Fetch-Dest: empty`**, where the browser's own navigation says
 *   `document`. That is evidence too.
 * - **No page of the keeper's ever fetches a page.** Its scripts only post.
 *   So a same-origin browser request for a page that is not a navigation of
 *   the document came from a worker or a planted page, and is evidence.
 *   A request from another site (a frame, a link) is not counted, so a web
 *   page cannot raise the alarm.
 *
 * A local process can send these headers itself and raise the alarm. That
 * only stops approvals until the owner clears it, like the other denials an
 * agent can cause.
 */

/** Sent on every response: removes any worker and cached page for the origin. */
export const CLEAR_SITE_DATA = '"cache", "storage"';

/** What the keeper serves as any worker script: one that removes itself. */
export const REMOVING_WORKER = `self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.registration.unregister()
  .then(() => self.clients.matchAll({ type: 'window' }))
  .then((cs) => Promise.all(cs.map((c) => c.navigate(c.url))))));
`;

const PAGE = /^\/(?:$|approve\/|enroll\/)/;

/** Why this request shows a service worker on the origin, or null. */
export function workerEvidence(req: Request): string | null {
  const path = new URL(req.url).pathname.slice(0, 80);
  const mode = req.headers.get('sec-fetch-mode');
  const dest = req.headers.get('sec-fetch-dest');
  if (req.headers.has('service-worker')) {
    return `the browser asked for a service worker script at ${path}`;
  }
  if (mode === 'navigate' && dest === 'empty') {
    return `a service worker passed on a navigation to ${path}`;
  }
  if (
    req.method === 'GET' &&
    PAGE.test(path) &&
    req.headers.get('sec-fetch-site') === 'same-origin' &&
    !(mode === 'navigate' && dest === 'document')
  ) {
    return `a script on the keeper's origin fetched the page ${path}`;
  }
  return null;
}
