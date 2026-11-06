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
 * Listening goes on while voice is on: once an answer has been said, or the
 * lead has taken the question to work on, the next question starts listening
 * by itself, and a question left working for `WORKING_MS` with nothing said
 * listens anyway. The microphone is opened once, inside the tap that turned
 * voice on, and stays open until voice is off; only a question that is
 * listening sends its frames, and none go up while an answer is said, so
 * the lead's own voice is never sent back as the next question.
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
 *
 * A LATE ANSWER IS STILL SAID. Voice that stopped by itself plays what the lead
 * owes, and a socket dropped while it owes something reopens to collect it
 * (`LeadAnswers.adopt`). Only the reader's own stop leaves an answer silent.
 */
import {
  type SpokenClientMessage,
  type SpokenServerMessage,
  type SpokenSetup,
  parseSpokenServerMessage,
} from '@claude-workspaces/core/spoken-reply';
import {
  type PlaybackContext,
  createSpokenPlayer,
  startSpokenCapture,
} from '../board/spoken-reply-audio.ts';
import { SETUP_KEY, type SpokenSocket } from '../board/spoken-reply-client.ts';
import { makeGestureContext } from '../meeting-audio.ts';
import { defaultOriginFacts, insecureOriginMessage } from '../voice-capture.ts';
import {
  type LeadVoice,
  type LeadVoiceOpts,
  type LeadVoiceState,
  NO_SOUND,
  NO_VOICE,
  OWED_RETRIES,
  OWED_RETRY_MS,
  TAP_TO_LISTEN,
} from './lead-chat-voice-api.ts';
import { audioContext, defaultSetups, reportToPage, socketUrl } from './lead-chat-voice-io.ts';
import { createListeningTab } from './listening-tab.ts';

export * from './lead-chat-voice-api.ts';

/** How long an open mic may send nothing before voice stops and says so. */
const NO_SOUND_MS = 5_000;
/** Said, and reported, when the voice socket closes while the page stays. */
const CLOSED = 'The connection closed. Tap the mic to try again.';
/** How long a question may show working with nothing said before the next
 *  one listens anyway: a router or voice that never answers does not leave
 *  voice deaf (Bryan, 3 Nov: "stopping often after I say one thing"). A
 *  board answer takes a few seconds, and a slow one plays its filler cue
 *  well inside this. */
export const WORKING_MS = 30_000;
/** The route of the lead's later answer (`spoken-reply/lead-answer.ts`). */
const LEAD_ANSWER = 'lead-answer';
/** How long a context started outside a tap has to run before the chat asks
 *  for one. */
const TAP_WAIT_MS = 600;
const LEAD_SETUPS: readonly SpokenSetup[] = [1, 2];
const OPEN = 1;
const MAX_HELD = 400;

