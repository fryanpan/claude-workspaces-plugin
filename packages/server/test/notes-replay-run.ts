/**
 * One recorded doc's meetings, driven through the live notes wiring on the
 * replay clock. The composer is a parameter: `notes-replay.ts` hands in the
 * shipped note-taker on the eval key, and the test hands in a scripted one,
 * so everything between the transcript and the doc is the code that ships.
 *
 * WIRED THE WAY `meeting-wiring.ts` WIRES IT — `withServerNotesSinks` over a
 * data dir, the notes written into the doc through `applyBlockEdits`, the
 * at-stop quality pass and its filer included. What differs, and why:
 *
 * - The doc store is `oneDocStore`, which delegates to the same
 *   `doc-outline-ops.ts` the server's `DocStore` does.
 * - No board: no task titles in context, no capture, no title namer. The
 *   recorded meeting had a board; the replay cannot know its rows as they
 *   stood, and the namer bills a second model for a title nothing scores.
 * - The doc sits on a stand-in board with no rows, and the quality board is
 *   a recorder, so a filed item is kept as a fact
 *   rather than posted anywhere.
 * - Names given during a leg are applied at the START of that leg. The index
 *   says which leg a name arrived in, never when within it.
 * - `Date.now` reads the replay clock for the length of the run, so every
 *   timestamp the pipeline takes sits on the recording's own timeline.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { prose } from '@claude-workspaces/core';
import * as Y from 'yjs';
import {
  DEFAULT_ENDPOINT_LAG_MS,
  ReplayClock,
  type ReplayEvent,
  type ReplayMeeting,
  driveReplay,
  legFrames,
} from '../../../scripts/notes-replay-lib.ts';
import { withServerNotesSinks } from '../src/meeting-notes-doc.ts';
import {
  type NotesComposer,
  type NotesMeetingSummary,
  beginNotesSession,
} from '../src/meeting-notes.ts';
import { meetingIndexPath, meetingTranscriptPath } from '../src/meetings.ts';
import type { NotesCoverageJudge } from '../src/notes-coverage-judge.ts';
import type { NotesQualityBoard } from '../src/notes-quality-review.ts';
import { oneDocStore } from './notes-doc-helpers.ts';

export interface ReplayRunInput {
  docId: string;
  docTitle?: string;
  meetings: readonly ReplayMeeting[];
  /** Names each meeting's first leg started knowing, by meeting id. */
  seedNames?: Readonly<Record<string, Record<string, string>>>;
  /** A fresh, empty server data dir for this run. */
  dataDir: string;
  composer: NotesComposer;
  endpointLagMs?: number;
  /** Wall clock the replay clock runs on while a call is in flight. */
  wall?: () => number;
  /** The at-stop reading of what the notes left out, as the server wires it.
   *  Absent, the lexical reading stands. */
  coverageJudge?: NotesCoverageJudge;
}

export interface ReplayFiling {
  op: 'file' | 'revise' | 'withdraw';
  meetingId?: string;
  at: number;
}

export interface ReplayRunResult {
  markdown: string;
  summaries: NotesMeetingSummary[];
  filings: ReplayFiling[];
  errors: string[];
  /** Per settled turn: when it settled and when a written note first carried it. */
  turnWaits: Array<{
    meetingId: string;
    turn: number;
    settledAt: number;
    writtenAt: number | null;
  }>;
  ticks: { written: number; empty: number; failed: number };
}

const ACTOR_ID = 'notes-replay';
const REPLAY_BOARD = 'w-replay';
/** How long after the last stop the replay keeps running timers, so a
 *  quality filer's resume grace can expire and file. */
const GRACE_HORIZON_MS = 30 * 60_000;

