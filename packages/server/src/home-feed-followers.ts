/**
 * Which boards a Home on another machine follows: those with a home-feed
 * stream open (`routes/home-feed.ts`), or whose feed was read in the last
 * fifteen minutes.
 *
 * `stall-escalation.ts` reads it to decide whether a dead board's owner item
 * should wait a moment for Team Lead on that machine to say it holds the
 * board. A board nobody follows files at once, as it always did, so a server
 * that no Mac pulls is unchanged. Memory only: after a restart a follower is
 * known again as soon as its stream reopens, within seconds.
 */

/** How long after a read a board still counts as followed. */
export const FOLLOW_READ_WINDOW_MS = 15 * 60_000;

export class HomeFeedFollowers {
  private readonly open = new Map<string, number>();
  private readonly readAt = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  /** A feed read. */
  read(boardId: string): void {
    this.readAt.set(boardId, this.now());
  }

  /** A stream opened; the returned function closes it, once. */
  opened(boardId: string): () => void {
    this.open.set(boardId, (this.open.get(boardId) ?? 0) + 1);
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      const n = (this.open.get(boardId) ?? 1) - 1;
      if (n > 0) this.open.set(boardId, n);
      else this.open.delete(boardId);
    };
  }

  followed(boardId: string): boolean {
    if ((this.open.get(boardId) ?? 0) > 0) return true;
    const at = this.readAt.get(boardId);
    return at !== undefined && this.now() - at < FOLLOW_READ_WINDOW_MS;
  }
}
