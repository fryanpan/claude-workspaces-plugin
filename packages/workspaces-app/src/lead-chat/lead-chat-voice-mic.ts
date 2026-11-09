/**
 * The lead chat voice's microphone: one capture for as long as voice is on,
 * the clock that says it sends no sound, and the tap a page with no gesture
 * behind it may need (the reasons are in `lead-chat-voice.ts`).
 */
import type { SpokenCapture } from '../board/spoken-reply-audio.ts';
import { startSpokenCapture } from '../board/spoken-reply-audio.ts';
import { makeGestureContext } from '../meeting-audio.ts';
import type { LeadVoiceOpts } from './lead-chat-voice-api.ts';

/** How long an open mic may send nothing before voice stops and says so. */
const NO_SOUND_MS = 5_000;
/** How long a context started outside a tap has to run before the chat asks
 *  for one. */
const TAP_WAIT_MS = 600;
/** How long an open mic may send nothing before its context's clock is read.
 *  A context that says `running` with its clock still where it started is
 *  not rendering — what Bryan's iPhone reported after a refresh ("context
 *  running … clock 0 s"), and what WebKit bugs 263627 and 276687 describe
 *  once another page's audio lets go of the session. Suspending and resuming
 *  is the workaround both threads report. */
const CLOCK_CHECK_MS = 1_000;

export interface LeadMicOpts {
  startCapture: LeadVoiceOpts['startCapture'];
  onFrame(pcm: Int16Array): void;
  /** The mic would not open; the words to say. */
  onRefused(message: string): void;
  /** The mic stayed silent; what the track and the context reported. */
  onSilent(detail: string): void;
  /** A tap would start the audio: ask for one. */
  askForTap(): void;
}

export interface LeadMic {
  /** Open the mic on a context the tap made, or, with `carried`, a context no
   *  tap has reached. */
  open(ctx: AudioContext | undefined, carried: boolean): void;
  /** Inside a tap: start what was waiting for one. False if nothing was. */
  wake(): boolean;
  /** Let go of the microphone's track while an answer is said, keeping the
   *  graph (`SpokenCapture.pause`). */
  pause(): void;
  /** Take the microphone back after the answer. */
  unpause(): void;
  /** Whether the microphone's track is live now, for the playback report. */
  live(): boolean;
  stop(): void;
}

