/**
 * The lead chat's meeting, recorded from whatever page of the board is open.
 *
 * The board holds the meeting (`lead-chat/meeting.ts` on the server): which
 * doc its notes go to, which browser holds the microphone, the lines said so
 * far. This module is the browser half on the device that holds the
 * microphone. It opens the capture, runs the doc's meeting socket through
 * `meeting-link.ts` — the same connection the doc page's Record button uses —
 * and posts every final line to the board, which shows it on every page and
 * hands a "Lead, …" line to the lead.
 *
 * A PAGE MOVE IS A RECONNECT. Moving to another page unloads this one and
 * its microphone with it, so the next page starts again with `resume: <the
 * meeting's id>` and the server continues the same recording, transcript and
 * notes section. What is said between the two pages is lost: the bank of held
 * audio dies with the page. On iPad Safari the microphone also needs one tap
 * on the new page, because an audio context only starts inside a gesture;
 * until then the chat shows "Tap to keep recording".
 *
 * A bot meeting has no microphone here. The bot joins the call from the
 * server; this page sends it and, while open, posts the bot's final lines the
 * same way (the board keeps one copy of each turn, however many pages post it).
 */
import {
  type CaptureMode,
  MEETING_AUDIO_ENCODING,
  MEETING_SAMPLE_RATE,
  type MeetingCaptureSource,
  type MeetingServerMessage,
  speakerDisplayName,
} from '@claude-workspaces/core';
import type { LeadChatMeeting } from '@claude-workspaces/core/lead-chat';
import { makeGestureContext, startMeetingCapture } from '../meeting-audio.ts';
import type { MeetingBotClient } from '../meeting-bot-client.ts';
import {
  type CaptureSetResult,
  type StartOneCapture,
  openCaptureSet,
} from '../meeting-capture-set.ts';
import {
  type MeetingLink,
  type MeetingSocket,
  createMeetingLink,
  defaultOpenSocket,
} from '../meeting-link.ts';
import { meetingSocketUrl, parseMeetingServerMessage } from '../meeting-protocol.ts';
import type { LeadChatClient } from './lead-chat-client.ts';

export type MeetingRunPhase =
  /** Nothing recording on this page. */
  | 'idle'
  /** Opening the microphone and the socket. */
  | 'opening'
  | 'recording'
  /** The socket dropped; the same meeting is being asked back. */
  | 'reconnecting'
  /** A resumed page whose microphone needs a tap to run (iPad Safari). */
  | 'tap'
  /** The recording could not run; `note` says why. */
  | 'stopped';

export interface MeetingRunState {
  phase: MeetingRunPhase;
  /** One sentence about the recording, or empty. */
  note: string;
  /** The words of the turn still being said, before it settles. */
  partial: string;
}

/** How long a resumed page waits for its microphone to deliver before it
 *  asks for the tap that starts it. */
export const TAP_WAIT_MS = 1_500;
export const TAP_NOTE = 'Tap to keep recording';

export interface LeadMeetingRunOpts {
  workspaceId: string;
  author: { id: string; name: string; kind?: string };
  client: LeadChatClient;
  /** This browser's recorder token (`recorderToken`). */
  recorder: string;
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => () => void;
  openSocket?: (url: string) => MeetingSocket;
  startCapture?: StartOneCapture;
  createAudioContext?: () => AudioContext | undefined;
  /** The doc's bot client, made for the meeting's doc. */
  bot?: (docId: string) => MeetingBotClient;
  onChange?: (s: MeetingRunState) => void;
}

export interface LeadMeetingRun {
  state(): MeetingRunState;
  /**
   * Record `meeting` from this page. `gesture` is true inside the tap that
   * started it (Start meeting, or Tap to keep recording) and false for a page
   * that resumes on load. `context` is an audio context the caller made
   * inside that tap, before it awaited anything — the start's own requests
   * come first, and a context made after them is no longer in the gesture.
   * `botUrl` is the call a bot meeting sends its bot to.
   */
  begin(
    meeting: LeadChatMeeting,
    how: { gesture: boolean; context?: AudioContext; botUrl?: string },
  ): Promise<void>;
  /** The tap a resumed page asked for. */
  tap(): void;
  /** End the recording for good: the server is told to stop. */
  stop(): void;
  /** The page is going away: close without ending, so the next page resumes. */
  release(): void;
}

/** This browser tab's recorder token. Per tab, not per device: two tabs on
 *  one Mac must not both take the microphone, and a page move in one tab
 *  keeps its token because session storage outlives the page. */
