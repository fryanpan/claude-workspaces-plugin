/**
 * The `/audio/<docId>` socket, kept out of `server.ts` the way `yjs-protocol`
 * keeps the editing socket out of it.
 *
 * NOT `packages/workspaces-app/src/meeting-protocol.ts`. That file is the other
 * end of this same socket — the strip's frame parsers and its transcript fold,
 * with no lifecycle in them. Two files, one name, in two packages: this one
 * sends what that one reads.
 *
 * The wire contract itself lives in `@claude-workspaces/core/meeting.ts`, shared with
 * the browser that opens the microphone. What lives here is the half a server
 * has to get right: the socket IS the meeting's lifecycle, so every way this
 * connection can end has to end the meeting exactly once — a clean `stop`, a
 * tab closing, a network drop mid-sentence.
 *
 * NOTHING WORD-RATE GOES OVER SSE. Transcript frames ride back down this same
 * socket; only `meeting.started` and `meeting.stopped` are broadcast to the
 * doc's channel, where other viewers learn that recording is live. The SSE
 * bus keeps 200 events per channel for reconnect replay, and a conversation
 * emits that many words in about a minute — broadcasting partials would
 * evict every real doc event from the buffer for the length of a meeting.
 *
 * STAGE TIMING IS OFF UNLESS THE CLIENT ASKS. A `start` frame carrying
 * `timing: true` (the strip's `?timing=1`) makes this relay keep a ledger of
 * what it forwarded and when, and attach a block of timestamps to each
 * transcript frame. Without it no ledger is allocated, no clock is read per
 * chunk, and the wire is byte-for-byte what it was. Nothing in that block is
 * content — see `meeting-timing.ts`.
 */

import {
  AudioChunkLedger,
  type CaptureMode,
  type MeetingCaptureSource,
  type MeetingServerMessage,
  type MeetingStreamId,
  type MeetingTimingMark,
  type NotesMethod,
  detectsSpeakers,
  maxSpeakersFor,
  maxSpeakersFromTuning,
  notesMethodLabel,
  parseMeetingClientMessage,
  pickLiveTuning,
  sanitizeTuning,
  streamsForSource,
  untagAudioFrame,
} from '@claude-workspaces/core';
import {
  type MeetingNotesDeps,
  type MeetingNotesSession,
  beginNotesSession,
} from './meeting-notes.ts';
import { type MeetingStreamSet, openMeetingStreamSet } from './meeting-stream-set.ts';
import type { ActiveMeeting, MeetingStore } from './meetings.ts';
import type { TranscriptionEngine } from './transcribe.ts';

/** The slice of a Bun `ServerWebSocket` this module needs. */
export interface MeetingClient {
  readonly data: {
    docId: string;
    /**
     * This socket may not START a meeting.
     *
     * Set at the upgrade when `CW_REQUIRE_SIGNIN_TO_WRITE` is on and the
     * browser opening it has proven nobody (server.ts), the same decision
     * and the same carry as `WsCtx.readOnly` on the editing socket. Absent
     * — every socket that predates the flag, and every socket while it is
     * off — means fully writable, so nothing had to be touched to keep
     * meaning what it meant.
     *
     * Enforced on `start` below rather than at the handshake, because the
     * refusal has to be something the strip can render: a websocket that is
     * refused an upgrade reaches the page as a bare error event with no body.
     */
    readOnly?: boolean;
  };
  send(payload: string): void;
}

export interface MeetingRelayDeps {
  store: MeetingStore;
  /**
   * Every engine this server can open, in preference order: the FIRST is
   * what a `start` naming no engine gets, so existing clients keep getting
   * exactly what they got. Empty is the configured-off state, not an error.
   * See `transcribe.ts`.
   */
  engines: readonly TranscriptionEngine[];
  /**
   * Pause-driven notes. Same no-default seam as the engine — null means no
   * meeting composes notes, and nothing constructed here can reach an LLM.
   * See `meeting-notes.ts`.
   */
  notes: MeetingNotesDeps | null;
  /** Lifecycle facts only — never a transcript frame. */
  broadcast: (docId: string, payload: { event: string } & Record<string, unknown>) => void;
  /**
   * Record which note-taker this DOC is now using, changed mid-recording.
   *
   * A seam rather than a store because the socket has no business knowing
   * where the record lives, and because the at-rest half of the same choice
   * is an HTTP route that writes through the same function. Absent — a relay
   * built without it, every test that does not care — leaves the frame a
   * no-op and the doc on the method it had.
   */
  setNotesMethod?: (change: {
    docId: string;
    meetingId?: string;
    method: NotesMethod;
    by?: string;
  }) => void;
}

