/**
 * The board mic in spoken mode: tap the mic (or Space), ask, and Claude
 * writes a short overview into the panel above the mic and says the first
 * two sentences of it. Speaking while Claude talks stops it.
 *
 * The socket is `WS /workspaces/<ws>/voice/converse` (the server's
 * `spoken-reply/`), opened at the first press and kept. The answer comes from
 * the board mic's own router, so everything the plain mic does — fast paths,
 * hand-off to the lead — happens here too; the setup switch changes only who
 * hears and who speaks.
 *
 * Every question is tapped (Bryan, 2 Oct: holding is wrong): a tap on the
 * mic or Space starts it, the listener ends it about half a second after the
 * last word, and a second tap ends it by hand. Frames said before the socket
 * opens are held and sent behind the `start`. Once the question reaches the
 * answerer the panel says it is being worked on until the reply arrives, so
 * the speaker can look away.
 *
 * THE DELAY is measured in `spoken-reply-turn.ts` and sent to the server as
 * `timing`, which logs it per setup (`spoken-reply/timings.ts` names where it
 * is read). Each point's note is shown in step with its point by
 * `spoken-reply-notes.ts`, and its lead rides the same report.
 */
import {
  SPOKEN_SETUPS,
  type SpokenClientMessage,
  type SpokenDecide,
  type SpokenHeldSetups,
  type SpokenMode,
  type SpokenServerMessage,
  type SpokenSetup,
  type SpokenTimingSummary,
  parseSpokenServerMessage,
  spokenSetupKey,
} from '@claude-workspaces/core/spoken-reply';
import { defaultOriginFacts, insecureOriginMessage } from '../voice-capture.ts';
import {
  type PlaybackContext,
  type SpokenCaptureOpts,
  type SpokenCaptureStart,
  createSpokenPlayer,
  startSpokenCapture,
} from './spoken-reply-audio.ts';
import { createNoteClock } from './spoken-reply-notes.ts';
import { type SpokenPanel, createSpokenPanel } from './spoken-reply-panel.ts';
import { wireSpokenTap } from './spoken-reply-tap.ts';
import { type Turn, newTurn, timingAt } from './spoken-reply-turn.ts';

/** A tap this soon after the listener ended the question was meant to end
 *  it, not to ask another. */
export const LATE_STOP_MS = 1000;
/** Frames held before the socket is open: 20s. */
const MAX_HELD_FRAMES = 400;
export const SETUP_KEY = 'cw.spoken-reply.setup';

export interface SpokenSocket {
  binaryType: string;
  readyState: number;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  send(data: string | ArrayBufferLike | ArrayBufferView): void;
  close(): void;
}

export interface SpokenReplyOpts {
  document: Document;
  button: HTMLElement;
  /** `ws(s)://host/workspaces/<ws>/voice/converse`. */
  url: string;
  setups: readonly SpokenSetup[];
  /** Pickable, but refused on the page with the server's one line. */
  held?: SpokenHeldSetups;
  timings: SpokenTimingSummary;
  author: { id: string; name: string; kind?: string };
  getContext(): unknown;
  /** The agent every question goes to, by id, rather than the board's
   *  router (`/voice`). Read at each press, so a switch needs no new socket. */
  agent?: () => string | undefined;
  onNavigate(url: string): void;
  /** Write a review decision the server read back and heard confirmed, and
   *  say whether it landed. */
  onDecide?: (d: SpokenDecide) => Promise<boolean>;
  openSocket?: (url: string) => SpokenSocket;
  startCapture?: (opts: SpokenCaptureOpts) => Promise<SpokenCaptureStart>;
  /** A context for the microphone, made inside the press. */
  captureContext?: () => AudioContext | undefined;
  playbackContext?: () => PlaybackContext | null;
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
  now?: () => number;
}

export interface SpokenReply {
  panel: SpokenPanel;
  setup(): SpokenSetup;
  destroy(): void;
}

const OPEN = 1;

function defaultSocket(url: string): SpokenSocket {
  return new WebSocket(url) as unknown as SpokenSocket;
}

function audioCtor(): typeof AudioContext | undefined {
  return (
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  );
}

function readStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function createSpokenReply(opts: SpokenReplyOpts): SpokenReply {
  const doc = opts.document;
  const now = opts.now ?? (() => performance.now());
  const storage = opts.storage === undefined ? readStorage() : opts.storage;
  const heldLine = (s: SpokenSetup): string | undefined => opts.held?.[spokenSetupKey(s)];
  const available = SPOKEN_SETUPS.filter((s) => opts.setups.includes(s) || heldLine(s));
  let summary = opts.timings;

  const stored = Number(
    (() => {
      try {
        return storage?.getItem(SETUP_KEY);
      } catch {
        return null;
      }
    })(),
  );
  let setup: SpokenSetup = available.includes(stored as SpokenSetup)
    ? (stored as SpokenSetup)
    : (available[0] ?? 1);

  let socket: SpokenSocket | null = null;
  let queue: Array<string | Int16Array> = [];
  let capture: { stop(): void } | null = null;
  let captureGen = 0;
  let held: Int16Array[] = [];
  let turn: Turn = newTurn();
  /** The reply's audio stream is open — the slow-answer cue opens it early. */
  let audioOpen = false;

  const sendRaw = (data: string | Int16Array): void => {
    if (socket && socket.readyState === OPEN) socket.send(data);
    else if (queue.length < MAX_HELD_FRAMES) queue.push(data);
  };
  const sendMsg = (m: SpokenClientMessage): void => sendRaw(JSON.stringify(m));

  const ensureSocket = (): void => {
    if (socket && socket.readyState <= OPEN) return;
    const ws = (opts.openSocket ?? defaultSocket)(opts.url);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      const pending = queue;
      queue = [];
      for (const d of pending) ws.send(d);
    };
    ws.onmessage = (ev) => onMessage(ev.data);
    ws.onclose = () => {
      if (socket !== ws) return;
      socket = null;
      queue = [];
      audioOpen = false;
      stopCapture();
      player.stop();
      notes.flush();
      const s = panel.state();
      if (s !== 'idle' && s !== 'done' && s !== 'stopped') {
        panel.note('The connection closed. Press the mic to try again.');
        panel.setState('done');
      }
    };
    socket = ws;
  };

  let playCtx: PlaybackContext | null = null;
  const player = createSpokenPlayer({
    context: () => {
      if (playCtx) return playCtx;
      if (opts.playbackContext) playCtx = opts.playbackContext();
      else {
        const Ctor = audioCtor();
        playCtx = Ctor ? (new Ctor() as unknown as PlaybackContext) : null;
      }
      return playCtx;
    },
    onFirstWord: (at) => recordDelay(at),
    now,
  });

  const panel = createSpokenPanel({
    document: doc,
    anchor: opts.button,
    setups: available,
    held: opts.held ?? {},
    onStop: () => stopSpeaking(),
    onClose: () => closePanel(),
    onPickSetup: (s) => pickSetup(s),
    onChoice: (text) => choose(text),
  });
  panel.setSetup(setup);
  panel.setDelay(null, summary[spokenSetupKey(setup)]);
  const notes = createNoteClock({ player, land: (i, text) => panel.landNote(i, text), now });

  /** The reply is over: every note shown, and the turn's report sent once. */
  function settle(): void {
    notes.flush();
    const t = turn.pending;
    if (!t) return;
    turn.pending = null;
    const noteLeadMs = notes.leads();
    sendMsg(noteLeadMs.length > 0 ? { ...t, noteLeadMs } : t);
  }

  function pickSetup(s: SpokenSetup): void {
    if (!available.includes(s)) return;
    setup = s;
    try {
      storage?.setItem(SETUP_KEY, String(s));
    } catch {}
    panel.setSetup(s);
    panel.setDelay(null, summary[spokenSetupKey(s)]);
    const line = heldLine(s);
    if (line) refuse(line);
  }

  /** One line in an open panel, and nothing sent or spoken. */
  function refuse(line: string): void {
    panel.open();
    panel.clearBody();
    panel.note(line);
    panel.setState('done');
  }

  function stopCapture(): void {
    captureGen++;
    capture?.stop();
    capture = null;
    held = [];
  }

  function speakingNow(): boolean {
    const s = panel.state();
    return s === 'speaking' || s === 'asking' || player.playing();
  }

  function stopSpeaking(): void {
    player.stop();
    sendMsg({ type: 'stop' });
    settle();
    panel.setState(turn.asking ? 'waiting' : 'stopped');
  }

  function closePanel(): void {
    stopCapture();
    if (speakingNow()) sendMsg({ type: 'stop' });
    player.stop();
    settle();
    panel.close();
    panel.setState('idle');
  }

  /** The question's kind is known: name it, then send what was held. */
  function commit(mode: SpokenMode): void {
    if (turn.mode) return;
    turn.mode = mode;
    const agentNow = opts.agent?.();
    sendMsg({
      type: 'start',
      setup,
      mode,
      context: opts.getContext(),
      author: opts.author,
      ...(agentNow ? { agent: agentNow } : {}),
    });
    for (const f of held) sendRaw(f);
    held = [];
  }

  function press(): void {
    const blocked = heldLine(setup) ?? insecureOriginMessage(defaultOriginFacts());
    if (blocked) return void refuse(blocked);
    // A second tap on a question that is still listening ends it by hand.
    if (panel.state() === 'listening') {
      finishByHand();
      return;
    }
    if (turn.turnEndAt !== null && now() - turn.turnEndAt < LATE_STOP_MS) return;
    player.wake();
    ensureSocket();
    const interrupting = speakingNow();
    const answering = interrupting ? turn.asking : panel.state() === 'waiting';
    if (interrupting) {
      player.stop();
      sendMsg({ type: 'stop' });
    }
    settle();
    panel.open();
    if (!interrupting && !answering) panel.clearBody();
    if (interrupting) panel.note('Stopped when you started talking.');
    panel.setYou('…');
    panel.setState('listening');
    stopCapture();
    turn = newTurn();
    audioOpen = false;
    const gen = captureGen;
    const Ctor = audioCtor();
    const ctx = opts.captureContext ? opts.captureContext() : Ctor ? new Ctor() : undefined;
    void (opts.startCapture ?? startSpokenCapture)({
      ...(ctx ? { context: ctx } : {}),
      onFrame: (pcm, speech) => {
        if (gen !== captureGen) return;
        if (speech) turn.lastVoiceAt = now();
        if (turn.mode) sendRaw(pcm);
        else if (held.length < MAX_HELD_FRAMES) held.push(pcm);
      },
    }).then((r) => {
      if (gen !== captureGen) {
        if (r.ok) r.capture.stop();
        return;
      }
      if (!r.ok) {
        panel.note(r.message);
        panel.setState('done');
        return;
      }
      capture = r.capture;
    });
    commit('tap');
  }

  function finishByHand(): void {
    turn.releasedAt = now();
    stopCapture();
    sendMsg({ type: 'end' });
    panel.setState('sending');
  }

  function choose(text: string): void {
    ensureSocket();
    player.wake();
    player.stop();
    settle();
    stopCapture();
    turn = newTurn(true);
    audioOpen = false;
    panel.setYou(text);
    panel.clearBody();
    panel.setState('sending');
    sendMsg({ type: 'say', text });
  }

  function decide(d: SpokenDecide): void {
    const write = opts.onDecide;
    void (write ? write(d) : Promise.resolve(false)).then(
      (ok) => sendMsg({ type: 'decided', id: d.id, ok }),
      () => sendMsg({ type: 'decided', id: d.id, ok: false }),
    );
  }

  function recordDelay(at: number): void {
    const t = timingAt(turn, at);
    if (!t) return;
    turn.timed = true;
    turn.pending = t;
    panel.setDelay(t.delayMs, summary[spokenSetupKey(setup)]);
  }

  function onMessage(data: unknown): void {
    if (data instanceof ArrayBuffer) {
      player.push(new Uint8Array(data));
      return;
    }
    if (typeof data !== 'string') return;
    const m = parseSpokenServerMessage(data);
    if (m) onServer(m);
  }

  function onServer(m: SpokenServerMessage): void {
    switch (m.type) {
      case 'ready':
        summary = m.timings;
        return;
      case 'heard':
        if (panel.state() === 'listening' || panel.state() === 'sending') panel.setYou(m.text);
        return;
      case 'turn-end':
        turn.turnEndAt = now();
        stopCapture();
        panel.setYou(m.text || '…');
        panel.setState('sending');
        return;
      case 'working':
        if (panel.state() === 'listening' || panel.state() === 'sending') {
          panel.setState('working');
        }
        return;
      case 'reply':
        turn.replyAt = now();
        turn.asking = m.asking;
        notes.reset();
        panel.reply({
          spoken: m.spoken,
          detail: m.detail,
          ...(m.choices ? { choices: m.choices } : {}),
          ...(m.points ? { points: m.points } : {}),
        });
        if (!m.spoken) {
          panel.note('Didn’t catch anything.');
          panel.setState('done');
        } else if (audioOpen) {
          // The cue already opened the voice: the answer continues it.
          panel.setState(m.asking ? 'asking' : 'speaking');
        } else if (panel.state() !== 'speaking' && panel.state() !== 'asking') {
          panel.setState('writing');
        }
        if (m.navigate) opts.onNavigate(m.navigate);
        if (m.decide) decide(m.decide);
        return;
      case 'note':
        notes.note(m.point, m.text);
        return;
      case 'audio-start':
        audioOpen = true;
        player.begin(m.sampleRate);
        // A cue before the reply: still being worked on, and the label says so.
        if (turn.replyAt !== null || panel.state() !== 'working') {
          panel.setState(turn.asking ? 'asking' : 'speaking');
        }
        return;
      case 'audio-end':
        audioOpen = false;
        player.finish(() => {
          settle();
          const s = panel.state();
          if (s === 'speaking') panel.setState('done');
          else if (s === 'asking') panel.setState('waiting');
        });
        return;
      case 'timings':
        summary = m.summary;
        panel.setDelay(undefined, summary[spokenSetupKey(setup)]);
        return;
      case 'error':
        settle();
        stopCapture();
        panel.note(m.message);
        panel.setState('done');
        return;
    }
  }

  const input = wireSpokenTap({
    document: doc,
    button: opts.button,
    onTap: press,
    onEscape: () => {
      if (!panel.isOpen()) return false;
      closePanel();
      return true;
    },
  });

  return {
    panel,
    setup: () => setup,
    destroy() {
      closePanel();
      input.destroy();
      const ws = socket;
      socket = null;
      ws?.close();
      panel.destroy();
    },
  };
}
