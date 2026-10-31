/**
 * Setup 3: Gemini Live hears the question and speaks the answer, and asks the
 * board what to say through one tool.
 *
 * The browser never talks to Google. This server holds the socket and the
 * key, the page streams its microphone here as it does for setups 1 and 2,
 * and the model's audio comes back the same way. That keeps the answer the
 * board's: the model is told to call `ask_board` with what it heard and to
 * say the result's `spoken` field word for word, so setup 3 differs from the
 * others in its ears and its voice, not in what it says.
 *
 * PROTOCOL (Live API reference, read 2026-09-29):
 *  - `wss://generativelanguage.googleapis.com/ws/…BidiGenerateContent?key=`.
 *    The first frame is `{setup}`; the server answers `{setupComplete}`.
 *  - audio up: `{realtimeInput: {audio: {data, mimeType: 'audio/pcm;rate=16000'}}}`.
 *    With automatic activity detection OFF (hold-to-talk), the turn is
 *    bracketed by `{realtimeInput: {activityStart: {}}}` and `activityEnd`.
 *    With it ON (tap), the server decides where the question ends.
 *  - down: `serverContent.modelTurn.parts[].inlineData` (24 kHz PCM16),
 *    `inputTranscription` / `outputTranscription` text, `turnComplete`,
 *    `interrupted`, and `toolCall.functionCalls[]`, answered with
 *    `{toolResponse: {functionResponses: [{id, name, response}]}}`.
 *  - the model's function calls default to NON_BLOCKING on this model, which
 *    would let it talk before the board answered; `ask_board` is BLOCKING.
 *  - frames arrive as text or binary JSON; both are read.
 */

const LIVE_URL =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
export const GEMINI_LIVE_MODEL = 'models/gemini-3.8-live';
export const ASK_BOARD = 'ask_board';
const CONNECT_TIMEOUT_MS = 10_000;
/** Silence before Gemini calls a tapped question over: 500 ms, the same
 *  bound setups 1 and 2 hold (Bryan, 2 Oct: the turn ends on its own about
 *  half a second after he stops). It was 3,500 so a three-second thinking
 *  pause was not cut off; it now is, and the long-pause harness on setup 3
 *  says so (`spoken-long-pause-gemini.test.ts`). */
export const GEMINI_SILENCE_MS = 500;

export const GEMINI_SYSTEM_INSTRUCTION =
  'You are the voice of a project board. For every request, call ask_board with the ' +
  "person's request in their own words. Then say the `spoken` field of its result word " +
  'for word, and nothing else. If `spoken` is empty, say nothing. Never add to it.';

export interface GeminiSocket {
  send(data: string): void;
  close(): void;
}

export interface GeminiSocketArgs {
  url: string;
  onOpen: () => void;
  onMessage: (text: string) => void;
  onError: (message: string) => void;
  onClose: (reason: string) => void;
}

export type GeminiSocketFactory = (args: GeminiSocketArgs) => GeminiSocket;

export interface GeminiLiveEvents {
  onInputText(text: string): void;
  onOutputText(text: string): void;
  onAudio(pcm: Uint8Array): void;
  /** The model asks the board. Answer with `session.answerTool`. */
  onToolCall(id: string, request: string): void;
  onTurnComplete(): void;
  onInterrupted(): void;
  onError(message: string): void;
  onClose(): void;
}

export interface GeminiLiveSession {
  sendAudio(pcm16k: Uint8Array): void;
  /** Hold-to-talk only: the question starts and ends where the page says. */
  activityStart(): void;
  activityEnd(): void;
  /** Tap mode: the page says the audio stopped, so Gemini's VAD flushes. */
  endStream(): void;
  /** A choice tapped on the page, sent as if it had been said. */
  sendText(text: string): void;
  answerTool(id: string, response: Record<string, unknown>): void;
  close(): void;
}

export interface GeminiLive {
  readonly name: string;
  /** `manual`: hold-to-talk, the page marks the turn. Otherwise Gemini's VAD. */
  open(opts: { manual: boolean; events: GeminiLiveEvents }): Promise<GeminiLiveSession>;
}

/** The setup frame, exported so a test holds its shape still. */
export function geminiSetup(manual: boolean): Record<string, unknown> {
  return {
    setup: {
      model: GEMINI_LIVE_MODEL,
      generationConfig: { responseModalities: ['AUDIO'] },
      systemInstruction: { parts: [{ text: GEMINI_SYSTEM_INSTRUCTION }] },
      tools: [
        {
          functionDeclarations: [
            {
              name: ASK_BOARD,
              description: 'Answer a spoken request about the board.',
              behavior: 'BLOCKING',
              parameters: {
                type: 'OBJECT',
                properties: { request: { type: 'STRING' } },
                required: ['request'],
              },
            },
          ],
        },
      ],
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      realtimeInputConfig: {
        automaticActivityDetection: manual
          ? { disabled: true }
          : // Tap once and walk away: the end of speech is called early, and
            // the slow-answer cue covers the wait for the board's answer.
            {
              endOfSpeechSensitivity: 'END_SENSITIVITY_HIGH',
              silenceDurationMs: GEMINI_SILENCE_MS,
            },
      },
    },
  };
}

