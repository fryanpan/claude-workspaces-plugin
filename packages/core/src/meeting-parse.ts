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

import { parseCaptureSource } from './meeting-streams.ts';
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
    };
  }
  return null;
}
