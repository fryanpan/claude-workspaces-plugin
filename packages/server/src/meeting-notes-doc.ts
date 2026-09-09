/**
 * Where composed meeting notes LAND: the block-addressed edits a tick
 * produced, applied to the meeting's own doc, plus the server-side glue that
 * joins the composer to the doc and the project to the composer.
 *
 * THE WRITE GOES THROUGH `DocStore.applyBlockEdits`, THE SAME VERB EVERY OTHER
 * AGENT USES. Not the filesystem — a meeting doc is a live bound doc and a
 * file write would be clobbered by the next flush — and no longer a private
 * merge of its own either. The note-taker is an agent editing a doc with the
 * operations the MCP block tools and the HTTP edit routes call; it has no
 * pathway nobody else has.
 *
 * THE SECTION IS NOT FOUND BY ITS HEADING TEXT ANY MORE, AND THAT IS THE FIX.
 * It used to be re-located per write by searching for a heading reading
 * "Meeting notes". A person renaming that heading orphaned the section, so the
 * next tick found none and opened a SECOND one below the first — one of the
 * four failures a real meeting produced. The session remembers the BLOCK ID of
 * the heading it opened, learned from the outline after its first batch lands.
 * An id survives a rename, so the rename is now a non-event.
 *
 * Authorship, not a ledger, decides what may be replaced. `applyBlockEdits`
 * writes directly into a block still marked as this agent's, and turns an edit
 * naming anything else into a suggestion — including one of the agent's own
 * blocks that a person has since touched, because the doc clears the mark the
 * moment they do (`clearAuthorshipOnPersonEdit`). The ownership ledger, the
 * merge planner and the ledger's file on disk all existed to answer that
 * question from beside the doc, and could lose track of a block the browser
 * re-created. They are gone.
 *
 * A RENAME REWRITES THE NOTES ALREADY WRITTEN, and does it as a TARGETED
 * replacement rather than a re-compose (owner, 2026-08-29: "rewrite them" — he
 * does not want the same person reading as "Speaker B" above a rename and by
 * name below it). `relabelNotesSection` and `retagSpeakerInNotes` in
 * `notes-speaker-tags.ts` change only the tokens this agent wrote, in place,
 * in blocks it still owns. A two-word correction must cost no more than two
 * words: expressed as block edits it would re-create every bullet it touched
 * and take the reader's comment anchors with them.
 *
 * A SPOKEN CORRECTION IS THE SAME SHAPE AND A DIFFERENT SUBJECT. "No, I said
 * Thursday" fixes the WORDS of a note rather than the name of a voice, and it
 * arrives from the capture pass rather than from a gesture — but it is the
 * same targeted in-place edit (`applyNotesCorrection`). What it adds is the
 * question a rename never has to ask: whose note is this? A rename sweeps only
 * names the agent itself wrote; a correction changes what a note SAYS, so it
 * may rewrite only the agent's own and must propose on anybody else's. That
 * resolution lives in `meeting-notes-correction.ts`.
 *
 * AND THE ENGINE'S OWN LATE CORRECTION IS A THIRD KIND OF EDIT.
 * `reattributeNotesSection` does not change a name; it moves a MENTION from
 * one voice to another, because AssemblyAI's end-of-session pass decided a
 * turn belonged to somebody else. Which mentions move is read off each tag's
 * own provenance rather than off the voice.
 */

import { contentKind } from '@claude-workspaces/core';
import type { prose } from '@claude-workspaces/core';
import { readRenamedEnv } from '@claude-workspaces/core/env-names';
import { docLookupUrl } from './meeting-lookup.ts';
import { NOTES_OUTLINE_RECENT_BLOCKS } from './meeting-notes-composer.ts';
import { correctNotesSection } from './meeting-notes-correction.ts';
import {
  type MeetingNotesDeps,
  type MeetingNotesOptions,
  type NotesCorrection,
  type NotesCorrectionResult,
  type NotesProjectContext,
  type NotesReattribution,
  type NotesRelabel,
  type NotesUpdate,
} from './meeting-notes.ts';
import {
  type ResearchFiled,
  type ReviewAsk,
  type TaskCaptureBoard,
  type TaskCaptureLookup,
  normalizedTitle,
  runTaskCapture,
  taskCaptureUrl,
} from './meeting-task-capture.ts';
import { meetingTimingPath } from './meetings.ts';
import {
  NOTES_AUTHOR_ID,
  type NotesDocStore,
  applyNotesBlockEdits,
  readNotesOutline,
  releaseNotesAuthorship,
} from './notes-doc-access.ts';
import { type NotesHeadingStore, createNotesHeadingFileStore } from './notes-heading-store.ts';
import {
  LEGACY_TRANSCRIPT_HEADING,
  dropLegacyTranscriptSection,
} from './notes-legacy-transcript.ts';
import { type NoteReference, referenceDate } from './notes-references.ts';
import { appendResearchPlaceholder } from './notes-research-placeholder.ts';
import {
  reattributeNotesSection,
  relabelNotesSection,
  retagSpeakerInNotes,
} from './notes-speaker-tags.ts';
import { createNotesTimingLog } from './notes-timing.ts';

