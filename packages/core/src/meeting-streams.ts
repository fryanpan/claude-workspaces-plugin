/**
 * Two microphones, one meeting: the vocabulary shared by the browser that
 * opens both streams and the server that transcribes them separately.
 *
 * WHY TWO STREAMS AND NOT ONE MIXED ONE. A laptop on a call hears two
 * different rooms. The microphone hears whoever is physically present; the
 * Mac's own output hears whoever is dialled in. Mixing them into one track
 * before the engine would throw away the one fact that is free to keep — a
 * sample either came from the microphone or it did not — and hand the
 * diarizer the hardest possible job: telling a voice in the room from the
 * same voice coming out of the speakers. Kept apart, each engine session
 * sees one acoustic scene and its labels stay inside it.
 *
 * WHICH MEANS THE LABELS MUST BE KEPT APART TOO. Every engine hands out "A"
 * afresh per session, so two sessions on one meeting BOTH produce a Speaker
 * A who is not the same person. `namespacedSpeaker` is the fix and the whole
 * reason this module is in core rather than in either end: the browser
 * renders the label, the server writes it into the durable record, and the
 * notes composer reads it back. One spelling, three processes.
 *
 * THE GROUPS ARE NAMED FOR WHERE THE PEOPLE ARE, not for the hardware. Bryan
 * asked for "mic is whoever is here in the room and Mac audio is whoever is
 * remote", so a reader of a transcript sees Room and Remote — facts about a
 * meeting — rather than `mic` and `system`, which are facts about a laptop.
 * The stream ids stay the hardware words because they name files on disk.
 */

/** One capture running inside a meeting. Names the audio file it tees to. */
export type MeetingStreamId = 'mic' | 'system';

/** Who a stream is carrying: people here, or people dialled in. */
export type MeetingGroup = 'room' | 'remote';

/**
 * What a meeting was opened to hear. `mic` and `system` are single-stream
 * captures — `system` alone is what PR 793 shipped and old records still
 * carry — and `mic+system` is the two-stream meeting this module exists for.
 */
export type MeetingCaptureSource = 'mic' | 'system' | 'mic+system';

/** The two-stream source, spelled once. */
export const COMBINED_SOURCE = 'mic+system' as const;

export const MEETING_CAPTURE_SOURCES: readonly MeetingCaptureSource[] = [
  'mic',
  'system',
  COMBINED_SOURCE,
];

/** A capture source, or nothing for anything a client did not mean. */
export function parseCaptureSource(raw: unknown): MeetingCaptureSource | undefined {
  return (MEETING_CAPTURE_SOURCES as readonly string[]).includes(raw as string)
    ? (raw as MeetingCaptureSource)
    : undefined;
}

/**
 * The streams a source opens, in the order they are asked for.
 *
 * The microphone comes FIRST for the combined source, and that ordering is a
 * product decision rather than an implementation detail: `getUserMedia` is a
 * permission the browser may already hold, while the share picker is a modal
 * the person has to drive. Asking for the cheap one first means a refusal of
 * the expensive one still leaves a meeting running.
 */
export function streamsForSource(source: MeetingCaptureSource): readonly MeetingStreamId[] {
  if (source === COMBINED_SOURCE) return ['mic', 'system'];
  return [source];
}

/** The source a set of opened streams adds up to, or nothing if none opened. */
export function sourceForStreams(
  streams: readonly MeetingStreamId[],
): MeetingCaptureSource | undefined {
  const mic = streams.includes('mic');
  const system = streams.includes('system');
  if (mic && system) return COMBINED_SOURCE;
  if (mic) return 'mic';
  if (system) return 'system';
  return undefined;
}

/** Where the people on this stream are sitting. */
export function groupForStream(stream: MeetingStreamId): MeetingGroup {
  return stream === 'system' ? 'remote' : 'room';
}

/** The word a person reads for a group. */
export function groupLabel(group: MeetingGroup): string {
  return group === 'remote' ? 'Remote' : 'Room';
}

/** The source in words, for a meeting record a person opens. */
export function describeCaptureSource(source: MeetingCaptureSource): string {
  if (source === COMBINED_SOURCE) return "microphone + this Mac's audio";
  if (source === 'system') return "this Mac's audio";
  return 'microphone';
}

/**
 * The separator between a group and the engine's own label.
 *
 * A colon, because it is already illegal in an engine label (they are single
 * letters or short digits) and legal in the `speaker:` tag href a composed
 * note carries — `speaker:room:A` parses as scheme plus `room:A`, because
 * `parseSpeakerTagHref` splits on the FIRST colon only.
 */
