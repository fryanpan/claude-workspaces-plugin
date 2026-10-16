/**
 * Which boards the coach never hears from.
 *
 * The coach session reads what the owner reads and writes, and sends it to
 * the Anthropic API. Some boards must never go there: a client's board, a
 * board shared with someone else, a family member's records. So a board is
 * off when any of these holds, and an event on it is not sent at all, not
 * even the board's title:
 *
 *  - it, or a doc on it, keeps its files on this machine (`local-only`, the
 *    attachment-set and project privacy);
 *  - its sharing lock is on;
 *  - anyone besides the owner can reach it: a member, a share, a link;
 *  - he turned the coach off for it ("Coach off for this board").
 *
 * The coach session and the plan lead pass `allowShared`: the owner wants the
 * coach to see everything he does (2026-10-16), and what reaches it from a
 * shared board is only his own actions there. The other three still hold.
 *
 * A doc is off when it is local-only itself or any board holding it is off.
 * A check that throws counts as off: the question is what may leave the
 * machine, and "could not tell" is not a yes.
 */

export type CoachOffReason = 'local-only' | 'locked' | 'shared' | 'turned-off' | 'unknown';

export interface BoardPrivacy {
  /** The board, or a doc on it, keeps its files on this machine. */
  localOnlyBoard(workspaceId: string): boolean;
  /** The doc's attachment set or project keeps its files on this machine. */
  localOnlyDoc(docId: string): boolean;
  /** The board's sharing lock is on. */
  locked(workspaceId: string): boolean;
  /** Anyone besides the owner can reach the board. */
  shared(workspaceId: string): boolean;
  /** Every board holding the doc. */
  boardsOfDoc(docId: string): readonly string[];
}

export interface CoachPlaceRef {
  workspaceId: string;
  docId?: string;
}

const safely = (check: () => boolean): boolean => {
  try {
    return check();
  } catch {
    return true;
  }
};

/** Why the coach is off for this board, or null when it may hear from it. */
export function boardOffReason(
  workspaceId: string,
  privacy: BoardPrivacy,
  turnedOff: ReadonlySet<string>,
): CoachOffReason | null {
  if (turnedOff.has(workspaceId)) return 'turned-off';
  try {
    if (privacy.localOnlyBoard(workspaceId)) return 'local-only';
    if (privacy.locked(workspaceId)) return 'locked';
    if (privacy.shared(workspaceId)) return 'shared';
    return null;
  } catch {
    return 'unknown';
  }
}

export interface PlaceOffOptions {
  /** A board shared with someone else still counts as on. The coach
   *  session's feed uses this, and so do the plan lead's rank and goal tag. */
  allowShared?: boolean;
}

/** True when nothing about this place may reach the coach session. */
export function placeIsOff(
  place: CoachPlaceRef,
  privacy: BoardPrivacy,
  turnedOff: ReadonlySet<string>,
  opts: PlaceOffOptions = {},
): boolean {
  const boardOff = (id: string): boolean => {
    const reason = boardOffReason(id, privacy, turnedOff);
    return reason !== null && !(opts.allowShared && reason === 'shared');
  };
  if (boardOff(place.workspaceId)) return true;
  const { docId } = place;
  if (!docId) return false;
  if (safely(() => privacy.localOnlyDoc(docId))) return true;
  let boards: readonly string[];
  try {
    boards = privacy.boardsOfDoc(docId);
  } catch {
    return true;
  }
  return boards.some(boardOff);
}

/** The server's stores, as `boardPrivacyFrom` reads them. */
export interface BoardPrivacySources {
  /** An attachment set (a board is one too) that keeps its files here. */
  isLocalOnlySet: (setId: string | undefined) => boolean;
  setOfDoc: (docId: string) => string | undefined;
  /** The project a doc's file is in, if any, and that project's privacy. */
  repoKeyOf: (docId: string) => string | undefined;
  projectIsLocalOnly: (repoKey: string) => boolean;
  docIdsOf: (workspaceId: string) => readonly string[];
  isBoardLocked: (workspaceId: string) => boolean;
  isBoardShared: (workspaceId: string) => boolean;
  boardsOfDoc: (docId: string) => Iterable<string>;
}

export function boardPrivacyFrom(src: BoardPrivacySources): BoardPrivacy {
  const localOnlyDoc = (docId: string): boolean => {
    if (src.isLocalOnlySet(src.setOfDoc(docId))) return true;
    const repoKey = src.repoKeyOf(docId);
    return repoKey !== undefined && src.projectIsLocalOnly(repoKey);
  };
  return {
    localOnlyDoc,
    localOnlyBoard: (id) => src.isLocalOnlySet(id) || src.docIdsOf(id).some(localOnlyDoc),
    locked: src.isBoardLocked,
    shared: src.isBoardShared,
    boardsOfDoc: (docId) => [...src.boardsOfDoc(docId)],
  };
}