export function createLeadVoice(opts: LeadVoiceOpts): LeadVoice {
  const st: LeadVoiceState = { phase: 'off', heard: '', notice: '', paused: false };
  let on = false;
  let setups: SpokenSetup[] | null = null;
  let socket: SpokenSocket | null = null;
  let queue: Array<string | Int16Array> = [];
  let capture: { stop(): void } | null = null;
  let gen = 0;
  /** A question is listening: the mic's frames go up. */
  let forwarding = false;
  /** The context the server holds for this question, as sent. */
  let sentContext = '';
  /** Questions the lead took and has not answered yet. */
  let awaiting = 0;
  /** The reader pressed stop: nothing more is said until they turn it on. */
  let hushed = false;
  /** An answer is being said on a page whose voice stopped by itself. */
  let answering = false;
  /** Tries left to reopen a dropped socket for an owed answer. */
  let owedTries = OWED_RETRIES;
  let owedTimer: ReturnType<typeof setTimeout> | null = null;
  let workTimer: ReturnType<typeof setTimeout> | null = null;
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
    // A paused tab waiting to listen holds no socket, and needs none.
    if (on && !socket && !(st.paused && st.phase === 'listening')) halt(CLOSED, '', true);
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

  /** Only the tab the reader is on, or was on last, hears them; on losing
   *  them, a question ends (asked, dropped, or ended empty while the lead
   *  still owes an answer), and a paused tab says nothing aloud, so the one
   *  that hears never takes the speakers' answer as a question. */
  const tab = (opts.listeningTab ?? createListeningTab)({
    onChange: (hears) => {
      if (!on) return;
      set({ paused: !hears });
      if (hears) {
        if (st.phase === 'listening' && !forwarding) listen();
        return;
      }
      player.stop();
      if (st.phase !== 'listening' || !forwarding) return;
      forwarding = false;
      if (!st.heard && awaiting === 0) return dropSocket();
      sendMsg({ type: 'end' });
      // Asked: coming back must not start another question over it.
      if (st.heard) {
        set({ phase: 'working' });
        stillWorking();
      }
    },
  });

  const sendRaw = (d: string | Int16Array): void => {
    if (socket && socket.readyState === OPEN) socket.send(d);
    else if (queue.length < MAX_HELD) queue.push(d);
  };
  const sendMsg = (m: SpokenClientMessage): void => sendRaw(JSON.stringify(m));

  const doneWorking = (): void => {
    if (workTimer) clearTimeout(workTimer);
    workTimer = null;
  };
  /** Working, with a way out: no word for `WORKING_MS` and the next
   *  question listens. */
  const stillWorking = (): void => {
    doneWorking();
    workTimer = setTimeout(() => {
      workTimer = null;
      if (on && st.phase === 'working') again();
    }, WORKING_MS);
  };

  const stopCapture = (): void => {
    gen++;
    forwarding = false;
    doneWorking();
    if (soundTimer) clearTimeout(soundTimer);
    soundTimer = null;
    if (tapTimer) clearTimeout(tapTimer);
    tapTimer = null;
    waiting = null;
    capture?.stop();
    capture = null;
  };

  /** The reader moved while the question listens — opened a review item,
   *  a thread, a doc: the server answers about what is open now. */
  const keepContext = (): void => {
    const context = opts.getContext();
    const now = JSON.stringify(context ?? null);
    if (now === sentContext) return;
    sentContext = now;
    sendMsg({ type: 'context', context });
  };

  /** Open the mic for as long as voice is on, on a context the tap made. */
  const openMic = (ctx: AudioContext | undefined): void => {
    const mine = gen;
    let frames = 0;
    void (opts.startCapture ?? startSpokenCapture)({
      ...(ctx ? { context: ctx } : {}),
      onFrame: (pcm) => {
        frames++;
        if (mine !== gen || !forwarding) return;
        keepContext();
        sendRaw(pcm);
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
    awaiting = 0;
    ws?.close();
  };

  const ensureSocket = (): void => {
    if (socket && socket.readyState <= OPEN) return;
    const ws = (opts.openSocket ?? ((u) => new WebSocket(u) as unknown as SpokenSocket))(
      socketUrl(opts.workspaceId),
    );
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      owedTries = OWED_RETRIES;
      const pending = queue;
      queue = [];
      for (const d of pending) ws.send(d);
    };
    ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        if (on || (answering && !hushed)) player.push(new Uint8Array(ev.data));
        return;
      }
      const m = typeof ev.data === 'string' ? parseSpokenServerMessage(ev.data) : null;
      if (m) onServer(m);
    };
    ws.onclose = () => {
      if (socket !== ws) return;
      socket = null;
      queue = [];
      const owed = awaiting > 0 && !leaving && !hushed;
      if (!owed) awaiting = 0;
      if (on && !leaving) halt(CLOSED);
      // A new socket collects what the lead owes; the microphone stays off.
      if (owed && owedTries > 0) {
        owedTries--;
        owedTimer = setTimeout(() => {
          owedTimer = null;
          if (!socket) ensureSocket();
        }, OWED_RETRY_MS);
      }
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
    if (!tab.hears()) {
      forwarding = false;
      set({ phase: 'listening', heard: '', notice: '', paused: true });
      return;
    }
    ensureSocket();
    const agent = opts.agent();
    const context = opts.getContext();
    sentContext = JSON.stringify(context ?? null);
    sendMsg({
      type: 'start',
      setup,
      mode: 'tap',
      context,
      author: opts.author,
      ...(agent ? { agent } : {}),
    });
    doneWorking();
    forwarding = true;
    set({ phase: 'listening', heard: '', notice: '' });
  };

  /** Voice stops by itself, says why, and reports it — except a state of
   *  this server or origin (`quiet`), which every tap would report again. */
  function halt(notice: string, detail = '', quiet = false): void {
    on = false;
    tab.leave();
    stopCapture();
    player.stop();
    set({ phase: 'off', heard: '', notice, paused: false });
    const err = new Error(`Lead chat voice stopped: ${notice}${detail ? ` (${detail})` : ''}`);
    err.name = 'LeadVoiceStopped';
    if (!quiet) (opts.report ?? reportToPage)(err);
  }

  const again = (): void => {
    if (on) listen();
  };

  /** The lead's answer reaching a page whose voice stopped by itself: the
   *  reader did not ask for silence, so it is said. It waits out no listener,
   *  because with voice off none is open. */
  function sayWhileOff(m: SpokenServerMessage): void {
    if (hushed) return;
    if (m.type === 'reply' && m.route === LEAD_ANSWER && m.spoken) answering = true;
    if (!answering) return;
    if (m.type === 'audio-start') player.begin(m.sampleRate);
    if (m.type === 'audio-end') {
      answering = false;
      player.finish(() => {});
    }
  }

  function onServer(m: SpokenServerMessage): void {
    // Counted while voice is off too: the socket a stop kept is waiting for it.
    if (m.type === 'reply' && m.route === 'agent' && !m.spoken) awaiting++;
    if (m.type === 'reply' && m.route === LEAD_ANSWER) awaiting = Math.max(0, awaiting - 1);
    if (!on) {
      sayWhileOff(m);
      return;
    }
    switch (m.type) {
      case 'heard':
        if (st.phase === 'listening') set({ heard: m.text });
        return;
      case 'turn-end':
        forwarding = false;
        // The empty question a paused tab ended: nothing was asked.
        if (st.paused && !m.text) return;
        set({ phase: 'working', heard: m.text });
        stillWorking();
        return;
      case 'working':
        set({ phase: 'working' });
        stillWorking();
        return;
      case 'reply':
        // Nothing to say now — nothing heard, or the lead took the question
        // and answers later: the next question listens while it works. The
        // server says the lead's answer over a listener that has heard
        // nothing yet (`SpokenSession.sayAside`).
        if (!m.spoken) {
          if (st.phase === 'working') again();
          return;
        }
        if (st.phase === 'working') stillWorking();
        return;
      case 'audio-start':
        // An answer said while listening: the mic hears the speaker, and
        // none of it goes back as a question.
        forwarding = false;
        doneWorking();
        if (!st.paused) player.begin(m.sampleRate);
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
      hushed = false;
      tab.join();
      player.wake();
      set({ phase: 'listening', heard: '', notice: '', paused: !tab.hears() });
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
      const asked = st.phase === 'working' || st.phase === 'speaking' || awaiting > 0;
      on = false;
      hushed = true;
      answering = false;
      tab.leave();
      stopCapture();
      player.stop();
      // A question still being heard is dropped with its socket. One already
      // asked keeps the socket, so the lead's answer still reaches the chat.
      if (asked) sendMsg({ type: 'stop' });
      else dropSocket();
      set({ phase: 'off', heard: '', notice: '', paused: false });
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
      if (owedTimer) clearTimeout(owedTimer);
      tab.destroy();
      stopCapture();
      player.stop();
      dropSocket();
    },
  };
}
