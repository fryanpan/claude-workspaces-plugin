/**
 * READING A CLIENT FRAME — the one place an untrusted meeting message becomes
 * a `MeetingClientMessage` or nothing at all.
 *
 * Split out of `meeting.ts`, which holds the VOCABULARY: the message shapes,
 * the capture modes, the engine names, the bounds. This holds the reading of
 * an outside value against that vocabulary, which is a different job with a
 * different rule — every field is dropped rather than defaulted where a wrong
 * guess would cost the meeting, and refused outright only where a wrong value
 * would cost more than the frame.
 *
 * IT IMPORTS FROM `meeting.ts` AND NEVER THE OTHER WAY. The vocabulary must
 * be readable without the parser, because both sides of the socket use the
 * types and only the server reads the frames.
 */

import { type MeetingStreamId, parseCaptureSource } from './meeting-streams.ts';
import { parseRawTuning } from './meeting-tuning.ts';
import { MAX_SPEAKER_NAME, MEETING_AUDIO_ENCODING } from './meeting.ts';
import type { MeetingClientMessage } from './meeting.ts';
import { parseCaptureMode, parseEngineName, parseRoomSpeakers } from './meeting.ts';
import { parseNotesMethod } from './notes-method.ts';

/**
 * A meeting id as the store writes them (`m-<docId>-<ms>`), or nothing.
 *
 * The value reaches a FILE NAME on the server, so the shape is checked here
 * rather than sanitized there: `meetings.ts` maps anything outside this set to
 * an underscore, which would let two different ids name one transcript. The
 * bound is generous — a doc id is part of the id — and anything else is
 * dropped, which reads downstream as a resume the server could not honour.
 */
/**
 * The ceiling on `heldMs`, matching the client's two-minute reconnect window
 * (`RECONNECT_WINDOW_MS`). Spelled here rather than imported because the
 * parser is shared with the server, which has no reason to know the browser's
 * backoff — what it needs is a bound, and this is the bound that exists.
 */
const MAX_HELD_AUDIO_MS = 120_000;

export function parseMeetingId(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  return /^[A-Za-z0-9._-]{1,200}$/.test(raw) ? raw : undefined;
}

