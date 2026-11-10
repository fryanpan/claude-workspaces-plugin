/**
 * The lead chat voice's microphone: one capture for as long as voice is on,
 * the clock that says it sends no sound, and the tap a page with no gesture
 * behind it may need (the reasons are in `lead-chat-voice.ts`). While the
 * page or a frame on it speaks, it sends silence (`page-speech.ts`).
 */
import type { SpokenCapture } from '../board/spoken-reply-audio.ts';
import { startSpokenCapture } from '../board/spoken-reply-audio.ts';
import { makeGestureContext } from '../meeting-audio.ts';
import type { LeadVoiceOpts } from './lead-chat-voice-api.ts';
import { watchPageSpeech } from './page-speech.ts';

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

/** How many frames with sound a check must see before it believes the mic.
 *  A source that just went dead still sends what its graph had buffered (9
 *  blocks in the measurement below, under two 50 ms frames); a live mic
 *  sends 20 a second. */
const SOUNDING_FRAMES = 3;

/**
 * Whether a frame carries any sound. Every check below counts these, never
 * frames: a running graph hands its processor a block every render quantum
 * whatever its source does, and a source whose track ended, was muted, or
 * holds the device and delivers nothing renders zeros. Measured in headless
 * Chrome, 10 Nov: 388 blocks in the second after `track.stop()`, all but 9 of
 * them zero. Counted as frames, those zeros told every check the mic was
 * sending, and an iPhone sat on "Listening…" with the mic light on and no
 * word heard. A live microphone's noise floor is not all zero.
 */
export function carriesSound(pcm: Int16Array): boolean {
  for (let i = 0; i < pcm.length; i++) if (pcm[i] !== 0) return true;
  return false;
}

export interface LeadMicOpts {
  startCapture: LeadVoiceOpts['startCapture'];
  onFrame(pcm: Int16Array): void;
  /** The mic would not open; the words to say. */
  onRefused(message: string): void;
  /** The mic stayed silent; what the track and the context reported. */
  onSilent(detail: string): void;
  /** A tap would start the audio: ask for one. */
  askForTap(): void;
  /** Whether the page or a frame on it is speaking; omitted, `watchPageSpeech`. */
  pageSpeech?: LeadVoiceOpts['pageSpeech'];
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
  /** The page is visible again after iOS put it in the background: check
   *  the mic still sends, and recover it if not (`recheck` below). */
  recheck(): void;
  stop(): void;
}

