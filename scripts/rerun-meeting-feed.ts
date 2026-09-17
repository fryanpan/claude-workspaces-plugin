/**
 * Everything this harness says to the server, over the routes a person's
 * browser uses and nothing else.
 *
 * WHY IT IS ITS OWN FILE. A rerun is only worth running if the path the audio
 * takes is the path a microphone takes, so every call here is deliberately the
 * public one: the board and the huddle are created over the Board's own "Have
 * a meeting" routes, the audio goes onto the `/audio` websocket a browser
 * opens, a person's mid-meeting edit goes through `find_and_replace`, and the
 * tidy-up is the same POST the button makes. A private shortcut anywhere in
 * here would make the run measure something nobody experiences.
 */

import { basename } from 'node:path';
import {
  type MeetingStreamId,
  sourceForStreams,
  streamsForSource,
  tagAudioFrame,
} from '../packages/core/src/meeting-streams.ts';
import { MEETING_AUDIO_ENCODING, meetingSocketPath } from '../packages/core/src/meeting.ts';
import {
  cleanupReasonLine,
  groupCleanupReasons,
} from '../packages/core/src/notes-cleanup-report.ts';
import type {
  TranscriptionEngine,
  TranscriptionSession,
} from '../packages/server/src/transcribe.ts';
import { type ReplayInput, type ReplayTarget, replayAudio } from './replay-meeting-lib.ts';
import { type DocSpec, type RerunArgs, UsageError } from './rerun-meeting-args.ts';
import type { TidyCounts } from './rerun-meeting-report.ts';
import { SpendCapReached } from './rerun-meeting-spend.ts';

/** How long the run waits for the server to report the meeting it stopped.
 *  Generous: the stop runs the quality pass and may name the meeting. */
export const STOP_TIMEOUT_MS = 180_000;
/** How long the `start` frame may go unanswered before the run gives up. */
const READY_TIMEOUT_MS = 30_000;

const AUTHOR = { id: 'agent:meeting-rerun', name: 'meeting-rerun', kind: 'agent' } as const;

