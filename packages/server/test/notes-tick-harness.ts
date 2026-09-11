/**
 * A meeting, scripted: utterances in, the doc after every tick out.
 *
 * The notes pipeline is a pause ticker, a promise chain, an LLM seam and a
 * doc store, and a test that wants to ask "what does the doc look like after
 * the third tick" had to assemble all four. So they are assembled once here. A
 * test says what was said and what edits the model answers with, and reads the
 * doc back after each tick.
 *
 * WHY IT MATTERS MORE THAN THE USUAL HELPER. Almost everything worth knowing
 * about a note-taker is a statement about a SEQUENCE — the heading does not
 * move between ticks, a second section never appears, a point already made
 * does not get a new heading of its own. None of those can be seen in one
 * write, and all of them are cheap to see here.
 *
 * Every clock is the manual scheduler: no test waits out real quiet, for the
 * same reason the mock engine advances per chunk (testing-standards.md, 2).
 *
 * All fixtures are synthetic. The repo is public.
 */

import { type DocType, type prose, prose as proseNs } from '@claude-workspaces/core';
import * as Y from 'yjs';
import { type NotesHeadingMemory, withServerNotesSinks } from '../src/meeting-notes-doc.ts';
import {
  type NotesComposeInput,
  type NotesMeetingSummary,
  type NotesRelabel,
  type NotesTickLifecycle,
  type TickScheduler,
  beginNotesSession,
} from '../src/meeting-notes.ts';
import { MEETING_NOTES_HEADING } from '../src/notes-doc-access.ts';
import { type NotesTimingLog, createNotesTimingLog } from '../src/notes-timing.ts';
import { headingsOf, noteLines, oneDocStore, sectionBody } from './notes-doc-helpers.ts';
import { waitFor } from './wait-for.ts';

/**
 * The edits a script means by "add these bullets".
 *
 * Almost every script here says the same thing — put this markdown in the
 * notes — and the only variable is whether the meeting has opened its section
 * yet. Spelling that in each test would put the same four lines in forty
 * places and make a script about duplicate bullets read as a script about
 * block ops.
 */
export function addNotes(input: NotesComposeInput, markdown: string): prose.BlockEdit[] {
  if (markdown.trim().length === 0) return [];
  const headingId = input.notesHeadingId;
  return headingId === undefined
    ? [{ op: 'insert_at_end', markdown: `## ${MEETING_NOTES_HEADING}\n\n${markdown}` }]
    : [{ op: 'insert_under_heading', headingId, markdown }];
}

/** Rewrite one block the outline says is the note-taker's own. Null when the
 *  outline holds no such block, so a script can say "revise the last bullet"
 *  without knowing whether there is one yet. */
export function replaceOwnBullet(input: NotesComposeInput, markdown: string): prose.BlockEdit[] {
  const own = [...input.outline]
    .reverse()
    .find((e) => e.author !== undefined && e.kind !== 'heading');
  return own === undefined ? [] : [{ op: 'replace_block', blockId: own.id, markdown }];
}

/**
 * A scheduler the test advances by hand. `fire()` runs whatever is armed,
 * shortest delay first — a real clock reaches the quiet threshold before the
 * cadence ceiling, and firing in the order timers happened to be set would let
 * the ceiling win a race it never wins in a meeting.
 */
export class ManualScheduler implements TickScheduler {
  private fns = new Map<number, { fn: () => void; ms: number }>();
  private n = 0;
  set(fn: () => void, ms: number): unknown {
    this.n++;
    this.fns.set(this.n, { fn, ms });
    return this.n;
  }
  clear(handle: unknown): void {
    this.fns.delete(handle as number);
  }
  get armed(): number {
    return this.fns.size;
  }
  fire(): void {
    const pending = [...this.fns.values()].sort((a, b) => a.ms - b.ms);
    this.fns.clear();
    for (const t of pending) t.fn();
  }
}

/** One utterance in a script: bare words, or words with a voice behind them. */
export type Utterance =
  | string
  | {
      speaker?: string;
      text: string;
      /**
       * When the words were SPOKEN, on the server clock — what the relay
       * derives from the audio chunk that carried them. Absent is the
       * ordinary case here and the one every other script runs: an engine
       * that reports no word offsets, and a timing row whose spoken clock is
       * null rather than guessed.
       */
      spokenAt?: number;
    };

