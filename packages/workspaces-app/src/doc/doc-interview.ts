/**
 * The planning voice on the review doc: tap Talk and talk through the plan.
 * Nobody has to say "interview me" — at each pause Claude asks about the
 * plan's next open question and writes each answer into its section (the
 * server's `spoken-reply/interview.ts`), and while it asks, its cursor is on
 * the words it means in every open view (`agent-focus.ts`).
 *
 * It talks over the board mic's spoken-reply socket,
 * `WS /workspaces/<ws>/voice/converse`, with `{ surface: 'doc', docId }` as
 * the context of every turn, and in the setup the board's switch last chose
 * (`SETUP_KEY`), so the three setups are compared here exactly as they are on
 * the board. On a doc the server ends each turn only at a confirmed pause
 * (`pause-gate.ts`), so the card never decides when a sentence is over.
 *
 * HANDS FREE. Once Claude has finished saying a question the card listens
 * again by itself, and when Claude decides to say nothing it listens again at
 * once; Done ends a turn by hand. The microphone is opened once, inside the
 * tap that opened the card — Safari opens audio only inside a gesture — and
 * frames are sent only while the card is listening, so Claude's own voice is
 * never sent back.
 *
 * SILENCE. When nothing is heard for `SILENCE_MS` the card ends the turn
 * empty, which is a pause like any other: on opening it asks the first
 * question, and after a question the server offers once to skip it. Only
 * once per question: after the offer it waits for as long as it takes.
 * Setup 3 is left to Gemini's own turn-taking.
 *
 * IN A PLANNING MEETING it needs no tap. While this page records a plan's
 * meeting (`DocInterviewOpts.meeting`) the voice is on by itself and every
 * `start` says `ears: 'meeting'`. The card stays closed, because the doc's
 * live zone already shows the transcript; Talk shows or hides it without
 * stopping the voice, and its × stops the voice. The server hears the
 * meeting's own transcript (`spoken-reply/meeting-ears.ts`), so no second
 * microphone is opened and no audio is sent here, and there is no silence turn — a quiet
 * room is not asked anything. The question plays through this page's
 * spoken-reply player, the same PCM path the Talk card plays, and the card
 * listens again after every reply until the recording stops; when the meeting
 * goes on over a reply, the server says `cut-in` and the card stops playing
 * and listens on. A meeting's card has only its ×: no Done, Skip, Later or
 * Finish. The meeting bar holds the pause setting and what Claude is working
 * on (`doc-interview-bar.ts`). Setup 3 has its
 * own ears, so a meeting is heard on setup 1 or 2. Any other meeting this
 * page records is heard the same way with the card closed, so "Claude, …"
 * from the owner is answered aloud through the same player
 * (`spoken-reply/meeting-ask.ts`); a server that will not answer here says
 * so once and the socket closes.
 *
 * Mounted only for a writer on a board whose server names a setup.
 */
