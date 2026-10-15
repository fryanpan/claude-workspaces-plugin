/**
 * Install the service worker from the doc page, so the next load of this page
 * works with no network (sw-offline.ts says what it keeps).
 *
 * The same `/sw.js` at the same root scope push enrolment registers
 * (push-client.ts), so the two are one registration. The server serves
 * `/sw.js` to trusted hosts only, never to a share or collab visitor
 * (route-table-rows.ts), so on those hosts the registration fails and the page
 * runs exactly as before: nothing is kept for them but the doc copy, which is
 * theirs.
 *
 * The first load of a page happens before any worker controls it, so the
 * worker cannot see the shell and bundles that load fetched. Once the worker
 * is active the page names them, and the worker keeps them — most come
 * straight out of the HTTP cache.
 */

interface WorkerNavigator {
  serviceWorker?: {
    register(url: string, options: { scope: string }): Promise<unknown>;
    ready: Promise<{ active: { postMessage(m: unknown): void } | null }>;
    controller?: unknown;
    addEventListener?(type: string, fn: () => void, options?: { once: boolean }): void;
  };
}

/** Same-origin files this page loaded from `/app/`. */
export function loadedAppFiles(names: readonly string[], origin: string): string[] {
  const out: string[] = [];
  for (const name of names) {
    try {
      const u = new URL(name);
      if (u.origin === origin && u.pathname.startsWith('/app/')) out.push(u.pathname);
    } catch {}
  }
  return out;
}

export function registerOfflineWorker(
  nav: WorkerNavigator = navigator as unknown as WorkerNavigator,
): void {
  const sw = nav.serviceWorker;
  if (!sw) return;
  const keep = (reg: { active: { postMessage(m: unknown): void } | null }): void => {
    const names = performance.getEntriesByType('resource').map((e) => e.name);
    reg.active?.postMessage({
      type: 'keep-page',
      shell: location.pathname,
      assets: loadedAppFiles(names, location.origin),
    });
  };
  // Once more when the worker takes this page over: whatever loaded between
  // the first message and that moment never passed through it either.
  if (!sw.controller) {
    sw.addEventListener?.('controllerchange', () => void sw.ready.then(keep), { once: true });
  }
  sw.register('/sw.js', { scope: '/' })
    .then(() => sw.ready)
    .then(keep)
    .catch(() => {});
}