/** The doc, and the tick's own inputs, immediately after that tick's write. */
export interface TickSnapshot {
  /** 1-based, per meeting. */
  tick: number;
  /** The whole doc as markdown. */
  markdown: string;
  /** Just the notes section's body, markdown. */
  notes: string;
  /** Every top-level heading, in order — the cheapest way to assert that a
   *  section did not move, get a twin, or gain a sibling. */
  headings: string[];
  /**
   * What the model was handed for this tick — UNDEFINED when no compose ran
   * for it.
   *
   * Optional because it really is optional: a tick whose compose was skipped
   * or coalesced settles with a doc and no input, and this field used to be
   * cast to non-null, which typechecked and then crashed a whole eval run
   * twelve minutes in. A caller reading it must handle the absence.
   */
  input?: NotesComposeInput;
  /** What it answered. */
  composed: readonly prose.BlockEdit[];
}

export interface NotesTickHarnessOptions {
  /** The doc before the meeting starts. Default: an empty doc. */
  doc?: string;
  /**
   * The fake model. Returns the EDITS this tick calls for, the way the real
   * composer does; throw to script a failed compose. `addNotes(input, md)`
   * above is the sugar most scripts want. The tick number is 1-based.
   */
  compose: (
    input: NotesComposeInput,
    tick: number,
  ) => readonly prose.BlockEdit[] | Promise<readonly prose.BlockEdit[]>;
  /** Default `markdown`; pass a flat type to test the refusal path. */
  docType?: DocType;
  /** Share a heading memory across two harnesses to model a second meeting on
   *  one doc. */
  heading?: NotesHeadingMemory;
  /**
   * A caller's own rename sink, run after the doc's — the seam
   * `withServerNotesSinks` offers as `onRelabel`, and the only one a script
   * can make throw. It is here so a test can ask what a THROWING step on the
   * compose chain does to the ticks behind it.
   */
  onRelabel?: (relabel: NotesRelabel) => void;
  /**
   * A caller's own lifecycle sink, run after the harness's own bookkeeping —
   * the seam a browser's `notes_progress` frames come off. It is here so a
   * test can ask what a throw from an observer does to the tick that was
   * telling it, `written` included.
   */
  onLifecycle?: (event: NotesTickLifecycle) => void;
  /**
   * Make the error sink itself throw, after recording. `onError` is a
   * caller's own function, so a test needs to be able to ask what happens
   * when the reporting step is the one that fails.
   */
  errorSinkThrows?: boolean;
  /** A doc a second harness is already driving, so two meetings can run over
   *  one `Y.Doc`. */
  ydoc?: Y.Doc;
  docId?: string;
  meetingId?: string;
  docTitle?: string;
  /** The file the doc is bound to, if any — what decides whether the old
   *  note-taker could have written a transcript section here. Pair with
   *  `dataDir`. */
  boundPath?: string;
  /** The server's data dir, as that placement rule reads it. */
  dataDir?: string;
  /**
   * The board this meeting's doc belongs to. Wiring it is what turns on the
   * two stages that need a board: the task titles in the composer's context,
   * and the per-tick reference search. Absent, both are empty, which is the
   * huddle-with-no-board case every other script here runs in.
   */
  workspaceId?: string;
  /** The board's rows, as the task store would list them. */
  tasks?: Array<{
    id?: string;
    title: string;
    status: string;
    kind?: 'task' | 'goal';
    body?: string;
  }>;
  /** The board's other docs, as the lookup would list them. */
  boardDocs?: Array<{ docId: string; title: string; meetingAt?: number }>;
  /** The board a bad meeting's quality item would be filed on. Absent, the
   *  end-of-meeting line still carries the counts and files nothing. */
  qualityBoard?: import('../src/notes-quality-review.ts').NotesQualityBoard;
  /**
   * How long `tick()` waits for the write. The default suits a scripted
   * composer, which answers in microseconds; `notes-eval.ts` drives a REAL
   * model whose reply grows with the notes, and five seconds is not enough
   * by the twentieth tick of a meeting.
   */
  tickTimeoutMs?: number;
  /**
   * The task-capture extractor, wired the way the server wires it. Present,
   * every tick runs a capture pass before its compose — which is what a test
   * about what a tick COSTS needs, because the capture call is the half that
   * used to go unrecorded. Needs `workspaceId` and `captureBoard` too: a
   * capture pass with no board has nothing to file against.
   */
  taskExtractor?: import('../src/meeting-task-capture.ts').TaskCaptureExtractor;
  /** The board that capture pass files and finds against. */
  captureBoard?: import('../src/meeting-task-capture.ts').TaskCaptureBoard;
}