/**
 * `opening` and `ending` are real states rather than booleans because both
 * ends of a meeting are round trips: the engine handshake, and the flush that
 * `close()` waits for. A second stop arriving inside either one must not run
 * the teardown twice.
 */
type ConnState = 'idle' | 'opening' | 'live' | 'ending';

/** How long a shutdown waits for meetings to flush before going anyway. */
const DISPOSE_DRAIN_MS = 5_000;

interface Conn {
  state: ConnState;
  meeting: ActiveMeeting | null;
  /**
   * Every engine session this meeting is running — one for a microphone,
   * two for a mic + Mac-audio capture. See `meeting-stream-set.ts`.
   */
  streams: MeetingStreamSet | null;
  /** This meeting's notes pipeline, when the server has a composer. */
  notes: MeetingNotesSession | null;
  /**
   * Audio that arrived before the engine session finished opening, exactly as
   * it came off the wire — still carrying its stream byte on a two-stream
   * meeting, because which engine it belongs to is not known until the set is
   * open.
   */
  pending: Uint8Array[];
  /**
   * When each of those buffered chunks arrived, parallel to `pending`, so the
   * hold shows up as its own leg rather than inside the vendor's. Populated
   * only on a timing meeting; `pending` itself is untouched.
   */
  pendingRecv: number[];
  /** This connection asked to be measured. Set synchronously from `start`. */
  wantsTiming: boolean;
  /**
   * The engine this connection's meeting runs on, once one is chosen — what
   * a mid-meeting `tune` frame is sanitized against. Null while idle.
   */
  engineName: string | null;
  /**
   * Whether audio frames on this socket carry a stream byte in front of them.
   * True exactly when the capture opened more than one stream; see
   * `tagAudioFrame` in core.
   */
  tagged: boolean;
  /** What was forwarded and when, once the meeting is live. */
  ledger: AudioChunkLedger | null;
  /**
   * A stop that arrived while the handshake was still out, carrying whether
   * the socket is still there to be answered. Held as its own field rather
   * than as a fifth state so the decision survives the await: the state is
   * what the connection IS, this is what it has been asked to become.
   */
  pendingStop: { reply: boolean } | null;
}

/**
 * The timing block for one engine frame, or nothing at all.
 *
 * Nothing is the common answer and the safe one: no ledger (timing off), an
 * engine that reports no word offsets (the mock), or a word whose chunk has
 * already fallen out of the ledger's window. A frame without a block is a
 * frame the client draws exactly as it always did.
 */
function timingFor(
  ledger: AudioChunkLedger | null,
  audioEndMs: number | undefined,
  engineMs: number | undefined,
): { timing?: MeetingTimingMark } {
  if (!ledger || audioEndMs === undefined || engineMs === undefined) return {};
  const chunk = ledger.chunkAt(audioEndMs);
  if (!chunk) return {};
  return {
    timing: {
      seq: chunk.seq,
      audioEndMs,
      chunkAudioEndMs: chunk.audioEndMs,
      recvMs: chunk.recvMs,
      fwdMs: chunk.fwdMs,
      engineMs,
      // The last thing read before the frame goes out, so the browser's leg
      // starts where ours ends.
      sendMs: Date.now(),
    },
  };
}

export class MeetingRelay {
  private readonly conns = new WeakMap<MeetingClient, Conn>();
  /**
   * Every started-and-unfinished piece of this relay's own async work.
   *
   * The socket callbacks cannot await — they are Bun websocket handlers —
   * but what they start is durable: `stop()` flushes the engine's turn in
   * progress and then the notes into the doc. On shutdown every socket closes
   * at once and those writes have to land before the docs are flushed, so
   * `dispose()` waits here. A `WeakMap` of connections cannot be enumerated;
   * this can.
   *
   * `start` is tracked as well as `stop`, and not for symmetry: a socket that
   * closes mid-handshake gets a DEFERRED teardown — `stop()` only records
   * `pendingStop` and returns, and the real flush runs inside `start`'s own
   * continuation when the engine finally answers. Tracking only the `stop`
   * would see that connection as already finished and flush the docs out
   * from under it.
   */
  private readonly inFlight = new Set<Promise<void>>();