export { type NotesDocStore, MEETING_NOTES_HEADING } from './notes-doc-access.ts';
export {
  type RelabelNotesResult,
  reattributeNotesSection,
  relabelNotesSection,
  retagSpeakerInNotes,
} from './notes-speaker-tags.ts';
export { appendResearchPlaceholder } from './notes-research-placeholder.ts';
/** Enough names to inform the composer; few enough that a thousand-row board
 *  cannot flood the prompt. */
const MAX_CONTEXT_TASKS = 30;

/**
 * How much of the board the per-tick reference search may scan.
 *
 * Far larger than `MAX_CONTEXT_TASKS`, and for the opposite reason: nothing
 * here reaches the prompt unless a tick's words named it, so the cost of a
 * big catalogue is a string scan rather than tokens. The cap exists only so
 * a board nobody has ever archived cannot turn one tick into a linear walk of
 * ten thousand rows.
 */
const MAX_REFERENCE_ROWS = 500;

/**
 * How much of one row's prose the loose matcher may read.
 *
 * The catalogue is assembled once per meeting and held for its length, so
 * this is the only number keeping that read proportional to the meeting
 * rather than to the board. Generous against what the scorer can use: its
 * body signal is at full strength once four of the request's words appear,
 * and four content words arrive long before a thousand characters do.
 */
const MAX_REFERENCE_BODY_CHARS = 1_000;

/** The slice of `TaskStore` the context gatherer needs. `id` is here for the
 *  reference catalogue, which needs a URL and not only a name. */
export interface NotesContextTasks {
  listTasks(workspaceId: string): Array<{
    id?: string;
    title: string;
    status: string;
    kind?: 'task' | 'goal';
    /** The row's prose. Read by the loose matcher only — a spoken
     *  description matches what somebody wrote in the ticket far more often
     *  than the few words of its title. */
    body?: string;
  }>;
}

/**
 * Which heading each meeting doc's notes are under, by BLOCK ID.
 *
 * THIS IS THE WHOLE OF WHAT REPLACED THE OWNERSHIP LEDGER'S SECTION HALF, and
 * it is one map from a meeting's ids to a block id. The ledger existed to answer "which
 * section is mine, and which lines in it may I replace"; the second half is an
 * attribute on the block now, and the first is this.
 *
 * WHY A REMEMBERED ID AND NOT A LOOKUP. Every other way of finding the section
 * again is a guess a person can invalidate. Heading TEXT was the shipped
 * answer, and a person renaming the heading made the next tick open a second
 * "Meeting notes" below theirs. AUTHORSHIP cannot do it either — precisely
 * because a rename CLEARS `cwAuthor` on the heading, so the heading a person
 * has just retitled stops being marked as the agent's while remaining the
 * section the agent is writing into. A block id changes under neither, so the
 * memory of it is what makes a rename a non-event.
 *
 * PER DOC **AND** PER MEETING. A new recording opens its own section below
 * whatever the last one wrote — the owner's 2026-08-31 rule that a
 * stop-and-restart never replaces what is already written.
 *
 * AND IT IS NO LONGER MEMORY ONLY. It used to be: a restarted server
 * remembered no heading and opened a new section on its first tick, so a
 * lunchtime deploy split one conversation across two `Meeting notes`
 * headings. The id is written beside the meeting's own transcript now
 * (`notes-heading-store.ts`), and the map in front of it is a cache. Keying
 * on the meeting is what keeps the two cases apart: an id the store already
 * knows belongs to the recording that opened it, and a new recording carries
 * a new id no record answers to.
 */
/** What a heading memory is keyed by. Both halves are load-bearing — see the
 *  `NotesHeadingMemory` note on cross-wiring. */
export interface NotesMeetingIds {
  docId: string;
  meetingId: string;
}

export interface NotesHeadingMemory {
  /**
   * The heading this meeting is writing under, or `undefined` when it has
   * none yet — a meeting that has not ticked, or one whose heading a person
   * has DELETED, which are the two cases that should open a section.
   *
   * Checked against the outline every time rather than trusted: a remembered
   * id whose block is gone is worse than no memory, because every edit
   * addressed to it would fail with `unknown-block` for the rest of the
   * meeting.
   */
  headingId(ids: NotesMeetingIds, outline: readonly prose.OutlineEntry[]): string | undefined;
  /**
   * Learn the heading a batch just opened: the one heading in `after` that was
   * not in `before` and that this agent wrote.
   *
   * Level-capped at 2, because the topic headings a tick writes under the
   * section (`### Export dialog`) are the agent's own and new as well. The
   * section heading is the level-2 one.
   */
  learn(
    ids: NotesMeetingIds,
    before: readonly prose.OutlineEntry[],
    after: readonly prose.OutlineEntry[],
  ): void;
  /** This meeting is (re)starting: forget whatever it remembered, so it opens
   *  its own section. Another meeting's memory of the same doc is untouched —
   *  that is the whole reason the key carries the meeting id. */
  beginMeeting(ids: NotesMeetingIds): void;
}

