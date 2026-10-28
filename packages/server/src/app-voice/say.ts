import { upstreamUrl } from '../app-proxy.ts';
/**
 * `say` from the app voice socket: the write an app's page makes to its own
 * dev server.
 *
 * The page cannot make it itself. A `POST` from the frame to
 * `/workspaces/<ws>/apps/<id>/say` carries `Origin: null` and is refused by
 * the write gate, and the app proxy answers GET and HEAD only
 * (`routes/apps.ts`). So the socket, which the token already admitted, makes
 * it: `POST <origin>/say` with `{"text": …}` as JSON, on the loopback origin
 * the app was attached with, built by `upstreamUrl` like every proxied read.
 * Like those reads, it sends nothing that names the reader — no cookie, no
 * Access assertion, no token — and follows no redirect.
 */
import type { DocStore } from '../doc-store.ts';
import { loopbackFetch } from '../outbound-fetch.ts';

const SAY_TIMEOUT_MS = 10_000;

/** The write to doc `docId`'s dev server, or null when it is not an attached app. */
export function appSayer(
  docStore: Pick<DocStore, 'peekMeta' | 'resolveDocId'>,
  doFetch: typeof fetch = loopbackFetch('attached-app'),
): (docId: string) => ((text: string) => Promise<number>) | null {
  return (docId) => {
    const meta = docStore.peekMeta(docStore.resolveDocId(docId));
    const origin = meta?.type === 'app' ? meta.sourceUrl : undefined;
    const target = origin ? upstreamUrl(origin, 'say', '') : null;
    if (!target) return null;
    return async (text) => {
      const r = await doFetch(target, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
        redirect: 'manual',
        signal: AbortSignal.timeout(SAY_TIMEOUT_MS),
      });
      await r.body?.cancel();
      return r.status;
    };
  };
}
