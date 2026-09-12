/**
 * The pass that runs when a meeting stops: read the notes it produced, count
 * what went wrong in them, say so in the log, leave a record for the daily
 * rollup, and put an item in front of a person when it went badly.
 *
 * WHY IT IS ITS OWN MODULE. The four things it does live in four places —
 * the doc, the process log, the data dir and the board — and the meeting sink
 * that calls it (`meeting-notes-doc.ts`) is already the largest file on this
 * path. Assembling them here keeps the sink's own job legible and gives the
 * assembly a test of its own that needs no meeting.
 *
 * IT MUST NEVER THROW. It runs inside a meeting's `end()`, after the last
 * compose and before the caller's own summary handler. An exception here
 * would take the stop down with it, which would cost the doc the flush the
 * whole meeting has been building towards — so every step is guarded and a
 * failure degrades to a log line. A quality report is worth strictly less
 * than the notes it is about.
 *
 * READING THE SECTION IS THE PART THAT NEEDED CARE. The notes are addressed
 * by the BLOCK ID of the heading the meeting opened, not by heading text —
 * a person renaming it must not orphan the reading — and they are read as
 * MARKDOWN rather than as outline text, because the outline flattens a
 * block's marks away and the speaker tags are exactly what the invented-voice
 * check reads. So the walk is over the prose fragment itself: the heading's
 * own element, then its siblings, stopping at the next heading of its level
 * or above.
 */

import { prose } from '@claude-workspaces/core';
import * as Y from 'yjs';
import { listMeetings, readTranscript } from './meetings.ts';
import type { NotesDocStore } from './notes-doc-access.ts';
import {
  type MeetingVoices,
  type NotesQualityReport,
  type SpokenTurn,
  buildNotesQualityReport,
  notesQualityLogLine,
} from './notes-quality-report.ts';
import {
  type NotesQualityBoard,
  type NotesQualityFiling,
  fileNotesQualityReview,
  filedItemLink,
} from './notes-quality-review.ts';
import { notesQualityRecord, writeNotesQuality } from './notes-quality-store.ts';
import { readTickWaits } from './notes-tick-timing.ts';

/** Whether this block is a list container — the element that serializes its
 *  children WITH their bullet markers. */
function isList(el: Y.XmlElement): boolean {
  return el.nodeName === 'bulletList' || el.nodeName === 'orderedList';
}

/** The addressable children of a list container, by block id. */
function childBlockIds(el: Y.XmlElement): string[] {
  const out: string[] = [];
  for (const child of el.toArray()) {
    if (!(child instanceof Y.XmlElement)) continue;
    const id = prose.readBlockId(child);
    if (id !== undefined) out.push(id);
  }
  return out;
}

/**
 * The markdown of one section: the block `headingId` names, then every block
 * after it until a heading at that level or above.
 *
 * Empty for a heading id nothing matches — a doc that is gone, a heading a
 * person deleted, or a meeting that never opened a section at all. Empty is
 * the honest reading of every one of those: the meeting produced no notes
 * this pass can find, and a coverage check over empty notes reports exactly
 * that.
 */
export function readSectionMarkdown(
  docStore: NotesDocStore,
  docId: string,
  headingId: string | undefined,
  skip: ReadonlySet<string> = new Set(),
): string {
  if (headingId === undefined) return '';
  const doc = docStore.get(docId);
  if (!doc) return '';
  let blocks: ReturnType<typeof prose.addressableBlocks>;
  try {
    blocks = prose.addressableBlocks(prose.getProseFragment(doc.ydoc));
  } catch {
    return '';
  }
  const all = [...blocks];
  const start = all.findIndex((el) => prose.readBlockId(el) === headingId);
  if (start < 0) return '';
  const levelOf = (el: (typeof all)[number]): number | undefined => {
    if (el.nodeName !== 'heading') return undefined;
    const raw = el.getAttribute('level');
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : 1;
  };
  const openLevel = levelOf(all[start]!) ?? 2;
  const out: string[] = [];
  for (let i = start; i < all.length; i++) {
    const el = all[i]!;
    const level = levelOf(el);
    if (i > start && level !== undefined && level <= openLevel) break;
    const id = prose.readBlockId(el);
    if (i > start && id !== undefined && skip.has(id)) continue;
    // A LIST HOLDING ANY SKIPPED ITEM IS DROPPED, AND ITS SURVIVORS CARRY
    // THEIR OWN MARKERS. The walk returns a list AND the items inside it, and
    // only the list serializes its children with the `- ` a bullet check
    // reads — so a meeting that appended its notes to a list the previous
    // recording opened would otherwise have that recording's bullets counted
    // as its own (the list emits every child) or its own counted as none (the
    // items emit bare lines). Dropping the container and marking what is left
    // is the only split that gives each recording its own bullets.
    if (isList(el) && childBlockIds(el).some((child) => skip.has(child))) continue;
    const orphaned =
      el.nodeName === 'listItem' &&
      el.parent instanceof Y.XmlElement &&
      isList(el.parent) &&
      childBlockIds(el.parent).some((child) => skip.has(child));
    out.push(
      orphaned ? `- ${prose.serializeBlockToMarkdown(el)}` : prose.serializeBlockToMarkdown(el),
    );
  }
  return out.join('\n');
}

