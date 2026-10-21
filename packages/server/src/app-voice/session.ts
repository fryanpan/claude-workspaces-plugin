/**
 * One app voice socket: a voice, a pair of ears, and a write to the app's
 * dev server, for a mock or app on the board (`core/app-voice.ts` is the
 * wire).
 *
 *  - `speak` says the text with the server's spoken-reply voice, setup 1's
 *    Soniox `tts-rt-v2` when this server has the key, else setup 2's. A new
 *    `speak` stops the one before it. `tone` is read and given to no voice:
 *    neither takes one.
 *  - `listen` opens the spoken reply's listener with its tap tuning, so the
 *    listener's own end of speech, at most 500 ms after the last word, ends
 *    each turn. Every frame is sent as `heard`, and a final one is followed
 *    by `turn-end`. The listener stays open for the next turn. Words heard
 *    while `speak` is still sending, which are not its own echo, stop it
 *    and send `cut-in` (`spoken-reply/cut-in.ts`). Nothing heard goes to the
 *    board's answerer or to any agent.
 *  - `say` posts `{text}` to `<app>/say` on the app's dev server
 *    (`say.ts`), and answers with the status it got.
 *
 * The billed engines are the ones `server-deps.ts` built for the spoken
 * reply; a test server is handed scripted ones.
 */
import {
  APP_VOICE_AUDIO_FRAME_MAX,
  APP_VOICE_INPUT_RATE,
  APP_VOICE_OUTPUT_RATE,
  APP_VOICE_SAY_MAX,
  APP_VOICE_SPEAK_MAX,
  type AppVoiceServerMessage,
  parseAppVoiceClientMessage,
} from '@claude-workspaces/core/app-voice';
import { cutsIn, hasWords } from '../spoken-reply/cut-in.ts';
import { SPOKEN_TAP_TUNING } from '../spoken-reply/session.ts';
import type { SpokenVoice } from '../spoken-reply/tts.ts';
import type { EngineTurn, TranscriptionEngine, TranscriptionSession } from '../transcribe.ts';
import { APP_VOICE_TOKEN_REFRESH_MS } from './token.ts';

/** Audio held while the listener connects: 20s of 50ms frames. */
const MAX_BUFFERED_FRAMES = 400;

export interface AppVoiceSessionDeps {
  voice: SpokenVoice | null;
  listener: TranscriptionEngine | null;
  /** Posts to the app's dev server and resolves its status; null when the
   *  doc is not an attached app. */
  say: ((text: string) => Promise<number>) | null;
  sendJson(msg: AppVoiceServerMessage): void;
  sendAudio(pcm: Uint8Array): void;
  /** A fresh token for this socket's doc. */
  freshToken(): { token: string; expiresAt: number };
  /** The refresh clock; a test passes its own. */
  every?: (fn: () => void, ms: number) => () => void;
}

const realEvery = (fn: () => void, ms: number): (() => void) => {
  const t = setInterval(fn, ms);
  t.unref?.();
  return () => clearInterval(t);
};

export class AppVoiceSession {
  private seq = 0;
  private speaking: { id: string; text: string; ctl: AbortController } | null = null;
  /** Bumped by every listen and unlisten, so an old listener's frames are dropped. */
  private ears = 0;
  private listening = false;
  private stt: TranscriptionSession | null = null;
  private buffered: Uint8Array[] = [];
  private stopRefresh: (() => void) | null = null;

  constructor(private readonly deps: AppVoiceSessionDeps) {}

  open(): void {
    this.deps.sendJson({
      type: 'ready',
      voice: this.deps.voice?.name ?? null,
      listen: this.deps.listener !== null,
      say: this.deps.say !== null,
      outputRate: APP_VOICE_OUTPUT_RATE,
      inputRate: APP_VOICE_INPUT_RATE,
    });
    this.stopRefresh = (this.deps.every ?? realEvery)(
      () => this.deps.sendJson({ type: 'token', ...this.deps.freshToken() }),
      APP_VOICE_TOKEN_REFRESH_MS,
    );
  }

  onText(raw: string): void {
    const m = parseAppVoiceClientMessage(raw);
    if (!m) {
      this.deps.sendJson({ type: 'error', code: 'bad_message', message: 'Not a message.' });
      return;
    }
    if (m.type === 'speak') void this.speak(m.text, m.id);
    else if (m.type === 'stop') this.stopSpeaking();
    else if (m.type === 'listen') this.listen();
    else if (m.type === 'unlisten') this.unlisten();
    else void this.say(m.text, m.id);
  }

