import { normalizeReviewType } from '@claude-workspaces/core';

/**
 * The two levels a board has, and the one reader of a level off the wire.
 *
 * Its own module rather than a corner of `share-links.ts`, because the store
 * is not the only thing that needs the word: the admission gate decides
 * `requireOwner` from it, two route context modules type a request by it, and
 * the share mint validates one out of a body. A vocabulary three layers spell
 * has no business living inside the one that persists it.
 */
/**
 * What a person may DO on a board they are a member of.
 *
 * Two roles, and the split is the one Bryan asked for on 2026-09-11: a share
 * link stops being a grant of everything he can do. `owner` is the seat that
 * changes who else is in and at what level, and answers the review items that
 * run a command on his machine; `member` — "Regular User" wherever a person
 * reads it — is everything else a board is worked with, which is already
 * generous (see BOARD_MEMBER_ROUTES in `middleware/host-guard.ts`).
 *
 * The BOARD'S OWN OWNER is not a row here at all, and that is the structural
 * half of "a board always has an owner". A board is created from the local
 * surface, by the operator or by their agents, and the operator reaches it as
 * `visitor === null` (loopback, tailnet, LAN) or as an address in
 * `proxiedTrustedEmails` on their own hostname — both of which resolve to
 * `owner` in `boardRoleOf` without any record being written. So the rows here
 * are the people INVITED to a board, and demoting every one of them still
 * leaves the board an owner. Nothing can lock the operator out of their own
 * machine's board, because nothing here is what lets them in.
 *
 * Absent on a record written before roles existed, and absent reads as
 * `member`: the narrower of the two, which is the only safe direction for a
 * field a migration can miss.
 */
export type BoardRole = 'owner' | 'member';

/** The default for a membership that names no role — see `BoardRole`. */
export const DEFAULT_BOARD_ROLE: BoardRole = 'member';

/**
 * A caller-supplied role, or `undefined` when it is not one of the two.
 *
 * Undefined rather than a fallback to `member`, so a route can tell "they did
 * not say" from "they said something we do not understand" and refuse the
 * second. A silent fallback would turn a typo'd `"Owner"` into a demotion.
 */
export function normalizeBoardRole(value: unknown): BoardRole | undefined {
  return value === 'owner' || value === 'member' ? value : undefined;
}

/**
 * The gate on a WRITE onto an owner-only ask — one check, called from every
 * door that can reach one.
 *
 * An ask whose answer the owner's own machine then acts on — running a
 * command, handing over a credential — carries `review.ownerOnly`, and the
 * whole point of the flag is that a Regular User cannot drive it. "Cannot
 * drive it" is not "cannot answer it": a revision rewrites the question the
 * owner will act on, a withdrawal takes it off their queue, a question posted
 * where the answer goes files on its thread. Every one of those is a write on
 * an ask the owner is expected to act on, so every one of them is the owner's.
 *
 * It lives here, beside the vocabulary, because two route families reach it —
 * a task's review items and a doc thread's — and a second copy is how the two
 * spellings of "only the owner" drift. A route under `routes/` may not import
 * another, so the shared name lives with the service (`.claude/rules/
 * code-health.md`).
 *
 * `workspaceId` may be the empty string when a caller's path named no board:
 * that fails CLOSED rather than open, because `boardRoleOf` reads a share
 * visitor's row on a board that holds nobody and answers `member`, while the
 * operator — who is the owner of every board on their own machine — is
 * admitted by a rung that never looks at the id.
 */
export function refuseOwnerOnlyWrite(
  review: { ownerOnly?: true } | undefined,
  workspaceId: string,
  requireOwner: (workspaceId: string) => Response | null,
): Response | null {
  if (review?.ownerOnly !== true) return null;
  return requireOwner(workspaceId);
}

/**
 * Does this body ask for a secret? Read the way the store will read it.
 *
 * Both spellings, because `checkReviewPayload` accepts both: the wire name
 * `review_type` an agent sends and the stored `shape` a peer echoes back.
 * Reading through `normalizeReviewType` rather than comparing strings is what
 * keeps this from missing a spelling the gate would have accepted.
 */
export function asksForSecret(review: unknown): boolean {
  if (typeof review !== 'object' || review === null) return false;
  const r = review as Record<string, unknown>;
  return normalizeReviewType(r.review_type ?? r.shape) === 'secret';
}

/**
 * What a share visitor is told when they file a secret ask. One object, so
 * the two filing doors cannot answer two different sentences.
 *
 * A SHARE LINK IS NOT A SEAT AT THE MACHINE. Filing this shape is not filing
 * a question: it puts a form in front of the board's owner asking them to
 * hand over a value, under names the FILER chose, which this machine then
 * runs a command to store. A link-holder who can do that can phrase an ask
 * for anything and have it arrive in the owner's queue looking exactly like
 * the board's own agents' work. Answering is already the owner's alone; this
 * is the other half, and the two together are what make the whole path
 * reachable only from the board's own side.
 *
 * It is a 403 rather than a silent downgrade to a plain question for the same
 * reason the comment-borne refusal is: the filer has to learn that the ask
 * did not land, or they will wait for an answer nobody was ever shown.
 */
export const SECRET_FILING_DENIAL = {
  error: 'share-visitor',
  message:
    "a 'secret' ask is filed from the board's own side, not through a share link — ask a member of the board to file it",
} as const;

/**
 * What every FREE-TEXT answer door says to a secret ask.
 *
 * The shape's whole claim is that a value reaches the store and nothing else.
 * An answer recorded as words is the opposite of that in every particular: it
 * is written onto the item, into the task file, into the events log and into
 * the activity feed, it is read back by the asking agent, and it closes the
 * ask so nobody comes looking. A surface that renders this item as an ordinary
 * question — and one did, on the task page — hands the reader a box that does
 * all of that with a real value in it.
 *
 * So the refusal lives at the door rather than in the card. A card can be got
 * wrong on one surface and right on another; a door cannot. It names the route
 * that does take the values, because the caller refused here is either a
 * person's browser on a surface that has not caught up or an agent that read
 * the wrong tool, and both need to be sent somewhere rather than stopped.
 */
export const SECRET_ANSWER_DENIAL = {
  error: 'secret-item',
  message:
    "a 'secret' ask is answered by handing the values to its own route (POST …/review-items/<id>/secrets), not by recording words — an answer recorded here is stored, echoed to the feed and read back by the agent",
} as const;