function defaultSocket(args: GeminiSocketArgs): GeminiSocket {
  const ws = new WebSocket(args.url);
  ws.binaryType = 'arraybuffer';
  const decoder = new TextDecoder();
  ws.addEventListener('open', () => args.onOpen());
  ws.addEventListener('message', (ev: MessageEvent) => {
    const data = ev.data as unknown;
    if (typeof data === 'string') args.onMessage(data);
    else if (data instanceof ArrayBuffer) args.onMessage(decoder.decode(data));
  });
  ws.addEventListener('error', () => args.onError('websocket error'));
  // The close reason is Google's own sentence ("API not enabled…"); it never
  // carries the key, which rides only in the URL we sent.
  ws.addEventListener('close', (ev: CloseEvent) => args.onClose(ev.reason || `code ${ev.code}`));
  return { send: (d) => ws.send(d), close: () => ws.close() };
}

export function createGeminiLive(opts: {
  apiKey: string;
  socketFactory?: GeminiSocketFactory;
  connectTimeoutMs?: number;
}): GeminiLive {
  const makeSocket = opts.socketFactory ?? defaultSocket;
  const connectTimeoutMs = opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  return {
    name: 'gemini',
    open({ manual, events }) {
      return new Promise<GeminiLiveSession>((resolve, reject) => {
        let ready = false;
        let closed = false;
        const timer = setTimeout(() => {
          if (ready) return;
          closed = true;
          socket.close();
          reject(new Error('gemini: setup did not complete within the connect timeout'));
        }, connectTimeoutMs);
        timer.unref?.();
        const send = (msg: unknown): void => {
          if (!closed) socket.send(JSON.stringify(msg));
        };
        const session: GeminiLiveSession = {
          sendAudio: (pcm) =>
            send({
              realtimeInput: {
                audio: {
                  data: Buffer.from(pcm).toString('base64'),
                  mimeType: 'audio/pcm;rate=16000',
                },
              },
            }),
          activityStart: () => send({ realtimeInput: { activityStart: {} } }),
          activityEnd: () => send({ realtimeInput: { activityEnd: {} } }),
          endStream: () => send({ realtimeInput: { audioStreamEnd: true } }),
          sendText: (text) => send({ realtimeInput: { text } }),
          answerTool: (id, response) =>
            send({ toolResponse: { functionResponses: [{ id, name: ASK_BOARD, response }] } }),
          close: () => {
            if (closed) return;
            closed = true;
            socket.close();
          },
        };
        const socket = makeSocket({
          url: `${LIVE_URL}?key=${encodeURIComponent(opts.apiKey)}`,
          onOpen: () => socket.send(JSON.stringify(geminiSetup(manual))),
          onMessage: (text) => {
            let m: Record<string, unknown>;
            try {
              m = JSON.parse(text) as Record<string, unknown>;
            } catch {
              return;
            }
            if (m.setupComplete !== undefined) {
              ready = true;
              clearTimeout(timer);
              resolve(session);
              return;
            }
            readServerMessage(m, events);
          },
          onError: (msg) => {
            if (!ready) {
              clearTimeout(timer);
              reject(new Error(`gemini: ${msg}`));
            } else events.onError(`gemini: ${msg}`);
          },
          onClose: (reason) => {
            const wasClosed = closed;
            closed = true;
            if (!ready) {
              clearTimeout(timer);
              reject(new Error(`gemini: closed before setup (${reason})`));
              return;
            }
            if (!wasClosed) events.onError(`gemini: closed (${reason})`);
            events.onClose();
          },
        });
      });
    },
  };
}

function readServerMessage(m: Record<string, unknown>, events: GeminiLiveEvents): void {
  const tool = m.toolCall as { functionCalls?: unknown[] } | undefined;
  for (const raw of tool?.functionCalls ?? []) {
    const fc = raw as { id?: unknown; name?: unknown; args?: { request?: unknown } };
    if (fc.name !== ASK_BOARD || typeof fc.id !== 'string') continue;
    events.onToolCall(fc.id, typeof fc.args?.request === 'string' ? fc.args.request : '');
  }
  const sc = m.serverContent as Record<string, unknown> | undefined;
  if (!sc) return;
  const input = sc.inputTranscription as { text?: unknown } | undefined;
  if (typeof input?.text === 'string' && input.text) events.onInputText(input.text);
  const turn = sc.modelTurn as { parts?: unknown[] } | undefined;
  for (const raw of turn?.parts ?? []) {
    const data = (raw as { inlineData?: { data?: unknown } }).inlineData?.data;
    if (typeof data === 'string' && data)
      events.onAudio(new Uint8Array(Buffer.from(data, 'base64')));
  }
  const output = sc.outputTranscription as { text?: unknown } | undefined;
  if (typeof output?.text === 'string' && output.text) events.onOutputText(output.text);
  if (sc.interrupted === true) events.onInterrupted();
  if (sc.turnComplete === true) events.onTurnComplete();
}
