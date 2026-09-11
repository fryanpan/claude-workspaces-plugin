/**
 * The live-meeting wire contract, shared by the browser capture and the
 * server relay.
 *
 * WHY AUDIO GETS ITS OWN SOCKET AND THE WORDS COME BACK DOWN IT. Doc events
 * already have a push channel — the SSE bus — but it keeps a replay buffer
 * of the last 200 events per channel so a reconnecting client can catch up.
 * A word-by-word transcript emits at conversational speed, which would evict
 * every real doc event from that buffer within a minute of a meeting. So the
 * transcript rides back down the same socket the audio went up: the client
 * that opened the mic is the one rendering the strip, nothing else needs the
 * partials, and no shared buffer is thrashed. Only the low-rate lifecycle
 * facts — a meeting started, a meeting stopped — go out over SSE, where
 * other viewers of the doc can see that recording is live.
 *
 * WHY THE SOCKET IS THE LIFECYCLE. Opening this socket starts the meeting and
 * closing it stops the meeting. A separate REST start/stop would introduce a
 * state the two halves can disagree about — a meeting marked live whose audio
 * socket never connected, or a socket streaming into a meeting the server
 * thinks ended. There is one fact here and one owner of it.
 */

import type { MeetingCaptureSource, MeetingGroup, MeetingStreamId } from './meeting-streams.ts';
import type { MeetingTimingMark } from './meeting-timing.ts';
import { MAX_ROOM_SPEAKERS, MIN_ROOM_SPEAKERS } from './meeting-tuning.ts';
import { type NotesMethod } from './notes-method.ts';

/** The audio the capture promises to send: mono, little-endian signed 16-bit. */
export const MEETING_AUDIO_ENCODING = 'pcm_s16le' as const;

/**
 * The sample rate the browser resamples to before sending. 16 kHz is the
 * floor every streaming speech model is trained at, and sending more than the
 * model uses only buys bandwidth.
 */
export const MEETING_SAMPLE_RATE = 16_000;

/**
 * The WebSocket path for a doc's meeting audio.
 *
 * The board is part of the address like every other resource route: the
 * socket is a doc's, and a doc is reached through a board that holds it. The
 * top-level `/audio/<docId>` it replaces was the last shape that let a caller
 * open a doc's stream without saying where the doc lived, and the upgrade
 * guard therefore had to re-derive the board itself to know whose it was.
 */
export function meetingSocketPath(workspaceId: string, docId: string): string {
  return `/workspaces/${encodeURIComponent(workspaceId)}/docs/${encodeURIComponent(docId)}/audio`;
}

/**
 * Who the microphone is expected to hear.
 *
 * `solo` is the default and the common case — Bryan talking to himself over a
 * doc — and it is the CHEAP one: diarization is a per-session surcharge on
 * top of the streaming rate ($0.12/hr against $0.15, so a 1.8x bill), and
 * guessing at a second speaker who is not in the room buys nothing. Nothing
 * announces an in-person conversation, so `conversation` is asked for: a
 * button that says this is a conversation, or the strip's own switch.
 */
export type CaptureMode = 'solo' | 'conversation';

/** The mode a capture runs in when nobody said otherwise. */
export const DEFAULT_CAPTURE_MODE: CaptureMode = 'solo';

/** Whether this mode pays for speaker labels. The one place that decides. */
export function detectsSpeakers(mode: CaptureMode): boolean {
  return mode === 'conversation';
}

/** A capture mode, or the default for anything else. */
export function parseCaptureMode(raw: unknown): CaptureMode {
  return raw === 'conversation' ? 'conversation' : DEFAULT_CAPTURE_MODE;
}

/**
 * How many people the room holds, and why the engine is TOLD.
 *
 * AssemblyAI's streaming diarization takes a `max_speakers` alongside
 * `speaker_labels` — "a hard cap on the number of speaker labels (1-10). If
 * more people speak than this value, the additional speakers are merged into
 * the closest existing label" (streaming/label-speakers-and-separate-channels,
 * read 2026-08-30). Left absent it is unbounded, and an unbounded diarizer in
 * a room where two people share ONE far-field microphone is free to answer a
 * change of posture with a new letter: the failure this cap exists to stop is
 * a model inventing people, not a model missing one.
 *
 * The docs also say to "give the model a little headroom above the number of
 * speakers you expect; setting it too high can cause over-splitting". We do
 * not take the headroom by default, because the two failures are not
 * symmetrical here: a third voice merged into the closest label costs one
 * misattributed turn, while an invented Speaker C costs the reader their
 * belief that the labels mean anything. The number is a knob (`?speakers=3`
 * on the doc address) precisely so a room that really holds three says so
 * rather than being guessed at.
 */
export const DEFAULT_ROOM_SPEAKERS = 2;

