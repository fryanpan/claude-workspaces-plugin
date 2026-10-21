/**
 * The two voices setups 1 and 2 speak with. Each takes the spoken part of a
 * reply and streams PCM16 mono at `SPOKEN_OUTPUT_RATE` to a callback, until
 * the text is said or the caller aborts.
 *
 * PROTOCOLS, checked against the vendors' docs and a live probe (2026-09-29):
 *
 *  - Soniox TTS: `wss://tts-rt.soniox.com/tts-websocket`. The first frame is
 *    a JSON config with the key in `api_key` (it must arrive within ~10s of
 *    connecting); then `{stream_id, text, text_end: true}`. The server answers
 *    `{stream_id, audio: <base64 PCM>}` frames, one with `audio_end: true`,
 *    then `{terminated: true}`; an error carries `error_code`.
 *    `{stream_id, cancel: true}` stops a stream.
 *  - ElevenLabs Flash: `POST /v1/text-to-speech/<voice>/stream` with
 *    `output_format=pcm_24000`, header `xi-api-key`, body
 *    `{text, model_id: 'eleven_flash_v2_5'}`; the response body IS the PCM.
 *    `enable_logging=false` is the zero-retention flag: the request is not
 *    stored and is not used to train. ElevenLabs' docs call it an Enterprise
 *    feature; the probe on this account returned 200 with it set.
 *
 * The keys are read by the caller (`server-deps.ts`) and held in a closure;
 * nothing here logs, throws or returns them.
 */
import { SPOKEN_OUTPUT_RATE } from '@claude-workspaces/core/spoken-reply';
import type { EngineSocket, EngineSocketFactory } from '../transcribe-assemblyai.ts';

/**
 * How one line is said, for the app voice (`app-voice/session.ts`), which
 * has already checked both. Only the Soniox voice reads them: `voice` goes in
 * the config frame and `tone` ahead of the text as a `[tone]` tag. The board's
 * own spoken reply and the meeting voice pass neither, so they keep
 * `SONIOX_TTS_VOICE`.
 */
export interface SpeakAs {
  voice?: string;
  tone?: string;
}

export interface SpokenVoice {
  readonly name: string;
  /**
   * Say `text`, streaming PCM16 chunks to `onAudio`. Resolves when the voice
   * has sent its last chunk, or when `signal` aborts (without error).
   */
  speak(
    text: string,
    onAudio: (pcm: Uint8Array) => void,
    signal: AbortSignal,
    as?: SpeakAs,
  ): Promise<void>;
}

const SONIOX_TTS_URL = 'wss://tts-rt.soniox.com/tts-websocket';
export const SONIOX_TTS_MODEL = 'tts-rt-v2';
export const SONIOX_TTS_VOICE = 'Adrian';
const SPEAK_TIMEOUT_MS = 20_000;

function textSocketFactory(args: Parameters<EngineSocketFactory>[0]): EngineSocket {
  const ws = new WebSocket(args.url);
  ws.addEventListener('open', () => args.onOpen());
  ws.addEventListener('message', (ev: MessageEvent) => {
    if (typeof ev.data === 'string') args.onMessage(ev.data);
  });
  ws.addEventListener('error', () => args.onError('websocket error'));
  ws.addEventListener('close', () => args.onClose());
  return {
    send: (data) => ws.send(data),
    close: () => ws.close(),
  };
}

/**
 * What a Soniox voice sends back. `pcm` is PCM16 for a page to play; `mp3`
 * is for a meeting bot, because Recall's `output_audio` takes nothing else.
 * MP3 at 24 kHz and 64 kbps: a 25-word line is about 60KB, well inside
 * Recall's body cap. Soniox's audio-formats page lists both values.
 */
export type SonioxAudio = 'pcm' | 'mp3';

/** The config frame's non-secret fields; the key is added at send time. */
export function sonioxTtsConfig(
  streamId: string,
  audio: SonioxAudio = 'pcm',
  voice: string = SONIOX_TTS_VOICE,
): Record<string, unknown> {
  return {
    stream_id: streamId,
    model: SONIOX_TTS_MODEL,
    language: 'en',
    voice,
    ...(audio === 'mp3'
      ? { audio_format: 'mp3', sample_rate: SPOKEN_OUTPUT_RATE, bitrate: 64_000 }
      : { audio_format: 'pcm_s16le', sample_rate: SPOKEN_OUTPUT_RATE }),
  };
}