export function createLeadMic(opts: LeadMicOpts): LeadMic {
  let capture: SpokenCapture | null = null;
  let gen = 0;
  let soundTimer: ReturnType<typeof setTimeout> | null = null;
  let clockTimer: ReturnType<typeof setTimeout> | null = null;
  /** The track is released while an answer is said. */
  let paused = false;
  /** Frames with sound the current capture has made, across its pauses. */
  let framesSeen = 0;
  let tapTimer: ReturnType<typeof setTimeout> | null = null;
  let recheckTimer: ReturnType<typeof setTimeout> | null = null;
  /** A context started outside a tap that is not running yet. */
  let waiting: AudioContext | null = null;
  /** A tap is asked for to rebuild a capture whose own context is unknown. */
  let tapRebuild = false;
  /** The context the current capture was handed, if any. */
  let handed: AudioContext | undefined;
  /** Voice started with no tap, and the one it may ask for has not come. */
  let tapDue = false;
  /** The context says it runs and nothing came: the tap rebuilds the graph. */
  let rebuild = false;
  /** A tap already rebuilt the capture once since voice was turned on. */
  let reopened = false;
  /** How this capture started, for the report. */
  let how = 'started in a tap';
  /** The page or a frame on it is speaking: frames go on as silence, so the
   *  open question hears a quiet room rather than the app's words. */
  let muted = false;
  let unwatch: (() => void) | null = null;

  const clear = (): void => {
    gen++;
    if (soundTimer) clearTimeout(soundTimer);
    soundTimer = null;
    if (clockTimer) clearTimeout(clockTimer);
    clockTimer = null;
    if (recheckTimer) clearTimeout(recheckTimer);
    recheckTimer = null;
    tapRebuild = false;
    paused = false;
    if (tapTimer) clearTimeout(tapTimer);
    tapTimer = null;
    waiting = null;
    capture?.stop();
    capture = null;
  };

  const start = (ctx: AudioContext | undefined): void => {
    const mine = gen;
    /** Frames with sound, and frames of nothing but zeros (`carriesSound`). */
    let frames = 0;
    let zeros = 0;
    framesSeen = 0;
    handed = ctx;
    void (opts.startCapture ?? startSpokenCapture)({
      ...(ctx ? { context: ctx } : {}),
      onFrame: (pcm) => {
        if (carriesSound(pcm)) {
          frames++;
          framesSeen++;
        } else zeros++;
        if (mine === gen) opts.onFrame(muted ? new Int16Array(pcm.length) : pcm);
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
        if (waiting || tapRebuild || paused) {
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
        opts.onSilent(`${said}; ${zeros} frames all zero; ${how}`);
      };
      soundTimer = setTimeout(noSound, NO_SOUND_MS);
    });
  };

  /** Start a capture; `carried` when no tap is behind it, so a context that
   *  does not run asks for one. */
  const begin = (ctx: AudioContext | undefined, carried: boolean): void => {
    tapDue = carried;
    rebuild = false;
    start(ctx);
    if (!carried || !ctx) return;
    tapTimer = setTimeout(() => {
      tapTimer = null;
      // Closed: the graph moved to a context at the mic's rate, which runs.
      if (ctx.state === 'running' || ctx.state === 'closed') return;
      waiting = ctx;
      opts.askForTap();
    }, TAP_WAIT_MS);
  };

  /** Ask for one tap, which rebuilds the capture inside it (`wake`). */
  const askToRebuild = (): void => {
    waiting = handed ?? null;
    tapRebuild = true;
    rebuild = true;
    opts.askForTap();
  };

  /**
   * Back from the background. iOS can end or mute the track there, leave a
   * context `interrupted` or `suspended`, or leave one `running` with its
   * clock stopped. So: resume the context at once, then give the mic
   * `CLOCK_CHECK_MS` to send. If it has not: a track that ended or is muted
   * is reopened (no tap needed while the page may capture; the tap is asked
   * for if its context does not run). Otherwise the context is suspended and
   * resumed, and if that brings nothing either, one tap rebuilds it.
   */
  const recheck = (): void => {
    const held = capture;
    if (!held || waiting || tapRebuild) return;
    void held.resume?.();
    // Released while an answer is said: `unpause` watches the track it takes.
    if (!paused) watch(held, 'after the page came back');
  };

  /** Give `held` `CLOCK_CHECK_MS` to send, then recover it as `recheck`
   *  describes. `when` names the moment, for the report. */
  const watch = (held: SpokenCapture, when: string): void => {
    const mine = gen;
    const before = framesSeen;
    // This check answers for the mic now; a no-sound clock that ran down in
    // the background would only stop voice it can still recover.
    if (soundTimer) clearTimeout(soundTimer);
    soundTimer = null;
    if (recheckTimer) clearTimeout(recheckTimer);
    const look = (kicked: boolean): void => {
      recheckTimer = setTimeout(() => {
        recheckTimer = null;
        if (mine !== gen || paused || waiting) return;
        // Hidden again: the next return checks afresh.
        if (document.visibilityState === 'hidden') return;
        // Read before any frame is believed: an ended or muted track's
        // graph still renders, in zeros.
        const h = held.health?.();
        if (h && (h.track !== 'live' || h.muted)) {
          const kept = how;
          clear();
          how = `${kept}, track ${h.track}${h.muted ? ' and muted' : ''} ${when}, reopened`;
          begin(makeGestureContext(), true);
          return;
        }
        if (framesSeen - before >= SOUNDING_FRAMES) return;
        if (!kicked) {
          how += `, silent ${when}, suspended and resumed`;
          void held.kick?.();
          look(true);
          return;
        }
        askToRebuild();
      }, CLOCK_CHECK_MS);
    };
    look(false);
  };

  return {
    open(ctx, carried) {
      unwatch ??= (opts.pageSpeech ?? watchPageSpeech)((speaking) => {
        muted = speaking;
      });
      reopened = false;
      how = carried ? 'started without a tap' : 'started in a tap';
      begin(ctx, carried);
    },
    wake() {
      const ctx = waiting;
      if (!ctx && !tapRebuild) return false;
      waiting = null;
      tapRebuild = false;
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
        void ctx?.resume().catch(() => {});
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
        // The reopened track has its own chance to send nothing, and is
        // recovered the way a page coming back is.
        watch(held, 'after an answer');
      });
    },
    live: () => capture !== null && !paused,
    recheck,
    stop() {
      clear();
      unwatch?.();
      unwatch = null;
      muted = false;
    },
  };
}
