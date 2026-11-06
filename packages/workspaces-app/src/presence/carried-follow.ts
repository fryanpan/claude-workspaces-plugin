/**
 * A follow that led to a page outside any board: the review queue or the
 * workspaces list. They are nobody's board, so they hold no room of their
 * own, and without one the follow would end there. So a page like that looks
 * in `sessionStorage` for a follow arriving at its own address, and only then
 * loads the room (`off-board-presence.ts`): a reader who is not following pays
 * for one storage read.
 */
const SLOT = /^cw-follow:(.+)$/;

/** The board whose follow this address continues, or null. */
export function carriedFollowBoard(storage: Storage, address: string): string | null {
  for (let i = 0; i < storage.length; i++) {
    const slot = storage.key(i);
    const board = slot ? SLOT.exec(slot)?.[1] : undefined;
    if (!slot || !board) continue;
    try {
      const v = JSON.parse(storage.getItem(slot) ?? 'null') as { arriving?: string } | null;
      if (v && (!v.arriving || v.arriving === address)) return board;
    } catch {
      // Not ours to read.
    }
  }
  return null;
}

/** Keep the follow going, if one led here. Called once as the page boots. */
export function keepFollowingHere(win: Window = window): void {
  // Read now: the page may rewrite its address as it boots.
  const address = win.location.pathname + win.location.search;
  const board = carriedFollowBoard(win.sessionStorage, address);
  if (!board) return;
  void import('./off-board-presence.ts').then((m) => m.joinOffBoard(board, address, win));
}