export const SPEAKER_GROUP_SEP = ':';

/** `('system', 'A')` → `'remote:A'`. The label as everything downstream sees it. */
export function namespacedSpeaker(stream: MeetingStreamId, label: string): string {
  return `${groupForStream(stream)}${SPEAKER_GROUP_SEP}${label}`;
}

/**
 * `'remote:A'` → its group and the engine's own label; null for a bare label.
 *
 * Null is the answer for every label a single-stream meeting ever produced,
 * which is what keeps those records reading exactly as they always did.
 */
export function parseNamespacedSpeaker(
  label: string,
): { group: MeetingGroup; base: string } | null {
  const at = label.indexOf(SPEAKER_GROUP_SEP);
  if (at <= 0) return null;
  const head = label.slice(0, at);
  const base = label.slice(at + 1);
  if (base.length === 0) return null;
  if (head !== 'room' && head !== 'remote') return null;
  return { group: head, base };
}

/**
 * The byte that says which stream an audio frame came from.
 *
 * ONE SOCKET, NOT TWO. A second socket would be a second meeting: the store
 * refuses a doc that is already recording, so two connections would need the
 * "one at a time" rule relaxed, two index rows, two transcripts and two notes
 * sessions over one conversation. Prefixing the frame instead costs one byte
 * per 50 ms of audio — 20 bytes a second against 32 000 — and every part of
 * the lifecycle stays exactly as it was.
 *
 * The prefix is sent ONLY when the meeting opened more than one stream. A
 * single-stream capture puts raw PCM on the wire, byte-for-byte what it
 * always did, so a server built before this reads a microphone meeting
 * unchanged and a client built before it is never sent a tagged frame.
 */
export const STREAM_TAG_BYTES: Readonly<Record<MeetingStreamId, number>> = {
  mic: 0,
  system: 1,
};

/** The stream a tag byte names, or null for a byte no client should send. */
export function streamForTagByte(byte: number): MeetingStreamId | null {
  if (byte === STREAM_TAG_BYTES.mic) return 'mic';
  if (byte === STREAM_TAG_BYTES.system) return 'system';
  return null;
}

/** One PCM frame with its stream byte in front. */
export function tagAudioFrame(stream: MeetingStreamId, pcm: Uint8Array): Uint8Array {
  const out = new Uint8Array(pcm.byteLength + 1);
  out[0] = STREAM_TAG_BYTES[stream];
  out.set(pcm, 1);
  return out;
}

/**
 * Split a tagged frame back into its stream and its audio, or null when the
 * byte names no stream.
 *
 * Null rather than a guess: a frame whose tag is unreadable would otherwise
 * be fed to whichever engine happened to be first, which puts the wrong
 * words under the wrong group in a durable record.
 */
export function untagAudioFrame(
  frame: Uint8Array,
): { stream: MeetingStreamId; chunk: Uint8Array } | null {
  if (frame.byteLength < 2) return null;
  const stream = streamForTagByte(frame[0] as number);
  if (!stream) return null;
  return { stream, chunk: frame.subarray(1) };
}

/**
 * Global turn ids across two engines, allocated IN ARRIVAL ORDER.
 *
 * Both engines number their turns from zero, so the ids collide outright —
 * and the obvious fix, interleaving by arithmetic (`turn * 2 + stream`),
 * produces ids that run backwards whenever one stream is ahead of the other.
 * The strip drops a turn whose id is below the newest it has seen (that is
 * what stops a corrected old line reappearing at the live end), so an
 * arithmetic id would make the quieter stream's words vanish from the strip.
 *
 * So an id is handed out the first time a (stream, engine turn) pair is seen
 * and remembered for every later revision of it. The ids are then in the
 * order the words actually arrived — which is the merge the meeting wants —
 * and a correction still lands on the line it belongs to.
 */
export class MeetingTurnMerger {
  private readonly ids = new Map<string, number>();
  private next = 0;

  /** The global id for one engine turn on one stream. Stable across revisions. */
  idFor(stream: MeetingStreamId, engineTurn: number): number {
    const key = `${stream}${SPEAKER_GROUP_SEP}${engineTurn}`;
    const known = this.ids.get(key);
    if (known !== undefined) return known;
    const id = this.next++;
    this.ids.set(key, id);
    return id;
  }
}