export interface NotesTickHarness {
  /** Settle these utterances as turns. Nothing is written until `tick()`. */
  say(...utterances: Utterance[]): void;
  /** Name a voice mid-meeting, the way a tap on a speaker pill does. */
  nameSpeaker(label: string, name: string): void;
  /** Let the room fall quiet: fire the pause tick and wait for its write. */
  tick(): Promise<TickSnapshot>;
  /** `say` then `tick` — the ordinary unit of a script. */
  speak(...utterances: Utterance[]): Promise<TickSnapshot>;
  /**
   * A turn that starts and never settles — somebody is mid-sentence.
   *
   * `say` always settles what it says, which is every tick but the last one
   * of a meeting that was stopped while a person was still talking. This is
   * the frame the engine had emitted when the button was pressed.
   */
  sayPartial(text: string, speaker?: string): void;
  /**
   * Stop the meeting and wait for the final compose.
   *
   * Returns the final tick's snapshot, or `null` when the stop had nothing
   * left to write — the meeting ended in a silence every earlier tick had
   * already covered.
   */
  end(): Promise<TickSnapshot | null>;
  /**
   * Refs the meeting wrote onto board rows, in order — `[taskId, docId]` per
   * spoken link. The harness stands in for the task store here, so a script
   * can assert the row's side of a link without a server.
   */
  readonly taskLinks: ReadonlyArray<{ taskId: string; docId: string }>;
  /** Every snapshot so far, in order. */
  readonly snapshots: readonly TickSnapshot[];
  /** Errors the session reported — an empty list is part of most assertions. */
  readonly errors: readonly string[];
  /** What the meeting came to, once `end()` has run. Null before that. */
  summary(): NotesMeetingSummary | null;
  /**
   * Per-tick timings for the run so far.
   *
   * The scheduler here is manual, so these do NOT include the wait on the
   * clocks — a script fires its own ticks. What they DO measure is the half a
   * script cannot fake: the compose, the write, and how far a tick's words
   * had to travel behind another tick. `scripts/notes-latency-check.ts` is
   * where the clocks are measured, on a virtual clock that has them.
   *
   * EMPTY WHEN `dataDir` IS SET, and that is not a bug here. The notes sinks
   * supply their own file-backed log whenever there is a data dir to write it
   * into, and it replaces the one this harness hands them — so the rows go to
   * the meeting's timing file and to `summary()`'s latency fields, and this
   * log is never recorded into. Read `summary()` for a meeting with a data
   * dir; read this one for a meeting without.
   */
  timing(): NotesTimingLog;
  readonly ydoc: Y.Doc;
  markdown(): string;
  notes(): string;
  headings(): string[];
  /** How many top-level headings read exactly `text`. The duplicate-section
   *  assertion, spelled once. */
  countHeadings(text: string): number;
}

