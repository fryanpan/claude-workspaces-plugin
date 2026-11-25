/**
 * The access level a write on a doc's REST subroutes needs, judged once in
 * `handleDocResource` before any subroute runs (`docs.ts`), so a write route
 * added under these prefixes is gated without having to remember to be.
 *
 * - Thread writes (a new thread, a reply, a resolve, a linked item, a
 *   promote) need `comment`.
 * - Writes that change the doc's text need `edit`: a thread's region rewrite
 *   or insert, a suggestion's accept or reject, and every text-edit verb.
 *
 * A read needs nothing here. A subroute not named below (title, metadata,
 * files, components) is not judged by this table.
 */

const TEXT_FROM_THREAD = /^threads\/[^/]+\/(rewrite_region|insert_after|insert_blocks_after)$/;
const TEXT_EDITS = new Set([
  'content',
  'reparse_from_disk',
  'find_and_replace',
  'block_edits',
  'delete_block_at_anchor',
  'delete_blocks_in_range',
  'delete_section',
  'agent_anchors',
]);

/** `rest` is the path after `docs/:docId/`. */
export function docWriteNeed(method: string, rest: string): 'comment' | 'edit' | null {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return null;
  if (rest === 'threads' || rest.startsWith('threads/')) {
    return TEXT_FROM_THREAD.test(rest) ? 'edit' : 'comment';
  }
  if (rest === 'suggestions' || rest.startsWith('suggestions/')) return 'edit';
  if (TEXT_EDITS.has(rest) || rest.startsWith('agent_anchors/')) return 'edit';
  return null;
}
