/**
 * Which boards the coach never hears from.
 *
 * The coach session reads what the owner reads and writes, and sends it to
 * the Anthropic API. Some boards must never go there: a client's board, a
 * family member's records. So a board is off when any of these holds, and an
 * event on it is not sent at all, not even the board's title:
 *
 *  - it, or a doc on it, keeps its files on this machine (`local-only`, the
 *    attachment-set and project privacy);
 *  - its sharing lock is on;
 *  - he turned the coach off for it ("Coach off for this board").
 *
 * A member or a share link does not turn a board off. The owner wants the
 * coach to see everything he does (2026-10-16), and what reaches it from a
 * shared board is only his own actions there.
 *
 * A doc is off when it is local-only itself or any board holding it is off.
 * A check that throws counts as off: the question is what may leave the
 * machine, and "could not tell" is not a yes.
 */
import { parseDocKey } from '../doc-key.ts';

export type CoachOffReason = 'local-only' | 'locked' | 'turned-off' | 'unknown';

export interface BoardPrivacy {
  /** The board, or a doc on it, keeps its files on this machine. */
  localOnlyBoard(workspaceId: string): boolean;
  /** The doc's attachment set or project keeps its files on this machine. */
  localOnlyDoc(docId: string): boolean;
  /** The board's sharing lock is on. */
  locked(workspaceId: string): boolean;
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
    return null;
  } catch {
    return 'unknown';
  }
}

/** True when nothing about this place may reach the coach session. */
export function placeIsOff(
  place: CoachPlaceRef,
  privacy: BoardPrivacy,
  turnedOff: ReadonlySet<string>,
): boolean {
  const boardOff = (id: string): boolean => boardOffReason(id, privacy, turnedOff) !== null;
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
  /** The doc's key (`repoKey\0relPath`), if its file is in a project, and
   *  that project's privacy, which is asked by the key's repo half. */
  docKeyOf: (docId: string) => string | undefined;
  projectIsLocalOnly: (repoKey: string) => boolean;
  docIdsOf: (workspaceId: string) => readonly string[];
  isBoardLocked: (workspaceId: string) => boolean;
  boardsOfDoc: (docId: string) => Iterable<string>;
}

export function boardPrivacyFrom(src: BoardPrivacySources): BoardPrivacy {
  const localOnlyDoc = (docId: string): boolean => {
    // A board lists a filed folder bind by the SET's id, not its members',
    // so an id on the board can be a local-only set itself.
    if (src.isLocalOnlySet(docId) || src.isLocalOnlySet(src.setOfDoc(docId))) return true;
    const docKey = src.docKeyOf(docId);
    const repoKey = docKey === undefined ? undefined : parseDocKey(docKey)?.repoKey;
    return repoKey !== undefined && src.projectIsLocalOnly(repoKey);
  };
  return {
    localOnlyDoc,
    localOnlyBoard: (id) => src.isLocalOnlySet(id) || src.docIdsOf(id).some(localOnlyDoc),
    locked: src.isBoardLocked,
    boardsOfDoc: (docId) => [...src.boardsOfDoc(docId)],
  };
}
