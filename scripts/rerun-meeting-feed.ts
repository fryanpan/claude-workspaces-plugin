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

import { MEETING_AUDIO_ENCODING, meetingSocketPath } from '../packages/core/src/meeting.ts';
import type {
  TranscriptionEngine,
  TranscriptionSession,
} from '../packages/server/src/transcribe.ts';
import { type ReplayTarget, replayAudio } from './replay-meeting-lib.ts';
import type { DocSpec, RerunArgs } from './rerun-meeting-args.ts';
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
  socket.send(
    JSON.stringify({
      type: 'start',
      sampleRate: first.sampleRate,
      encoding: MEETING_AUDIO_ENCODING,
      mode,
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

  const timers = f.doc.edits.map((edit) => scheduleEdit(f, edit));

  try {
    for (const input of f.target.inputs) {
      const { chunks, bytes } = await replayAudio(input, {
        engine: wireEngine((chunk) => socket.send(chunk), f.stopping),
        detectSpeakers: mode === 'conversation',
        chunkMs: f.args.chunkMs,
        realtime: true,
      });
      f.log(`  segment ${input.segment}: ${chunks} chunk(s), ${bytes} bytes`);
    }
  } catch (err) {
    if (!(err instanceof SpendCapReached)) throw err;
    f.log(`${err.message} — stopping the meeting with the audio unfinished`);
  } finally {
    for (const t of timers) clearTimeout(t);
  }

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
function scheduleEdit(f: FeedArgs, edit: DocSpec['edits'][number]): ReturnType<typeof setTimeout> {
  return setTimeout(() => {
    void postJson(
      `${f.base}/workspaces/${f.ws}/docs/${encodeURIComponent(f.docId)}/find_and_replace`,
      {
        find: edit.find,
        replace: edit.replace,
        author: AUTHOR,
      },
    ).then(
      () => f.log(`edit at ${edit.atMs}ms applied: ${JSON.stringify(edit.find)}`),
      (err: unknown) =>
        f.log(
          `edit at ${edit.atMs}ms did not apply: ${err instanceof Error ? err.message : String(err)}`,
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
  };
  const counts: TidyCounts = {
    ok: body.ok === true,
    proposed: body.proposed ?? 0,
    applied: body.applied ?? 0,
    refused: body.refused ?? 0,
    ...(body.reason !== undefined ? { reason: body.reason } : {}),
  };
  log(
    `tidy-up: ${counts.proposed} proposed, ${counts.applied} applied, ${counts.refused} refused` +
      (counts.ok ? '' : ` (refused: ${counts.reason ?? 'unknown'})`),
  );
  return counts;
}