export async function postJson(url: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`POST ${url} → ${res.status} ${text}`);
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Poll until `read` answers, or fail saying what was wanted. */
export async function until<T>(read: () => T | undefined, ms: number, what: string): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = read();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timed out after ${ms}ms waiting for ${what}`);
    await sleep(50);
  }
}

/** A board and a huddle doc, over the routes the Board's own "Have a meeting"
 *  calls — so the doc this run composes into is shaped like a person's. */
export async function seedDoc(base: string): Promise<{ ws: string; docId: string }> {
  const board = (await postJson(`${base}/workspaces`, {
    name: 'meeting rerun',
    author: AUTHOR,
  })) as { workspace?: { id?: string } };
  const ws = board.workspace?.id;
  if (!ws) throw new Error(`no workspace id: ${JSON.stringify(board)}`);
  const huddle = (await postJson(`${base}/workspaces/${ws}/huddles`, {})) as { docId?: string };
  if (!huddle.docId) throw new Error(`no huddle doc: ${JSON.stringify(huddle)}`);
  return { ws, docId: huddle.docId };
}

/** The starting document, written over the doc route a person's paste takes. */
export async function seedContent(
  base: string,
  ws: string,
  docId: string,
  markdown: string,
): Promise<void> {
  await postJson(`${base}/workspaces/${ws}/docs/${encodeURIComponent(docId)}/content`, {
    markdown,
    author: AUTHOR,
    // The doc was created by this run, seconds ago, in a throwaway data dir.
    // The stale-write guard exists to stop a rewrite destroying somebody's
    // live edits; there is nobody here, and being refused for the freshness of
    // a doc we just made would be a flake rather than a protection.
    confirmOverwriteHumanEdits: true,
  });
}

/**
 * A `TranscriptionEngine` whose session is the AUDIO SOCKET.
 *
 * This is what lets the pacing be reused rather than rewritten. `replayAudio`
 * already knows how to cut a PCM file into browser-sized chunks and release
 * them at the audio's own rate, and it expresses "where the bytes go" as an
 * engine — so here the bytes go onto the wire, and the engine that actually
 * hears them is the one the SERVER opened at the other end.
 *
 * `stopping()` is how the spend cap reaches the feed: a send that throws ends
 * the replay loop at once, which on a 41-minute recording is the difference
 * between stopping and sitting through the rest of the audio doing nothing.
 */
export function wireEngine(
  send: (chunk: Uint8Array) => void,
  stopping: () => Error | null,
): TranscriptionEngine {
  return {
    name: 'audio-socket',
    open(): Promise<TranscriptionSession> {
      return Promise.resolve({
        send(chunk: Uint8Array): void {
          const stop = stopping();
          if (stop) throw stop;
          send(chunk);
        },
        close(): Promise<void> {
          // The socket outlives this session: the meeting is stopped with a
          // `stop` frame, not by dropping the connection, so that the server
          // takes the ordinary path a person's stop takes.
          return Promise.resolve();
        },
      });
    },
  };
}

export interface FeedArgs {
  args: RerunArgs;
  target: ReplayTarget;
  doc: DocSpec;
  base: string;
  ws: string;
  docId: string;
  stopping: () => Error | null;
  log: (line: string) => void;
}

/** The frames this run reads off the socket. */
interface ServerFrame {
  type: string;
  meetingId?: string;
  message?: string;
  reason?: string;
}

/**
 * Open the audio socket, push the recording through it at its own rate, and
 * stop the meeting the way the strip's own stop control does.
 *
 * Answers the meeting id, because everything read afterwards — the heading,
 * the quality record, the tidy-up — is addressed by it.
 */
export async function feedMeeting(f: FeedArgs): Promise<string> {
  const url = `ws://127.0.0.1:${new URL(f.base).port}${meetingSocketPath(f.ws, f.docId)}`;
  const socket = new WebSocket(url);
  const seen: { meetingId?: string; stopped: boolean; errors: string[] } = {
    stopped: false,
    errors: [],
  };
  socket.addEventListener('message', (ev) => {
    if (typeof ev.data !== 'string') return;
    let msg: ServerFrame;
    try {
      msg = JSON.parse(ev.data) as ServerFrame;
    } catch {
      return;
    }
    if (msg.type === 'ready') seen.meetingId = msg.meetingId;
    else if (msg.type === 'stopped') seen.stopped = true;
    else if (msg.type === 'unavailable' || msg.type === 'error') {
      seen.errors.push(`${msg.type}: ${msg.message ?? msg.reason ?? ''}`);
    }
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve());
    socket.addEventListener('error', () => reject(new Error(`could not open ${url}`)));
  });

  const first = f.target.inputs[0];
  if (!first) throw new Error('no audio to replay');
  const mode = f.args.mode ?? (first.mode === 'conversation' ? 'conversation' : 'solo');
  // WHICH STREAMS THIS RECORDING HELD, told to the server the way the browser
  // tells it. A mic + Mac-audio capture kept two files per segment and the
  // socket expects both, each frame carrying its stream byte; a one-stream
  // recording expects no byte at all. Getting this wrong does not fail
  // loudly — it feeds a call's two sides to the wrong engines, or prepends a
  // byte of noise to every frame of a single-stream meeting.
  const streams = streamsOf(f.target);
  const source = sourceForStreams(streams) ?? 'mic';
  const tagged = streamsForSource(source).length > 1;
  socket.send(
    JSON.stringify({
      type: 'start',
      sampleRate: first.sampleRate,
      encoding: MEETING_AUDIO_ENCODING,
      mode,
      source,
    }),
  );
  const meetingId = await until(
    () => {
      if (seen.errors.length > 0) throw new Error(seen.errors.join('; '));
      return seen.meetingId;
    },
    READY_TIMEOUT_MS,
    'the meeting to be ready',
  );
  f.log(
    `meeting ${meetingId} is recording (${mode}); feeding ${f.target.inputs.length} segment(s) at audio rate`,
  );

  // Every edit's REQUEST, not just its timer. An edit scheduled near the end
  // of the recording fires while the last chunks are still going out, and the
  // stop frame used to overtake it: the at-stop compose and the report then
  // read a document the edit had not reached, nondeterministically, with the
  // log line arriving afterwards to say it had been applied.
  const applied: Array<Promise<void>> = [];
  const timers = f.doc.edits.map((edit) => scheduleEdit(f, edit, applied));

  try {
    // ONE SEGMENT AT A TIME, BUT ITS STREAMS TOGETHER. The two files of a
    // segment are the two sides of the same minutes, not one after the other:
    // played in sequence they would double the meeting's length, put the
    // answer before the question, and land every mid-run document edit
    // against speech nobody was saying then.
    for (const [segment, inputs] of bySegment(f.target.inputs)) {
      const played = await Promise.all(
        inputs.map((input) =>
          replayAudio(input, {
            engine: wireEngine(
              (chunk) =>
                socket.send(tagged ? tagAudioFrame(input.stream as MeetingStreamId, chunk) : chunk),
              f.stopping,
            ),
            detectSpeakers: mode === 'conversation',
            chunkMs: f.args.chunkMs,
            realtime: true,
          }),
        ),
      );
      const chunks = played.reduce((n, p) => n + p.chunks, 0);
      const bytes = played.reduce((n, p) => n + p.bytes, 0);
      const names = inputs.map((i) => i.stream).join(' + ');
      f.log(`  segment ${segment} (${names}): ${chunks} chunk(s), ${bytes} bytes`);
    }
  } catch (err) {
    if (!(err instanceof SpendCapReached)) throw err;
    f.log(`${err.message} — stopping the meeting with the audio unfinished`);
  } finally {
    for (const t of timers) clearTimeout(t);
  }

  await Promise.all(applied);
  socket.send(JSON.stringify({ type: 'stop' }));
  await until(() => (seen.stopped ? true : undefined), STOP_TIMEOUT_MS, 'the stopped frame');
  socket.close();
  return meetingId;
}

