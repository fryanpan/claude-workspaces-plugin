import type { User } from '@claude-workspaces/core';
import { asBackgroundWrite } from './signin/write-gate.ts';

/**
 * Tell the board a person opened one of its items, for the Library's
 * Recently Viewed list (`packages/server/src/routes/workspace-library-views.ts`).
 *
 * Called by the pages a person opens — a doc of any kind, a mock, a
 * whiteboard — once per arrival. Fire-and-forget: a refusal has nothing to
 * show the reader. The server records it only for a browser request whose
 * author is a person, so an agent's read never lands here at all.
 */
export function recordLibraryView(
  workspaceId: string,
  docId: string,
  author?: Pick<User, 'id' | 'name' | 'kind'>,
): void {
  const url = `/workspaces/${encodeURIComponent(workspaceId)}/library/views`;
  try {
    // The app's idea, not the reader's: a sign-in refusal shows the standing
    // bar rather than a modal about something they never did.
    asBackgroundWrite(() => {
      void fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ docId, ...(author ? { author } : {}) }),
        keepalive: true,
      }).catch(() => {});
    });
  } catch {
    // Best-effort; never throw from a page's arrival.
  }
}