export function createSonioxVoice(opts: {
  apiKey: string;
  socketFactory?: EngineSocketFactory;
  timeoutMs?: number;
  audio?: SonioxAudio;
}): SpokenVoice {
  const makeSocket = opts.socketFactory ?? textSocketFactory;
  const timeoutMs = opts.timeoutMs ?? SPEAK_TIMEOUT_MS;
  let seq = 0;
  return {
    name: opts.audio === 'mp3' ? 'soniox-mp3' : 'soniox',
    speak(text, onAudio, signal, as) {
      const said = as?.tone ? `[${as.tone}] ${text}` : text;
      return new Promise<void>((resolve, reject) => {
        if (signal.aborted) return resolve();
        const streamId = `s${++seq}`;
        let done = false;
        const finish = (err?: Error): void => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
          try {
            socket.close();
          } catch {
            // Already closed.
          }
          if (err) reject(err);
          else resolve();
        };
        const onAbort = (): void => {
          try {
            socket.send(JSON.stringify({ stream_id: streamId, cancel: true }));
          } catch {
            // The socket may not be open yet; closing it is enough.
          }
          finish();
        };
        const timer = setTimeout(() => finish(new Error('soniox tts: timed out')), timeoutMs);
        timer.unref?.();
        const socket = makeSocket({
          url: SONIOX_TTS_URL,
          headers: {},
          onOpen: () => {
            socket.send(
              JSON.stringify({
                api_key: opts.apiKey,
                ...sonioxTtsConfig(streamId, opts.audio, as?.voice),
              }),
            );
            socket.send(JSON.stringify({ stream_id: streamId, text: said, text_end: true }));
          },
          onMessage: (raw) => {
            if (done) return;
            let msg: Record<string, unknown>;
            try {
              msg = JSON.parse(raw) as Record<string, unknown>;
            } catch {
              return;
            }
            if (msg.error_code !== undefined) {
              const detail = typeof msg.error_message === 'string' ? msg.error_message : 'error';
              finish(new Error(`soniox tts: ${detail}`));
              return;
            }
            if (typeof msg.audio === 'string' && msg.audio.length > 0) {
              onAudio(new Uint8Array(Buffer.from(msg.audio, 'base64')));
            }
            if (msg.audio_end === true || msg.terminated === true) finish();
          },
          onError: (m) => finish(new Error(`soniox tts: ${m}`)),
          onClose: () => finish(),
        });
        signal.addEventListener('abort', onAbort);
      });
    },
  };
}

const ELEVENLABS_URL = 'https://api.elevenlabs.io/v1/text-to-speech';
/** A stock ElevenLabs voice ("George"), not a clone of anybody. */
export const ELEVENLABS_VOICE_ID = 'JBFqnCBsd6RMkjVDRZzb';
export const ELEVENLABS_MODEL = 'eleven_flash_v2_5';

/** The request URL, exported so a test can hold the retention flag still. */
export function elevenLabsUrl(voiceId = ELEVENLABS_VOICE_ID): string {
  return `${ELEVENLABS_URL}/${voiceId}/stream?output_format=pcm_${SPOKEN_OUTPUT_RATE}&enable_logging=false`;
}

export function createElevenLabsVoice(opts: {
  apiKey: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): SpokenVoice {
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? SPEAK_TIMEOUT_MS;
  return {
    name: 'elevenlabs',
    async speak(text, onAudio, signal) {
      if (signal.aborted) return;
      const timeout = AbortSignal.timeout(timeoutMs);
      const both = AbortSignal.any([signal, timeout]);
      let res: Response;
      try {
        res = await doFetch(elevenLabsUrl(), {
          method: 'POST',
          headers: { 'xi-api-key': opts.apiKey, 'content-type': 'application/json' },
          body: JSON.stringify({ text, model_id: ELEVENLABS_MODEL }),
          signal: both,
        });
      } catch (err) {
        if (signal.aborted) return;
        throw new Error(`elevenlabs: ${timeout.aborted ? 'timed out' : 'request failed'}`, {
          cause: err,
        });
      }
      if (!res.ok || !res.body) {
        // The status only: an error body may echo the request.
        throw new Error(`elevenlabs: HTTP ${res.status}`);
      }
      const reader = res.body.getReader();
      // PCM16 is two bytes a sample; a chunk boundary can split one, so an
      // odd byte waits for the next chunk.
      let carry: Uint8Array | null = null;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done || signal.aborted) break;
          let bytes: Uint8Array = value;
          if (carry) {
            const joined = new Uint8Array(carry.length + bytes.length);
            joined.set(carry);
            joined.set(bytes, carry.length);
            bytes = joined;
            carry = null;
          }
          const even = bytes.length - (bytes.length % 2);
          if (even < bytes.length) carry = bytes.slice(even);
          if (even > 0) onAudio(bytes.subarray(0, even));
        }
      } catch (err) {
        if (!signal.aborted) throw new Error('elevenlabs: stream failed', { cause: err });
      } finally {
        reader.releaseLock();
      }
    },
  };
}
