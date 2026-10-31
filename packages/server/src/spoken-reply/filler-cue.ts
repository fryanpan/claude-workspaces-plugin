/**
 * A short spoken cue when the answer is slow, so a silence never reads as a
 * broken mic.
 *
 * Armed when the question ends. If the answer is not ready `FILLER_CUE_AFTER_MS`
 * later, the cue says what the server is doing ("Checking the board.") in the
 * setup's voice, opening the reply's audio stream; the answer then continues
 * that same stream, so the page plays the two back to back and never
 * overlaps them. When the answer arrives first, nothing is said. When it
 * arrives after the cue was asked for but before any of its audio was sent,
 * the cue is dropped and the answer goes straight out.
 *
 * It never talks over the speaker: the turn's `live()` check is read before
 * every chunk, so a new question or a `stop` silences it at once, and a turn
 * with nothing heard is never armed.
 */
import { SPOKEN_OUTPUT_RATE, type SpokenServerMessage } from '@claude-workspaces/core/spoken-reply';
import { type GateTimers, REAL_TIMERS } from './pause-gate.ts';
import type { SpokenVoice } from './tts.ts';

/** How long after the question ends a still-missing answer gets a cue. */
export const FILLER_CUE_AFTER_MS = 1200;

const CUES: ReadonlyArray<[RegExp, string]> = [
  [/\breview/i, 'Checking your reviews.'],
  [/\bgoals?\b/i, 'Checking the goals.'],
  [/\btasks?\b/i, 'Checking the tasks.'],
];

/** The cue for a question: the part of the board the answer is read from. */
export function cueFor(heard: string): string {
  for (const [pattern, cue] of CUES) if (pattern.test(heard)) return cue;
  return 'Checking the board.';
}

export interface FillerCueDeps {
  voice: SpokenVoice;
  heard: string;
  /** False once the turn this cue belongs to is over. */
  live(): boolean;
  sendJson(msg: SpokenServerMessage): void;
  sendAudio(pcm: Uint8Array): void;
  timers?: GateTimers;
  afterMs?: number;
}

export class FillerCue {
  private readonly timers: GateTimers;
  private timer: unknown = null;
  private readonly ctl = new AbortController();
  private speaking: Promise<void> | null = null;
  private opened = false;
  private handedOver = false;
  private cancelled = false;
  private bytes = 0;

  constructor(private readonly d: FillerCueDeps) {
    this.timers = d.timers ?? REAL_TIMERS;
    if (!d.heard.trim()) return;
    this.timer = this.timers.set(() => this.fire(), d.afterMs ?? FILLER_CUE_AFTER_MS);
  }

  /** How long the cue that was sent plays, in ms; 0 when none was. */
  get playedMs(): number {
    return Math.round((this.bytes / 2 / SPOKEN_OUTPUT_RATE) * 1000);
  }

  /**
   * The answer is ready. Resolves once nothing more of the cue will be sent,
   * true when the cue opened the audio stream, so the answer continues it
   * with no `audio-start` of its own and must end it with `audio-end`.
   */
  async ready(): Promise<boolean> {
    this.clearTimer();
    if (this.speaking && !this.opened) this.ctl.abort();
    await this.speaking;
    this.handedOver = this.opened && !this.cancelled && this.d.live();
    return this.handedOver;
  }

  /** The turn is over or the speaker cut in: silence the cue now. */
  cancel(): void {
    this.clearTimer();
    this.ctl.abort();
    if (this.opened && !this.handedOver && !this.cancelled) this.d.sendJson({ type: 'audio-end' });
    this.cancelled = true;
  }

  private on(): boolean {
    return !this.ctl.signal.aborted && this.d.live();
  }

  private fire(): void {
    this.timer = null;
    if (!this.on()) return;
    this.speaking = this.d.voice
      .speak(
        cueFor(this.d.heard),
        (pcm) => {
          if (!this.on()) return;
          if (!this.opened) {
            this.opened = true;
            this.d.sendJson({ type: 'audio-start', sampleRate: SPOKEN_OUTPUT_RATE });
          }
          this.bytes += pcm.byteLength;
          this.d.sendAudio(pcm);
        },
        this.ctl.signal,
      )
      // A cue that fails costs nothing: the answer still goes out.
      .catch(() => {});
  }

  private clearTimer(): void {
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
  }
}