export function createLeadMic(opts: LeadMicOpts): LeadMic {
  let capture: SpokenCapture | null = null;
  let gen = 0;
  let soundTimer: ReturnType<typeof setTimeout> | null = null;
  let clockTimer: ReturnType<typeof setTimeout> | null = null;
  /** The track is released while an answer is said. */
  let paused = false;
  /** Frames the current capture has made, across its pauses. */
  let framesSeen = 0;
  let tapTimer: ReturnType<typeof setTimeout> | null = null;
  /** A context started outside a tap that is not running yet. */
  let waiting: AudioContext | null = null;
  /** Voice started with no tap, and the one it may ask for has not come. */
  let tapDue = false;
  /** The context says it runs and nothing came: the tap rebuilds the graph. */
  let rebuild = false;
  /** A tap already rebuilt the capture once since voice was turned on. */
  let reopened = false;
  /** How this capture started, for the report. */
  let how = 'started in a tap';

  const clear = (): void => {
    gen++;
    if (soundTimer) clearTimeout(soundTimer);
    soundTimer = null;
    if (clockTimer) clearTimeout(clockTimer);
    clockTimer = null;
    paused = false;
    if (tapTimer) clearTimeout(tapTimer);
    tapTimer = null;
    waiting = null;
    capture?.stop();
    capture = null;
  };

  const start = (ctx: AudioContext | undefined): void => {
    const mine = gen;
    let frames = 0;
    framesSeen = 0;
    void (opts.startCapture ?? startSpokenCapture)({
      ...(ctx ? { context: ctx } : {}),
      onFrame: (pcm) => {
        frames++;
        framesSeen++;
        if (mine === gen) opts.onFrame(pcm);
      },
    }).then((r) => {
      if (mine !== gen) {
        if (r.ok) r.capture.stop();
        return;
      }
      if (!r.ok) {
        opts.onRefused(r.message);
        return;
      }
      capture = r.capture;
      // An answer began while the mic was opening: let go of it now.
      if (paused) r.capture.pause?.();
      const diag = r.capture.diag;
      const startedAt = r.capture.clock?.();
      /** The clock never moved, so a tap's fresh context may run where this
       *  one did not. */
      let frozen = false;
      if (startedAt !== undefined) {
        clockTimer = setTimeout(() => {
          clockTimer = null;
          if (mine !== gen || frames > 0 || waiting) return;
          if (r.capture.clock?.() !== startedAt) return;
          frozen = true;
          how += ', clock stood still, suspended and resumed';
          void r.capture.kick?.();
        }, CLOCK_CHECK_MS);
      }
      // An open mic that makes no frame is a context that never ran — unless
      // it is waiting for the reader's tap, which restarts this clock.
      const noSound = (): void => {
        soundTimer = null;
        if (mine !== gen || frames > 0) return;
        // Released while an answer is said: no frame is owed.
        if (waiting || paused) {
          soundTimer = setTimeout(noSound, NO_SOUND_MS);
          return;
        }
        // A context that says it runs, on a page no tap has reached: the tap
        // can still rebuild the graph, so ask for it before giving up.
        // A clock that stood still through the kick: likewise.
        if (ctx && (tapDue || (frozen && !reopened))) {
          waiting = ctx;
          rebuild = true;
          opts.askForTap();
          soundTimer = setTimeout(noSound, NO_SOUND_MS);
          return;
        }
        // What the mic's track and the graph's context said, so the report
        // answers why (`AudioPump.diag`).
        const said = diag?.() || `context ${ctx?.state ?? 'none'} at ${ctx?.sampleRate ?? 0} Hz`;
        opts.onSilent(`${said}; ${how}`);
      };
      soundTimer = setTimeout(noSound, NO_SOUND_MS);
    });
  };

  return {
    open(ctx, carried) {
      tapDue = carried;
      rebuild = false;
      reopened = false;
      how = carried ? 'started without a tap' : 'started in a tap';
      start(ctx);
      if (!carried || !ctx) return;
      tapTimer = setTimeout(() => {
        tapTimer = null;
        // Closed: the graph moved to a context at the mic's rate, which runs.
        if (ctx.state === 'running' || ctx.state === 'closed') return;
        waiting = ctx;
        opts.askForTap();
      }, TAP_WAIT_MS);
    },
    wake() {
      const ctx = waiting;
      if (!ctx) return false;
      waiting = null;
      tapDue = false;
      const micRate = capture?.offRate?.();
      if (micRate || rebuild) {
        rebuild = false;
        reopened = true;
        how += ', reopened in a tap';
        clear();
        // Made here, inside the tap, at the rate the mic delivers.
        start(makeGestureContext(micRate ?? undefined));
      } else {
        // Inside the gesture: the one call Safari lets start the context.
        void ctx.resume().catch(() => {});
      }
      return true;
    },
    pause() {
      if (capture && !capture.pause) return;
      paused = true;
      capture?.pause?.();
    },
    unpause() {
      const held = capture;
      if (!paused) return;
      paused = false;
      if (!held) return;
      const mine = gen;
      void held.unpause?.().then((ok) => {
        if (mine !== gen || paused) return;
        if (!ok) {
          opts.onRefused('The microphone could not be opened again.');
          return;
        }
        // The reopened track has its own chance to send nothing.
        const before = framesSeen;
        if (soundTimer) clearTimeout(soundTimer);
        soundTimer = setTimeout(() => {
          soundTimer = null;
          if (mine !== gen || paused || framesSeen > before) return;
          const said = held.diag?.() || 'no report';
          opts.onSilent(`${said}; ${how}, reopened after an answer`);
        }, NO_SOUND_MS);
      });
    },
    live: () => capture !== null && !paused,
    stop: clear,
  };
}