/** Parse a client frame, returning null for anything malformed. */
export function parseMeetingClientMessage(raw: unknown): MeetingClientMessage | null {
  if (typeof raw !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const m = parsed as Record<string, unknown>;
  if (m.type === 'stop') return { type: 'stop' };
  if (m.type === 'tune') {
    // The settings are only shallow-checked here; the relay sanitizes them
    // against the engine that is actually running. A frame with no readable
    // settings still parses — the relay answers it with nothing applied.
    return { type: 'tune', settings: parseRawTuning(m.settings) ?? {} };
  }
  if (m.type === 'timing_ping') {
    if (typeof m.id !== 'number' || !Number.isFinite(m.id)) return null;
    if (typeof m.clientMs !== 'number' || !Number.isFinite(m.clientMs)) return null;
    return { type: 'timing_ping', id: m.id, clientMs: m.clientMs };
  }
  if (m.type === 'set_notes_method') {
    // An unknown method is dropped rather than defaulted: a client one
    // version ahead must not silently reset this doc to the original.
    const method = parseNotesMethod(m.method);
    if (!method) return null;
    const by = typeof m.by === 'string' ? m.by.trim().slice(0, MAX_SPEAKER_NAME) : '';
    return by ? { type: 'set_notes_method', method, by } : { type: 'set_notes_method', method };
  }
  if (m.type === 'stream_state') {
    // The stream must be one this server knows how to write a file for: the
    // value reaches the durable record as the name of the source that went
    // quiet, and an unreadable one there is worse than no gap line at all.
    const stream =
      m.stream === 'mic' || m.stream === 'system' ? (m.stream as MeetingStreamId) : null;
    if (!stream) return null;
    if (m.state !== 'lost' && m.state !== 'restored') return null;
    // A CLOSED SET, not bounded free text. The field is a machine word the
    // client picks from two, and it is written into the durable index, so
    // there is no reason for the wire to accept anything a future reader
    // would have to interpret. Anything else drops the word, not the frame:
    // a loss reported without a reason is still a loss.
    const reason = m.reason === 'ended' || m.reason === 'muted' ? m.reason : '';
    return reason
      ? { type: 'stream_state', stream, state: m.state, reason }
      : { type: 'stream_state', stream, state: m.state };
  }
  if (m.type === 'no_audio') {
    // It reaches a log line, so every field is a closed set or a bounded
    // integer: nothing a page writes here can put text in the server log.
    const states = ['running', 'suspended', 'interrupted', 'closed'];
    const contextState =
      typeof m.contextState === 'string' && states.includes(m.contextState)
        ? m.contextState
        : 'unknown';
    const int = (v: unknown): number =>
      typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1e6, Math.round(v))) : 0;
    return {
      type: 'no_audio',
      contextState,
      sampleRate: int(m.sampleRate),
      blocks: int(m.blocks),
    };
  }
  if (m.type === 'name_speaker') {
    const speaker = typeof m.speaker === 'string' ? m.speaker.trim() : '';
    const name = typeof m.name === 'string' ? m.name.trim() : '';
    if (!speaker || speaker.length > 16 || !name || name.length > MAX_SPEAKER_NAME) return null;
    return { type: 'name_speaker', speaker, name };
  }
  if (m.type === 'start') {
    const rate = m.sampleRate;
    const resume = parseMeetingId(m.resume);
    // A rate the engine cannot be told about is worse than no meeting: the
    // audio would transcribe as noise and look like a bad microphone.
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 8000 || rate > 48_000) {
      return null;
    }
    if (m.encoding !== MEETING_AUDIO_ENCODING) return null;
    const speakers = parseRoomSpeakers(m.speakers);
    const engine = parseEngineName(m.engine);
    const source = parseCaptureSource(m.source);
    const tuning = parseRawTuning(m.tuning);
    // Same shape as a speaker name: trimmed, bounded, dropped when empty.
    const participant =
      typeof m.participant === 'string' ? m.participant.trim().slice(0, MAX_SPEAKER_NAME) : '';
    const held = resume !== undefined ? parseHeldMs(m.heldMs) : undefined;
    return {
      type: 'start',
      sampleRate: Math.round(rate),
      encoding: MEETING_AUDIO_ENCODING,
      // A missing or unreadable mode is `solo` rather than a refused frame:
      // the field arrived after the meeting did, and the fallback is the one
      // that spends nothing.
      mode: parseCaptureMode(m.mode),
      // Same rule for the room size, one step further: out of range is
      // clamped rather than refused, because a bad number here is a knob
      // typed into an address bar and the meeting is worth more than the
      // typo.
      ...(speakers !== undefined ? { speakers } : {}),
      // An unknown engine name is dropped rather than refused: the meeting
      // is worth more than the typo, and absent is the server's default.
      ...(engine !== undefined ? { engine } : {}),
      // Kept even when empty — presence is the tuning-aware marker; see the
      // field's comment above.
      ...(tuning !== undefined ? { tuning } : {}),
      // Only the literal `true` opts in: a stray truthy value on this frame
      // should read as a client that does not know about timing, not as one
      // asking for it.
      ...(m.timing === true ? { timing: true } : {}),
      ...(participant ? { participant } : {}),
      // A value this build knows, or nothing — and nothing is the microphone,
      // which is what absent has always meant.
      ...(source !== undefined && source !== 'mic' ? { source } : {}),
      // Dropped rather than refused, like every other unreadable field on
      // this frame: a resume id the server could never match is a new
      // meeting, which is exactly the fallback a failed resume takes anyway.
      ...(resume !== undefined ? { resume } : {}),
      // Only beside a resume, because it is a claim ABOUT an outage and a
      // first start has none. Bounded at the top by the whole reconnect
      // window — a client claiming to have carried an hour would silently
      // erase a real gap from the record — and a value that is not a finite
      // number at all is simply absent, which reads as "nothing carried".
      ...(held !== undefined ? { heldMs: held } : {}),
    };
  }
  return null;
}

/**
 * How much audio a reconnect says it carried, as a number this server will
 * subtract from a durable record.
 *
 * Clamped rather than refused, like the room size beside it: the value only
 * shortens a gap, so a hostile one costs a record that understates a hole
 * rather than a meeting that will not start. The ceiling is the reconnect
 * window itself — nothing can have been carried across an outage longer than
 * the one the client was still willing to wait out.
 */
function parseHeldMs(raw: unknown): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return undefined;
  return Math.min(Math.round(raw), MAX_HELD_AUDIO_MS);
}
