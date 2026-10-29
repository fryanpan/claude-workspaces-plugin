/**
 * When a recording's socket is tried again after it dropped — a server
 * restart, a network blip. Quick at first, then every two seconds, so a
 * server that comes back is found within two seconds of it listening; and
 * given up after two minutes, when the recording ends and says so.
 *
 * No socket here: the session (`voice-session.ts`) says what one attempt is.
 */

/** The wait before each attempt; the last repeats. */
export const REDIAL_STEPS_MS = [250, 500, 1000, 2000] as const;
/** Attempts stop once their waits add up to this. */
export const REDIAL_GIVE_UP_MS = 120_000;

export interface RedialTimers {
  set: (fn: () => void, ms: number) => unknown;
  clear: (h: unknown) => void;
}

export class Redial {
  private handle: unknown = null;
  private tries = 0;
  private waited = 0;

  constructor(private readonly timers: () => RedialTimers) {}

  /** Try `attempt` after the next wait; false when the time is spent. */
  next(attempt: () => void): boolean {
    if (this.waited >= REDIAL_GIVE_UP_MS) return false;
    const ms = REDIAL_STEPS_MS[Math.min(this.tries, REDIAL_STEPS_MS.length - 1)] ?? 2000;
    this.tries += 1;
    this.waited += ms;
    this.cancel();
    this.handle = this.timers().set(() => {
      this.handle = null;
      attempt();
    }, ms);
    return true;
  }

  /** Connected, or ended: the next drop starts from the quick waits again. */
  reset(): void {
    this.cancel();
    this.tries = 0;
    this.waited = 0;
  }

  private cancel(): void {
    if (this.handle !== null) this.timers().clear(this.handle);
    this.handle = null;
  }
}

/** Audio held while the server opens its engine, or while a dropped socket is
 *  opened again: longer than redialling lasts, at the 16kHz the page sends. */
export const MAX_HELD_SAMPLES = 16_000 * 130;

/** The microphone's frames kept until a socket is ready to take them. */
export class HeldAudio {
  private frames: Int16Array[] = [];
  private samples = 0;

  get empty(): boolean {
    return this.frames.length === 0;
  }

  /** Kept unless the cap is reached; past it the newest are dropped. */
  push(pcm: Int16Array): void {
    if (this.samples + pcm.length > MAX_HELD_SAMPLES) return;
    this.frames.push(pcm);
    this.samples += pcm.length;
  }

  /** Every frame held, oldest first, and none held after. */
  drain(): Int16Array[] {
    const out = this.frames;
    this.clear();
    return out;
  }

  clear(): void {
    this.frames = [];
    this.samples = 0;
  }
}
