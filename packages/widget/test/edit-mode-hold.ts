/**
 * A helper for `edit-mode-driver.ts`, split out for size: it pauses the edit
 * send's answer over CDP so the driver can reload inside the gap.
 */
// audit: no-text
import type { Cdp } from '../../../scripts/headless-chrome.ts';

/**
 * Hold the Send's answer until the page has reloaded.
 *
 * The board stores the thread before it answers, so a reader who reloads in
 * that gap reloads a page that never heard its send succeed. On a loaded
 * runner the gap is wide enough to land in by accident; this makes every run
 * land in it. The answer is paused at the Response stage on every target
 * that could send it (the page, and a mock's frame), and released — into a
 * page that is gone — once `release` is called.
 */
export async function holdSendAnswer(
  cdp: Cdp,
  sessions: readonly string[],
): Promise<{ held: () => number; release: () => Promise<void> }> {
  const paused: Array<{ requestId: string; sessionId?: string }> = [];
  const targets: Array<string | undefined> = [undefined, ...sessions];
  cdp.on('Fetch.requestPaused', (p, sessionId) => {
    const requestId = p.requestId as string;
    // A cross-origin send is preceded by its preflight; only the POST waits.
    if ((p.request as { method?: string } | undefined)?.method !== 'POST') {
      void cdp.send('Fetch.continueRequest', { requestId }, sessionId).catch(() => {});
      return;
    }
    paused.push({ requestId, ...(sessionId ? { sessionId } : {}) });
  });
  for (const t of targets) {
    await cdp
      .send(
        'Fetch.enable',
        { patterns: [{ urlPattern: '*/threads', requestStage: 'Response' }] },
        t,
      )
      .catch(() => {});
  }
  return {
    held: () => paused.length,
    release: async () => {
      for (const r of paused.splice(0)) {
        await cdp
          .send('Fetch.continueRequest', { requestId: r.requestId }, r.sessionId)
          .catch(() => {});
      }
      for (const t of targets) await cdp.send('Fetch.disable', {}, t).catch(() => {});
    },
  };
}
