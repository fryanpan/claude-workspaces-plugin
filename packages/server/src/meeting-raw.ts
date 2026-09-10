/**
 * The raw record a meeting leaves beside its doc, for a person rather than
 * for the pipeline: `<docname>-raw-transcript.md`, the audio it was heard
 * from, and a `meeting.json` tying both back to the doc.
 *
 * WHY A SECOND TRANSCRIPT. The JSONL in `meetings.ts` is the pipeline's
 * durable record — append-only, revisable, machine-shaped. What it cannot do
 * is be opened by the person whose note came out wrong. That person needs
 * the words as they were heard, in order, with a clock and a name on each
 * line, in a file that any markdown viewer renders and any grep searches.
 * That is this file, and its whole grammar is three markdown forms: a
 * `## Segment N — <ISO start>` heading per recording, a
 * `- [HH:MM:SSZ] Speaker: words` bullet per settled turn, and a
 * `- [HH:MM:SSZ] — ... —` bullet for a stretch where a capture was dead. No
 * custom syntax, so a viewer later is a rendering choice, not a parser.
 *
 * WHY A GAP IS A LINE AND NOT AN ABSENCE. A meeting whose microphone died for
 * three minutes produces a transcript whose turns simply run from before the
 * outage to after it, and it reads as a conversation in which nobody said
 * anything about those three minutes. That is the worst possible record: it is
 * indistinguishable from a true one, so nothing prompts anybody to go looking
 * for what was lost. The gap line sits in time order among the turns, in the
 * place the missing words would have been, and says how long went unrecorded
 * and which capture was not listening.
 *
 * WHY IT IS WRITTEN AT STOP, FROM THE JSONL. The live record revises turns
 * in place — a punctuated final replaces a rough one, an end-of-session pass
 * relabels a speaker — and a markdown file appended live would carry every
 * draft of every turn. So a segment is composed once, when the meeting
 * ends, from the folded transcript. A server that dies mid-meeting leaves
 * the JSONL but no segment; the next meeting on the same doc writes the
 * missing one first (`flushRawSegments`), so every meeting keeps a segment
 * and they stay in order.
 *
 * WHY THE AUDIO IS RAW PCM. The microphone socket carries 16 kHz PCM16LE
 * frames with no container at all, and this tees exactly those bytes to
 * `segment-<N>-<stream>.pcm`: no transcode, no header, so the file replays
 * into the engine seam byte-for-byte (`scripts/replay-meeting-audio.ts`)
 * and plays with `ffplay -f s16le -ar 16000 -ac 1 <file>`. The sample rate
 * and channel count live in `meeting.json` beside it.
 *
 * NEVER PUSHED. All of this lives under the server data dir — prod's is
 * outside any checkout — and belt-and-braces `*-raw-transcript.md` and
 * `*.pcm` are gitignored and refused outright by `scripts/scrub-check.py`.
 * The repo is public; a meeting's words never enter it.
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import {
  MEETING_CAPTURE_SOURCES,
  type MeetingCaptureSource,
  describeCaptureSource,
  speakerDisplayName,
} from '@claude-workspaces/core';
import {
  type MeetingGap,
  type MeetingRecord,
  type TranscriptTurn,
  listMeetings,
  meetingDirPath,
  readTranscript,
} from './meetings.ts';

/** What the store is told about the doc a meeting belongs to. */
export interface DocInfo {
  /** The file the doc is bound to at the time, when it is bound to one. */
  path?: string;
  title?: string;
}

export type DocInfoResolver = (docId: string) => DocInfo | undefined;

/**
 * Where the audio came from. A bot's audio never reaches this server;
 * `system` is the Mac's own output through Chrome's share picker, and
 * `mic+system` is BOTH on one socket — the meeting that hears the room and
 * the call at once, with a `segment-N-<stream>.pcm` per side.
 */
export type MeetingSource = MeetingCaptureSource | 'bot';

/** Every value `MeetingSource` can hold, for parsing a stored record. */
export const MEETING_SOURCES: readonly MeetingSource[] = [...MEETING_CAPTURE_SOURCES, 'bot'];