/** The level a meeting's own section heading is written at. Deeper headings
 *  under it are topics, which the agent also writes and which must never be
 *  mistaken for the section. */
const NOTES_HEADING_LEVEL = 2;

export function createNotesHeadingMemory(store?: NotesHeadingStore): NotesHeadingMemory {
  // KEYED BY DOC **AND** MEETING. Keyed by doc alone, two recordings into one
  // doc cross-wired: the second one's `beginMeeting` wiped the first one's
  // memory, so the first one's next tick either adopted the second's heading
  // or opened a third section under a doc that already had two.
  //
  // The map is now a CACHE over `store`, which keeps the same fact beside the
  // meeting's transcript. Without one the memory behaves exactly as it did:
  // remembered for the life of the process and no longer.
  const byMeeting = new Map<string, string>();
  const keyOf = ({ docId, meetingId }: NotesMeetingIds): string => `${docId}::${meetingId}`;
  const present = (id: string, outline: readonly prose.OutlineEntry[]): boolean =>
    outline.some((e) => e.id === id && e.kind === 'heading');
  /** What this meeting is writing under, reading through to the store on a
   *  cache miss — which is every read of the first tick after a restart. */
  const remembered = (ids: NotesMeetingIds): string | undefined => {
    const key = keyOf(ids);
    const held = byMeeting.get(key);
    if (held !== undefined) return held;
    const stored = store?.read(ids);
    if (stored !== undefined) byMeeting.set(key, stored);
    return stored;
  };
  /** Forget it in both places. Used only where the heading is GONE from the
   *  doc: a remembered id whose block no longer exists would fail every edit
   *  addressed to it for the rest of the meeting. */
  const forget = (ids: NotesMeetingIds): void => {
    byMeeting.delete(keyOf(ids));
    store?.clear(ids);
  };
  return {
    headingId(ids, outline) {
      const id = remembered(ids);
      if (id === undefined) return undefined;
      if (present(id, outline)) return id;
      forget(ids);
      return undefined;
    },
    learn(ids, before, after) {
      const held = remembered(ids);
      if (held !== undefined && present(held, after)) return;
      const known = new Set(before.map((e) => e.id));
      const opened = after.find(
        (e) =>
          e.kind === 'heading' &&
          !known.has(e.id) &&
          e.author === NOTES_AUTHOR_ID &&
          (e.level ?? NOTES_HEADING_LEVEL) <= NOTES_HEADING_LEVEL,
      );
      if (opened) {
        byMeeting.set(keyOf(ids), opened.id);
        store?.write(ids, opened.id);
      } else if (held !== undefined) forget(ids);
    },
    beginMeeting(ids) {
      // IN MEMORY ONLY, AND THAT IS THE RESTART FIX. A meeting id is minted
      // from the millisecond a recording started, so a session starting under
      // one the store already knows is the SAME recording coming back after a
      // restart — and it must find the section it opened rather than open a
      // second one. A genuinely new recording carries a new id, which no
      // record answers to, so it still gets a section of its own.
      byMeeting.delete(keyOf(ids));
    },
  };
}

/**
 * Docs already reported as keeping a `Raw transcript` section this process.
 * The condition is a property of the DOC, not of the tick, so a meeting that
 * ticks for an hour would otherwise say the same line sixty times.
 */
const legacyKeptReported = new Set<string>();

function noteLegacyKept(docId: string): void {
  if (legacyKeptReported.has(docId)) return;
  legacyKeptReported.add(docId);
  console.log(
    `[meeting-notes] the "${LEGACY_TRANSCRIPT_HEADING}" section in ${docId} is not ` +
      "the old note-taker's, so it stays",
  );
}

/**
 * Why a tick's edits did not reach the doc.
 *
 * NAMED RATHER THAN COUNTED, because "doc write skipped" was for weeks the
 * only thing production said about a meeting whose notes stopped growing —
 * and it covered four unrelated failures at once. `no-doc` is a lookup that
 * came back empty (an evicted or deleted doc); `not-prose` is a doc that is
 * not a notepad; `store-refused` is the store declining the batch outright;
 * `all-edits-failed` is every edit in the batch naming a block that is no
 * longer there. Only the last two are a compose worth retrying, and no
 * amount of reading the old line could tell them apart.
 */
export type NotesWriteSkip = 'no-doc' | 'not-prose' | 'store-refused' | 'all-edits-failed';

/** What a tick's write came to: `null` when it landed, else why it did not. */
export type NotesWriteResult = null | NotesWriteSkip;

/**
 * Write one tick's edits into its meeting doc, through the shared
 * `applyBlockEdits` verb. A skip reason — never a throw — when the doc is
 * gone, is not prose, or the whole batch failed: a meeting on a vanished doc
 * still has its transcript file, and a flat doc is not a notepad.
 */