export { MIN_ROOM_SPEAKERS, MAX_ROOM_SPEAKERS } from './meeting-tuning.ts';

/**
 * A room size, clamped into the engine's range, or nothing.
 *
 * Nothing — rather than the default — is the answer for an absent or
 * unreadable field, so the caller can tell "nobody said" from "somebody said
 * two" and apply the default in ONE place.
 */
export function parseRoomSpeakers(raw: unknown): number | undefined {
  // An empty or blank string is NOT a room of zero people. `?speakers=` with
  // nothing after it is what an address bar produces when the value is
  // deleted, and `Number('')` is 0, which clamps to one label — every voice
  // merged into one, the exact opposite of what the cap is for, from a
  // parameter that said nothing.
  if (typeof raw === 'string' && raw.trim() === '') return undefined;
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN;
  if (!Number.isFinite(n)) return undefined;
  const rounded = Math.round(n);
  if (rounded < MIN_ROOM_SPEAKERS) return MIN_ROOM_SPEAKERS;
  if (rounded > MAX_ROOM_SPEAKERS) return MAX_ROOM_SPEAKERS;
  return rounded;
}

/**
 * The cap this capture asks the engine for, or nothing when it asks for no
 * labels at all. A solo session sends neither parameter: an unpriced session
 * is one that never asked, and a cap on a feature that is off is noise on the
 * URL that a reader would have to work out is inert.
 */
export function maxSpeakersFor(mode: CaptureMode, speakers?: number): number | undefined {
  if (!detectsSpeakers(mode)) return undefined;
  return parseRoomSpeakers(speakers) ?? DEFAULT_ROOM_SPEAKERS;
}

/**
 * The engines a capture may name. The list the CLIENT may ask for — the mock
 * is not on it, because a browser must not be able to talk a server into a
 * wordless meeting. Which of these a given server can actually open depends
 * on its keys; `GET /api/meeting-engines` reports that, and a `start` naming
 * an engine the server does not hold answers `unavailable`.
 */
export const TRANSCRIPTION_ENGINE_NAMES = ['assemblyai', 'assemblyai-pro', 'soniox'] as const;
export type TranscriptionEngineName = (typeof TRANSCRIPTION_ENGINE_NAMES)[number];

/**
 * An engine name, or nothing. Nothing — rather than a default — for an
 * absent or unreadable value, so "nobody chose" reaches the server as
 * itself and the server's default (its first configured engine) applies in
 * ONE place. The permissive direction would route a typo to a paid session
 * on an engine nobody picked.
 */
export function parseEngineName(raw: unknown): TranscriptionEngineName | undefined {
  return (TRANSCRIPTION_ENGINE_NAMES as readonly string[]).includes(raw as string)
    ? (raw as TranscriptionEngineName)
    : undefined;
}

/**
 * The one line the transcript panel opens with, before any words arrive.
 *
 * IT IS A REMINDER, NOT A CONTROL. What stood here was a whole consent step —
 * a fixed sentence the device spoke into the room, a second start button that
 * declined it, and a record of which path was taken. Bryan took all of it out
 * on 2026-09-01 ("This is too much fiddling. I'll manually handle consent for
 * now."): the machinery asked the person to make a decision on every single
 * recording, in front of a room that was already talking, and the thing it
 * bought — a claim that somebody had been told — was one the client could
 * never actually stand behind.
 *
 * So the honest replacement says who is responsible, once, where the words
 * they are about to record appear. It is addressed to the person recording
 * rather than to the room, and it blocks nothing: pressing record is the
 * confirmation.
 */
export const RECORDING_CONSENT_NOTE = "By recording, you confirm that you've asked for consent";