/** A stored source, or nothing — and nothing reads as the microphone. */
export function parseMeetingSource(raw: unknown): MeetingSource | undefined {
  return (MEETING_SOURCES as readonly string[]).includes(raw as string)
    ? (raw as MeetingSource)
    : undefined;
}

export interface MeetingJsonAudio {
  /** `mic` for the microphone; a per-participant id when a source has several. */
  stream: string;
  /** File name inside the meeting folder. */
  file: string;
  codec: 'pcm_s16le';
  sampleRate: number;
  channels: 1;
  bytes: number;
}

export interface MeetingJsonSegment {
  n: number;
  meetingId: string;
  startedAt: number;
  endedAt: number | null;
  engine: string;
  mode: string;
  source: MeetingSource;
  /** Who was on the microphone socket, when the client said — see MeetingRecord. */
  participant?: string;
  audio: MeetingJsonAudio[];
  /**
   * Stretches where one capture delivered nothing. Here as well as in the
   * markdown because this is the file a replay reads: the audio for a stream
   * is SHORTER than the meeting by exactly these, so a tool lining the PCM up
   * against the clock has to know where the silence it will not find is.
   */
  gaps?: MeetingGap[];
}

/**
 * The tie from the folder back to the doc. Rewritten (atomically) at every
 * meeting start and stop, so it names the path and title the doc had LAST —
 * which survives the doc moving, being renamed, or being committed, because
 * the folder is keyed by the doc id and the id never moves.
 */
export interface MeetingJson {
  docId: string;
  docName: string;
  /** The companion file's name inside this folder. */
  transcript: string;
  path?: string;
  title?: string;
  updatedAt: number;
  segments: MeetingJsonSegment[];
}