  onAudio(pcm: Uint8Array): void {
    if (!this.listening || pcm.byteLength > APP_VOICE_AUDIO_FRAME_MAX) return;
    if (this.stt) this.stt.send(pcm);
    else if (this.buffered.length < MAX_BUFFERED_FRAMES) this.buffered.push(pcm);
  }

  close(): void {
    this.stopRefresh?.();
    this.stopRefresh = null;
    this.stopSpeaking();
    this.unlisten();
  }

  private async speak(raw: string, asked?: string): Promise<void> {
    const id = asked ?? `s${++this.seq}`;
    const text = raw.trim();
    const voice = this.deps.voice;
    if (!voice) return this.fail('no_voice', 'This server has no voice to speak with.', id);
    if (text === '') return this.fail('bad_message', 'Nothing to say.', id);
    if (text.length > APP_VOICE_SPEAK_MAX) {
      return this.fail('too_long', `A line is at most ${APP_VOICE_SPEAK_MAX} characters.`, id);
    }
    this.stopSpeaking();
    const ctl = new AbortController();
    this.speaking = { id, text, ctl };
    this.deps.sendJson({ type: 'speaking', id });
    let failed = false;
    try {
      await voice.speak(
        text,
        (pcm) => {
          if (!ctl.signal.aborted) this.deps.sendAudio(pcm);
        },
        ctl.signal,
      );
    } catch {
      failed = true;
      if (!ctl.signal.aborted) this.fail('voice_failed', 'The voice did not answer.', id);
    }
    if (this.speaking?.ctl === ctl) this.speaking = null;
    this.deps.sendJson({ type: 'spoken', id, stopped: ctl.signal.aborted || failed });
  }

  private stopSpeaking(): void {
    const s = this.speaking;
    this.speaking = null;
    s?.ctl.abort();
  }

  private listen(): void {
    const listener = this.deps.listener;
    if (!listener) {
      this.fail('no_listener', 'This server has no listener.');
      return;
    }
    if (this.listening) {
      this.deps.sendJson({ type: 'listening' });
      return;
    }
    this.listening = true;
    const ears = ++this.ears;
    const mine = () => ears === this.ears;
    listener
      .open({
        sampleRate: APP_VOICE_INPUT_RATE,
        detectSpeakers: false,
        tuning: SPOKEN_TAP_TUNING,
        onTurn: (t) => {
          if (mine()) this.heard(t);
        },
        onError: (message) => {
          if (mine()) this.fail('listener_failed', message);
        },
        onClosed: () => {
          if (!mine()) return;
          this.listening = false;
          this.stt = null;
        },
      })
      .then(
        (session) => {
          if (!mine()) {
            void session.close().catch(() => {});
            return;
          }
          this.stt = session;
          for (const pcm of this.buffered) session.send(pcm);
          this.buffered = [];
        },
        (err: unknown) => {
          if (!mine()) return;
          this.listening = false;
          this.buffered = [];
          this.fail('listener_failed', err instanceof Error ? err.message : 'No listener.');
        },
      );
    this.deps.sendJson({ type: 'listening' });
  }

  private unlisten(): void {
    this.ears++;
    this.listening = false;
    this.buffered = [];
    const s = this.stt;
    this.stt = null;
    void s?.close().catch(() => {});
  }

  private heard(t: EngineTurn): void {
    if (!hasWords(t.text)) return;
    const s = this.speaking;
    if (s && cutsIn(t.text, s.text)) {
      this.stopSpeaking();
      this.deps.sendJson({ type: 'cut-in', text: t.text, id: s.id });
    }
    this.deps.sendJson({ type: 'heard', text: t.text });
    if (t.final) this.deps.sendJson({ type: 'turn-end', text: t.text });
  }

  private async say(raw: string, asked?: string): Promise<void> {
    const id = asked ?? `w${++this.seq}`;
    const say = this.deps.say;
    if (!say)
      return this.fail('not_an_app', 'Only an attached app has a dev server to write to.', id);
    if (raw.length > APP_VOICE_SAY_MAX) {
      return this.fail('too_long', `A say is at most ${APP_VOICE_SAY_MAX} characters.`, id);
    }
    try {
      this.deps.sendJson({ type: 'said', id, status: await say(raw) });
    } catch {
      this.fail('say_failed', 'The app did not answer.', id);
    }
  }

  private fail(
    code: Extract<AppVoiceServerMessage, { type: 'error' }>['code'],
    message: string,
    id?: string,
  ): void {
    this.deps.sendJson({ type: 'error', code, message, ...(id ? { id } : {}) });
  }
}
