import type { BoardRole } from './board-role.ts';

/**
 * The four access levels a person has on a board, and the per-board switch
 * that decides whether the two narrow ones are enforced yet.
 *
 * D1 step 8. `BoardRole` (`board-role.ts`) stays the SEAT: `owner` changes
 * who is in, `member` does everything else. This module adds what a member
 * may do to a doc's CONTENT, as a second field on the membership row rather
 * than as two more words in `BoardRole`: about forty call sites read the seat
 * as `owner | member`, and none of them asks about doc content. The four-word
 * role is derived from the two fields and is what a socket is told at
 * connect and what the members API reads and writes.
 *
 * - `owner`: the seat. Edits docs.
 * - `edit`: a member with no `access` on their row. Edits docs. Every row
 *   written before this field existed reads as `edit`, so nobody loses
 *   anything on deploy.
 * - `comment`: reads docs, and comments through the thread routes, which
 *   stamp the author from the server's identity. Never changes a doc over
 *   its socket.
 * - `view`: reads docs. Never changes one over its socket.
 */
export type AccessRole = 'owner' | 'edit' | 'comment' | 'view';

/** What a membership row stores beside its seat. Absent means `edit`. */
export type MemberAccess = 'comment' | 'view';

/**
 * Whether a board's narrow roles are enforced (`enforce`) or only logged
 * (`report-only`). Every board is `report-only` until its owner turns it on,
 * so a deploy changes no behaviour, and turning it back off is one call.
 */
export type RolesMode = 'report-only' | 'enforce';

export const DEFAULT_ROLES_MODE: RolesMode = 'report-only';

/** The four-word role a seat and a stored access level make. */
export function accessRoleOf(seat: BoardRole, access: MemberAccess | undefined): AccessRole {
  if (seat === 'owner') return 'owner';
  return access ?? 'edit';
}

/**
 * A caller-supplied role, or undefined when it is not one. `member` is
 * accepted as `edit`, because it is what every caller sent before there were
 * four levels and the shared server's routes keep the old payload working.
 */
export function parseAccessRole(value: unknown): AccessRole | undefined {
  if (value === 'member') return 'edit';
  return value === 'owner' || value === 'edit' || value === 'comment' || value === 'view'
    ? value
    : undefined;
}

/** A stored access level as read back off disk; anything else is `edit`. */
export function normalizeMemberAccess(value: unknown): MemberAccess | undefined {
  return value === 'comment' || value === 'view' ? value : undefined;
}

/** The seat and the stored field a four-word role is written as. */
export function seatAndAccess(role: AccessRole): { seat: BoardRole; access?: MemberAccess } {
  if (role === 'owner') return { seat: 'owner' };
  if (role === 'edit') return { seat: 'member' };
  return { seat: 'member', access: role };
}

/** Whether this role may change a doc's content over its socket. */
export function mayEditDocs(role: AccessRole): boolean {
  return role === 'owner' || role === 'edit';
}

/** A caller-supplied mode, or undefined when it is not one of the two. */
export function parseRolesMode(value: unknown): RolesMode | undefined {
  return value === 'report-only' || value === 'enforce' ? value : undefined;
}

/**
 * What a doc or board socket carries about its person's access, stamped at
 * the upgrade (`routes/upgrade-stream.ts`). The role is fixed for the life
 * of the socket — a role change hangs the socket up so it reconnects with
 * the new one — and the mode is read per frame, so an owner switching a
 * board to enforce reaches sockets already open.
 */
export interface SocketAccess {
  role: AccessRole;
  workspaceId: string;
  mode: () => RolesMode;
}