function safeSegment(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * The `<docname>` the companion file is named after: the bound file's own
 * name, so the two sit side by side in a listing; else a slug of the title;
 * else the doc id. Sanitized either way — it becomes a path.
 */
export function docNameFor(docId: string, info: DocInfo | undefined): string {
  if (info?.path) {
    const base = basename(info.path);
    const stem = base.slice(0, base.length - extname(base).length) || base;
    return safeSegment(stem);
  }
  if (info?.title) {
    const slug = info.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    if (slug) return slug;
  }
  return safeSegment(docId);
}

/** Where a doc's raw transcript lives — beside its JSONL, under the data dir. */
export function rawTranscriptPath(dataDir: string, docId: string, docName: string): string {
  return join(meetingDirPath(dataDir, docId), `${docName}-raw-transcript.md`);
}

export function meetingJsonPath(dataDir: string, docId: string): string {
  return join(meetingDirPath(dataDir, docId), 'meeting.json');
}

export function segmentAudioFileName(n: number, stream: string): string {
  return `segment-${n}-${safeSegment(stream)}.pcm`;
}

function utcClock(ts: number): string {
  return `${new Date(ts).toISOString().slice(11, 19)}Z`;
}

/** `- [HH:MM:SSZ] Speaker: words` — the whole grammar of a transcript line. */
export function formatRawBullet(ts: number, speaker: string, text: string): string {
  return `- [${utcClock(ts)}] ${speaker}: ${text.replace(/\s*\n\s*/g, ' ').trim()}`;
}

/**
 * How long an outage lasted, for a person rather than for arithmetic:
 * `2h 5m`, `3m 12s`, `45s`. Rounded to the second, because the browser
 * reported it off a track event and the seconds are the honest precision.
 */
export function formatGapDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/** What a stream is called on a gap line, in the words the strip uses. */
function gapStreamWords(stream: string): string {
  if (stream === 'system') return "this Mac's audio";
  if (stream === 'mic') return 'the microphone';
  return stream;
}

/**
 * `- [HH:MM:SSZ] — the microphone stopped for 3m 12s; nothing was recorded —`
 *
 * A gap the meeting ended inside says so instead of naming a length: the
 * capture never came back, so there is no end to measure to, and writing one
 * would be inventing the moment the loss stopped.
 */
export function formatGapBullet(gap: MeetingGap): string {
  const words = gapStreamWords(gap.stream);
  const tail =
    gap.to === null
      ? 'stopped here and did not come back before the meeting ended'
      : `stopped for ${formatGapDuration(gap.to - gap.from)}`;
  return `- [${utcClock(gap.from)}] — ${words} ${tail}; nothing from it was recorded —`;
}

/**
 * `- [HH:MM:SSZ] — the microphone came back after 3m 12s —`
 *
 * The other half of a gap that crossed a reconnect. The block before the
 * restart was already written, and it reported this loss as still open,
 * because at the time it was: an append-only file cannot go back and add the
 * ending. So the recovery is stated HERE, dated when it happened, and the two
 * bullets together say what one of them could not.
 */
export function formatGapReturn(gap: MeetingGap & { to: number }): string {
  const words = gapStreamWords(gap.stream);
  return `- [${utcClock(gap.to)}] — ${words} came back after ${formatGapDuration(
    gap.to - gap.from,
  )}; the loss it ends is the one the block above reports as still open —`;
}

/**
 * Who a bullet says spoke: the engine's label, shown as the name the person
 * gave it or as "Speaker A"; failing a label, the participant on the
 * socket; failing that, "Speaker 1" — one voice assumed, as a solo capture
 * assumes.
 */
export function speakerLineName(
  label: string | undefined,
  names: Readonly<Record<string, string>>,
  participant: string | undefined,
): string {
  if (label !== undefined) return speakerDisplayName(label, names);
  return participant ?? 'Speaker 1';
}

export interface RawSegmentInput {
  n: number;
  startedAt: number;
  /**
   * When set, this block is the CONTINUATION of a segment already in the
   * file: the meeting's socket dropped, the same recording came back, and
   * the turns since then have nowhere else to go. The heading says so and
   * carries this moment rather than the meeting's own start, so the two
   * blocks read in the order they were spoken.
   */
  resumedAt?: number;
  endedAt: number | null;
  engine: string;
  mode: string;
  source: MeetingSource;
  audio: readonly MeetingJsonAudio[];
  turns: readonly TranscriptTurn[];
  /** Stretches with no audio from one capture, rendered in time order among
   *  the turns. Empty on every meeting that never lost one. */
  gaps?: readonly MeetingGap[];
  /**
   * Gaps that OPENED before this block and closed inside it — only ever on a
   * continuation. The block that opened them is already in the file saying
   * they never ended, so their recovery is stated here rather than nowhere.
   */
  carriedGaps?: ReadonlyArray<MeetingGap & { to: number }>;
  names: Readonly<Record<string, string>>;
  participant?: string;
}

/** One `## Segment` block, ready to append. */
export function formatRawSegment(seg: RawSegmentInput): string {
  const facts = [
    `Engine: ${seg.engine}`,
    `Mode: ${seg.mode}`,
    // In words as well as in the stored value: a two-stream meeting has to
    // NAME both sources where a person reads the record, and "mic+system"
    // alone does not say what the second one was.
    `Source: ${seg.source}${seg.source === 'bot' ? '' : ` (${describeCaptureSource(seg.source)})`}`,
    seg.endedAt !== null
      ? `Ended: ${new Date(seg.endedAt).toISOString()}`
      : 'Ended: no recorded end (the server stopped mid-meeting)',
  ];
  if (seg.audio.length > 0) {
    const first = seg.audio[0] as MeetingJsonAudio;
    // The file names carry the stream (`segment-2-system.pcm`), and
    // `meeting.json` carries it as a field beside the byte count — a
    // two-stream meeting lists one entry per stream here.
    facts.push(
      `Audio: ${seg.audio.map((a) => a.file).join(', ')} (${first.codec}, ${first.sampleRate} Hz, mono)`,
    );
  }
  const lines = [
    seg.resumedAt !== undefined
      ? `## Segment ${seg.n} (resumed) — ${new Date(seg.resumedAt).toISOString()}`
      : `## Segment ${seg.n} — ${new Date(seg.startedAt).toISOString()}`,
    '',
    facts.join(' · '),
    '',
  ];
  const gaps = seg.gaps ?? [];
  const carried = seg.carriedGaps ?? [];
  if (seg.turns.length === 0 && gaps.length === 0 && carried.length === 0) {
    lines.push('_(no settled turns)_');
  } else {
    // Turns and gaps in ONE time-ordered run, because a gap's whole job is to
    // sit where the words it swallowed would have been. Sorted on the moment
    // each thing happened — a turn's settle time, a gap's start — and nothing
    // finer: two things stamped in the SAME millisecond keep turns first,
    // which is a tie this record cannot break and does not try to. In a real
    // meeting the two are seconds apart, because a gap opens when a device
    // dies and a turn settles when somebody stops talking.
    const entries: Array<{ at: number; turn: boolean; line: string }> = [
      ...seg.turns.map((t) => ({
        at: t.ts,
        turn: true,
        line: formatRawBullet(t.ts, speakerLineName(t.speaker, seg.names, seg.participant), t.text),
      })),
      ...gaps.map((g) => ({ at: g.from, turn: false, line: formatGapBullet(g) })),
      // Dated when the capture CAME BACK, which is the moment this block is
      // reporting — the loss itself belongs to the block above.
      ...carried.map((g) => ({ at: g.to, turn: false, line: formatGapReturn(g) })),
    ];
    entries.sort((a, b) => a.at - b.at || Number(b.turn) - Number(a.turn));
    for (const entry of entries) lines.push(entry.line);
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function transcriptPreamble(docId: string, docName: string, info: DocInfo | undefined): string {
  const facts = [`Doc: ${docId}`];
  if (info?.title) facts.push(`Title: ${info.title}`);
  if (info?.path) facts.push(`File: ${info.path}`);
  return [
    `# Raw transcript — ${info?.title ?? docName}`,
    '',
    facts.join(' · '),
    '',
    'Every settled turn as the transcription engine heard it, one segment per',
    'recording. This file and the audio beside it are the meeting record kept',
    'outside the repo; `meeting.json` in this folder ties them to the doc.',
    '',
  ].join('\n');
}

export function readMeetingJson(dataDir: string, docId: string): MeetingJson | null {
  const path = meetingJsonPath(dataDir, docId);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<MeetingJson>;
    if (typeof parsed.docId !== 'string') return null;
    return {
      docId: parsed.docId,
      docName: typeof parsed.docName === 'string' ? parsed.docName : safeSegment(docId),
      transcript: typeof parsed.transcript === 'string' ? parsed.transcript : '',
      ...(typeof parsed.path === 'string' ? { path: parsed.path } : {}),
      ...(typeof parsed.title === 'string' ? { title: parsed.title } : {}),
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
      segments: Array.isArray(parsed.segments) ? (parsed.segments as MeetingJsonSegment[]) : [],
    };
  } catch {
    // A torn write is replaced by the next; the segments it named are
    // re-derivable from the transcript file's own headings if it ever matters.
    return null;
  }
}

/** Written whole and renamed into place: a reader never sees half a file. */
export function writeMeetingJson(dataDir: string, docId: string, json: MeetingJson): void {
  const path = meetingJsonPath(dataDir, docId);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(json, null, 2)}\n`);
  renameSync(tmp, path);
}

/**
 * The tie, refreshed. Called at meeting START so a folder whose meeting
 * never reaches stop still says which doc it belongs to.
 */
export function ensureMeetingJson(dataDir: string, docId: string, info: DocInfo | undefined): void {
  const docName = docNameFor(docId, info);
  const prior = readMeetingJson(dataDir, docId);
  writeMeetingJson(dataDir, docId, {
    docId,
    docName,
    transcript: `${docName}-raw-transcript.md`,
    ...(info?.path ? { path: info.path } : {}),
    ...(info?.title ? { title: info.title } : {}),
    updatedAt: Date.now(),
    segments: prior?.segments ?? [],
  });
}

/**
 * One audio stream of one segment, appended frame by frame as it arrives.
 *
 * A file descriptor rather than `appendFileSync`: the microphone sends fifty
 * frames a second, and opening the file for each would be the cost that
 * made someone turn this off. A write that fails disables the sink and says
 * so once; the meeting itself is unaffected — the transcript is the record,
 * the audio is what lets it be checked.
 */
export class AudioSink {
  private fd: number | null = null;
  private failed = false;
  bytes = 0;

  constructor(
    readonly path: string,
    readonly stream: string,
    readonly sampleRate: number,
  ) {}

  write(chunk: Uint8Array): void {
    if (this.failed) return;
    try {
      if (this.fd === null) {
        mkdirSync(dirname(this.path), { recursive: true });
        this.fd = openSync(this.path, 'a');
      }
      writeSync(this.fd, chunk);
      this.bytes += chunk.byteLength;
    } catch (err) {
      this.failed = true;
      console.error(
        `[meeting] audio tee to ${this.path} failed; audio for this segment stops here:`,
        err,
      );
    }
  }

  /** The audio entry for `meeting.json`, or null when nothing was written. */
  close(): MeetingJsonAudio | null {
    if (this.fd !== null) {
      try {
        closeSync(this.fd);
      } catch {
        // Already closed, or the disk went away — either way the bytes we
        // counted are what reached the file.
      }
      this.fd = null;
    }
    if (this.bytes === 0) return null;
    return {
      stream: this.stream,
      file: basename(this.path),
      codec: 'pcm_s16le',
      sampleRate: this.sampleRate,
      channels: 1,
      bytes: this.bytes,
    };
  }
}

/** The audio files a segment left on disk — how a backfill finds a crashed meeting's audio. */
function audioOnDisk(dir: string, n: number, sampleRate: number): MeetingJsonAudio[] {
  if (!existsSync(dir)) return [];
  const prefix = `segment-${n}-`;
  return readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.pcm'))
    .sort()
    .map((file) => ({
      stream: file.slice(prefix.length, -'.pcm'.length),
      file,
      codec: 'pcm_s16le' as const,
      sampleRate,
      channels: 1 as const,
      bytes: statSync(join(dir, file)).size,
    }));
}

/**
 * Append every segment the transcript file does not yet hold, in index
 * order, and refresh `meeting.json`. Called at meeting stop with the meeting
 * that just ended; earlier meetings that never reached stop (a crash, a
 * meeting from before this file existed) are written on the way.
 */
export function flushRawSegments(args: {
  dataDir: string;
  docId: string;
  info: DocInfo | undefined;
  /** Meetings still recording in THIS process — not ready to be written. */
  liveMeetingIds: ReadonlySet<string>;
  /** The meeting that just stopped, with the audio its sinks closed on. */
  ended?: {
    meetingId: string;
    audio: MeetingJsonAudio[];
    /**
     * The first turn number the leg that just stopped recorded, when this
     * meeting was RESUMED. Its segment may already be in `meeting.json` from
     * the leg before the outage, and a written segment is otherwise skipped —
     * which would drop the second half of the meeting from the companion
     * a person reads. Given it, the flush appends a continuation block
     * holding exactly the turns from here on.
     */
    resumedFrom?: number;
    /** When that leg picked the meeting up — the continuation's heading. */
    resumedAt?: number;
  };
}): void {
  const { dataDir, docId, info } = args;
  const docName = docNameFor(docId, info);
  const dir = meetingDirPath(dataDir, docId);
  const mdPath = rawTranscriptPath(dataDir, docId, docName);
  const json: MeetingJson = readMeetingJson(dataDir, docId) ?? {
    docId,
    docName,
    transcript: `${docName}-raw-transcript.md`,
    updatedAt: 0,
    segments: [],
  };
  const written = new Set(json.segments.map((s) => s.meetingId));
  const records: MeetingRecord[] = listMeetings(dataDir, docId);
  let appended = '';
  records.forEach((record, i) => {
    if (written.has(record.meetingId)) {
      const ended = args.ended;
      if (
        ended?.meetingId !== record.meetingId ||
        ended.resumedFrom === undefined ||
        ended.resumedAt === undefined
      ) {
        return;
      }
      // The same recording, picked up again after its socket dropped. The
      // block already in the file holds the turns from before the outage, so
      // this one holds the rest and says in its heading that it is a
      // continuation rather than a second recording.
      const n = record.segment ?? i + 1;
      const rest = readTranscript(dataDir, docId, record.meetingId).filter(
        (t) => t.turn >= (ended.resumedFrom as number),
      );
      const resumedAt = ended.resumedAt as number;
      const all = record.gaps ?? [];
      // Only the outages of THIS leg: the block before the restart already
      // carries the ones that happened before it, and a gap printed twice
      // reads as two separate losses.
      const legGaps = all.filter((g) => g.from >= resumedAt);
      // And the recoveries that block could not know about — a capture that
      // was already down when the socket dropped and came back after it. That
      // block states the loss as still open, so without this the file makes a
      // claim the folded record contradicts.
      const carriedGaps = all.filter(
        (g): g is MeetingGap & { to: number } =>
          g.from < resumedAt && typeof g.to === 'number' && g.to >= resumedAt,
      );
      // THE STORED SEGMENT IS UPDATED WHATEVER THE MARKDOWN DOES. It used to
      // sit past the early return below, so a resumed leg whose capture was
      // dead for all of it — the very meeting a gap matters most on, since the
      // outage is WHY there are no turns — wrote its gaps to neither file.
      const stored = json.segments.find((sg) => sg.meetingId === record.meetingId);
      if (stored) {
        stored.endedAt = record.endedAt;
        stored.audio = audioOnDisk(dir, n, record.sampleRate);
        if (all.length > 0) stored.gaps = [...all];
      }
      if (rest.length === 0 && legGaps.length === 0 && carriedGaps.length === 0) return;
      const source: MeetingSource = parseMeetingSource(record.source) ?? 'mic';
      appended += formatRawSegment({
        n,
        startedAt: record.startedAt,
        resumedAt: ended.resumedAt,
        endedAt: record.endedAt,
        engine: record.engine,
        mode: record.mode,
        source,
        // Read off the files rather than from the sinks: a resumed leg's own
        // sink counts only the bytes IT appended, and the file holds both.
        audio: audioOnDisk(dir, n, record.sampleRate),
        turns: rest,
        gaps: legGaps,
        carriedGaps,
        names: record.speakers ?? {},
        ...(record.participant !== undefined ? { participant: record.participant } : {}),
      });
      return;
    }
    if (args.liveMeetingIds.has(record.meetingId) && record.meetingId !== args.ended?.meetingId) {
      return;
    }
    const n = record.segment ?? i + 1;
    const audio =
      args.ended?.meetingId === record.meetingId
        ? args.ended.audio
        : audioOnDisk(dir, n, record.sampleRate);
    const source: MeetingSource = parseMeetingSource(record.source) ?? 'mic';
    appended += formatRawSegment({
      n,
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      engine: record.engine,
      mode: record.mode,
      source,
      audio,
      turns: readTranscript(dataDir, docId, record.meetingId),
      ...(record.gaps && record.gaps.length > 0 ? { gaps: record.gaps } : {}),
      names: record.speakers ?? {},
      ...(record.participant !== undefined ? { participant: record.participant } : {}),
    });
    json.segments.push({
      n,
      meetingId: record.meetingId,
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      engine: record.engine,
      mode: record.mode,
      source,
      ...(record.participant !== undefined ? { participant: record.participant } : {}),
      audio,
      ...(record.gaps && record.gaps.length > 0 ? { gaps: record.gaps } : {}),
    });
    written.add(record.meetingId);
  });
  if (appended) {
    mkdirSync(dir, { recursive: true });
    if (!existsSync(mdPath)) appendFileSync(mdPath, transcriptPreamble(docId, docName, info));
    appendFileSync(mdPath, appended);
  }
  json.docName = docName;
  json.transcript = basename(mdPath);
  if (info?.path) json.path = info.path;
  if (info?.title) json.title = info.title;
  json.updatedAt = Date.now();
  writeMeetingJson(dataDir, docId, json);
}