export function applyNotesUpdate(
  docStore: NotesDocStore,
  update: NotesUpdate,
  heading: NotesHeadingMemory,
  opts: { dataDir?: string } = {},
): NotesWriteResult {
  const doc = docStore.get(update.docId);
  if (!doc) return 'no-doc';
  if (contentKind(doc.meta.type) !== 'prose') return 'not-prose';
  // NO TRANSCRIPT IN THIS DOC (owner, 2026-09-03). A tick used to append the
  // meeting's own words here under `## Raw transcript`. It does not any more:
  // the notes are the shorter record a person has reviewed and edited, and
  // that is what both people and agents should be reading. A transcript is
  // unreviewed raw material, kept only to check exactly who said what and to
  // improve how we transcribe, so it belongs in the `-raw-transcript.md`
  // sister file beside the meeting's data dir. This call takes the section
  // back out of any doc that received one while the writer shipped; those
  // words are in that sister file, which is why removing them loses nothing —
  // and why it removes only the writer's exact fingerprint and never a
  // transcript a person put there themselves.
  const legacy = dropLegacyTranscriptSection(doc.ydoc, {
    boundPath: docStore.boundPathOf?.(update.docId),
    dataDir: opts.dataDir,
  });
  if (legacy === 'kept') noteLegacyKept(update.docId);
  if (update.edits.length === 0) return null;
  // Headings before and after, so the memory can tell the section this batch
  // OPENED from the topic headings it also wrote. Cheap: `headingsOnly` walks
  // the same blocks the batch is about to and returns a handful of entries.
  const before = readNotesOutline(docStore, update.docId, { headingsOnly: true });
  const res = applyNotesBlockEdits(docStore, update.docId, update.edits);
  if (!res.ok) return 'store-refused';
  heading.learn(
    { docId: update.docId, meetingId: update.meetingId },
    before,
    readNotesOutline(docStore, update.docId, { headingsOnly: true }),
  );
  // A batch every one of whose edits failed wrote nothing, and saying so is
  // what reports the skip. A batch that landed some of its edits is a
  // success: the rest reported `unknown-block`, which is the ordinary answer
  // for a block a person deleted mid-compose.
  return res.applied + res.suggested > 0 ? null : 'all-edits-failed';
}

/** What the log says about a skip, beyond its name — the detail whoever is
 *  reading it needs next. Empty when the name is the whole answer. */
export function notesWriteSkipDetail(skip: NotesWriteSkip): string {
  if (skip === 'no-doc') {
    return 'the doc store had no such doc — it was deleted, or evicted while the meeting ran';
  }
  if (skip === 'not-prose') return 'the doc is not a prose doc, so it has nowhere to put notes';
  if (skip === 'store-refused') return 'the store refused the batch outright';
  return 'every edit named a block that is no longer in the doc';
}

/** The doc as the composer addresses it, capped so a tick's prompt is the size
 *  of the recent conversation rather than of the meeting. */
export function readNotesOutlineForTick(
  docStore: NotesDocStore,
  docId: string,
): readonly prose.OutlineEntry[] {
  return readNotesOutline(docStore, docId, { recentBlocks: NOTES_OUTLINE_RECENT_BLOCKS });
}

/**
 * Carry a rename into the notes already written in the meeting's doc.
 * Same tolerances as `applyNotesUpdate`: a doc that has gone away or was
 * never prose is not an error, it is a meeting whose notes are elsewhere.
 * Returns how many mentions moved — zero when the voice was never written
 * about, which is ordinary.
 *
 * TWO PASSES, AND THE ORDER IS NOT ARBITRARY. The tags go first and always:
 * they name the voice by label, so they are right whatever anybody is
 * called. The plain-text sweep runs second and only when the relabel says it
 * may — it is what reaches notes composed before tags existed, and it is
 * also the pass that cannot tell two voices with one name apart. Running it
 * second means a mention that was already retagged is no longer spelled the
 * old way, so the sweep has nothing left to find there and cannot touch it
 * twice.
 */
export function applyNotesRelabel(docStore: NotesDocStore, relabel: NotesRelabel): number {
  const doc = docStore.get(relabel.docId);
  if (!doc) return 0;
  if (contentKind(doc.meta.type) !== 'prose') return 0;
  // NO RECLAIM WRAPPER ANY MORE, AND NONE IS NEEDED. The ledger recorded a
  // line's WORDING, so an in-place rewrite of those words made it stop
  // recognising its own line unless something re-recorded it. Authorship is on
  // the ELEMENT: the rename changes the text inside it and the block is still
  // the agent's afterwards, with no bookkeeping in between.
  //
  // The untagged sweep runs FIRST, and the order is load-bearing. It looks for
  // the old display name on word boundaries, and an extension rename leaves
  // that name inside the new one — retag first and the sweep finds "Devi"
  // inside the "@Devi Raman" it has just written, and makes it "@Devi Raman
  // Raman". Sweeping first, the sweep sees only the old spelling everywhere it
  // appears, and the retag that follows canonicalises every tag for this voice
  // — including any the sweep had no way to reach, and including the ones it
  // has just corrected, where it finds the right text already there and does
  // nothing.
  const swept = relabel.rewriteUntagged
    ? relabelNotesSection(doc.ydoc, relabel.from, relabel.to).replaced
    : 0;
  return swept + retagSpeakerInNotes(doc.ydoc, relabel.label, relabel.to).replaced;
}

