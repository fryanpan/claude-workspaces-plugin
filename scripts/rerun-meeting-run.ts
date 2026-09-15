/**
 * Hold a retained meeting again, through the real note-taker.
 *
 * WHAT THIS IS AND WHY IT IS NOT THE SMOKE CHECK. `check:meeting-smoke` runs
 * a whole meeting for free, four scripted turns of it, with
 * `createStubNotesComposer` writing the notes — no model call, which is a
 * requirement of that gate rather than a convenience. It can therefore say
 * that the pipeline moves words into a doc, and it can say nothing at all
 * about what the notes READ like. Every note-taking change on this board has
 * been judged on fixtures, and a real 41-minute meeting still came out as 192
 * bullets under no topic heading with its own quality pass scoring zero ideas
 * covered. This is the harness that would have caught that.
 *
 * THE THREE THINGS IT CHANGES, and nothing else:
 *
 *   1. THE AUDIO IS A REAL RECORDING'S. A retained meeting's PCM is fed to
 *      the capture seam — the `/workspaces/<ws>/docs/<id>/audio` socket, the
 *      one a browser's microphone opens — paced at the audio's own rate by
 *      `replay-meeting-lib.ts`'s loop rather than a second copy of it. The
 *      socket is where a person's audio enters the server, so Chrome is not
 *      in this harness: it contributed the fake microphone and the on-screen
 *      assertions, and this run replaces the first and asks nothing of the
 *      second.
 *   2. THE NOTE-TAKER IS REAL, and which one is a flag. All three of
 *      `NOTES_METHODS` are selectable, because "which note-taker ran" is one
 *      of the questions a rerun exists to answer — and the method is chosen
 *      by writing the doc's own `notes-method.json`, so the per-tick read the
 *      shipped composer makes is the read that decides.
 *   3. THE STARTING DOCUMENT IS A PARAMETER. Empty, a prep outline, or an
 *      outline somebody edits while the room talks. The fault under test is
 *      about structure, so holding the audio fixed and moving only this is
 *      what isolates it.
 *
 * IT IS NOT A GATE AND MUST NEVER BECOME ONE. It calls a real model on every
 * tick of a real recording. `--spend-usd` is required before anything opens,
 * the estimate is refused against it before the socket does, and the meter in
 * `rerun-meeting-spend.ts` stops the run mid-flight if the bill reaches the
 * ceiling anyway.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { NotesMethod } from '../packages/core/src/notes-method.ts';
import type { MeetingNamer } from '../packages/server/src/meeting-namer.ts';
import type { NotesComposer, NotesMeetingSummary } from '../packages/server/src/meeting-notes.ts';
import type { TaskCaptureExtractor } from '../packages/server/src/meeting-task-capture.ts';
import { meetingDirPath } from '../packages/server/src/meetings.ts';
import { createNotesHeadingFileStore } from '../packages/server/src/notes-heading-store.ts';
import { readNotesMethod, writeNotesMethod } from '../packages/server/src/notes-method-store.ts';
import { readSectionMarkdown } from '../packages/server/src/notes-quality-pass.ts';
import { readNotesQuality } from '../packages/server/src/notes-quality-store.ts';
import { type ServerHandle, createServer } from '../packages/server/src/server.ts';
import type { TranscriptionEngine } from '../packages/server/src/transcribe.ts';
import type { ReplayTarget } from './replay-meeting-lib.ts';
import {
  type DocSpec,
  type RerunArgs,
  UsageError,
  budgetCheck,
  checkDocEdits,
  pcmDurationMs,
} from './rerun-meeting-args.ts';
import {
  STOP_TIMEOUT_MS,
  bySegment,
  feedMeeting,
  runTidy,
  seedContent,
  seedDoc,
  until,
} from './rerun-meeting-feed.ts';
import { type RerunReport, buildRerunReport, renderRerunReport } from './rerun-meeting-report.ts';
import { SpendCapReached, createSpendMeter } from './rerun-meeting-spend.ts';

export interface RerunDeps {
  /**
   * The note-taker, built against the run's own data dir.
   *
   * A FACTORY AND NOT AN OBJECT because the shipped composer picks its method
   * per tick by reading `notes-method.json` out of the data dir, and the data
   * dir does not exist until this function makes one. Handed a finished
   * composer, the harness would have had to name the method at construction —
   * which is exactly how `--method ledger-opus` silently ran the original
   * note-taker in the first draft of this file.
   */
  composer: (dataDir: string) => NotesComposer;
  /** The engine the SERVER opens. `mock` costs nothing; a live one bills for
   *  the audio's length on top of the note-taker. */
  transcription: TranscriptionEngine;
  /** The spoken-ask capture pass, which bills per tick and is half of what a
   *  real meeting costs. Absent runs the notes without it. */
  taskExtractor?: TaskCaptureExtractor | null;
  /** Names the meeting from its notes. Absent leaves the default title. */
  titleNamer?: MeetingNamer | null;
  log: (line: string) => void;
}