export function createNotesTickHarness(opts: NotesTickHarnessOptions): NotesTickHarness {
  const docId = opts.docId ?? 'd-meeting';
  const meetingId = opts.meetingId ?? 'm1';
  const ydoc = opts.ydoc ?? new Y.Doc();
  if (opts.doc) proseNs.applyMarkdownToFragment(proseNs.getProseFragment(ydoc), opts.doc);
  const meta = {
    type: opts.docType ?? ('markdown' as DocType),
    ...(opts.docTitle ? { title: opts.docTitle } : {}),
  };
  const docStore = oneDocStore(docId, {
    ydoc,
    meta,
    ...(opts.boundPath !== undefined ? { boundPath: opts.boundPath } : {}),
  });

  const qualityBoard = opts.qualityBoard;
  const schedule = new ManualScheduler();
  const timing = createNotesTimingLog();
  const snapshots: TickSnapshot[] = [];
  const errors: string[] = [];
  const taskLinks: Array<{ taskId: string; docId: string }> = [];
  let summary: NotesMeetingSummary | null = null;
  const settled = new Map<
    number,
    { input: NotesComposeInput; composed: readonly prose.BlockEdit[] }
  >();
  const done = new Set<number>();
  let turnNo = 0;
  let tickNo = 0;

  const deps = withServerNotesSinks(
    {
      composer: {
        name: 'scripted',
        async compose(input: NotesComposeInput): Promise<readonly prose.BlockEdit[]> {
          const n = input.tick.tick;
          const composed = await opts.compose(input, n);
          settled.set(n, { input, composed });
          return composed;
        },
      },
      ...(opts.taskExtractor ? { taskExtractor: opts.taskExtractor } : {}),
      // Pause ticks only. A ceiling would fire on its own inside `fire()` and
      // turn a script's third tick into somebody else's second.
      cadenceMs: Number.POSITIVE_INFINITY,
      schedule,
      openTiming: () => timing,
      onError: (message) => {
        errors.push(message);
        if (opts.errorSinkThrows) throw new Error('the error sink threw');
      },
      onMeetingSummary: (s) => {
        summary = s;
      },
      ...(opts.onRelabel ? { onRelabel: opts.onRelabel } : {}),
      onTickLifecycle: (event) => {
        // Every terminal phase, `empty` included: this set is what `tick()`
        // waits on, and a tick that composed nothing is as finished as one
        // that wrote a bullet. Leaving it out hangs the wait.
        if (event.phase !== 'composing') done.add(event.tick);
        opts.onLifecycle?.(event);
      },
    },
    {
      docStore: () => docStore,
      tasks: () => ({ listTasks: () => opts.tasks ?? [] }),
      ...(opts.workspaceId ? { boardOf: () => opts.workspaceId } : {}),
      ...(opts.boardDocs ? { lookup: { docs: () => opts.boardDocs ?? [] } } : {}),
      linkTaskToDoc: (taskId, linkedDocId) => {
        taskLinks.push({ taskId, docId: linkedDocId });
      },
      ...(opts.dataDir ? { dataDir: opts.dataDir } : {}),
      ...(opts.captureBoard ? { captureBoard: () => opts.captureBoard as never } : {}),
      ...(qualityBoard ? { qualityBoard: () => qualityBoard } : {}),
      ...(opts.heading ? { heading: opts.heading } : {}),
    },
  );
  const session = beginNotesSession(deps, { docId, meetingId });

  const markdown = (): string =>
    proseNs.serializeFragmentToMarkdown(proseNs.getProseFragment(ydoc));

  const headings = (): string[] => headingsOf(ydoc);

  const snapshot = (tick: number): TickSnapshot => {
    const seen = settled.get(tick);
    return {
      tick,
      markdown: markdown(),
      notes: sectionBody(ydoc, MEETING_NOTES_HEADING),
      headings: headings(),
      ...(seen?.input ? { input: seen.input } : {}),
      composed: seen?.composed ?? [],
    };
  };

  const harness: NotesTickHarness = {
    snapshots,
    errors,
    taskLinks,
    summary: () => summary,
    timing: () => timing,
    ydoc,
    markdown,
    notes: () => sectionBody(ydoc, MEETING_NOTES_HEADING),
    headings,
    countHeadings: (text) => headings().filter((h) => h === text).length,
    say(...utterances) {
      for (const u of utterances) {
        const turn = turnNo++;
        const text = typeof u === 'string' ? u : u.text;
        const speaker = typeof u === 'string' ? undefined : u.speaker;
        const spokenAt = typeof u === 'string' ? undefined : u.spokenAt;
        // A partial first, then the settled turn: the ticker treats any frame
        // as speech in progress, which is how a real turn arrives. The partial
        // carries the spoken clock too, because in a meeting that frame is
        // where the first words of the turn actually reach the server.
        session.onTurn(
          { turn, text: text.slice(0, Math.max(1, text.length - 1)), final: false },
          spokenAt,
        );
        session.onTurn(
          {
            turn,
            text,
            final: true,
            ...(speaker !== undefined ? { speaker } : {}),
          },
          spokenAt === undefined ? undefined : spokenAt + 1,
        );
      }
    },
    async tick() {
      const n = ++tickNo;
      schedule.fire();
      await waitFor(() => done.has(n), {
        describe: `notes tick ${n} to be written`,
        ...(opts.tickTimeoutMs !== undefined ? { timeout: opts.tickTimeoutMs } : {}),
      });
      const shot = snapshot(n);
      snapshots.push(shot);
      return shot;
    },
    async speak(...utterances) {
      harness.say(...utterances);
      return harness.tick();
    },
    nameSpeaker(label, name) {
      session.nameSpeaker(label, name);
    },
    sayPartial(text, speaker) {
      const turn = turnNo++;
      session.onTurn({
        turn,
        text,
        final: false,
        ...(speaker !== undefined ? { speaker } : {}),
      });
    },
    async end() {
      // The end tick takes the next number in the same sequence the pause
      // ticks use, so a script that has taken three ticks reads its final
      // pass as the fourth.
      const n = ++tickNo;
      await session.end();
      if (!done.has(n)) return null;
      const shot = snapshot(n);
      snapshots.push(shot);
      return shot;
    },
  };
  return harness;
}

/** The lines the notes section currently holds — the unit a test counts when
 *  it wants to know whether a note appeared twice. */
export function notesItems(ydoc: Y.Doc): string[] {
  return noteLines(ydoc, MEETING_NOTES_HEADING);
}