/**
 * A person's edit, arriving while the room talks.
 *
 * Over the same `find_and_replace` route any other edit takes, because an edit
 * that reached the doc by a private path would not be the thing under test.
 */
export function scheduleEdit(
  f: FeedArgs,
  edit: DocSpec['edits'][number],
  applied: Array<Promise<void>>,
  post: (url: string, body: unknown) => Promise<unknown> = postJson,
): ReturnType<typeof setTimeout> {
  return setTimeout(() => {
    applied.push(
      post(`${f.base}/workspaces/${f.ws}/docs/${encodeURIComponent(f.docId)}/find_and_replace`, {
        find: edit.find,
        replace: edit.replace,
        author: AUTHOR,
      }).then(
        () => f.log(`edit at ${edit.atMs}ms applied: ${JSON.stringify(edit.find)}`),
        // A refused or failed edit is reported and does not fail the run: the
        // report says the document it measured, and the log says why.
        (err: unknown) =>
          f.log(
            `edit at ${edit.atMs}ms did not apply: ${err instanceof Error ? err.message : String(err)}`,
          ),
      ),
    );
  }, edit.atMs);
}

/**
 * The at-stop tidy-up, over the same route the button reaches.
 *
 * A refusal is an answer and is reported as one: a run whose pass was refused
 * for want of a composer is a different finding from a pass that ran and
 * proposed nothing, and a blank in that row would hide both.
 */
export async function runTidy(
  base: string,
  ws: string,
  docId: string,
  meetingId: string,
  log: (line: string) => void,
): Promise<TidyCounts> {
  const url =
    `${base}/workspaces/${ws}/docs/${encodeURIComponent(docId)}` +
    `/meetings/${encodeURIComponent(meetingId)}/notes-cleanup`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  const body = (await res.json()) as {
    ok?: boolean;
    reason?: string;
    proposed?: number;
    applied?: number;
    refused?: number;
    failed?: number;
    refusals?: readonly string[];
    failures?: readonly string[];
  };
  const counts: TidyCounts = {
    ok: body.ok === true,
    proposed: body.proposed ?? 0,
    applied: body.applied ?? 0,
    refused: body.refused ?? 0,
    failed: body.failed ?? 0,
    // EVERY EDIT THIS RUN DID NOT APPLY, WITH THE RULE THAT DROPPED IT. A
    // rerun whose tidy-up refused everything used to report three zeros and
    // a count, which says a pass went wrong and nothing about what — the
    // finding the harness exists to produce. The report groups these by rule.
    refusals: body.refusals ?? [],
    failures: body.failures ?? [],
    ...(body.reason !== undefined ? { reason: body.reason } : {}),
  };
  log(
    `tidy-up: ${counts.proposed} proposed, ${counts.applied} applied, ${counts.refused} refused` +
      (counts.ok ? '' : ` (refused: ${counts.reason ?? 'unknown'})`),
  );
  for (const group of groupCleanupReasons([
    ...(counts.refusals ?? []),
    ...(counts.failures ?? []),
  ])) {
    log(`  ${cleanupReasonLine(group)}`);
  }
  return counts;
}

/** The segments in order, each with every stream it kept. */
export function bySegment(inputs: readonly ReplayInput[]): Array<[number, ReplayInput[]]> {
  const byN = new Map<number, ReplayInput[]>();
  for (const input of inputs) {
    const held = byN.get(input.segment);
    if (held) held.push(input);
    else byN.set(input.segment, [input]);
  }
  return [...byN.entries()].sort((a, b) => a[0] - b[0]);
}

/**
 * Every file this recording holds names a stream the capture knows.
 *
 * The resolver accepts any `segment-N-<stream>.pcm`, and a name that is
 * neither `mic` nor `system` used to be dropped by `streamsOf` and then
 * replayed anyway — untagged, or tagged as byte 0 — so its words arrived
 * under the microphone's source and the report described a meeting whose
 * sides were not the ones on disk. Refused here instead, where it is still a
 * recording to fix rather than a transcript to disbelieve.
 */
export function checkStreams(target: ReplayTarget): void {
  const unknown = target.inputs.filter((i) => i.stream !== 'mic' && i.stream !== 'system');
  if (unknown.length === 0) return;
  throw new UsageError(
    `this recording holds ${unknown.length} file(s) on a stream this harness cannot open: ` +
      `${unknown.map((i) => `${i.stream} (${basename(i.path)})`).join(', ')}. ` +
      'The capture knows mic and system; replay one of those with --segment, or rename the file.',
  );
}

/** The stream ids this recording holds, in the order the capture opens them.
 *  A file whose name is not a stream id is left out: it cannot be tagged, and
 *  guessing a stream for it would put its words under the wrong speaker. */
export function streamsOf(target: ReplayTarget): MeetingStreamId[] {
  const held: MeetingStreamId[] = [];
  for (const id of ['mic', 'system'] as const) {
    if (target.inputs.some((i) => i.stream === id)) held.push(id);
  }
  return held;
}
