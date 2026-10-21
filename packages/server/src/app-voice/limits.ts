/**
 * What an app voice socket may spend, and for how long.
 *
 * The socket's token is checked once, at upgrade, and an open socket is sent
 * a fresh one every four minutes (`session.ts`), so the token's ten minutes
 * do not bound anything. These do:
 *
 * - a socket closes after `idleMs` with no `speak`, `say` or audio heard
 *   while listening, and after `lifetimeMs` whatever it does;
 * - a doc has at most `socketsPerDoc` app voice sockets open (`relay.ts`);
 * - the whole server listens at most `dailyListenS` seconds of audio and
 *   speaks at most `dailySpeakChars` characters per UTC day, across every
 *   app voice socket. Past either, `speak` and `listen` answer `daily_cap`
 *   and the engine is not called.
 *
 * The daily counts are held in memory, so a restart starts the day's budget
 * again. The two daily caps can be set with `CW_APP_VOICE_DAILY_LISTEN_S`
 * and `CW_APP_VOICE_DAILY_SPEAK_CHARS`; the defaults cover about four hours
 * of listening and about four hours of speech (Soniox speaks roughly 15
 * characters a second).
 */
import { APP_VOICE_INPUT_RATE } from '@claude-workspaces/core/app-voice';

export interface AppVoiceLimits {
  idleMs: number;
  lifetimeMs: number;
  socketsPerDoc: number;
  dailyListenS: number;
  dailySpeakChars: number;
}

export const APP_VOICE_LIMITS: AppVoiceLimits = {
  idleMs: 10 * 60_000,
  lifetimeMs: 2 * 60 * 60_000,
  socketsPerDoc: 3,
  dailyListenS: 4 * 60 * 60,
  dailySpeakChars: 200_000,
};

/** How often an open socket checks its idle and lifetime limits. */
export const APP_VOICE_LIMIT_CHECK_MS = 30_000;

/** Seconds of audio in `bytes` of PCM16 mono at the socket's input rate. */
export function audioSeconds(bytes: number): number {
  return bytes / 2 / APP_VOICE_INPUT_RATE;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || !/^\d+$/.test(raw.trim())) return fallback;
  const n = Number(raw.trim());
  return n > 0 ? n : fallback;
}

/** The limits, with the two daily caps read from `env`. */
export function appVoiceLimitsFromEnv(env: Record<string, string | undefined>): AppVoiceLimits {
  return {
    ...APP_VOICE_LIMITS,
    dailyListenS: positiveInt(env.CW_APP_VOICE_DAILY_LISTEN_S, APP_VOICE_LIMITS.dailyListenS),
    dailySpeakChars: positiveInt(
      env.CW_APP_VOICE_DAILY_SPEAK_CHARS,
      APP_VOICE_LIMITS.dailySpeakChars,
    ),
  };
}

/** The server's spend on app voice for one UTC day, shared by every socket. */
export class AppVoiceBudget {
  private day = '';
  private listenS = 0;
  private speakChars = 0;
  private warned = false;

  constructor(
    private readonly caps: Pick<AppVoiceLimits, 'dailyListenS' | 'dailySpeakChars'>,
    private readonly now: () => number = Date.now,
    private readonly warn: (line: string) => void = console.warn,
  ) {}

  /** Whether a listener may open: some of today's seconds are left. */
  mayListen(): boolean {
    this.roll();
    if (this.listenS < this.caps.dailyListenS) return true;
    this.hit();
    return false;
  }

  /** Spend `seconds` of listening, or refuse when it would pass the cap. */
  takeListen(seconds: number): boolean {
    this.roll();
    if (this.listenS + seconds > this.caps.dailyListenS) {
      this.hit();
      return false;
    }
    this.listenS += seconds;
    return true;
  }

  /** Spend `chars` of speech, or refuse when it would pass the cap. */
  takeSpeak(chars: number): boolean {
    this.roll();
    if (this.speakChars + chars > this.caps.dailySpeakChars) {
      this.hit();
      return false;
    }
    this.speakChars += chars;
    return true;
  }

  private roll(): void {
    const day = new Date(this.now()).toISOString().slice(0, 10);
    if (day === this.day) return;
    this.day = day;
    this.listenS = 0;
    this.speakChars = 0;
    this.warned = false;
  }

  private hit(): void {
    if (this.warned) return;
    this.warned = true;
    this.warn(
      `[app-voice] daily cap reached on ${this.day} (${this.caps.dailyListenS}s listening, ` +
        `${this.caps.dailySpeakChars} characters spoken): speak and listen refused until 00:00 UTC`,
    );
  }
}