/**
 * What the shipped composer should be told the doc's method is, per tick.
 *
 * THE SEAM `--method` TRAVELS THROUGH, and the one place it can go wrong
 * quietly. `createNotesMethodComposer` picks its note-taker at the top of
 * every compose by calling this and nothing else, so a reader that answered a
 * constant would run the original composer for all three methods while the
 * report's heading still named the one that was asked for — a comparison of
 * nothing, printed as a comparison. `server-deps.ts` wires exactly this read;
 * this is the same one over the run's own data dir, plus a line in the log
 * saying which note-taker actually composed.
 */
export function methodReader(
  dataDir: string,
  log: (line: string) => void,
  read: (dir: string, docId: string) => NotesMethod = readNotesMethod,
): (docId: string) => NotesMethod {
  let announced: NotesMethod | undefined;
  return (docId: string): NotesMethod => {
    const method = read(dataDir, docId);
    if (method !== announced) {
      announced = method;
      log(`note-taker in force: ${method}`);
    }
    return method;
  };
}

/**
 * How long the meeting itself ran, from the files it kept.
 *
 * THE MEETING'S LENGTH, NOT ITS FILES' TOTAL. A segment's mic and system
 * files are the same minutes recorded twice, so summing every file costs a
 * two-stream meeting at double its length — which would refuse runs that fit
 * and report a rate against a denominator nobody spoke for.
 */
export function audioLengthMs(
  target: ReplayTarget,
  sizeOf: (path: string) => number = (path) => statSync(path).size,
): number {
  return bySegment(target.inputs).reduce(
    (ms, [, inputs]) =>
      ms +
      inputs.reduce(
        (longest, i) => Math.max(longest, pcmDurationMs(sizeOf(i.path), i.sampleRate)),
        0,
      ),
    0,
  );
}

/** `rerun-YYYYMMDDTHHMMSSZ`, so two runs of the same audio sit side by side. */
export function runFolderName(at: number): string {
  const stamp = new Date(at)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  return `rerun-${stamp}`;
}

/**
 * A folder of this run's own, even when another run started in the same
 * second.
 *
 * EXCLUSIVE CREATION, not `recursive: true`. Two comparison runs against the
 * same `--out` are the ordinary way this harness is used, and a `recursive`
 * create accepts a directory that already exists — so the second run would
 * have written its notes, its report and its log over the first one's and
 * said nothing. The stamp keeps seconds; the suffix is what makes it unique.
 */
