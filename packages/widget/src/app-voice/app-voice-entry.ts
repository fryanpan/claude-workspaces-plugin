/**
 * `/widget/app-voice.js`: the app voice client on `window.cwAppVoice`, with
 * the browser's speaker and microphone handed in.
 *
 *     <script src="/widget/app-voice.js"></script>
 *     const voice = await cwAppVoice.connect();
 *
 * Inside a served mock or app the server has already written the socket's
 * path and a token into the frame (`server/src/app-voice/seed.ts`). A
 * separate bundle, not part of `widget.iife.js`: only a page that talks
 * loads it.
 */
import { APP_VOICE_OUTPUT_RATE, type AppVoiceSeed } from '@claude-workspaces/core/app-voice';
import { startPcmCapture } from '../voice/voice-audio.ts';
import {
  type AppVoice,
  type AppVoiceMic,
  type AppVoicePlayer,
  connectAppVoice,
  readSeed,
} from './app-voice-client.ts';

/** Plays PCM16 chunks back to back at the output rate. */
function webPlayer(): AppVoicePlayer {
  let ctx: AudioContext | null = null;
  let next = 0;
  let live: AudioBufferSourceNode[] = [];
  let ended: (() => void)[] = [];
  const settle = (): void => {
    if (live.length > 0) return;
    for (const fn of ended) fn();
    ended = [];
  };
  return {
    play(pcm) {
      ctx ??= new AudioContext();
      const n = pcm.length >> 1;
      if (n === 0) return;
      const view = new DataView(pcm.buffer, pcm.byteOffset, n * 2);
      const buf = ctx.createBuffer(1, n, APP_VOICE_OUTPUT_RATE);
      const ch = buf.getChannelData(0);
      for (let i = 0; i < n; i++) ch[i] = view.getInt16(i * 2, true) / 0x8000;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      next = Math.max(next, ctx.currentTime);
      src.start(next);
      next += buf.duration;
      live.push(src);
      src.onended = () => {
        live = live.filter((s) => s !== src);
        settle();
      };
    },
    drained() {
      return live.length === 0 ? Promise.resolve() : new Promise((r) => ended.push(r));
    },
    stop() {
      for (const s of live) {
        s.onended = null;
        try {
          s.stop();
        } catch {}
      }
      live = [];
      next = 0;
      settle();
    },
  };
}

async function openMic(onFrame: (pcm: Int16Array) => void): Promise<AppVoiceMic> {
  const got = await startPcmCapture({ onFrame });
  if (!got.ok) throw new Error(got.message);
  return got.capture;
}

/**
 * Open the socket. With no argument it reads the token the server wrote into
 * this page; a page of its own passes the seed it was handed. `play: false`
 * plays nothing, for a page that takes the `audio` events itself.
 */
function connect(opts: { seed?: AppVoiceSeed; play?: boolean } = {}): Promise<AppVoice> {
  const seed = opts.seed ?? readSeed(document);
  if (!seed) {
    return Promise.reject(
      new Error(
        'No app voice token on this page: it is given to the owner, on a page the board serves.',
      ),
    );
  }
  return connectAppVoice(seed, {
    WebSocket: window.WebSocket,
    location: window.location,
    player: opts.play === false ? null : webPlayer(),
    openMic,
  });
}

(window as unknown as { cwAppVoice: { connect: typeof connect } }).cwAppVoice = { connect };