  constructor(private readonly deps: MeetingRelayDeps) {}

  /**
   * The notes pipeline this relay was built with, so the BOT relay can share
   * it rather than build a second one from the same options.
   *
   * Sharing is the requirement, not a convenience: the memory of which
   * heading each doc's notes are under is held per doc inside these deps'
   * sink (`NotesHeadingMemory`). Two of them over one doc would each miss the
   * other's section and open one of their own.
   */
  get notesDeps(): MeetingNotesDeps | null {
    return this.deps.notes;
  }

  onOpen(ws: MeetingClient): void {
    this.conns.set(ws, {
      state: 'idle',
      meeting: null,
      streams: null,
      notes: null,
      pending: [],
      pendingRecv: [],
      wantsTiming: false,
      engineName: null,
      tagged: false,
      ledger: null,
      pendingStop: null,
    });
  }

  /** A JSON text frame from the client. */
  onText(ws: MeetingClient, text: string): void {
    const conn = this.conns.get(ws);
    if (!conn) return;
    // Before the parse, so a clock exchange is never charged for our own
    // JSON work — the number it produces is used to price a network leg.
    const serverRecvMs = Date.now();
    const msg = parseMeetingClientMessage(text);
    if (!msg) {
      // Distinct from `unavailable`: the meeting is not refused, this frame
      // was unreadable. The socket stays open either way.
      this.send(ws, { type: 'error', message: 'unreadable frame' });
      return;
    }
    if (msg.type === 'timing_ping') {
      // Answered whatever the meeting is doing, and it changes nothing about
      // it: a client that never asks to be measured never sends one.
      this.send(ws, {
        type: 'timing_pong',
        id: msg.id,
        clientMs: msg.clientMs,
        serverRecvMs,
        serverSendMs: Date.now(),
      });
      return;
    }
    if (msg.type === 'start') {
      // A meeting is a WRITE and a SPEND: it opens a billed engine session
      // and its notes pipeline writes into the doc. So the sign-in decision
      // the upgrade carried is enforced here, before either happens — the
      // socket stays open so the strip can say why, which is the same shape
      // `unavailable` uses.
      if (ws.data.readOnly) {
        this.send(ws, {
          type: 'error',
          message: 'Sign in to record a meeting — recording writes notes into this doc.',
        });
        return;
      }
      // Synchronously, before the handshake is awaited: audio may arrive
      // during it, and those chunks belong in the ledger too.
      conn.wantsTiming = msg.timing === true;
      this.track(
        this.start(
          ws,
          conn,
          msg.sampleRate,
          msg.mode,
          msg.speakers,
          msg.engine,
          msg.tuning,
          msg.participant,
          msg.source,
          msg.resume,
        ),
      );
      return;
    }
    if (msg.type === 'tune') {
      // Advanced Options changed mid-meeting. Sanitized against the engine
      // that is actually running, narrowed to what its protocol can change
      // on an open session, and answered with exactly what was applied —
      // everything else waits for the next recording, and the client knows
      // which is which from the same shared specs.
      const engineName = conn.engineName;
      const streams = conn.streams;
      if (conn.state !== 'live' || !engineName || !streams) {
        this.send(ws, { type: 'tuned', applied: [] });
        return;
      }
      const live = pickLiveTuning(engineName, sanitizeTuning(engineName, msg.settings));
      // Applied only where a session actually took it — an engine with no
      // update channel answers nothing applied, exactly as it did when there
      // was one session to ask.
      const applied = Object.keys(live).length > 0 && streams.update(live) ? Object.keys(live) : [];
      this.send(ws, { type: 'tuned', applied });
      return;
    }
    if (msg.type === 'set_notes_method') {
      // The record first, because that is what the NEXT tick reads and what
      // survives a reload; the line in the doc is the visible half of the
      // same fact. Nothing already written is touched, and no answer goes
      // back — the fold that sent it already shows the row it picked.
      const meeting = conn.meeting;
      this.deps.setNotesMethod?.({
        docId: ws.data.docId,
        ...(meeting ? { meetingId: meeting.meetingId } : {}),
        method: msg.method,
        ...(msg.by ? { by: msg.by } : {}),
      });
      if (conn.state === 'live') {
        conn.notes?.noteMethodChange(notesMethodLabel(msg.method), msg.by);
      }
      return;
    }
    if (msg.type === 'name_speaker') {
      // Both the record and the notes pipeline learn the name; the strip
      // that sent it already knows. Nothing to answer.
      conn.meeting?.nameSpeaker(msg.speaker, msg.name);
      conn.notes?.nameSpeaker(msg.speaker, msg.name);
      return;
    }
    this.track(this.stop(ws, conn, true));
  }