/** Who a meeting had, read off its own record and its transcript. */
export function voicesOf(
  dataDir: string | undefined,
  docId: string,
  meetingId: string,
  transcript: readonly SpokenTurn[],
): MeetingVoices {
  const labels = new Set<string>();
  const names: string[] = [];
  // Which voice each name belongs to, kept rather than flattened: a name on
  // the wrong label is the failure `unknownVoices` cannot see without it.
  const assigned: Record<string, string> = {};
  for (const turn of transcript) if (turn.speaker) labels.add(turn.speaker);
  if (dataDir !== undefined) {
    try {
      for (const record of listMeetings(dataDir, docId)) {
        if (record.meetingId !== meetingId) continue;
        for (const [label, name] of Object.entries(record.speakers ?? {})) {
          labels.add(label);
          names.push(name);
          assigned[label] = name;
        }
        if (record.participant) names.push(record.participant);
      }
    } catch {
      // A record that cannot be read leaves the meeting with the voices its
      // transcript proves. That direction over-reports invented names rather
      // than under-reporting them, which is the error worth making.
    }
  }
  return { labels: [...labels], assigned, names };
}

/** What this pass needs, all of it optional except the doc it reads. */
export interface NotesQualityPassDeps {
  docStore: () => NotesDocStore;
  /** The board a review item would be filed on. Absent, nothing is filed. */
  board?: () => NotesQualityBoard;
  /** Which board a doc belongs to. */
  boardOf?: (docId: string) => string | undefined;
  /** The server's data dir — where the transcript, the meeting record, the
   *  tick timings and this pass's own record live. Absent, the pass still
   *  reads the notes and reports on them alone. */
  dataDir?: string;
  /** The block id of the heading this meeting wrote under. */
  headingIdOf: (docId: string, meetingId: string) => string | undefined;
  /**
   * What was already in that section when this meeting took it over.
   *
   * A meeting that CONTINUES the last recording's section shares a heading
   * with notes it did not write, and this pass judges the notes a meeting
   * wrote: handed the previous recording's five identical bullets it would
   * file a bad-notes item against a meeting whose own notes are fine. Absent,
   * or empty — every meeting that opened its own section — the whole section
   * is read, which is what this pass always did.
   */
  priorBlocks?: (docId: string, meetingId: string) => ReadonlySet<string>;
  /** The actor a filed item is attributed to. */
  actor: { id: string; name: string; kind?: string };
  now?: () => number;
}

/** What the pass concluded, for the caller and for a test. */
export interface NotesQualityPassResult {
  report: NotesQualityReport;
  filing: NotesQualityFiling;
  /** Whether the record reached the data dir. `false` also for a pass with
   *  no data dir to write to. */
  stored: boolean;
  /**
   * The counts, and where the item went, as the END-OF-MEETING LINE carries
   * them.
   *
   * Returned rather than logged, because there is one line per meeting and it
   * is the caller's. A second line would be the thing this whole change is
   * against: the coverage numbers and the quality numbers answer one question
   * together, and a reader who has to join two lines to ask it will not.
   */
  line: string;
}

/**
 * Read one finished meeting's notes and act on what they say.
 *
 * Returns the reading so the caller can put it in its own line, and so a test
 * can assert on it without reading a log.
 */
export function runNotesQualityPass(
  deps: NotesQualityPassDeps,
  meeting: { docId: string; meetingId: string; docTitle?: string },
): NotesQualityPassResult {
  const { docId, meetingId } = meeting;
  const now = deps.now?.() ?? Date.now();

  const notes = readSectionMarkdown(
    deps.docStore(),
    docId,
    deps.headingIdOf(docId, meetingId),
    deps.priorBlocks?.(docId, meetingId),
  );
  let transcript: SpokenTurn[] = [];
  if (deps.dataDir !== undefined) {
    try {
      transcript = readTranscript(deps.dataDir, docId, meetingId);
    } catch {
      transcript = [];
    }
  }
  const waits = deps.dataDir === undefined ? null : readTickWaits(deps.dataDir, docId, meetingId);
  const report = buildNotesQualityReport({
    notes,
    transcript,
    voices: voicesOf(deps.dataDir, docId, meetingId, transcript),
    ...(waits !== null ? { waits } : {}),
  });

  let stored = false;
  if (deps.dataDir !== undefined) {
    stored = writeNotesQuality(deps.dataDir, notesQualityRecord(docId, meetingId, report, now));
  }

  const workspaceId = deps.boardOf?.(docId);
  let filing: NotesQualityFiling = { filed: false, reason: 'healthy' };
  if (report.flags.length > 0) {
    const board = deps.board?.();
    filing = board
      ? fileNotesQualityReview(board, deps.actor, {
          workspaceId,
          docId,
          ...(meeting.docTitle !== undefined ? { docTitle: meeting.docTitle } : {}),
          report,
        })
      : { filed: false, reason: 'no-board' };
  }

  return { report, filing, stored, line: passLine(report, filing, workspaceId) };
}

/**
 * The half of the end-of-meeting line this pass owns: the counts, and — for a
 * meeting that went past a bar — what it went past and where the item went.
 *
 * A meeting that files nothing says so with the counts alone. "Not filed"
 * appears only when something SHOULD have been filed and was not, because
 * that is a failure of this path rather than a property of the meeting, and
 * printing it on every healthy meeting would train a reader to skip it.
 */
export function passLine(
  report: NotesQualityReport,
  filing: NotesQualityFiling,
  workspaceId: string | undefined,
): string {
  const counts = notesQualityLogLine(report);
  if (report.flags.length === 0) return counts;
  const where = filing.filed
    ? `filed on ${
        workspaceId !== undefined ? filedItemLink(workspaceId, filing.taskId) : filing.taskId
      }`
    : `NOT filed (${filing.reason}${
        'message' in filing && filing.message !== undefined ? `: ${filing.message}` : ''
      })`;
  return `${counts}; BAD — ${report.flags.map((f) => f.text).join('; ')}; ${where}`;
}
