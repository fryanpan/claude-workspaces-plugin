import type { DocResourceRouteRequest, DocRoutesContext } from './docs-routes-context.ts';

/**
 * A doc's title, as something a person can change.
 *
 * `PUT /workspaces/<ws>/docs/<docId>/title` and nothing else. A member of the
 * same chain `docs.ts` dispatches, so it inherits the doc resolution and the
 * alias canonicalization every other doc route reads; its own file because
 * the neighbouring modules are read-and-react verbs about a doc's plan, its
 * threads and its edits, and a rename is none of those.
 *
 * **Why this exists at all.** A meeting's title was whatever the clock said
 * when the button was pressed — "Meeting notes 2026-09-11 14:05" — and there
 * was no way to change it afterwards from anywhere. That is fine for the
 * minute the meeting is happening in and useless the week after, when the
 * list of a project's meetings is a column of timestamps. Rule 5 of the docs
 * decision puts meetings on the project's front page beside its documents,
 * and a document nobody can name does not belong on one.
 *
 * It is a rename for any doc, not only a meeting: a title is a title, and a
 * verb that refused to rename a bound project file would be a second rule
 * about what a doc is, enforced in the one place a person can reach.
 *
 * **The gate is trusted-local**, the same one `plan` and `plan-request` sit
 * behind: renaming is a member's seat. A share visitor is refused here as
 * well as by the admission layer, so a later widening of an allowed prefix
 * cannot open it silently.
 *
 * The title is the doc's, never its file's. A bound doc keeps the path it is
 * bound to — the address every comment hangs off — so a rename changes what
 * the doc is CALLED and moves nothing on disk.
 */

/** Longer than this is a paragraph somebody pasted, not a name. */
export const DOC_TITLE_MAX = 200;

export async function handleDocTitleRoute(
  ctx: DocRoutesContext,
  rq: DocResourceRouteRequest,
): Promise<Response | undefined> {
  const { req, visitor, rest, docId } = rq;
  const { j } = ctx;
  if (rest !== 'title') return undefined;
  if (req.method !== 'PUT') return j(405, { error: 'method not allowed' });
  if (visitor) return j(403, { error: 'not available to share visitors' });
  const body = await ctx.safeJson(req);
  const title = body?.title;
  if (typeof title !== 'string') return j(400, { error: 'title is required' });
  // Judged before the store sees it, because the store's refusal is about a
  // title that is empty and this one is about a title that is a document.
  if (title.length > DOC_TITLE_MAX) {
    return j(400, { error: `title must be ${DOC_TITLE_MAX} characters or fewer` });
  }
  const set = ctx.docStore.setTitle(docId, title);
  if (!set.ok) {
    return set.error === 'not-found'
      ? j(404, { error: 'doc not found' })
      : j(400, { error: 'title cannot be blank' });
  }
  return j(200, { docId: set.docId, title: set.title });
}