  /** A binary audio frame. */
  onAudio(ws: MeetingClient, chunk: Uint8Array): void {
    const conn = this.conns.get(ws);
    if (!conn) return;
    if (conn.state === 'opening') {
      // The client is allowed to talk before the handshake finishes, and the
      // words spoken in that window are as real as any other. Bounded so a
      // client streaming into an engine that never answers cannot grow this
      // without limit — roughly a few seconds of 16 kHz audio.
      if (conn.pending.length < 256) {
        conn.pending.push(chunk);
        if (conn.wantsTiming) conn.pendingRecv.push(Date.now());
      } else if (conn.wantsTiming) {
        // The buffer is full, so this frame is being dropped — and the two
        // sides count frames independently: the client numbers what it SENT,
        // the ledger numbers what we FORWARDED. From the first dropped frame
        // the two ordinals name different audio, and every later sample would
        // be priced against an emit one frame per drop too early, with
        // nothing on screen to say so. Refuse to measure rather than measure
        // wrongly; the transcript itself is unaffected.
        conn.wantsTiming = false;
        conn.pendingRecv = [];
      }
      return;
    }
    if (conn.state !== 'live') return;
    this.deliver(conn, chunk, Date.now());
  }

  /**
   * One frame off the wire into the meeting that owns it: split from its
   * stream byte where there is one, teed to that stream's audio file, then
   * fed to that stream's engine.
   *
   * `recvMs` is when the frame ARRIVED, which is not now for a frame that
   * waited out the handshake — that wait belongs to the server's own leg of
   * the latency budget rather than disappearing into the engine's.
   */
  private deliver(conn: Conn, frame: Uint8Array, recvMs: number): void {
    let stream: MeetingStreamId = 'mic';
    let chunk = frame;
    if (conn.tagged) {
      const split = untagAudioFrame(frame);
      // A frame whose tag names no stream is dropped rather than guessed at:
      // feeding it to whichever engine came first would put the room's words
      // under the remote group in a record nothing can correct afterwards.
      if (!split) return;
      stream = split.stream;
      chunk = split.chunk;
    } else {
      stream = conn.streams?.streams[0] ?? 'mic';
    }
    // Teed to the meeting's retained audio before the engine sees it — the
    // same bytes, so a replay hears exactly what the engine heard, and under
    // the stream's own name so `segment-N-<stream>.pcm` says where it came
    // from.
    conn.meeting?.recordAudio(chunk, stream);
    // Recorded BEFORE the send: an engine may answer inside it, and the turn
    // it answers with has to find this chunk already in the ledger.
    conn.ledger?.record(chunk.byteLength, recvMs, Date.now());
    conn.streams?.send(stream, chunk);
  }

  /** The socket went away. Whatever it was holding ends here. */
  onClose(ws: MeetingClient): void {
    const conn = this.conns.get(ws);
    if (!conn) return;
    this.conns.delete(ws);
    this.track(this.stop(ws, conn, false));
  }

  private track(work: Promise<void>): void {
    this.inFlight.add(work);
    void work.finally(() => this.inFlight.delete(work));
  }

  /**
   * Every live meeting ends — server shutdown.
   *
   * Awaits the teardowns already running first: a shutdown force-closes the
   * audio sockets, and each one's `onClose` is mid-flush when this is called.
   * `stopAll()` after them is the belt — it ends a meeting whose connection
   * never produced a close at all, so a restart never reads a doc as
   * recording by a socket that is gone.
   */
  async dispose(): Promise<void> {
    // Looped, not a single `allSettled`: finishing a handshake ENQUEUES the
    // deferred teardown, so the set is refilled by the very thing being
    // waited on.
    //
    // allSettled, and bounded: one meeting whose engine refuses to close must
    // keep neither the others' notes nor the process itself out of the flush
    // that follows. A shutdown that cannot finish is worse than a lost
    // sentence — SIGTERM comes through here.
    const deadline = Date.now() + DISPOSE_DRAIN_MS;
    while (this.inFlight.size > 0 && Date.now() < deadline) {
      await Promise.race([
        Promise.allSettled([...this.inFlight]),
        new Promise((r) => setTimeout(r, Math.max(0, deadline - Date.now()))),
      ]);
    }
    this.deps.store.stopAll();
  }