/** Client → server. Sent as a JSON text frame; audio is sent as binary frames. */
export type MeetingClientMessage =
  | {
      type: 'start';
      sampleRate: number;
      encoding: typeof MEETING_AUDIO_ENCODING;
      /**
       * Absent means `solo`: a client built before modes existed, and a
       * person who never asked for the surcharge, get the same cheap
       * session.
       */
      mode: CaptureMode;
      /**
       * How many people are in the room, when the client knows. Only the
       * browser can know it — nothing on the server can hear the room — and
       * it is absent from every solo capture and from any client built before
       * the cap existed, both of which fall back to `DEFAULT_ROOM_SPEAKERS`.
       */
      speakers?: number;
      /**
       * Where the audio on this socket comes from. Absent is the
       * microphone — every client built before the choice existed. `system`
       * is the Mac's own output, handed to the page by Chrome's share
       * picker; it rides the same pipeline and differs only in the record.
       * `mic+system` is BOTH at once, and it is the one value that changes
       * what the bytes on this socket mean: every audio frame carries a
       * stream byte in front of it (`tagAudioFrame`), because one meeting is
       * now carrying two engine sessions. See `meeting-streams.ts`.
       */
      source?: MeetingCaptureSource;
      /**
       * Which transcription engine to open, when the person chose one.
       * Absent means the server's default — AssemblyAI wherever both are
       * configured — so a client built before the choice existed, and a
       * person who never touched the option, keep getting exactly what they
       * got. Start-time only, like `mode`: an engine session's config is
       * fixed once open, so there is no later switch.
       */
      engine?: TranscriptionEngineName;
      /**
       * The Advanced Options a person set for this capture — only the knobs
       * they moved off the defaults, keyed by engine parameter name and
       * sanitized server-side against `tuningSpecsFor(engine)`. PRESENCE is
       * meaningful even empty: a client that sends the field owns the
       * speaker cap in its Advanced panel (default uncapped), where a client
       * that omits it gets the legacy `DEFAULT_ROOM_SPEAKERS` fallback — see
       * `maxSpeakersFromTuning`.
       */
      tuning?: Record<string, unknown>;
      /**
       * Measure this meeting's stage latencies (`?timing=1` on the address).
       * Absent on every ordinary meeting, and a server that is not asked
       * allocates nothing and attaches nothing — see `meeting-timing.ts`.
       */
      timing?: boolean;
      /**
       * Who is on this socket — the signed-in person's name, when the client
       * knows it. Not a speaker label: the engine labels voices, and a solo
       * capture asks for none. This is what the raw transcript attributes an
       * unlabelled turn to, in place of "Speaker 1". Never shown as a label
       * on the strip.
       */
      participant?: string;
      /**
       * Continue the meeting this id names instead of starting a new one.
       *
       * Sent only by a client whose socket DROPPED while it was recording:
       * the microphone stayed open, so the words either side of the outage
       * belong to one meeting, one transcript file and one notes section. The
       * server accepts it only for a meeting it can still find on disk and
       * that no other socket is holding; anything else opens a new meeting,
       * and `ready` says which happened (`resumed`).
       *
       * Absent on every first `start`, which is what a resume must never be
       * mistaken for: a fresh recording gets its own id, its own section and
       * its own bill.
       */
      resume?: string;
    }
  | { type: 'stop' }
  /**
   * Advanced Options changed MID-MEETING. Only AssemblyAI's protocol has a
   * mid-session update message, and only for some knobs; the relay applies
   * what the live engine can take (`pickLiveTuning`) and answers `tuned`
   * naming what it applied, so the strip can say "applied" only about knobs
   * that actually reached the session. Everything else waits for the next
   * recording, which the client already knows from the same specs.
   */
  | { type: 'tune'; settings: Record<string, unknown> }
  /**
   * One half of an NTP-style exchange, so the two network legs can be priced
   * across two clocks. Answered with `timing_pong` and nothing else; it never
   * touches the meeting's state.
   */
  | { type: 'timing_ping'; id: number; clientMs: number }
  /**
   * "Speaker A is Carol." The engine labels voices within one session; the
   * person names a label once and every turn with it — on the strip, in the
   * record, in the notes — reads as the name from then on. Per meeting: the
   * same letter is a different person next time.
   */
  | { type: 'name_speaker'; speaker: string; name: string }
  /**
   * "Take the rest of these notes with THIS note-taker."
   *
   * Per DOC, not per meeting, and it takes effect on the next tick: nothing
   * already written is rewritten, and the meeting record keeps who asked and
   * when. Sent while recording, from the same chooser fold that sets it at
   * rest, which is why the socket carries it at all — the at-rest case is an
   * HTTP call and needs no live session.
   */
  | { type: 'set_notes_method'; method: NotesMethod; by?: string }
  /**
   * "One of my microphones just died", and later "it is back".
   *
   * A capture is not the meeting. The socket can be perfectly healthy while
   * the browser has taken a stream away underneath it — which is what starting
   * a screen share does to a `getDisplayMedia` capture, because the browser
   * and the OS re-arbitrate screen capture at exactly that moment. The audio
   * graph downstream of a dead track keeps pulling and keeps delivering
   * SILENCE, so every frame still arrives, the engine hears a quiet room, and
   * nothing anywhere reports a problem. That is the shape of the bug this
   * frame exists for: not a failure, an absence that looks like success.
   *
   * So the browser says so out loud. `lost` opens a gap in the durable
   * record at the moment the track ended; `restored` closes it. A gap left
   * open when the meeting stops stays open, because "the audio never came
   * back" is a different fact from "it came back at the end".
   *
   * It changes NOTHING about the audio path: the frames on this socket are
   * the frames the streams that are still running produce. This is a note in
   * the margin of the record, and the record is the only thing it reaches.
   */
  | {
      type: 'stream_state';
      stream: MeetingStreamId;
      state: 'lost' | 'restored';
      /** A short machine reason (`ended`, `muted`) for the record. */
      reason?: string;
    };

