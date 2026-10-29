/**
 * Which boards the coach never hears from.
 *
 * The coach sees what the owner sees: every board, doc and project, whether
 * it is local-only, sharing-locked or shared (the owner, 2026-10-28: "All
 * boards. Team Lead and Coach may have access to everything I have access
 * to."). The one exception is his own switch: a board he turned off with
 * "Coach off for this board". An event there is not sent at all, not even
 * the board's title.
 *
 * A doc is off when any board holding it is off. When the boards holding a
 * doc cannot be read, the doc counts as off: one of them may be a board he
 * turned off, and "could not tell" is not a yes.
 */

export interface DocBoards {
  /** Every board holding the doc. */
  boardsOfDoc(docId: string): readonly string[];
}

export interface CoachPlaceRef {
  workspaceId: string;
  docId?: string;
}

/** True when nothing about this place may reach the coach session. */
export function placeIsOff(
  place: CoachPlaceRef,
  docBoards: DocBoards,
  turnedOff: ReadonlySet<string>,
): boolean {
  if (turnedOff.has(place.workspaceId)) return true;
  const { docId } = place;
  if (!docId || turnedOff.size === 0) return false;
  try {
    return docBoards.boardsOfDoc(docId).some((id) => turnedOff.has(id));
  } catch {
    return true;
  }
}
