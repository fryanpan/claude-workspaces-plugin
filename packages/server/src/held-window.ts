/**
 * A window that holds what arrives and hands it over in one batch.
 *
 * Every frame an agent receives is a session turn, so a feed that sends one
 * frame per event costs one turn per event (the coach measured 86 turns in
 * five hours with nothing said). The first item opens a window; when the
 * window closes, everything it held goes out together. A quiet stretch opens
 * no window and sends nothing.
 *
 * Two feeds use it: the coach session's digest (`coach/session-feed.ts`) and
 * the plan lead's new-asks feed (`ask-feed.ts`). The clock and the timer are
 * injected so a test moves time by hand.
 */

export interface HeldWindowDeps<T> {
  /** How long a window stays open. */
  windowMs: number;
  /** The held items, oldest first, with when the window opened and closed. */
  close: (items: T[], from: number, to: number) => void;
  now?: () => number;
  /** Runs `fn` after `ms`; answers a cancel. Defaults to an unref'd timer. */
  schedule?: (fn: () => void, ms: number) => () => void;
}

const timer = (fn: () => void, ms: number): (() => void) => {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return () => clearTimeout(t);
};

export class HeldWindow<T> {
  private held: T[] = [];
  private openedAt = 0;
  private cancel: (() => void) | null = null;

  constructor(private readonly deps: HeldWindowDeps<T>) {}

  /** Adds an item, opening a window if none is open. */
  hold(item: T): void {
    this.held.push(item);
    if (this.cancel) return;
    this.openedAt = (this.deps.now ?? Date.now)();
    this.cancel = (this.deps.schedule ?? timer)(() => this.flush(), this.deps.windowMs);
  }

  /** Whether a window is open now. */
  open(): boolean {
    return this.cancel !== null;
  }

  /** Drops a window still open, sending nothing. */
  stop(): void {
    this.cancel?.();
    this.cancel = null;
    this.held = [];
  }

  /** What an open window holds and when it opened, or null. Read so a feed
   *  can keep it across a restart. */
  snapshot(): { items: T[]; openedAt: number } | null {
    return this.cancel ? { items: [...this.held], openedAt: this.openedAt } : null;
  }

  /** Closes an open window now, handing it over as its timer would. */
  closeNow(): void {
    if (this.cancel) {
      this.cancel();
      this.flush();
    }
  }

  /** Opens a window a restart interrupted: it closes when it would have,
   *  or at once if that time has passed. */
  resume(items: T[], openedAt: number): void {
    if (this.cancel || items.length === 0) return;
    this.held = [...items];
    this.openedAt = openedAt;
    const left = Math.max(0, openedAt + this.deps.windowMs - (this.deps.now ?? Date.now)());
    this.cancel = (this.deps.schedule ?? timer)(() => this.flush(), left);
  }

  private flush(): void {
    const items = this.held;
    this.cancel = null;
    this.held = [];
    this.deps.close(items, this.openedAt, (this.deps.now ?? Date.now)());
  }
}
