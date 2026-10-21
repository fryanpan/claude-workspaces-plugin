/**
 * The app voice socket: the wire between a served mock or app and the
 * server's `WS /workspaces/<ws>/docs/<docId>/app-voice`.
 *
 * In `core` because both ends read it: the client a page loads with one
 * script tag (`widget/src/app-voice/`) and the server's session
 * (`server/src/app-voice/`). The page sends the JSON below as text frames,
 * and microphone audio as binary PCM16 mono at `APP_VOICE_INPUT_RATE` after
 * a `listen`. The server answers with JSON, and with speech as binary PCM16
 * mono at `APP_VOICE_OUTPUT_RATE` between `speaking` and `spoken`.
 *
 * Nothing said on this socket reaches the board's answerer or any agent. It
 * is a voice and a pair of ears for the page, and `say` is a write to the
 * app's own dev server.
 */

/** The socket's last path segment, under a doc's address. */
export const APP_VOICE_VERB = 'app-voice';

/** The query parameter the socket's token travels in. */
export const APP_VOICE_TOKEN_PARAM = 'token';

/** The attribute on the `<script type="application/json">` the server writes
 *  into a frame that loads the client: the socket's path and its token. */
export const APP_VOICE_SEED_ATTR = 'data-cw-app-voice';

/** The client's file under `/widget/`. A page names it to be given a token. */
export const APP_VOICE_CLIENT_FILE = 'app-voice.js';

/** Speech, as the server sends it. */
export const APP_VOICE_OUTPUT_RATE = 24_000;
/** Microphone audio, as the server expects it. */
export const APP_VOICE_INPUT_RATE = 16_000;

/** The most text one `speak` may carry. */
export const APP_VOICE_SPEAK_MAX = 2_000;
/** The most text one `say` may carry. */
export const APP_VOICE_SAY_MAX = 8_000;
/** The largest audio frame the server reads; a larger one is dropped. */
export const APP_VOICE_AUDIO_FRAME_MAX = 64 * 1024;

/** What the server writes into the frame for the client to read. */
export interface AppVoiceSeed {
  /** The socket's path on the board: `/workspaces/<ws>/docs/<docId>/app-voice`. */
  socket: string;
  token: string;
  /** ms epoch the token stops opening the socket. */
  expiresAt: number;
}

export type AppVoiceClientMessage =
  /** Say `text` aloud. `tone` is accepted and passed to no voice yet. */
  | { type: 'speak'; text: string; tone?: string; id?: string }
  /** Stop speaking now. Audio not yet sent is never sent. */
  | { type: 'stop' }
  /** Start hearing the binary frames that follow. */
  | { type: 'listen' }
  /** Stop hearing. */
  | { type: 'unlisten' }
  /** Deliver `text` to the app's own dev server, as `POST <app>/say`. */
  | { type: 'say'; text: string; id?: string };

export type AppVoiceServerMessage =
  | {
      type: 'ready';
      /** The voice `speak` uses, or null when this server has none. */
      voice: string | null;
      /** Whether `listen` can open a listener here. */
      listen: boolean;
      /** Whether `say` reaches anything: only an attached app has a dev server. */
      say: boolean;
      outputRate: number;
      inputRate: number;
    }
  | { type: 'speaking'; id: string }
  | { type: 'spoken'; id: string; stopped: boolean }
  | { type: 'listening' }
  /** The words of the current turn so far. A later frame replaces it. */
  | { type: 'heard'; text: string }
  /** The listener decided the speaker finished: the whole turn. */
  | { type: 'turn-end'; text: string }
  /** The speaker talked over `speak`, which has stopped. */
  | { type: 'cut-in'; text: string; id: string }
  | { type: 'said'; id: string; status: number }
  /** A fresh token for the next connection; the open socket needs none. */
  | { type: 'token'; token: string; expiresAt: number }
  | { type: 'error'; code: AppVoiceErrorCode; message: string; id?: string };

export type AppVoiceErrorCode =
  | 'bad_message'
  | 'too_long'
  | 'no_voice'
  | 'voice_failed'
  | 'no_listener'
  | 'listener_failed'
  | 'not_an_app'
  | 'say_failed';

const ID = /^[\w.:-]{1,64}$/;

function idOf(v: unknown): { id?: string } {
  return typeof v === 'string' && ID.test(v) ? { id: v } : {};
}

/** One text frame from the page, or null when it is not one of ours. */
export function parseAppVoiceClientMessage(raw: string): AppVoiceClientMessage | null {
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!m || typeof m !== 'object') return null;
  const o = m as Record<string, unknown>;
  switch (o.type) {
    case 'speak':
      if (typeof o.text !== 'string') return null;
      return {
        type: 'speak',
        text: o.text,
        ...(typeof o.tone === 'string' ? { tone: o.tone.slice(0, 64) } : {}),
        ...idOf(o.id),
      };
    case 'say':
      if (typeof o.text !== 'string') return null;
      return { type: 'say', text: o.text, ...idOf(o.id) };
    case 'stop':
    case 'listen':
    case 'unlisten':
      return { type: o.type };
    default:
      return null;
  }
}

/** The seed's JSON, safe inside an inline `<script>`. */
export function appVoiceSeedJson(seed: AppVoiceSeed): string {
  return JSON.stringify(seed).replace(/</g, '\\u003c');
}

/** The seed back off the page, or null when it is not one. */
export function parseAppVoiceSeed(raw: string | null | undefined): AppVoiceSeed | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    if (
      typeof o.socket === 'string' &&
      o.socket.startsWith('/workspaces/') &&
      typeof o.token === 'string' &&
      typeof o.expiresAt === 'number'
    ) {
      return { socket: o.socket, token: o.token, expiresAt: o.expiresAt };
    }
  } catch {}
  return null;
}