export function makeRunDir(
  out: string,
  at: number,
  make: (dir: string) => void = mkdirDeep,
): string {
  const stem = join(out, runFolderName(at));
  for (let n = 1; ; n++) {
    const dir = n === 1 ? stem : `${stem}-${n}`;
    try {
      make(dir);
      return dir;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
}

/** The parent chain, then this directory and only if it is new. */
function mkdirDeep(dir: string): void {
  mkdirSync(dirname(dir), { recursive: true });
  mkdirSync(dir);
}

/** What a run billed, and how many calls did it. */
export interface Billed {
  usd: number;
  calls: number;
}

/**
 * The meeting's own bill plus whatever was billed after it was struck.
 *
 * The summary is made when the meeting stops, and the tidy-up runs after that
 * through the same metered composer — so a report that took the summary's
 * figure alone left the cleanup's call out of a number that had already
 * helped decide whether the cap fired. `summary` is preferred for the meeting
 * itself because it is the pipeline's own accounting; the meter supplies only
 * the difference it has booked since.
 */
export function billedTotals(summary: Billed | undefined, atSummary: Billed, now: Billed): Billed {
  const meeting = summary ?? atSummary;
  return {
    usd: meeting.usd + (now.usd - atSummary.usd),
    calls: meeting.calls + (now.calls - atSummary.calls),
  };
}

export interface RerunOutcome {
  report: RerunReport;
  runDir: string;
  reportPath: string;
  /** Set when the run stopped early because the ceiling was reached. */
  cappedUsd?: number;
}

/** The running state of one meeting, in one object rather than five `let`s, so
 *  the sinks below and the code after the meeting read the same thing. */
interface RunState {
  firstNoteMs: number | null;
  summary: NotesMeetingSummary | undefined;
  /** What the meter had booked when the meeting's own summary arrived — the
   *  line between what the summary already counts and what came after it. */
  meteredAtSummary: number;
  callsAtSummary: number;
  spentUsd: number;
  spentCalls: number;
  capped: Error | null;
}

/**
 * One rerun, start to report.
 *
 * Everything that bills arrives from the caller already built — the composer,
 * the engine, the capture pass — which is what lets the test suite drive this
 * whole path for nothing.
 */
export async function runRerun(
  args: RerunArgs,
  target: ReplayTarget,
  doc: DocSpec,
  deps: RerunDeps,
): Promise<RerunOutcome> {
  const audioMs = audioLengthMs(target);
  const budget = budgetCheck(audioMs, args.method, args.spendUsd);
  deps.log(budget.line);
  // A UsageError, not an Error: the operator named too small a ceiling for
  // this recording, which is a command line to fix rather than a crash.
  if (!budget.ok) throw new UsageError(budget.line);
  checkDocEdits(doc.edits, audioMs);

  const dataDir = mkdtempSync(join(tmpdir(), 'cw-meeting-rerun-data-'));
  const runDir = makeRunDir(args.out, Date.now());

  const state: RunState = {
    firstNoteMs: null,
    summary: undefined,
    meteredAtSummary: 0,
    callsAtSummary: 0,
    spentUsd: 0,
    spentCalls: 0,
    capped: null,
  };

  // ONE METER OVER BOTH BILLED PASSES — see `rerun-meeting-spend.ts`. The
  // capture pass bills per tick as well, and a cap that watched the composer
  // alone would let a run reach about twice the ceiling it was given.
  const meter = createSpendMeter(
    args.spendUsd,
    (usd, calls) => onSpend(state, args.spendUsd, deps, usd, calls),
    (model) => onUnpriceable(state, deps, model),
  );
  const taskExtractor =
    deps.taskExtractor === undefined || deps.taskExtractor === null
      ? deps.taskExtractor
      : meter.extractor(deps.taskExtractor);

  const server: ServerHandle = createServer({
    port: args.port,
    dataDir,
    requireSignInToWrite: false,
    transcription: deps.transcription,
    meetingNotes: {
      composer: meter.composer(deps.composer(dataDir)),
      ...(taskExtractor !== undefined ? { taskExtractor } : {}),
      ...(deps.titleNamer !== undefined ? { titleNamer: deps.titleNamer } : {}),
      onFirstNote: (first) => {
        state.firstNoteMs = first.afterMs;
      },
      onMeetingSummary: (summary) => {
        state.summary = summary;
        state.meteredAtSummary = meter.totalUsd;
        state.callsAtSummary = meter.calls;
      },
    },
  });
  const base = `http://127.0.0.1:${server.port}`;

  try {
    const { ws, docId } = await seedDoc(base);
    // The doc's own preference file, exactly as the chooser writes it. The
    // shipped composer re-reads this at the top of every compose, so this is
    // what makes `--method` choose the note-taker rather than the harness
    // wiring a different object.
    writeNotesMethod(dataDir, docId, { method: args.method, at: Date.now(), by: 'meeting-rerun' });
    if (doc.markdown.trim().length > 0) await seedContent(base, ws, docId, doc.markdown);
    deps.log(
      `starting document: ${doc.shape}` +
        (doc.edits.length > 0 ? `, ${doc.edits.length} edit(s) arriving mid-run` : ''),
    );

    const meetingId = await feedMeeting({
      args,
      target,
      doc,
      base,
      ws,
      docId,
      stopping: () => state.capped,
      log: deps.log,
    });
    const summary = await until(() => state.summary, STOP_TIMEOUT_MS, 'the meeting summary');
    deps.log(
      `meeting ${meetingId} ended: ${summary.ticks} tick(s), ${summary.turnsSettled} settled turn(s)`,
    );

    const tidy = await runTidy(base, ws, docId, meetingId, deps.log);
    const billed = billedTotals(
      summary.spend ? { usd: summary.spend.totalUsd, calls: summary.spend.calls } : undefined,
      { usd: state.meteredAtSummary, calls: state.callsAtSummary },
      { usd: meter.totalUsd, calls: meter.calls },
    );
    const headingId = createNotesHeadingFileStore(dataDir).read({ docId, meetingId });
    const section = readSectionMarkdown(server.docStore, docId, headingId);
    const quality = readNotesQuality(dataDir, docId, meetingId);
    const notesPath = join(runDir, 'notes.md');
    const document = server.docStore.readMarkdownBody(docId) ?? '';
    writeFileSync(notesPath, document);
    writeFileSync(join(runDir, 'notes-section.md'), section);
    copyTranscript(dataDir, docId, runDir);

    const report = buildRerunReport({
      method: args.method,
      engine: deps.transcription.name,
      docShape: doc.shape,
      docEdits: doc.edits.length,
      audioMs,
      elapsedMs: summary.elapsedMs,
      ticks: summary.ticks,
      turnsSettled: summary.turnsSettled,
      // THE PIPELINE'S OWN READING, not a second one. The at-stop quality
      // record is the number the production log prints; the summary's running
      // count is the fallback for a run whose record failed to write, so the
      // row is never blank.
      ideasVoiced: quality?.ideas ?? summary.ideas.seen,
      ideasCovered:
        quality !== undefined ? quality.ideas - quality.uncoveredIdeas : summary.ideas.carried,
      tidy,
      billedUsd: billed.usd,
      billedCalls: billed.calls,
      unpricedModels: summary.spend?.unpricedModels ?? [],
      firstNoteMs: state.firstNoteMs,
      notesPath,
      logPath: join(runDir, 'run.log'),
      document,
      section,
    });
    const reportPath = join(runDir, 'report.md');
    writeFileSync(reportPath, renderRerunReport(report));
    return {
      report,
      runDir,
      reportPath,
      ...(state.capped !== null ? { cappedUsd: state.spentUsd } : {}),
    };
  } finally {
    await server.stop();
    if (args.keep) deps.log(`kept ${dataDir}`);
    else rmSync(dataDir, { recursive: true, force: true });
  }
}

/** Record what the last call billed, and arm the feed's stop once the running
 *  total reaches the ceiling the operator named. */
function onSpend(
  state: RunState,
  maxUsd: number,
  deps: RerunDeps,
  usd: number,
  calls: number,
): void {
  state.spentUsd = usd;
  state.spentCalls = calls;
  if (usd < maxUsd || state.capped !== null) return;
  state.capped = new SpendCapReached(
    `spend cap reached: $${usd.toFixed(4)} of $${maxUsd.toFixed(2)} — stopping the meeting`,
  );
  deps.log(state.capped.message);
}

/** A call this build cannot price ends the meeting, because from here on the
 *  ceiling the operator named is unenforceable and the recording would go on
 *  billing under it. */
function onUnpriceable(state: RunState, deps: RerunDeps, model: string): void {
  if (state.capped !== null) return;
  state.capped = new SpendCapReached(
    `${model} has no price in this build — stopping the meeting, because --spend-usd cannot cap ` +
      'a run whose calls cannot be priced.',
  );
  deps.log(state.capped.message);
}

/** The raw transcript the server wrote, beside the notes, so the run folder
 *  holds both halves of what a reader compares. */
function copyTranscript(dataDir: string, docId: string, runDir: string): void {
  const dir = meetingDirPath(dataDir, docId);
  if (!existsSync(dir)) return;
  for (const file of readdirSync(dir)) {
    if (file.endsWith('-raw-transcript.md')) cpSync(join(dir, file), join(runDir, 'transcript.md'));
  }
}