/** Longest name a speaker label can be given. A name, not a bio. */
export const MAX_SPEAKER_NAME = 60;

// What a voice is CALLED — the placeholder, the normalisation of a saved
// name, and the display string — is `speaker-name.ts`, re-exported here
// because every caller of this module asks for it in the same breath as the
// protocol it belongs to.
export {
  normalizeSpeakerName,
  speakerDisplayName,
  speakerGivenName,
  speakerPlaceholderName,
} from './speaker-name.ts';

/**
 * Why a meeting cannot be transcribed. Separated from a generic error because
 * the strip renders these as a settled state rather than a failure: nothing
 * is retrying, and the words are never coming.
 */
export type MeetingUnavailableReason =
  /** No API key on the server — the documented "transcription not configured". */
  | 'not_configured'
  /** A key exists but the engine refused or dropped the connection. */
  | 'engine_unavailable'
  /** Another socket already holds this doc's meeting. */
  | 'already_recording';

/** Server → client. Always a JSON text frame. */
export type MeetingServerMessage =
  /**
   * Transcription is live; words follow. `mode` is what the SERVER opened,
   * echoed back so the strip reports the session that is actually running
   * (and being billed) rather than the one the client asked for.
   */
  | {
      type: 'ready';
      meetingId: string;
      startedAt: number;
      engine: string;
      mode: CaptureMode;
      /**
       * True only when this `ready` answers a `start` that asked to RESUME
       * and the server took it: same meeting id, same transcript, same notes
       * section, and `startedAt` is the original recording's.
       *
       * Absent — never `false` from an older server — is a new meeting, so a
       * client that asked to resume and reads nothing here knows the fallback
       * happened and can say so.
       */
      resumed?: boolean;
    }
  /** No words will follow. The socket stays open so the strip can say why. */
  | { type: 'unavailable'; reason: MeetingUnavailableReason; message: string }
  /**
   * One turn of speech. `text` is the WHOLE turn as currently understood, not
   * a delta — a later message with the same `turn` replaces the earlier text
   * in place, which is how a mis-heard word gets corrected after it is already
   * on screen. `final` marks the engine done revising that turn. `speaker` is
   * the engine's label for the voice (`"A"`, `"B"`), absent until it has
   * decided; display goes through `speakerDisplayName`.
   */
  | {
      type: 'transcript';
      turn: number;
      text: string;
      final: boolean;
      speaker?: string;
      /**
       * Which half of a two-stream meeting these words came from — the
       * people in the room, or the people coming out of the speakers.
       * Absent on every single-stream meeting, where there is only one
       * answer and stating it would be noise.
       */
      group?: MeetingGroup;
      /** Stage marks for this frame, present only on a timing meeting. */
      timing?: MeetingTimingMark;
    }
  /**
   * Where a notes tick is in its life: its turns split off to compose
   * (`composing`), the composed note landed in the doc (`written`), the
   * compose ran and wrote nothing (`empty`), or the compose failed and the
   * turns carry into the next tick (`failed`). `turns` are the same turn ids
   * the `transcript` frames carry, so the provisional surface can move
   * exactly those lines into "being written" and out again.
   *
   * `empty` and `failed` differ on the server and not on the surface: both
   * mean no note carries these words, so both return them to the stream.
   * They are separate because only `failed` carries them into another
   * compose — see `NotesTickLifecycle`.
   */
  | {
      type: 'notes_progress';
      tick: number;
      phase: 'composing' | 'written' | 'empty' | 'failed';
      turns: number[];
    }
  /** The answer to a `timing_ping`, carrying both server-side timestamps. */
  | {
      type: 'timing_pong';
      id: number;
      clientMs: number;
      serverRecvMs: number;
      serverSendMs: number;
    }
  /**
   * The answer to a `tune`: which keys reached the live engine session.
   * Empty means none did — an engine with no update channel (Soniox), keys
   * outside the live set, or no live meeting to apply them to; those take
   * effect on the next recording instead.
   */
  | { type: 'tuned'; applied: string[] }
  /**
   * The answer to a `set_notes_method`, and the reason that frame has one at
   * all: the record's write can fail (a data dir that is full, read-only or
   * gone) and the failure is swallowed, because losing a preference must
   * never fail a tick. Unanswered, the chooser would go on showing a
   * note-taker the next tick is not going to use. `recorded: false` is the
   * client's cue to put the row back.
   */
  | { type: 'notes_method'; method: NotesMethod; recorded: boolean }
  /** The meeting ended; its transcript is durable. */
  | { type: 'stopped'; meetingId: string; endedAt: number }
  /** Something went wrong mid-meeting. Distinct from `unavailable`. */
  | { type: 'error'; message: string };