export function recorderToken(storage: Pick<Storage, 'getItem' | 'setItem'> | null): string {
  const KEY = 'cw.lead-chat.recorder';
  try {
    const held = storage?.getItem(KEY);
    if (held) return held;
    const made = `rec-${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`;
    storage?.setItem(KEY, made);
    return made;
  } catch {
    return `rec-${Math.random().toString(36).slice(2, 12)}`;
  }
}

const SOURCE: Record<'mic' | 'mix', MeetingCaptureSource> = { mic: 'mic', mix: 'mic+system' };

function defaultSchedule(fn: () => void, ms: number): () => void {
  const id = setTimeout(fn, ms);
  return () => clearTimeout(id);
}

export function createLeadMeetingRun(opts: LeadMeetingRunOpts): LeadMeetingRun {
  const now = opts.now ?? Date.now;
  const schedule = opts.schedule ?? defaultSchedule;
  let state: MeetingRunState = { phase: 'idle', note: '', partial: '' };
  let meeting: LeadChatMeeting | null = null;
  let docId = '';
  let docTitle = '';
  let recordingId: string | null = null;
  /** The capture's audio has reached the socket at least once. */
  let delivering = false;
  let capture: (CaptureSetResult & { ok: true }) | null = null;
  let bot: MeetingBotClient | null = null;
  let offBot: (() => void) | null = null;
  let cancelTapWait: (() => void) | null = null;
  let generation = 0;
  const names: Record<string, string> = {};
  const posted = new Set<number>();

  const set = (next: Partial<MeetingRunState>): void => {
    state = { ...state, ...next };
    opts.onChange?.(state);
  };

  const mode = (): CaptureMode => (meeting?.speakers === 'solo' ? 'solo' : 'conversation');
  const who = (speaker?: string): string =>
    speaker ? speakerDisplayName(speaker, names) : opts.author.name;

  const postLine = (turn: number, text: string, speaker?: string): void => {
    if (!meeting || posted.has(turn) || !text.trim()) return;
    posted.add(turn);
    void opts.client.meeting('line', opts.author, {
      id: meeting.id,
      turn,
      who: who(speaker),
      text,
    });
  };

  const link: MeetingLink = createMeetingLink({
    url: () => meetingSocketUrl(opts.workspaceId, docId),
    openSocket: opts.openSocket ?? defaultOpenSocket,
    now,
    schedule,
    startFrame: (c) => {
      const source = capture?.source ?? 'mic';
      const first = c.resume === undefined;
      return {
        type: 'start',
        sampleRate: MEETING_SAMPLE_RATE,
        encoding: MEETING_AUDIO_ENCODING,
        mode: mode(),
        ...(source !== 'mic' ? { source } : {}),
        participant: opts.author.name,
        ...(meeting?.notes === 'none' ? { notes: false } : {}),
        // A doc the person picked may hold their own writing; the server
        // then answers with a notes doc of its own, and this page records
        // there (`notes_doc` below). Only on a first microphone start.
        ...(first && meeting?.notes === 'existing' && source === 'mic' ? { handoff: true } : {}),
        ...(c.resume !== undefined ? { resume: c.resume } : {}),
        ...(c.heldMs > 0 ? { heldMs: c.heldMs } : {}),
      };
    },
    message: (data) => handle(parseMeetingServerMessage(data)),
    dropped: () => {
      if (recordingId && (state.phase === 'recording' || state.phase === 'tap')) {
        retry();
        return;
      }
      finish('The connection to the meeting was lost.');
    },
  });

  function retry(): void {
    const step = link.retry(recordingId ?? undefined, () => state.phase === 'reconnecting');
    if (step === 'give-up') {
      finish('The connection to the meeting was lost.');
      return;
    }
    set({ phase: 'reconnecting', note: 'Reconnecting…' });
  }

  function releaseAudio(): void {
    cancelTapWait?.();
    cancelTapWait = null;
    capture?.stopAll();
    capture = null;
  }

  function finish(note: string): void {
    link.cancelRetry();
    link.clearHold();
    link.close();
    releaseAudio();
    set({ phase: 'stopped', note, partial: '' });
  }

  function handle(msg: MeetingServerMessage | null): void {
    if (!msg || !meeting) return;
    switch (msg.type) {
      case 'ready': {
        link.ready();
        for (const [label, name] of Object.entries(msg.speakers ?? {})) names[label] = name;
        const moved = docId !== meeting.docId;
        const changed = msg.meetingId !== recordingId || meeting.meetingId !== msg.meetingId;
        recordingId = msg.meetingId;
        // A page still waiting for its tap stays waiting: the socket is up,
        // the microphone is not.
        if (state.phase !== 'tap') set({ phase: 'recording', note: '' });
        if (changed || moved || meeting.recorder !== opts.recorder) {
          void opts.client.meeting('recording', opts.author, {
            id: meeting.id,
            meetingId: msg.meetingId,
            recorder: opts.recorder,
            ...(moved ? { docId, docTitle } : {}),
          });
        }
        break;
      }
      case 'notes_doc':
        // The doc picked holds the person's own writing, so the note-taker
        // writes to a notes doc of its own; record there instead.
        link.close();
        docId = msg.docId;
        docTitle = msg.title;
        link.connect();
        break;
      case 'transcript':
        if (msg.final) {
          postLine(msg.turn, msg.text, msg.speaker);
          set({ partial: '' });
        } else {
          set({ partial: msg.text });
        }
        break;
      case 'unavailable':
        if (link.resuming && msg.reason === 'already_recording') {
          // The last page's socket is still being torn down; ask again.
          retry();
          break;
        }
        finish(msg.message);
        break;
      case 'stopped':
        finish(msg.reason === 'silence' ? 'The recording stopped after a long silence.' : '');
        break;
      case 'error':
        finish(msg.message);
        break;
      default:
        break;
    }
  }

  /** On a page that resumed without a gesture: if nothing is flowing after a
   *  moment, the microphone is waiting for a tap. */
  function watchForTap(): void {
    cancelTapWait?.();
    cancelTapWait = schedule(() => {
      cancelTapWait = null;
      if (delivering || !capture) return;
      const health = capture.health();
      if (health && health.contextState !== 'running') set({ phase: 'tap', note: TAP_NOTE });
    }, TAP_WAIT_MS);
  }

  async function beginBot(m: LeadChatMeeting, botUrl?: string): Promise<void> {
    if (!opts.bot) {
      set({ phase: 'stopped', note: 'This page cannot send a bot.' });
      return;
    }
    bot = opts.bot(m.docId);
    offBot = bot.onTranscript((f) => {
      if (f.final) postLine(f.turn, f.text, f.speakerName ?? f.speaker);
      else set({ partial: f.text });
    });
    if (botUrl) {
      try {
        await bot.invite(botUrl, m.by.name ? `${m.by.name}’s notes` : undefined);
      } catch (err) {
        set({ phase: 'stopped', note: err instanceof Error ? err.message : String(err) });
        return;
      }
    }
    set({ phase: 'recording', note: '' });
  }

  return {
    state: () => state,
    async begin(m, how) {
      if (state.phase === 'opening' || state.phase === 'recording') return;
      const attempt = ++generation;
      meeting = m;
      docId = m.docId;
      docTitle = m.docTitle;
      recordingId = m.meetingId ?? null;
      for (const l of m.lines) posted.add(l.turn);
      if (m.source === 'bot') {
        await beginBot(m, how.botUrl);
        return;
      }
      // Before anything is awaited: this is still the tap, and Safari lets an
      // audio context start only inside one.
      const context =
        how.context ??
        (how.gesture ? (opts.createAudioContext ?? makeGestureContext)() : undefined);
      set({ phase: 'opening', note: '' });
      delivering = false;
      const started = await openCaptureSet({
        ...(context ? { context } : {}),
        source: SOURCE[m.source],
        mode: mode(),
        onFirstStreamFrame: () => {
          if (!link.open || delivering) return;
          delivering = true;
          if (state.phase === 'tap') set({ phase: 'recording', note: '' });
        },
        onFrame: (pcm) => link.audio(pcm),
        startCapture: opts.startCapture ?? startMeetingCapture,
      });
      if (attempt !== generation) {
        if (started.ok) started.stopAll();
        return;
      }
      if (!started.ok) {
        set({
          phase: how.gesture ? 'stopped' : 'tap',
          note: how.gesture ? started.message : TAP_NOTE,
        });
        return;
      }
      capture = started;
      link.connect(recordingId ?? undefined);
      if (!how.gesture) watchForTap();
    },
    tap() {
      if (state.phase !== 'tap' || !meeting) return;
      if (capture) {
        // Inside the gesture: the one call Safari lets start the context.
        void capture.resumeAudio();
        set({ phase: 'recording', note: '' });
        watchForTap();
        return;
      }
      const m = meeting;
      set({ phase: 'idle' });
      void this.begin(m, { gesture: true });
    },
    stop() {
      generation++;
      if (bot) {
        void bot.leave().catch(() => {});
        offBot?.();
        offBot = null;
        bot.destroy();
        bot = null;
      }
      if (link.open) link.send(JSON.stringify({ type: 'stop' }));
      link.cancelRetry();
      link.clearHold();
      link.close();
      releaseAudio();
      meeting = null;
      recordingId = null;
      set({ phase: 'idle', note: '', partial: '' });
    },
    release() {
      generation++;
      offBot?.();
      offBot = null;
      bot?.destroy();
      bot = null;
      link.cancelRetry();
      link.close();
      releaseAudio();
    },
  };
}
