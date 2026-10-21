/**
 * The app voice client: what a mock or an app on the board loads with one
 * script tag, `<script src="/widget/app-voice.js"></script>`, to speak with
 * the board's voice and hear with its listener.
 *
 * The server writes the socket's path and a token into the page when it
 * serves the frame to the owner (`server/src/app-voice/seed.ts`); this reads
 * them, opens `WS …/app-voice?token=`, and keeps the newest token the server
 * sends, so a reconnect after a drop still opens. Inside the board's sandboxed
 * frame the socket goes through the page holding the frame
 * (`mock-bridge.ts`), like the widget's own; in a page of its own it is a
 * plain socket.
 *
 * The wire is `core/app-voice.ts`. This module is the socket and the
 * bookkeeping; the speaker and the microphone are handed in, so a test can
 * drive it without either (`app-voice-entry.ts` hands in the real ones).
 */
import {
  APP_VOICE_SEED_ATTR,
  APP_VOICE_TOKEN_PARAM,
  type AppVoiceSeed,
  type AppVoiceServerMessage,
  type AppVoiceTone,
  parseAppVoiceSeed,
} from '@claude-workspaces/core/app-voice';

/** What `ready` said this server can do. */
export interface AppVoiceAbilities {
  voice: string | null;
  listen: boolean;
  say: boolean;
}

export interface AppVoicePlayer {
  /** One chunk of PCM16 at the output rate, played after the last one. */
  play(pcm: Uint8Array): void;
  /** Resolves once everything queued has played. */
  drained(): Promise<void>;
  /** Silence now, and drop what is queued. */
  stop(): void;
}

export interface AppVoiceMic {
  stop(): void;
}

export interface AppVoiceEnv {
  WebSocket: new (url: string) => WebSocket;
  /** The page's own address, for the socket's host and scheme. */
  location: { protocol: string; host: string };
  /** The speaker. Null plays nothing; `onAudio` still hears every chunk. */
  player: AppVoicePlayer | null;
  /** Opens the microphone, calling `onFrame` with 16 kHz PCM16 frames. */
  openMic: (onFrame: (pcm: Int16Array) => void) => Promise<AppVoiceMic>;
  /** Reconnect delay. */
  wait?: (ms: number) => Promise<void>;
}

export type AppVoiceEvent = 'heard' | 'turn-end' | 'cut-in' | 'error' | 'audio' | 'close';

export interface SpeakOptions {
  /** A Soniox voice name for this line; it overrides the one
   *  `connect` was given. The server's own voice when neither names one. */
  voice?: string;
  /** One of Soniox's tags, said as `[tone]` ahead of the line. */
  tone?: AppVoiceTone;
}

export interface ConnectOptions {
  /** The voice every line speaks in unless it names another. */
  voice?: string;
}

export interface ListenOptions {
  /** Open the microphone (the default). False listens to `sendAudio` only. */
  mic?: boolean;
}

export interface AppVoice {
  /** What the server can do here. */
  readonly abilities: AppVoiceAbilities;
  /** Say `text`; resolves once it has been said, or stopped. */
  speak(text: string, opts?: SpeakOptions): Promise<{ stopped: boolean }>;
  /** Stop speaking now. */
  stop(): void;
  /** Start hearing. Turns arrive as `heard` and `turn-end` events. */
  listen(opts?: ListenOptions): Promise<void>;
  /** Stop hearing, and close the microphone if this opened it. */
  unlisten(): void;
  /** One frame of 16 kHz PCM16 mono, for a page that captures its own audio. */
  sendAudio(pcm: Int16Array | Uint8Array): void;
  /** Deliver `text` to the app's dev server as `POST <app>/say`; resolves its status. */
  say(text: string): Promise<number>;
  on(event: 'heard' | 'turn-end' | 'cut-in', fn: (text: string) => void): () => void;
  on(event: 'error', fn: (err: { code: string; message: string }) => void): () => void;
  on(event: 'audio', fn: (pcm: Uint8Array) => void): () => void;
  on(event: 'close', fn: () => void): () => void;
  close(): void;
}

/** The seed the server wrote into this page, or null. */
export function readSeed(doc: Pick<Document, 'querySelector'>): AppVoiceSeed | null {
  return parseAppVoiceSeed(doc.querySelector(`script[${APP_VOICE_SEED_ATTR}]`)?.textContent);
}