import {
  type SpokenClientMessage,
  type SpokenHeldSetups,
  type SpokenPause,
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
import type { SpokenSocket } from '../board/spoken-reply-client.ts';
import type { MountScope } from '../mount-scope.ts';
import { defaultOriginFacts, insecureOriginMessage } from '../voice-capture.ts';
import { MeetingVoiceBar, pageStorage, storedPause } from './doc-interview-bar.ts';
import { audioCtor, interviewSetups } from './doc-interview-setup.ts';
import {
  DocInterviewView,
  type InterviewFrame,
  MEETING_PROMPT,
  START_PROMPT,
} from './doc-interview-view.ts';

const OPEN = 1;
/** Frames held while the socket connects: 20s of 50ms frames. */
const MAX_QUEUED = 400;
/** How long a question waits in silence before the card says so. */
export const SILENCE_MS = 8000;

export interface DocInterviewOpts {
  docId: string;
  workspaceId: string;
  author: { id: string; name: string; kind?: string };
  scope: MountScope;
  /** `GET /workspaces/<ws>/voice/timings`'s answer. */
  setups: readonly SpokenSetup[];
  held?: SpokenHeldSetups;
  url: string;
  document?: Document;
  openSocket?: (url: string) => SpokenSocket;
  startCapture?: (opts: SpokenCaptureOpts) => Promise<SpokenCaptureStart>;
  captureContext?: () => AudioContext | undefined;
  playbackContext?: () => PlaybackContext | null;
  storage?: Pick<Storage, 'getItem'> | null;
  /** Where the pause setting is kept; absent, the page's own storage. */
  pauseStorage?: Pick<Storage, 'getItem' | 'setItem'> | null;
  /** The secure-context gate; a test passes one that lets it through. */
  blocked?: () => string | null;
  silenceMs?: number;
  /** The page's meeting: told when it starts and stops recording, and
   *  whether the doc is a plan. Absent: the card opens only on a tap. */
  meeting?: {
    onRecording(fn: (recording: boolean) => void): void;
    isPlan(): boolean;
    /** The meeting bar, which takes the voice's line and pause setting. */
    bar?: HTMLElement;
  };
}

export function mountDocInterview(opts: DocInterviewOpts): DocInterviewView {
  const doc = opts.document ?? document;
  const view = new DocInterviewView(doc);
  const { setup, earsSetup } = interviewSetups(opts.setups, opts.storage);
  const heldLine = Object.values(opts.held ?? {})[0] ?? 'Spoken replies are not set up here.';

  const frame: InterviewFrame = {
    open: false,
    phase: 'idle',
    question: START_PROMPT,
    heard: '',
    detail: [],
    note: null,
    interviewing: false,
    meeting: false,
  };
  const draw = (): void => {
    if (!opts.scope.disposed) view.draw(frame);
  };

  let socket: SpokenSocket | null = null;
  let queue: Array<string | Int16Array> = [];
  let capture: { stop(): void } | null = null;
  let listening = false;
  let asking = false;
  let silenceTimer: ReturnType<typeof setTimeout> | null = null;
  /** The current question has had its silence turn. */
  let silenced = false;
  /** Hearing this page's meeting rather than a microphone. */
  let inMeeting = false;
  /** That meeting is a plan's: the planning voice is on, its card on a tap. */
  let planMeeting = false;
  /** The server stopped a reply for a cut-in; that reply's `audio-end`
   *  may still come, and resumes nothing. */
  let cutOff = false;
  /** When the server called the last turn over, for the delay it logs. */
  let turnEndedAt: number | null = null;
  const quiet = (): void => {
    if (silenceTimer) clearTimeout(silenceTimer);
    silenceTimer = null;
  };

  const sendRaw = (d: string | Int16Array): void => {
    if (socket && socket.readyState === OPEN) socket.send(d);
    else if (queue.length < MAX_QUEUED) queue.push(d);
  };
  const sendMsg = (m: SpokenClientMessage): void => sendRaw(JSON.stringify(m));
  const pauseStore = opts.pauseStorage === undefined ? pageStorage() : opts.pauseStorage;
  const onPause = (pause: SpokenPause): void =>
    void (inMeeting && sendMsg({ type: 'pause', pause }));
  const host = opts.meeting?.bar;
  const bar = host
    ? new MeetingVoiceBar({ host, scope: opts.scope, storage: pauseStore, onPause })
    : null;

  const ensureSocket = (): void => {
    if (socket && socket.readyState <= OPEN) return;
    const ws = (opts.openSocket ?? ((u) => new WebSocket(u) as unknown as SpokenSocket))(opts.url);
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
      listening = false;
      player.stop();
      if (frame.open || planMeeting) {
        frame.note = 'The connection closed. Tap Talk to go on.';
        frame.phase = 'done';
        draw();
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
    onFirstWord: (at) => {
      // The meeting's delay, pause to first word, logged per setup.
      if (!inMeeting || turnEndedAt === null) return;
      sendMsg({ type: 'timing', delayMs: Math.max(0, Math.round(at - turnEndedAt)) });
      turnEndedAt = null;
    },
  });

  /** Open the microphone, inside the tap that asked for it. */
  function openCapture(): void {
    if (capture) return;
    const Ctor = audioCtor();
    const ctx = opts.captureContext ? opts.captureContext() : Ctor ? new Ctor() : undefined;
    const holder = { stopped: false };
    capture = { stop: () => void (holder.stopped = true) };
    void (opts.startCapture ?? startSpokenCapture)({
      ...(ctx ? { context: ctx } : {}),
      onFrame: (pcm) => {
        if (listening) sendRaw(pcm);
      },
    }).then((r) => {
      if (!r.ok) {
        capture = null;
        listening = false;
        frame.note = r.message;
        frame.phase = 'done';
        draw();
        return;
      }
      if (holder.stopped) r.capture.stop();
      else capture = r.capture;
    });
  }

  function closeCapture(): void {
    listening = false;
    capture?.stop();
    capture = null;
  }

  function listen(): void {
    const using = inMeeting ? earsSetup : setup;
    if (using === null) return;
    player.stop();
    listening = true;
    frame.phase = 'listening';
    frame.heard = '';
    frame.note = null;
    sendMsg({
      type: 'start',
      setup: using,
      mode: 'tap',
      context: { surface: 'doc', docId: opts.docId },
      author: opts.author,
      ...(inMeeting ? { ears: 'meeting' as const } : {}),
      pause: bar?.current ?? storedPause(pauseStore),
    });
    quiet();
    if (!inMeeting && setup !== 3 && !silenced) {
      silenceTimer = setTimeout(() => {
        silenceTimer = null;
        if (!listening) return;
        silenced = true;
        listening = false;
        sendMsg({ type: 'end' });
        frame.phase = 'thinking';
        draw();
      }, opts.silenceMs ?? SILENCE_MS);
    }
    draw();
  }

  /** A command tapped rather than said: answered as if it had been heard. */
  function say(text: string): void {
    quiet();
    silenced = false;
    listening = false;
    player.stop();
    sendMsg({ type: 'stop' });
    sendMsg({ type: 'say', text });
    frame.heard = text;
    frame.phase = 'thinking';
    draw();
  }

  function afterSpoken(): void {
    if (!frame.open && !inMeeting) return;
    if (asking || inMeeting) listen();
    else {
      frame.phase = 'done';
      draw();
    }
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
      case 'heard':
        if (m.text.trim()) quiet();
        if (listening) {
          frame.heard = m.text;
          draw();
        }
        return;
      case 'turn-end':
        cutOff = false;
        quiet();
        if (m.text.trim()) silenced = false;
        listening = false;
        turnEndedAt = performance.now();
        frame.heard = m.text;
        frame.phase = 'thinking';
        draw();
        return;
      case 'reply': {
        asking = m.asking;
        const planning = m.route === 'interview';
        frame.interviewing = planning && m.asking;
        // A reply talking the open question over keeps it on the card.
        frame.question = m.question ?? (m.spoken || frame.question);
        frame.detail = m.question && m.spoken ? [m.spoken, ...m.detail] : m.detail;
        if (m.spoken) {
          frame.note = null;
          frame.phase = 'asking';
        } else if (inMeeting || (planning && m.asking)) {
          // Claude chose to say nothing: listen for the next pause.
          listen();
          return;
        } else {
          frame.note = planning ? null : 'Didn’t catch anything. Tap Talk to try again.';
          frame.phase = 'done';
        }
        draw();
        return;
      }
      case 'audio-start':
        cutOff = false;
        player.begin(m.sampleRate);
        return;
      case 'audio-end':
        // A cut-in's stopped reply ends nothing: the card is listening.
        if (cutOff) cutOff = false;
        else player.finish(afterSpoken);
        return;
      case 'cut-in':
        // The meeting went on over the voice: silence it, and listen on.
        // The server is already hearing the new turn, so no `start`, and
        // has withdrawn the question, so the card stops showing it.
        player.stop();
        cutOff = true;
        if (planMeeting) frame.question = MEETING_PROMPT;
        listening = true;
        frame.phase = 'listening';
        frame.heard = '';
        draw();
        return;
      case 'doing':
        bar?.doing(m.label);
        return;
      case 'error':
        // A meeting heard with no card: the server will not answer here.
        if (inMeeting && !planMeeting && !frame.open) {
          shut();
          return;
        }
        listening = false;
        frame.note = m.message;
        frame.phase = 'done';
        draw();
        return;
      default:
        return;
    }
  }

  function open(): void {
    const blocked =
      setup === null
        ? heldLine
        : (opts.blocked ?? (() => insecureOriginMessage(defaultOriginFacts())))();
    frame.open = true;
    if (blocked) {
      frame.note = blocked;
      frame.phase = 'done';
      draw();
      return;
    }
    player.wake();
    ensureSocket();
    openCapture();
    listen();
  }

  /** This page started recording: listen to the meeting, with the card
   *  closed. The doc's live zone already shows what is heard, so a plan's
   *  card opens only on a tap of Talk; any other meeting is heard for
   *  "Claude, …" alone. */
  function joinMeeting(): void {
    if (earsSetup === null || frame.open) return;
    inMeeting = true;
    planMeeting = opts.meeting?.isPlan() === true;
    if (planMeeting) frame.question = MEETING_PROMPT;
    frame.meeting = true;
    bar?.show(true);
    player.wake();
    ensureSocket();
    listen();
  }

  function shut(): void {
    quiet();
    silenced = false;
    inMeeting = false;
    planMeeting = false;
    bar?.show(false);
    turnEndedAt = null;
    if (frame.interviewing) sendMsg({ type: 'say', text: 'that’s enough' });
    else sendMsg({ type: 'stop' });
    // A fresh socket next time, so the next Talk starts the planning voice
    // afresh rather than finding it stopped, and the cursor comes off now.
    const ws = socket;
    socket = null;
    queue = [];
    ws?.close();
    closeCapture();
    player.stop();
    Object.assign(frame, {
      open: false,
      phase: 'idle',
      question: START_PROMPT,
      heard: '',
      detail: [],
      note: null,
      interviewing: false,
      meeting: false,
    } satisfies InterviewFrame);
    draw();
  }

  opts.meeting?.onRecording((recording) => {
    if (opts.scope.disposed) return;
    if (recording) joinMeeting();
    else if (inMeeting) shut();
  });
  opts.scope.listen(view.button, 'click', () => {
    // In a meeting Talk shows or hides the card; the voice stays on.
    if (inMeeting) {
      frame.open = !frame.open;
      draw();
    } else if (frame.open) shut();
    else open();
  });
  opts.scope.listen(view.close, 'click', () => shut());
  opts.scope.listen(view.primary, 'click', () => {
    if (frame.phase === 'listening') {
      quiet();
      listening = false;
      sendMsg({ type: 'end' });
      frame.phase = 'thinking';
      draw();
    } else if (frame.phase !== 'thinking') {
      if (!capture) openCapture();
      player.wake();
      ensureSocket();
      if (frame.phase === 'asking') sendMsg({ type: 'stop' });
      listen();
    }
  });
  for (const b of view.commands) {
    opts.scope.listen(b, 'click', () => {
      const text = b.dataset.say;
      if (text) say(text);
    });
  }
  opts.scope.onCleanup(() => {
    quiet();
    closeCapture();
    player.stop();
    const ws = socket;
    socket = null;
    ws?.close();
    bar?.remove();
    view.remove();
  });
  draw();
  return view;
}
