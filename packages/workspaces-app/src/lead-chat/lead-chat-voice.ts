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
 * microphone is opened once, inside the tap that turned voice on (Safari
 * starts audio only from a gesture), and stays open until voice is off; only
 * a question that is listening sends its frames, so the lead's own voice is
 * never sent back as the next question.
 * Only setups 1 and 2 are used — the ones that hear through the server's
 * listener and so can address an agent.
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
}

export interface LeadVoice {
  start(): void;
  stop(): void;
  state(): LeadVoiceState;
  destroy(): void;
}

export const NO_VOICE = 'Voice is not set up on this server. Type to your lead instead.';
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
    capture?.stop();
    capture = null;
  };

  /** Open the mic for as long as voice is on, on a context the tap made. */
  const openMic = (ctx: AudioContext | undefined): void => {
    const mine = gen;
    void (opts.startCapture ?? startSpokenCapture)({
      ...(ctx ? { context: ctx } : {}),
      onFrame: (pcm) => {
        if (mine === gen && forwarding) sendRaw(pcm);
      },
    }).then((r) => {
      if (mine !== gen) {
        if (r.ok) r.capture.stop();
        return;
      }
      if (r.ok) capture = r.capture;
      else halt(r.message);
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
      if (on) halt('The connection closed. Tap the mic to try again.');
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
      halt(NO_VOICE);
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

  /** Voice stops by itself, and says why. */
  function halt(notice: string): void {
    on = false;
    stopCapture();
    player.stop();
    set({ phase: 'off', heard: '', notice });
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
    start() {
      if (on) return;
      const blocked = (opts.blocked ?? (() => insecureOriginMessage(defaultOriginFacts())))();
      if (blocked) {
        halt(blocked);
        return;
      }
      on = true;
      player.wake();
      set({ phase: 'listening', heard: '', notice: '' });
      // Made here, inside the tap, before anything is awaited.
      const ctx = opts.startCapture ? undefined : audioContext();
      const go = (): void => {
        if (!on || pickSetup() === null) {
          void ctx?.close().catch(() => {});
          if (on) halt(NO_VOICE);
          return;
        }
        openMic(ctx);
        listen();
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
    state: () => ({ ...st }),
    destroy() {
      on = false;
      stopCapture();
      player.stop();
      dropSocket();
    },
  };
}
