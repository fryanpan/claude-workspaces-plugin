/**
 * Voice in the lead chat: the board mic's own path, aimed at the lead.
 *
 * The page opens `WS /workspaces/<ws>/voice/converse`, names the lead in
 * `start` (`agent`), and streams the microphone up as the board mic does
 * (`board/spoken-reply-audio.ts`). The server's listener hears it, the turn
 * goes to the lead alone, and the lead's answer is said back on this socket.
 * The server also writes both into the board's chat (`AgentConversationLog`
 * in `server/src/spoken-reply/agent-conversation.ts`), so the panel shows a
 * spoken turn through the same stream as a typed one — nothing here writes
 * to the chat.
 *
 * Audio never leaves for a service the board's own mic does not already use:
 * no browser speech recognition, which in Chrome sends it to Google.
 *
 * Listening goes on while voice is on: once the lead has answered and its
 * answer has been said, the next question starts listening by itself. The
 * microphone is opened once, inside the tap that turned voice on, and stays
 * open until voice is off; only a question that is listening sends its
 * frames, so the lead's own voice is never sent back as the next question.
 *
 * iOS Safari runs an AudioContext only when `resume()` is called inside the
 * gesture, so the tap makes the capture context AND resumes it
 * (`makeGestureContext`), and asks for the microphone, before anything is
 * awaited. A context only constructed in the tap and resumed after the
 * setups fetch stayed suspended on a phone: the mic was open, no frame was
 * made, and the chat said "Listening…" with nothing to end it. A mic that
 * still sends no sound now stops voice with `NO_SOUND` and is reported.
 * Only setups 1 and 2 are used — the ones that hear through the server's
 * listener and so can address an agent.
 *
 * A PAGE MOVE CARRIES VOICE ON. A link that loads another of the board's
 * pages unloads this one with its microphone, so the next page calls
 * `start({ gesture: false })`. Chrome lets that context run, because the
 * reader tapped on this origin a moment ago. iOS Safari does not: the context
 * stays suspended, so instead of stopping with `NO_SOUND` the chat asks for
 * one tap (`TAP_TO_LISTEN`), and `wake()` inside that tap starts it. The
 * socket that closes as this page unloads is that move, not a stop, so it
 * is neither said nor reported.
 */
import {
  type SpokenClientMessage,
  type SpokenServerMessage,
  type SpokenSetup,
  parseSpokenServerMessage,
} from '@claude-workspaces/core/spoken-reply';
import {
  type PlaybackContext,
  type SpokenCaptureOpts,
  type SpokenCaptureStart,
  createSpokenPlayer,
  startSpokenCapture,
} from '../board/spoken-reply-audio.ts';
import { SETUP_KEY, type SpokenSocket } from '../board/spoken-reply-client.ts';
import { makeGestureContext } from '../meeting-audio.ts';
import { defaultOriginFacts, insecureOriginMessage } from '../voice-capture.ts';

export type LeadVoicePhase = 'off' | 'listening' | 'working' | 'speaking';

export interface LeadVoiceState {
  phase: LeadVoicePhase;
  /** What the listener has heard of the question so far. */
  heard: string;
  /** Why voice is not running, when it stopped by itself. */
  notice: string;
}

export interface LeadVoiceOpts {
  workspaceId: string;
  author: { id: string; name: string; kind?: string };
  getContext(): unknown;
  /** The lead's agent id, read at each question. */
  agent(): string | undefined;
  onChange(s: LeadVoiceState): void;
  /** `GET …/voice/timings`'s setups; injected by tests. */
  fetchSetups?: () => Promise<SpokenSetup[]>;
  openSocket?: (url: string) => SpokenSocket;
  startCapture?: (opts: SpokenCaptureOpts) => Promise<SpokenCaptureStart>;
  playbackContext?: () => PlaybackContext | null;
  /** The page's origin facts; a test passes a secure one. */
  blocked?: () => string | null;
  /** Where the board mic keeps its chosen setup; omitted, this page's own. */
  storage?: Pick<Storage, 'getItem'> | null;
  /** Where a failure is reported; omitted, the page's error reporter
   *  (Sentry, where the shell loads it). */
  report?: (err: Error) => void;
}

export interface LeadVoice {
  /** Voice on. `gesture: false` is a page carrying voice on from the page
   *  before, outside any tap; omitted, this is the reader's tap. */
  start(how?: { gesture: boolean }): void;
  /** A tap anywhere on the page: starts a context that waits for one, and
   *  says whether there was one. */
  wake(): boolean;
  stop(): void;
  state(): LeadVoiceState;
  destroy(): void;
}

export const NO_VOICE = 'Voice is not set up on this server. Type to your lead instead.';
export const NO_SOUND = 'The microphone is sending no sound. Tap the agent button to try again.';
/** How long an open mic may send nothing before voice stops and says so. */
const NO_SOUND_MS = 5_000;
/** Said while a carried-on voice waits for the tap its context needs. */
const CLOSED = 'The connection closed. Tap the mic to try again.';
export const TAP_TO_LISTEN = 'Tap anywhere to keep listening.';
/** How long a context started outside a tap has to run before the chat asks
 *  for one. */
