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

/**
 * The id the Library knows this page's item by, or null when it lists none.
 *
 * A diff review is one Library item, filed on the board under its review id
 * (the doc's `workspaceId`, which only a review's or a folder browse's files
 * carry), so every diff file page answers the REVIEW: a view of any file
 * counts as a view of the review, and the page's star stars the review. A
 * folder browse's files belong to no Library item, so they answer null and
 * the page shows no star. Anything else is its own doc.
 */
export function libraryIdOf(meta: {
  docId: string;
  docType?: string;
  workspaceId?: string;
}): string | null {
  if (!meta.workspaceId) return meta.docId;
  return meta.docType === 'diff' ? meta.workspaceId : null;
}