function appendLine(path: string, row: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(row)}\n`);
}

export async function runReplay(input: ReplayRunInput): Promise<ReplayRunResult> {
  const first = input.meetings[0];
  if (!first) throw new Error('nothing to replay: no meeting in this folder has a settled turn');
  const clock = new ReplayClock(first.startedAt, input.wall);
  const ydoc = new Y.Doc();
  const docStore = oneDocStore(input.docId, {
    ydoc,
    meta: { type: 'markdown', ...(input.docTitle ? { title: input.docTitle } : {}) },
  });
  const summaries: NotesMeetingSummary[] = [];
  const filings: ReplayFiling[] = [];
  const errors: string[] = [];
  const ticks = { written: 0, empty: 0, failed: 0 };
  const settled = new Map<string, { settledAt: number; writtenAt: number | null }>();
  let current = '';
  let filed = 0;

  const composer: NotesComposer = {
    name: input.composer.name,
    async compose(ci) {
      clock.begin();
      try {
        return await input.composer.compose(ci);
      } finally {
        clock.finish();
      }
    },
  };
  const board: NotesQualityBoard = {
    backlinksFor: () => [],
    addReviewItem: () => ({ ok: false, error: 'no-board' }),
    fileOnDoc: () => {
      filings.push({ op: 'file', meetingId: current, at: clock.now() });
      filed++;
      return { threadId: `replay-thread-${filed}`, commentId: `replay-comment-${filed}` };
    },
    reviseOnDoc: () => {
      filings.push({ op: 'revise', meetingId: current, at: clock.now() });
      return { ok: true };
    },
    withdrawOnDoc: () => {
      filings.push({ op: 'withdraw', meetingId: current, at: clock.now() });
      return { ok: true };
    },
  };
  // The judge runs after a meeting's last leg, at wall speed and off the
  // replay clock; the run waits for every reading it started.
  const judging = new Set<Promise<unknown>>();
  const judge = input.coverageJudge;
  const coverageJudge: NotesCoverageJudge | undefined = judge
    ? (args) => {
        const run = judge(args);
        judging.add(run);
        return run;
      }
    : undefined;
  const deps = withServerNotesSinks(
    {
      composer,
      ...(coverageJudge ? { coverageJudge } : {}),
      schedule: clock,
      now: () => clock.now(),
      onError: (m) => errors.push(m),
      onMeetingSummary: (s) => summaries.push(s),
      onTickLifecycle: (e) => {
        if (e.phase === 'composing') return;
        ticks[e.phase]++;
        if (e.phase !== 'written') return;
        for (const turn of e.turns) {
          const row = settled.get(`${e.meetingId}|${turn}`);
          if (row && row.writtenAt === null) row.writtenAt = clock.now();
        }
      },
    },
    {
      docStore: () => docStore,
      tasks: () => ({ listTasks: () => [] }),
      dataDir: input.dataDir,
      // A board of its own, so the quality pass has somewhere to file: with
      // no board the pass reads the notes and files nothing, and goal 5
      // would score a silence the live server does not have.
      boardOf: () => REPLAY_BOARD,
      qualityBoard: () => board,
      qualityActor: { id: ACTOR_ID, name: 'Notes replay' },
      qualityGraceSchedule: clock,
    },
  );

  const realNow = Date.now;
  Date.now = () => Math.round(clock.now());
  try {
    for (const meeting of input.meetings) {
      current = meeting.meetingId;
      const ids = { docId: input.docId, meetingId: meeting.meetingId };
      const indexPath = meetingIndexPath(input.dataDir, input.docId);
      const transcriptPath = meetingTranscriptPath(input.dataDir, input.docId, meeting.meetingId);
      const names: Record<string, string> = { ...(input.seedNames?.[meeting.meetingId] ?? {}) };
      for (const [legNo, leg] of meeting.legs.entries()) {
        clock.jumpTo(leg.startAt);
        await clock.idle();
        for (const line of leg.openLines) appendLine(indexPath, line);
        const session = beginNotesSession(deps, { ...ids, speakerNames: { ...names } });
        for (const [label, name] of Object.entries(leg.names)) {
          names[label] = name;
          session.nameSpeaker(label, name);
        }
        const events: ReplayEvent[] = legFrames(
          leg.turns,
          leg.startAt,
          input.endpointLagMs ?? DEFAULT_ENDPOINT_LAG_MS,
        ).map((f) => ({
          at: f.at,
          run: () => {
            if (f.frame.final) {
              appendLine(transcriptPath, {
                turn: f.frame.turn,
                text: f.frame.text,
                ...(f.frame.speaker !== undefined ? { speaker: f.frame.speaker } : {}),
                ts: Math.round(clock.now()),
              });
              settled.set(`${meeting.meetingId}|${f.frame.turn}`, {
                settledAt: clock.now(),
                writtenAt: null,
              });
            }
            session.onTurn(f.frame, f.spokenAt);
          },
        }));
        const lastAt = events[events.length - 1]?.at ?? leg.startAt;
        // The leg stops when the index says it did, never before its last turn.
        events.push({ at: Math.max(lastAt, leg.endAt ?? lastAt), run: () => undefined });
        await driveReplay(clock, events);
        await session.end();
        await clock.idle();
        if (leg.endLine) appendLine(indexPath, leg.endLine);
        const last = legNo === meeting.legs.length - 1;
        deps.onLegEnded?.(ids, { resumable: !last });
      }
    }
    // Whatever grace a filer still holds runs out on the replay clock.
    await driveReplay(clock, [], clock.now() + GRACE_HORIZON_MS);
    // And a judge still reading finishes, and its filing lands.
    await Promise.allSettled([...judging]);
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    Date.now = realNow;
  }

  const turnWaits = [...settled.entries()].map(([key, v]) => {
    const [meetingId = '', turn = '0'] = key.split('|');
    return { meetingId, turn: Number(turn), ...v };
  });
  return {
    markdown: prose.serializeFragmentToMarkdown(prose.getProseFragment(ydoc)),
    summaries,
    filings,
    errors,
    turnWaits,
    ticks,
  };
}