/**
 * Carry a spoken correction into the note it fixes.
 *
 * Same tolerances as `applyNotesUpdate` and `applyNotesRelabel`: a doc that
 * has gone away or was never prose is not an error, it is a meeting whose
 * notes are somewhere this cannot reach. `'none'` covers all of those and the
 * ordinary case besides — a correction whose words are in no note.
 *
 * NO RECLAIM WRAPPER AND NO LEDGER — both are gone, and this comment used to
 * describe them. The ledger recorded a line's WORDING, so a correction that
 * rewrote those words in place made the agent stop recognising its own note
 * unless a wrapper re-recorded it. Authorship is an attribute on the ELEMENT
 * now: the correction changes the text inside a block the agent owns and the
 * block is still the agent's afterwards, with no bookkeeping in between.
 * Whose note it is stays the question that decides direct-vs-proposed, and
 * `meeting-notes-correction.ts` answers it from `cwAuthor`.
 */
export function applyNotesCorrection(
  docStore: NotesDocStore,
  correction: NotesCorrection,
): NotesCorrectionResult {
  const doc = docStore.get(correction.docId);
  if (!doc) return 'none';
  if (contentKind(doc.meta.type) !== 'prose') return 'none';
  const outcome = correctNotesSection(doc.ydoc, correction);
  if (outcome.applied === 'revised') return 'revised';
  if (outcome.applied === 'suggested') return 'suggested';
  return 'none';
}

/**
 * Carry the engine's late correction of who spoke into the meeting's doc.
 * Same tolerances as `applyNotesRelabel`, and — like it — no reclaim wrapper:
 * the pass edits text inside blocks the agent owns, and owning a block is an
 * attribute on the block rather than a record of its wording.
 */
export function applyNotesReattribution(
  docStore: NotesDocStore,
  reattribution: NotesReattribution,
): number {
  const doc = docStore.get(reattribution.docId);
  if (!doc) return 0;
  if (contentKind(doc.meta.type) !== 'prose') return 0;
  return reattributeNotesSection(doc.ydoc, reattribution).replaced;
}

/**
 * Wire caller options into the deps a meeting session runs on: the doc write
 * becomes the sink (a caller `onNotes` observes after it), and the context
 * resolver reads the doc's title and its board's open task titles at meeting
 * start — the "informed, not generic" half of the notes agent.
 *
 * `docStore` / `tasks` are thunks because `createServer` builds the relay before
 * either exists; a meeting can only start once both do.
 */