/** The socket's address for `seed` from a page at `location`. */
export function socketUrl(
  location: { protocol: string; host: string },
  seed: { socket: string; token: string },
): string {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${location.host}${seed.socket}?${APP_VOICE_TOKEN_PARAM}=${encodeURIComponent(seed.token)}`;
}

const RECONNECTS = 5;

type Pending<T> = { resolve: (v: T) => void; reject: (e: Error) => void };

export async function connectAppVoice(
  seed: AppVoiceSeed,
  env: AppVoiceEnv,
  defaults: ConnectOptions = {},
): Promise<AppVoice> {
  const listeners = new Map<AppVoiceEvent, Set<(v: never) => void>>();
  const emit = (event: AppVoiceEvent, v?: unknown): void => {
    for (const fn of listeners.get(event) ?? []) (fn as (x: unknown) => void)(v);
  };
  const wait = env.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let token = { token: seed.token, expiresAt: seed.expiresAt };
  let ws: WebSocket;
  let closed = false;
  let seq = 0;
  let abilities: AppVoiceAbilities = { voice: null, listen: false, say: false };
  const speaking = new Map<string, Pending<{ stopped: boolean }>>();
  const saying = new Map<string, Pending<number>>();
  let wantListen = false;
  let mic: AppVoiceMic | null = null;

  const send = (msg: Record<string, unknown>): void => {
    if (ws.readyState === 1) ws.send(JSON.stringify(msg));
  };

  const onFrame = (m: AppVoiceServerMessage): void => {
    switch (m.type) {
      case 'ready':
        abilities = { voice: m.voice, listen: m.listen, say: m.say };
        return;
      case 'token':
        token = { token: m.token, expiresAt: m.expiresAt };
        return;
      case 'spoken': {
        const p = speaking.get(m.id);
        speaking.delete(m.id);
        if (!p) return;
        if (m.stopped || !env.player) p.resolve({ stopped: m.stopped });
        else void env.player.drained().then(() => p.resolve({ stopped: false }));
        return;
      }
      case 'cut-in':
        env.player?.stop();
        emit('cut-in', m.text);
        return;
      case 'heard':
        emit('heard', m.text);
        return;
      case 'turn-end':
        emit('turn-end', m.text);
        return;
      case 'said': {
        saying.get(m.id)?.resolve(m.status);
        saying.delete(m.id);
        return;
      }
      case 'error': {
        const err = new Error(m.message);
        if (m.id && speaking.has(m.id)) speaking.get(m.id)?.resolve({ stopped: true });
        else if (m.id && saying.has(m.id)) saying.get(m.id)?.reject(err);
        if (m.id) {
          speaking.delete(m.id);
          saying.delete(m.id);
        }
        emit('error', { code: m.code, message: m.message });
        return;
      }
      default:
        return;
    }
  };

  const open = (): Promise<void> =>
    new Promise((resolve, reject) => {
      const sock = new env.WebSocket(socketUrl(env.location, { socket: seed.socket, ...token }));
      sock.binaryType = 'arraybuffer';
      ws = sock;
      let opened = false;
      sock.onmessage = (ev: MessageEvent) => {
        if (typeof ev.data === 'string') {
          let m: AppVoiceServerMessage;
          try {
            m = JSON.parse(ev.data) as AppVoiceServerMessage;
          } catch {
            return;
          }
          onFrame(m);
          if (m.type === 'ready' && !opened) {
            opened = true;
            if (wantListen) send({ type: 'listen' });
            resolve();
          }
          return;
        }
        const pcm = new Uint8Array(ev.data as ArrayBuffer);
        env.player?.play(pcm);
        emit('audio', pcm);
      };
      sock.onclose = () => {
        for (const p of speaking.values()) p.resolve({ stopped: true });
        speaking.clear();
        for (const p of saying.values()) p.reject(new Error('The socket closed.'));
        saying.clear();
        if (!opened) {
          reject(new Error('The app voice socket was refused.'));
          return;
        }
        if (!closed) void reconnect();
      };
    });

  const reconnect = async (): Promise<void> => {
    for (let i = 0; i < RECONNECTS && !closed; i++) {
      await wait(1000 * 2 ** i);
      if (closed || token.expiresAt <= Date.now()) break;
      try {
        await open();
        return;
      } catch {}
    }
    if (!closed) {
      closed = true;
      mic?.stop();
      mic = null;
      emit('close');
    }
  };

  await open();

  function on(event: AppVoiceEvent, fn: (v: never) => void): () => void {
    let set = listeners.get(event);
    if (!set) {
      set = new Set();
      listeners.set(event, set);
    }
    set.add(fn);
    return () => set.delete(fn);
  }

  return {
    get abilities() {
      return abilities;
    },
    speak(text, opts) {
      const id = `s${++seq}`;
      const voice = opts?.voice ?? defaults.voice;
      env.player?.stop();
      return new Promise((resolve, reject) => {
        speaking.set(id, { resolve, reject });
        send({
          type: 'speak',
          text,
          id,
          ...(voice ? { voice } : {}),
          ...(opts?.tone ? { tone: opts.tone } : {}),
        });
      });
    },
    stop() {
      env.player?.stop();
      send({ type: 'stop' });
    },
    async listen(opts) {
      wantListen = true;
      send({ type: 'listen' });
      if (opts?.mic === false || mic) return;
      mic = await env.openMic((pcm) => {
        if (ws.readyState === 1) ws.send(pcm);
      });
    },
    unlisten() {
      wantListen = false;
      mic?.stop();
      mic = null;
      send({ type: 'unlisten' });
    },
    sendAudio(pcm) {
      if (ws.readyState === 1) ws.send(pcm);
    },
    say(text) {
      const id = `w${++seq}`;
      return new Promise((resolve, reject) => {
        saying.set(id, { resolve, reject });
        send({ type: 'say', text, id });
      });
    },
    on: on as AppVoice['on'],
    close() {
      closed = true;
      mic?.stop();
      mic = null;
      env.player?.stop();
      ws.close();
      emit('close');
    },
  };
}