const TAP_WAIT_MS = 600;
const LEAD_SETUPS: readonly SpokenSetup[] = [1, 2];
const OPEN = 1;
const MAX_HELD = 400;

function voiceBase(workspaceId: string): string {
  return `/workspaces/${encodeURIComponent(workspaceId)}/voice`;
}

async function defaultSetups(workspaceId: string): Promise<SpokenSetup[]> {
  try {
    const res = await fetch(`${voiceBase(workspaceId)}/timings`, { credentials: 'same-origin' });
    const body = res.ok ? ((await res.json()) as { setups?: SpokenSetup[] }) : null;
    return Array.isArray(body?.setups) ? body.setups : [];
  } catch {
    return [];
  }
}

function socketUrl(workspaceId: string): string {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${location.host}${voiceBase(workspaceId)}/converse`;
}

/** Raise a voice failure where the page's error reporting sees it, without
 *  throwing into the caller. `reportError` fires the window's `error` event,
 *  which Sentry's handler (or the shell's early buffer) files. */
function reportToPage(err: Error): void {
  const w = window as unknown as { reportError?: (e: unknown) => void };
  if (typeof w.reportError === 'function') w.reportError(err);
  else
    setTimeout(() => {
      throw err;
    }, 0);
}

function audioContext(): AudioContext | undefined {
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  return Ctor ? new Ctor() : undefined;
}

export function createLeadVoice(opts: LeadVoiceOpts): LeadVoice {
  const st: LeadVoiceState = { phase: 'off', heard: '', notice: '' };
  let on = false;
  let setups: SpokenSetup[] | null = null;
  let socket: SpokenSocket | null = null;
  let queue: Array<string | Int16Array> = [];
  let capture: { stop(): void } | null = null;
  let gen = 0;
  /** A question is listening: the mic's frames go up. */
  let forwarding = false;
  let soundTimer: ReturnType<typeof setTimeout> | null = null;
  /** A context started outside a tap that is not running yet. */
  let waiting: AudioContext | null = null;
  let tapTimer: ReturnType<typeof setTimeout> | null = null;
  /** The page is unloading: its socket closing is the move, not a stop. */
  let leaving = false;
  const onPageHide = (): void => {
    leaving = true;
  };
  /** Back from the back-forward cache with the socket gone: voice is off. */
  const onPageShow = (): void => {
    leaving = false;
    if (on && !socket) halt(CLOSED, '', true);
  };
  window.addEventListener('pagehide', onPageHide);
  window.addEventListener('pageshow', onPageShow);

  const emit = (): void => opts.onChange({ ...st });
  const set = (p: Partial<LeadVoiceState>): void => {
    Object.assign(st, p);
    emit();
  };

  const player = createSpokenPlayer({
    context: () =>
      opts.playbackContext
        ? opts.playbackContext()
        : ((audioContext() as unknown as PlaybackContext | undefined) ?? null),
    onFirstWord: () => {},
  });

  const sendRaw = (d: string | Int16Array): void => {
    if (socket && socket.readyState === OPEN) socket.send(d);
    else if (queue.length < MAX_HELD) queue.push(d);
  };
  const sendMsg = (m: SpokenClientMessage): void => sendRaw(JSON.stringify(m));

  const stopCapture = (): void => {
    gen++;
    forwarding = false;
    if (soundTimer) clearTimeout(soundTimer);
    soundTimer = null;
    if (tapTimer) clearTimeout(tapTimer);
    tapTimer = null;
    waiting = null;
    capture?.stop();
    capture = null;
  };

  /** Open the mic for as long as voice is on, on a context the tap made. */
  const openMic = (ctx: AudioContext | undefined): void => {
    const mine = gen;
    let frames = 0;
    void (opts.startCapture ?? startSpokenCapture)({
      ...(ctx ? { context: ctx } : {}),
      onFrame: (pcm) => {
        frames++;
        if (mine === gen && forwarding) sendRaw(pcm);
      },
    }).then((r) => {
      if (mine !== gen) {
        if (r.ok) r.capture.stop();
        return;
      }
      if (!r.ok) {
        halt(r.message);
        return;
      }
      capture = r.capture;
      const diag = r.capture.diag;
      // An open mic that makes no frame is a context that never ran — unless
      // it is waiting for the reader's tap, which restarts this clock.
      const noSound = (): void => {
        soundTimer = null;
        if (mine !== gen || frames > 0) return;
        if (waiting) {
          soundTimer = setTimeout(noSound, NO_SOUND_MS);
          return;
        }
        // What the mic's track and the graph's context said, so the report
        // answers why (`AudioPump.diag`).
        halt(NO_SOUND, diag?.() || `context ${ctx?.state ?? 'none'} at ${ctx?.sampleRate ?? 0} Hz`);
      };
      soundTimer = setTimeout(noSound, NO_SOUND_MS);
    });
  };

  const dropSocket = (): void => {
    const ws = socket;
    socket = null;
    queue = [];
    ws?.close();
  };

  const ensureSocket = (): void => {
    if (socket && socket.readyState <= OPEN) return;
    const ws = (opts.openSocket ?? ((u) => new WebSocket(u) as unknown as SpokenSocket))(
      socketUrl(opts.workspaceId),
    );
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      const pending = queue;
      queue = [];
      for (const d of pending) ws.send(d);
    };
    ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        if (on) player.push(new Uint8Array(ev.data));
        return;
      }
      const m = typeof ev.data === 'string' ? parseSpokenServerMessage(ev.data) : null;
      if (m) onServer(m);
    };
    ws.onclose = () => {
      if (socket !== ws) return;
      socket = null;
      queue = [];
      if (on && !leaving) halt(CLOSED);
    };
    socket = ws;
  };

  const pickSetup = (): SpokenSetup | null => {
    const usable = LEAD_SETUPS.filter((s) => setups?.includes(s));
    let raw: string | null = null;
    try {
      raw =
        (opts.storage === undefined ? window.localStorage : opts.storage)?.getItem(SETUP_KEY) ??
        null;
    } catch {}
    const stored = Number(raw ?? Number.NaN) as SpokenSetup;
    return usable.includes(stored) ? stored : (usable[0] ?? null);
  };

  /** One question: name the lead, and send what the mic hears. */
  const listen = (): void => {
    const setup = pickSetup();
    if (setup === null) {
      halt(NO_VOICE, '', true);
      return;
    }
    ensureSocket();
    const agent = opts.agent();
    sendMsg({
      type: 'start',
      setup,
      mode: 'tap',
      context: opts.getContext(),
      author: opts.author,
      ...(agent ? { agent } : {}),
    });
    forwarding = true;
    set({ phase: 'listening', heard: '', notice: '' });
  };

  /** Voice stops by itself, says why, and reports it — except a state of
   *  this server or origin (`quiet`), which every tap would report again. */
  function halt(notice: string, detail = '', quiet = false): void {
    on = false;
    stopCapture();
    player.stop();
    set({ phase: 'off', heard: '', notice });
    const err = new Error(`Lead chat voice stopped: ${notice}${detail ? ` (${detail})` : ''}`);
    err.name = 'LeadVoiceStopped';
    if (!quiet) (opts.report ?? reportToPage)(err);
  }

  const again = (): void => {
    if (on) listen();
  };

  function onServer(m: SpokenServerMessage): void {
    if (!on) return;
    switch (m.type) {
      case 'heard':
        if (st.phase === 'listening') set({ heard: m.text });
        return;
      case 'turn-end':
        forwarding = false;
        set({ phase: 'working', heard: m.text });
        return;
      case 'working':
        set({ phase: 'working' });
        return;
      case 'reply':
        // The lead took the question: its answer comes later, as a reply of
        // its own. Listening now would open the server's listener, and the
        // server does not speak an answer over an open listener, so the
        // answer would arrive as text only.
        if (!m.spoken && m.route === 'agent') {
          set({ phase: 'working' });
          return;
        }
        // Nothing heard: listen again rather than wait on a voice.
        if (!m.spoken) again();
        return;
      case 'audio-start':
        player.begin(m.sampleRate);
        set({ phase: 'speaking' });
        return;
      case 'audio-end':
        player.finish(again);
        return;
      case 'error':
        halt(m.message);
        return;
      default:
        return;
    }
  }

  return {
    start(how) {
      if (on) return;
      const blocked = (opts.blocked ?? (() => insecureOriginMessage(defaultOriginFacts())))();
      if (blocked) {
        halt(blocked, '', true);
        return;
      }
      on = true;
      player.wake();
      set({ phase: 'listening', heard: '', notice: '' });
      // Inside the tap, before anything is awaited: the context is made and
      // resumed, and the microphone is asked for (see the header).
      const ctx = makeGestureContext();
      openMic(ctx);
      if (how?.gesture === false && ctx) {
        tapTimer = setTimeout(() => {
          tapTimer = null;
          if (!on || ctx.state === 'running') return;
          waiting = ctx;
          set({ notice: TAP_TO_LISTEN });
        }, TAP_WAIT_MS);
      }
      const go = (): void => {
        if (!on) return;
        if (pickSetup() === null) halt(NO_VOICE, '', true);
        else listen();
      };
      if (setups) return go();
      void (opts.fetchSetups ?? (() => defaultSetups(opts.workspaceId)))().then((s) => {
        setups = s;
        go();
      });
    },
    stop() {
      const asked = st.phase === 'working' || st.phase === 'speaking';
      on = false;
      stopCapture();
      player.stop();
      // A question still being heard is dropped with its socket. One already
      // asked keeps the socket, so the lead's answer still reaches the chat.
      if (asked) sendMsg({ type: 'stop' });
      else dropSocket();
      set({ phase: 'off', heard: '', notice: '' });
    },
    wake() {
      const ctx = waiting;
      if (!ctx || !on) return false;
      waiting = null;
      // Inside the gesture: the one call Safari lets start the context.
      void ctx.resume().catch(() => {});
      set({ notice: '' });
      return true;
    },
    state: () => ({ ...st }),
    destroy() {
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('pageshow', onPageShow);
      on = false;
      stopCapture();
      player.stop();
      dropSocket();
    },
  };
}