  private send(ws: MeetingClient, msg: MeetingServerMessage): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // A socket that went away between the event and this write is the
      // normal end of a meeting, not a failure worth logging.
    }
  }

  /** The engine names a client may ask for here, default first. */
  engineNames(): string[] {
    return this.deps.engines.map((e) => e.name);
  }

  private async start(
    ws: MeetingClient,
    conn: Conn,
    sampleRate: number,
    mode: CaptureMode,
    speakers?: number,
    engineName?: string,
    rawTuning?: Record<string, unknown>,
    participant?: string,
    source?: MeetingCaptureSource,
    resume?: string,
  ): Promise<void> {
    if (conn.state !== 'idle') return;
    const docId = ws.data.docId;
    // No name means the first configured engine — the server's default, and
    // exactly what every client sent before the choice existed. A name the
    // server cannot open is refused rather than substituted: a person who
    // picked an engine must not be silently billed on a different one.
    const engine =
      engineName === undefined
        ? (this.deps.engines[0] ?? null)
        : (this.deps.engines.find((e) => e.name === engineName) ?? null);
    if (!engine) {
      this.send(ws, {
        type: 'unavailable',
        reason: 'not_configured',
        message:
          engineName === undefined
            ? 'No transcription engine is configured on this server.'
            : `The ${engineName} transcription engine is not configured on this server.`,
      });
      return;
    }
    // The person's Advanced Options, sanitized against the engine that will
    // actually run — and the speaker cap resolved once, here. A tuning-aware
    // client owns the cap in its Advanced panel where the default is
    // UNCAPPED (the engine's own default); a client that never sent the
    // field keeps the legacy fallback, `speakers` or DEFAULT_ROOM_SPEAKERS.
    // Either way a solo session gets no cap, because it asks for no labels.
    const tuning = rawTuning !== undefined ? sanitizeTuning(engine.name, rawTuning) : undefined;
    const maxSpeakers =
      tuning !== undefined
        ? detectsSpeakers(mode)
          ? maxSpeakersFromTuning(tuning)
          : undefined
        : maxSpeakersFor(mode, speakers);
    // Claim the doc BEFORE the handshake: two sockets starting at once would
    // otherwise both pass the check and both open a billed session.
    // Which captures this meeting is carrying. More than one means every
    // audio frame on this socket wears a stream byte, and it means two billed
    // engine sessions — the mic-plus-Mac-audio meeting's whole cost.
    const streams = streamsForSource(source ?? 'mic');
    const opening = {
      docId,
      engine: engine.name,
      sampleRate,
      mode,
      source: source ?? 'mic',
      ...(participant !== undefined ? { participant } : {}),
    };
    // A client whose socket dropped mid-recording asks for the meeting it was
    // already in. Taken only for one this server can still find and nobody
    // else is holding; otherwise a NEW meeting opens and `ready` says the
    // resume did not happen, which is what the strip turns into a sentence.
    // Silently starting a new meeting under the old id's name is the one
    // thing this must never do: the transcript is append-only.
    const resumed =
      resume !== undefined ? this.deps.store.resume({ ...opening, meetingId: resume }) : null;
    const meeting = resumed ?? this.deps.store.start(opening);
    if (!meeting) {
      this.send(ws, {
        type: 'unavailable',
        reason: 'already_recording',
        message: 'This doc is already being recorded by another connection.',
      });
      return;
    }
    conn.state = 'opening';
    conn.meeting = meeting;
    conn.engineName = engine.name;
    conn.tagged = streams.length > 1;
    // Stage timing measures ONE audio stream: the ledger correlates a turn to
    // the chunk it ended in by an offset into the engine's own stream, and two
    // engines have two of those. A combined capture is not measured rather
    // than measured against whichever stream wrote the ledger last.
    if (conn.tagged) conn.wantsTiming = false;
    // The notes pipeline exists for exactly the meeting's lifetime. Created
    // before the handshake so the closure below can feed it, but it holds no
    // resource until a turn arrives — abandoning it on a failed handshake
    // leaks nothing.
    const notesDeps = this.deps.notes;
    // Held as a local, not read back off `conn`: `stop()` detaches the conn's
    // fields BEFORE awaiting the engine close, and the close is what settles
    // the turn in progress — the meeting's last sentence must still have a
    // pipeline to land in when that settle arrives.
    const notes = notesDeps
      ? beginNotesSession(
          {
            // Spread, never mutated: the deps (and the ownership ledger their
            // sink holds) are shared with the bot relay, so the per-socket
            // lifecycle callback is layered on a copy.
            ...notesDeps,
            onTickLifecycle: (e) => {
              this.send(ws, {
                type: 'notes_progress',
                tick: e.tick,
                phase: e.phase,
                turns: [...e.turns],
              });
              notesDeps.onTickLifecycle?.(e);
            },
          },
          { docId, meetingId: meeting.meetingId },
        )
      : null;
    conn.notes = notes;
    // Held as a local for the same reason `notes` is: `stop()` detaches the
    // conn's fields before awaiting the engine close, and the flushed final
    // turn still deserves a mark.
    const ledger = conn.wantsTiming ? new AudioChunkLedger(sampleRate) : null;
    conn.ledger = ledger;
    // A local for the same reason `notes` and `ledger` are: `stop()` detaches
    // the conn's fields before the engine's flush settles the final turn, and
    // that turn still has to be numbered under this meeting.
    const turnBase = meeting.turnBase;

    let streamSet: MeetingStreamSet;
    try {
      streamSet = await openMeetingStreamSet({
        engine,
        streams,
        session: {
          sampleRate,
          // The mode is the only thing that turns diarization on, and it turns
          // it on for the ENGINE SESSION — there is no later switch.
          detectSpeakers: detectsSpeakers(mode),
          // And how many voices it may name. Same one-shot rule: the cap is
          // part of the session's configuration, so a person arriving late does
          // not raise it.
          ...(maxSpeakers !== undefined ? { maxSpeakers } : {}),
          // The knobs the person moved, already clamped into this engine's
          // ranges. Untouched knobs are absent — the engine's own defaults run.
          ...(tuning !== undefined && Object.keys(tuning).length > 0 ? { tuning } : {}),
        },
        onTurn: (turn) => {
          // Above whatever this meeting already recorded. Zero for a fresh
          // meeting, so every ordinary meeting's frames are byte-for-byte
          // what they were; on a resumed one it is what keeps the numbering
          // running on rather than starting again on top of the words
          // already on disk — see `ActiveMeeting.turnBase`.
          const turnId = turn.turn + turnBase;
          this.send(ws, {
            type: 'transcript',
            turn: turnId,
            text: turn.text,
            final: turn.final,
            ...(turn.speaker !== undefined ? { speaker: turn.speaker } : {}),
            // Which half of a two-stream meeting spoke. Absent on every
            // single-stream meeting, where there is only one answer.
            ...(turn.group !== undefined ? { group: turn.group } : {}),
            // The ledger is a local (see above) but the PERMISSION is read
            // off the connection every frame: the ledger is built before the
            // handshake is awaited, and audio dropped during that wait
            // withdraws the permission after the fact.
            ...timingFor(conn.wantsTiming ? ledger : null, turn.audioEndMs, turn.engineMs),
          });
          // Only settled turns reach the file. A partial is a view of a turn
          // still being revised, and the record keeps what the turn became.
          if (turn.final) meeting.recordTurn(turnId, turn.text, turn.speaker);
          // The notes pipeline sees EVERY frame: a partial is speech in
          // progress, which is exactly the evidence that defers a pause tick.
          // Under the meeting's numbering, not the session's: the ids it
          // reports back on `notes_progress` are the ones the strip has.
          notes?.onTurn({ ...turn, turn: turnId });
        },
        onError: (message) => {
          this.send(ws, { type: 'error', message });
        },
      });
    } catch (err) {
      // The doc must not be left marked as recording by a session that never
      // opened, or the next attempt answers `already_recording` forever.
      meeting.stop();
      conn.state = 'idle';
      conn.meeting = null;
      conn.engineName = null;
      conn.tagged = false;
      // Nothing has fed it, so there is nothing to flush — just let it go.
      conn.notes = null;
      // The socket stays open after `unavailable`, so a client may retry
      // `start` on this same connection — and audio buffered during THIS
      // failed handshake must not be replayed into that next meeting's
      // append-only transcript.
      conn.pending = [];
      conn.pendingRecv = [];
      conn.ledger = null;
      conn.pendingStop = null;
      this.send(ws, {
        type: 'unavailable',
        reason: 'engine_unavailable',
        message: err instanceof Error ? err.message : 'the transcription engine refused',
      });
      return;
    }

    conn.streams = streamSet;
    conn.state = 'live';
    // Whatever was said during the handshake goes in FIRST, and before any
    // pending stop: a meeting ended a second after it started still owes the
    // speaker the sentence they had already begun.
    for (let i = 0; i < conn.pending.length; i++) {
      // `recvMs` is when the frame actually arrived, so the wait for the
      // handshake reads as the server holding it — which is what happened —
      // instead of disappearing into the engine's leg.
      this.deliver(conn, conn.pending[i] as Uint8Array, conn.pendingRecv[i] ?? Date.now());
    }
    conn.pending = [];
    conn.pendingRecv = [];
    // Broadcast before the stop check so `meeting.started` and
    // `meeting.stopped` always reach the doc's other viewers as a pair — a
    // lone `stopped` reads as a meeting they missed the beginning of.
    this.deps.broadcast(docId, {
      event: 'meeting.started',
      docId,
      meetingId: meeting.meetingId,
      startedAt: meeting.startedAt,
      engine: engine.name,
    });
    // A stop (or a closed tab) that arrived during the handshake: honour it
    // now, and skip `ready` — the client is not waiting to be told it may
    // speak, it is waiting to be told the meeting ended.
    const asked = conn.pendingStop;
    if (asked) {
      conn.pendingStop = null;
      await this.stop(ws, conn, asked.reply);
      return;
    }
    this.send(ws, {
      type: 'ready',
      meetingId: meeting.meetingId,
      startedAt: meeting.startedAt,
      engine: engine.name,
      // Only ever present on a resume that was TAKEN. A client that asked and
      // reads nothing here knows it is in a new meeting, with a new section,
      // and says so rather than leaving the split unexplained.
      ...(resumed ? { resumed: true } : {}),
      // What was actually opened, so the strip reports the session being
      // billed rather than the one it asked for.
      mode,
    });
  }

  /** `reply` is false when the socket is already gone. */
  private async stop(ws: MeetingClient, conn: Conn, reply: boolean): Promise<void> {
    if (conn.state === 'opening') {
      // The handshake is still out; `start` finishes the job when it lands.
      conn.pendingStop = { reply };
      return;
    }
    if (conn.state !== 'live') return;
    conn.state = 'ending';
    const meeting = conn.meeting;
    const streams = conn.streams;
    const notes = conn.notes;
    conn.streams = null;
    conn.meeting = null;
    conn.notes = null;
    conn.engineName = null;
    conn.tagged = false;
    conn.pending = [];
    conn.pendingRecv = [];
    conn.ledger = null;
    // Closing the session is what flushes the turn in progress, so the last
    // sentence of a meeting reaches `onTurn` — and therefore the file —
    // before the record is stopped.
    try {
      await streams?.close();
    } catch (err) {
      console.error('[meeting] engine close failed:', err);
    }
    // AFTER the close: the flush above settles the turn in progress, and the
    // meeting's last sentence belongs in its notes as much as in its file.
    try {
      await notes?.end();
    } catch (err) {
      console.error('[meeting] notes flush failed:', err);
    }
    conn.state = 'idle';
    if (!meeting) return;
    const record = meeting.stop();
    if (reply) {
      this.send(ws, {
        type: 'stopped',
        meetingId: record.meetingId,
        endedAt: record.endedAt ?? Date.now(),
      });
    }
    this.deps.broadcast(meeting.docId, {
      event: 'meeting.stopped',
      docId: meeting.docId,
      meetingId: record.meetingId,
      endedAt: record.endedAt ?? Date.now(),
      turns: record.turns ?? 0,
    });
  }
}
