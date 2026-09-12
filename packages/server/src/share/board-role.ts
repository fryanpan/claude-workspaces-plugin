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