export function withServerNotesSinks(
  options: MeetingNotesOptions,
  deps: {
    docStore: () => NotesDocStore;
    tasks: () => NotesContextTasks;
    /** The store the capture pipeline writes through. A thunk like `tasks`,
     *  and only read when `taskExtractor` is present. */
    captureBoard?: () => TaskCaptureBoard;
    /** Where a "pull that in" ask looks: the board's docs and their past
     *  meetings. Absent, lookups resolve to nothing and the notes are as
     *  they were. */
    lookup?: TaskCaptureLookup;
    /** The lead wake for a captured task judged clear enough to start —
     *  wired to the ready-nudge channel by the server. */
    onTaskReady?: (wake: { workspaceId: string; taskId: string; title: string }) => void;
    /**
     * The board a doc's meeting files onto. A huddle doc has no `setId` —
     * it is HELD by a board workspace, not owned by one — so scoping capture
     * on `meta.setId` alone silently returned nothing for exactly the docs
     * meetings run on. Absent, `meta.setId` is the whole answer.
     */
    boardOf?: (docId: string) => string | undefined;
    /** Observes a research row after the doc's placeholder is written. */
    onResearchFiled?: (filed: ResearchFiled) => void;
    /** Files a spoken review ask the way the Review float's press is filed —
     *  only `createServer` holds the comment + stamp path. Deduped here per
     *  meeting so a question repeated across ticks opens one thread. */
    onReviewAsk?: (ask: ReviewAsk) => void | Promise<void>;
    /** The server's data dir. Read only by the legacy-transcript removal, to
     *  tell a huddle doc from a doc bound into somebody's working tree.
     *  Absent, every BOUND doc is treated as outside it and keeps whatever
     *  `Raw transcript` section it has. */
    dataDir?: string;
    /**
     * Writes the doc ref onto a row somebody asked, out loud, to link — the
     * store half of `onTaskLinked`, which is `TaskStore.linkRef` in the
     * server and a recorder in the tests. Absent, a spoken link still writes
     * its citation into the notes and the row simply gains no backlink.
     */
    linkTaskToDoc?: (taskId: string, docId: string) => void;
    /** Tests: a heading memory they can share across two harnesses to model a
     *  second meeting on one doc. */
    heading?: NotesHeadingMemory;
  },
): MeetingNotesDeps {
  const extractor = options.taskExtractor;
  const captureBoard = deps.captureBoard;
  // One heading memory per wiring, i.e. per server: it is keyed by doc and
  // meeting, and a meeting is the life of one notes section. Backed by the
  // data dir when there is one, so the section survives a restart mid-meeting
  // — a deploy at lunchtime used to leave one conversation under two
  // headings.
  const heading =
    deps.heading ??
    createNotesHeadingMemory(
      deps.dataDir !== undefined ? createNotesHeadingFileStore(deps.dataDir) : undefined,
    );
  const boardOf = (docId: string): string | undefined => {
    const doc = deps.docStore().get(docId);
    return doc?.meta.setId ?? deps.boardOf?.(docId);
  };
  // Review asks already filed this meeting, by normalized question. The
  // capture's own dedupe covers a request seen twice in one tick's window;
  // this covers "ask the team whether X" said again ten minutes later.
  const reviewAsked = new Map<string, Set<string>>();
  // The cue lines each meeting has already spent, by turn number. One cue is
  // one ask: without this the marked overlap would show the previous tick's
  // "Claude, can you …" again and let it license whatever the doc happened
  // to be talking about next. Cleared with the rest of the per-meeting state
  // in onSessionStart, because turn numbering restarts with the recording.
  const spentCues = new Map<string, Set<number>>();
  const spentCuesFor = (docId: string): Set<number> => {
    let set = spentCues.get(docId);
    if (!set) {
      set = new Set<number>();
      spentCues.set(docId, set);
    }
    return set;
  };
  const captureIntents: MeetingNotesDeps['captureIntents'] =
    options.captureIntents ??
    (extractor && captureBoard
      ? async ({ docId, turns, priorTurns }) => {
          // The doc's board is the capture's scope: a meeting on a doc no
          // workspace owns or holds has no board to find or create on.
          const doc = deps.docStore().get(docId);
          const workspaceId = boardOf(docId);
          if (!doc || !workspaceId) return { tasks: [], docs: [] };
          return runTaskCapture(
            {
              board: captureBoard(),
              extractor,
              ...(deps.lookup ? { lookup: deps.lookup } : {}),
              ...(deps.onTaskReady ? { onTaskReady: deps.onTaskReady } : {}),
              onResearchFiled: (filed) => {
                const wrote = appendResearchPlaceholder(
                  deps.docStore(),
                  filed.docId,
                  filed.title,
                  filed.url,
                );
                if (!wrote.ok && wrote.error !== 'not-found') {
                  console.error(`[meeting-tasks] research placeholder failed: ${wrote.error}`);
                }
                deps.onResearchFiled?.(filed);
              },
              ...(deps.onReviewAsk
                ? {
                    onReviewAsk: async (ask: ReviewAsk) => {
                      const key = normalizedTitle(ask.question);
                      let seen = reviewAsked.get(ask.docId);
                      if (!seen) {
                        seen = new Set();
                        reviewAsked.set(ask.docId, seen);
                      }
                      if (seen.has(key)) return;
                      seen.add(key);
                      await deps.onReviewAsk?.(ask);
                    },
                  }
                : {}),
              onError: (message) => console.error(`[meeting-tasks] ${message}`),
            },
            {
              workspaceId,
              docId,
              ...(doc.meta.title !== undefined ? { docTitle: doc.meta.title } : {}),
              turns,
              priorTurns,
              spentCues: spentCuesFor(docId),
            },
          );
        }
      : undefined);
  return {
    ...options,
    ...(captureIntents ? { captureIntents } : {}),
    // NOTHING SUPPLIED THIS BEFORE, so every compose failure the pipeline
    // reported went nowhere — including the one that matters most, a reply
    // refused for running past the composer's output ceiling. Those ticks are
    // the notes falling behind a long meeting, and they were invisible in
    // production while the eval was measuring them at about a tenth of ticks.
    // A caller that wants its own handling still gets it: theirs runs too.
    onError: (message): void => {
      console.error(`[meeting-notes] ${message}`);
      options.onError?.(message);
    },
    // ONE LINE PER MEETING, and the reason it exists is that there were
    // none. A meeting reported as "skipping chunks" left nothing in the log
    // to check the claim against: the pipeline spoke only when a stage threw,
    // so a meeting whose notes quietly covered half of what was said read
    // exactly like a healthy one. This is the coverage, stated at the stop.
    onMeetingSummary: (summary): void => {
      const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`;
      const line =
        `[meeting-notes] ${summary.docId} meeting ${summary.meetingId}: ` +
        `${plural(summary.ticks, 'tick')} over ${plural(summary.turnsSettled, 'settled turn')}, ` +
        `${plural(summary.turnsLost, 'turn')} in no note` +
        (summary.composeFailures > 0
          ? `, ${plural(summary.composeFailures, 'failed compose')}`
          : '') +
        // The number Bryan actually feels, when the meeting was measured.
        (summary.latencyMedianMs !== undefined
          ? `, settled-to-written median ${Math.round(summary.latencyMedianMs)}ms / worst ` +
            `${Math.round(summary.latencyWorstMs ?? summary.latencyMedianMs)}ms`
          : '');
      // Only a meeting that actually lost words is an error. A clean one is
      // still logged, because the absence of a line is not evidence that a
      // meeting went well — it is evidence that nothing was written down.
      if (summary.turnsLost > 0) console.error(line);
      else console.log(line);
      options.onMeetingSummary?.(summary);
    },
    // TIMING IS ON WHENEVER THERE IS A DATA DIR TO WRITE IT IN. It was
    // opt-in, on the reasoning that a measurement nobody asked for is still a
    // file in Bryan's data dir — but the file has a reader now (the at-stop
    // quality report scores how late the notes landed from it), and a
    // measurement that is only there when somebody remembered to ask for it
    // cannot be read by anything. It holds counts and durations and no words,
    // so it is as private as the empty directory it sits in.
    // `CW_NOTES_TIMING=0` turns it off; the replay harness and the tick
    // harness pass their own log instead.
    ...(readRenamedEnv(process.env, 'CW_NOTES_TIMING') !== '0' && deps.dataDir !== undefined
      ? {
          openTiming: (ids: { docId: string; meetingId: string }) =>
            createNotesTimingLog({
              path: meetingTimingPath(deps.dataDir ?? '', ids.docId, ids.meetingId),
            }),
        }
      : {}),
    onSessionStart: (ids): void => {
      // A new recording on this doc: whatever the previous one wrote is
      // FINISHED, and this recording may not rewrite it.
      //
      // Two things make that true, and forgetting the heading id was only the
      // first. `NOTES_AUTHOR_ID` is one constant for every meeting, so without
      // the release meeting two reads meeting one's bullets as its own — the
      // note-taking prompt explicitly invites deleting your own bullets when
      // regrouping a topic, and `applyBlockEdits` applies that directly. That
      // is a hard delete of notes a person has already read, against the
      // project-wide never-hard-delete rule. Releasing the claim leaves the
      // blocks exactly where they are and turns any edit naming one into a
      // SUGGESTION, which is the reviewable form.
      //
      // Per DOC, deliberately: the claim is per author and the author id is
      // shared, so there is nothing meeting-shaped to release. The heading
      // memory below is per meeting because a section IS meeting-shaped. Two
      // concurrent recordings on one doc therefore keep separate sections
      // while each loses direct-edit rights on its own bullets when the other
      // starts — the safe direction, and the same one a restarted server
      // lands in.
      releaseNotesAuthorship(deps.docStore(), ids.docId);
      heading.beginMeeting(ids);
      reviewAsked.delete(ids.docId);
      spentCues.delete(ids.docId);
      options.onSessionStart?.(ids);
    },
    resolveContext: (docId: string): NotesProjectContext | undefined => {
      const gathered: NotesProjectContext = {};
      try {
        const doc = deps.docStore().get(docId);
        if (doc?.meta.title) gathered.docTitle = doc.meta.title;
        const workspaceId = boardOf(docId);
        if (workspaceId) {
          gathered.workspaceId = workspaceId;
          const titles = deps
            .tasks()
            .listTasks(workspaceId)
            .filter((t) => t.kind !== 'goal' && t.status !== 'done')
            .slice(0, MAX_CONTEXT_TASKS)
            .map((t) => t.title);
          if (titles.length > 0) gathered.taskTitles = titles;
        }
      } catch (err) {
        // Context is an enhancement to the notes, never a dependency: a
        // store that cannot answer must not cost the meeting its notes.
        console.error('[meeting-notes] context gather failed:', err);
      }
      // Caller-supplied context wins field-by-field: whoever wired the
      // server said something more specific than what we can gather.
      const supplied = options.resolveContext?.(docId) ?? options.context;
      const merged = { ...gathered, ...supplied };
      return Object.keys(merged).length > 0 ? merged : undefined;
    },
    /**
     * The board this meeting could cite: every open row and every doc the
     * board holds, each with the URL a note would link.
     *
     * Rows the board has already finished are IN — "we shipped the balloons
     * ticket last week" is exactly the sentence whose link a reader wants,
     * and a done row is still the thing that was named. Goals are out: a goal
     * is a heading over the work rather than a thing a note is about, and its
     * words ("live meeting notes") are the words half the meeting uses.
     *
     * Never throws. A store that cannot answer costs the notes their links,
     * the same way a store that cannot answer costs them their context.
     */
    resolveReferences: (docId: string): readonly NoteReference[] => {
      const out: NoteReference[] = [];
      try {
        const workspaceId = boardOf(docId);
        if (!workspaceId) return out;
        for (const task of deps.tasks().listTasks(workspaceId)) {
          if (out.length >= MAX_REFERENCE_ROWS) break;
          if (task.kind === 'goal' || !task.id || !task.title) continue;
          out.push({
            kind: 'task',
            id: task.id,
            title: task.title,
            url: taskCaptureUrl(workspaceId, task.id),
            // Clipped: a catalogue of five hundred whole ticket bodies is the
            // one way this per-session read could grow with the board rather
            // than with the meeting, and the scorer saturates long before a
            // body runs out of words.
            ...(task.body ? { body: task.body.slice(0, MAX_REFERENCE_BODY_CHARS) } : {}),
          });
        }
        // The meeting's own doc is excluded for the reason the lookup
        // excludes it: a note citing the page it is written on is a link to
        // itself, and the reader is already there.
        for (const doc of deps.lookup?.docs(workspaceId, docId) ?? []) {
          if (out.length >= MAX_REFERENCE_ROWS) break;
          out.push({
            kind: 'doc',
            id: doc.docId,
            title: doc.title,
            url: docLookupUrl(workspaceId, doc.docId),
            ...(doc.meetingAt !== undefined ? { when: referenceDate(doc.meetingAt) } : {}),
          });
        }
      } catch (err) {
        console.error('[meeting-notes] reference catalogue failed:', err);
      }
      return out;
    },
    readOutline: (ids: { docId: string; meetingId: string }): readonly prose.OutlineEntry[] => {
      try {
        return readNotesOutlineForTick(deps.docStore(), ids.docId);
      } catch (err) {
        // An outline we cannot read costs the compose its awareness of the
        // doc, never its notes: it opens a section and appends.
        console.error('[meeting-notes] outline read failed:', err);
        return [];
      }
    },
    notesHeadingId: ({ docId, meetingId, outline }): string | undefined =>
      heading.headingId({ docId, meetingId }, outline),
    onNotes: (update: NotesUpdate): boolean => {
      let landed = true;
      try {
        const skip = applyNotesUpdate(deps.docStore(), update, heading, {
          ...(deps.dataDir ? { dataDir: deps.dataDir } : {}),
        });
        if (skip !== null) {
          landed = false;
          // The reason, the doc, the meeting and the tick. The line this
          // replaces named only the doc, so a meeting whose notes stopped
          // could not be told from a doc that had been deleted.
          console.error(
            `[meeting-notes] doc write skipped for ${update.docId} meeting ` +
              `${update.meetingId} tick ${update.tick.tick} (${update.edits.length} ` +
              `edit${update.edits.length === 1 ? '' : 's'}): ${skip} — ${notesWriteSkipDetail(skip)}`,
          );
        }
      } catch (err) {
        // A throw is a broken sink rather than a refused write, and the words
        // DID compose. Contained, and reported as a skip so the tick's words
        // are carried instead of vanishing.
        landed = false;
        console.error('[meeting-notes] doc write failed:', err);
      }
      options.onNotes?.(update);
      return landed;
    },
    onRelabel: (relabel: NotesRelabel): void => {
      try {
        applyNotesRelabel(deps.docStore(), relabel);
      } catch (err) {
        // A rename that cannot reach the doc leaves a stale label, which is
        // a blemish; letting it reach the compose chain as a rejection would
        // cost the meeting its next notes, which is not.
        console.error('[meeting-notes] relabel failed:', err);
      }
      options.onRelabel?.(relabel);
    },
    onCorrection: (correction: NotesCorrection): NotesCorrectionResult => {
      try {
        const result = applyNotesCorrection(deps.docStore(), correction);
        options.onCorrection?.(correction);
        return result;
      } catch (err) {
        // A correction that cannot reach the doc leaves a note reading the
        // way the doc already said it does not; letting the throw reach the
        // compose chain would cost the meeting its next notes, which is
        // worse. Same containment as the relabel above.
        console.error('[meeting-notes] correction failed:', err);
        return 'none';
      }
    },
    onTaskLinked: (link): void => {
      try {
        deps.linkTaskToDoc?.(link.taskId, link.docId);
      } catch (err) {
        // The note already carries the link; what fails here is the row's
        // backlink. Contained on the same terms as every other sink — a
        // throw reaching the compose chain would cost the meeting its notes.
        console.error('[meeting-notes] task link failed:', err);
      }
      options.onTaskLinked?.(link);
    },
    onReattribute: (reattribution: NotesReattribution): void => {
      try {
        applyNotesReattribution(deps.docStore(), reattribution);
      } catch (err) {
        // Same containment as the relabel above: an attribution left stale
        // is a blemish, and a rejection reaching the compose chain would
        // cost the meeting its next notes.
        console.error('[meeting-notes] reattribution failed:', err);
      }
      options.onReattribute?.(reattribution);
    },
  };
}
