/**
 * The addresses a person is handed for things on a board, and the two
 * lookups that turn a wrong address into the right one.
 *
 * Three reports on 8 and 9 November, all from the owner's phone, came down to
 * links that named the right thing in a form nothing served:
 *
 *  - `/workspaces/<ws>/review/<reviewItemId>` — a review item has no page of
 *    its own; it opens on Home's walkthrough as `home?item=<key>`.
 *  - `[note](../dir/plan.md)` in a reply — a path in the agent's checkout,
 *    which a browser resolves against the page it is on.
 *  - `add_review_item` answered with the TASK's link, so the agent had no
 *    link to the item to hand on and built one.
 *
 * `reviewItemPath` is the one spelling of an item's link; the add and revise
 * routes return it and `routes/board-links.ts` redirects the wrong spellings
 * to it. `resolveRelativeLink` picks the doc on a board that a relative path
 * names. Both are pure, so the rules are tested without a server.
 */
import { posix } from 'node:path';
import { LEGACY_REVIEW_ITEM_ID } from './review-items/derive.ts';

/** The key Home's queue knows an item by (`board-review-model.ts`, and
 *  `rowKey` in `cross-review-queue.ts`). A ticket's own decision has no item
 *  id of its own and is keyed by its task. */
export function taskReviewItemKey(taskId: string, reviewItemId: string): string {
  return reviewItemId === LEGACY_REVIEW_ITEM_ID
    ? `decision:${taskId}`
    : `task-review:${taskId}:${reviewItemId}`;
}

/** The key of an ask raised on a doc's thread. A task's own doc is a task
 *  thread; every other doc's thread is a doc thread. */
export function threadReviewItemKey(docId: string, threadId: string): string {
  const kind = docId.startsWith('task:') ? 'task-thread' : 'doc-thread';
  return `${kind}:${docId}:${threadId}`;
}

/**
 * The page that shows one review item: Home, with the walkthrough on it.
 *
 * Relative, like `taskDeepLink`: a caller that hands it to a person outside
 * the board prefixes `externalBaseUrl()`. When the item has left the queue
 * (answered, withdrawn, or held by the quality gate) the board opens the task
 * the key names instead — `board-deep-links.ts`.
 */
export function reviewItemPath(workspaceId: string, key: string): string {
  return `/workspaces/${encodeURIComponent(workspaceId)}/home?item=${encodeURIComponent(key)}`;
}

/** One doc on a board, with every path its file is known by: the absolute
 *  bound path, and the path from its repo or folder root. */
export interface LinkCandidate {
  docId: string;
  paths: readonly string[];
}

export type RelativeLinkMatch =
  | { kind: 'one'; docId: string }
  | { kind: 'many'; docIds: string[] }
  | { kind: 'none' };

/** The longest path the open route will read. A link is pasted, and a path
 *  longer than this is not one a doc on a board is bound to. */
export const RELATIVE_LINK_MAX = 1024;

/**
 * Which doc on a board a relative link names.
 *
 * Two passes, the exact one first:
 *
 *  1. Resolved against the file of the doc the link was written on (`from`),
 *     when that doc has one: `../dir/plan.md` written on `docs/a/notes.md`
 *     means `docs/dir/plan.md`, and only a doc bound to exactly that file
 *     answers.
 *  2. Otherwise the path's own segments, with every `.` and `..` dropped, as
 *     a SUFFIX of a candidate's path, cut at a `/`. An agent writes the path
 *     from its own checkout, which the server cannot see; the tail of it is
 *     what a doc's file shares. `plan.md` would match every `plan.md` on the
 *     board, so more than one hit is reported as many rather than guessed.
 *
 * Nothing here touches the filesystem. A path is only ever compared with the
 * paths of docs already on the board, so a hostile value can match nothing
 * the board does not already show.
 */
export function resolveRelativeLink(
  raw: string,
  candidates: readonly LinkCandidate[],
  fromPaths: readonly string[] = [],
): RelativeLinkMatch {
  const clean = cleanLinkPath(raw);
  if (clean === null) return { kind: 'none' };

  for (const from of fromPaths) {
    if (!from.startsWith('/')) continue;
    const target = posix.resolve(posix.dirname(from), clean);
    const hits = unique(candidates.filter((c) => c.paths.includes(target)));
    if (hits.length > 0) return verdict(hits);
  }

  const segs = clean.split('/').filter((s) => s !== '' && s !== '.' && s !== '..');
  if (segs.length === 0) return { kind: 'none' };
  const suffix = segs.join('/');
  return verdict(
    unique(candidates.filter((c) => c.paths.some((p) => p === suffix || p.endsWith(`/${suffix}`)))),
  );
}

/** The path part of a link: no fragment or query, `%`-escapes decoded,
 *  backslashes as slashes. Null for nothing usable. */
function cleanLinkPath(raw: string): string | null {
  if (raw.length === 0 || raw.length > RELATIVE_LINK_MAX) return null;
  const bare = raw.split(/[?#]/, 1)[0] ?? '';
  let decoded: string;
  try {
    decoded = decodeURIComponent(bare);
  } catch {
    return null;
  }
  // A NUL or another control character is in no file name a doc is bound to.
  for (const ch of decoded) if (ch.charCodeAt(0) < 0x20) return null;
  const slashed = decoded.replace(/\\/g, '/').trim();
  return slashed === '' ? null : slashed;
}

function unique(hits: readonly LinkCandidate[]): string[] {
  return [...new Set(hits.map((h) => h.docId))];
}

function verdict(docIds: string[]): RelativeLinkMatch {
  if (docIds.length === 0) return { kind: 'none' };
  if (docIds.length === 1 && docIds[0] !== undefined) return { kind: 'one', docId: docIds[0] };
  return { kind: 'many', docIds };
}

/** What `linkCandidateOf` reads off a doc's meta. */
export interface LinkCandidateMeta {
  docId: string;
  sourceUrl?: string;
  relPath?: string;
  workspaceRoot?: string;
  docHome?: { repoRoot: string; relPath: string };
}

/**
 * Every path a doc's file is known by: its bound path (`sourceUrl`, when that
 * is a file rather than a dev server's URL), its path from its folder root,
 * and its path in its home repo. A relative link written in any of those
 * checkouts ends in one of them.
 */
export function linkCandidateOf(meta: LinkCandidateMeta): LinkCandidate {
  const paths = new Set<string>();
  const src = meta.sourceUrl;
  if (src && !/^[a-z][a-z0-9+.-]*:/i.test(src)) paths.add(src);
  if (meta.relPath) {
    paths.add(meta.relPath);
    if (meta.workspaceRoot) paths.add(posix.join(meta.workspaceRoot, meta.relPath));
  }
  if (meta.docHome) {
    paths.add(meta.docHome.relPath);
    paths.add(posix.join(meta.docHome.repoRoot, meta.docHome.relPath));
  }
  return { docId: meta.docId, paths: [...paths] };
}
