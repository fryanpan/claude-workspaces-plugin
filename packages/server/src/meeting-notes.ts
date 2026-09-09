/**
 * Meeting notes on two clocks: the quiet detector, the cadence ceiling, the
 * composer seam, and the per-meeting session that joins them.
 *
 * WHY A PAUSE IS THE UNIT. Notes composed per turn would interrupt a thought
 * mid-argument; notes composed at the end would arrive after the meeting they
 * were for. A pause in speech is the moment a human note-taker writes, so the
 * detector watches the transcript stream — EVERY frame, partials included,
 * because a partial is speech in progress and therefore evidence there is no
 * pause — and fires only when the stream has been quiet for the threshold.
 *
 * WHY A PAUSE IS NOT THE ONLY UNIT (owner, 2026-08-30: "waits too long to
 * update notes"). Every frame REPLACES the quiet countdown, so a conversation
 * where nobody stops for the threshold never fires one — and the meeting that
 * most needs notes, the one where people are talking without a break, was
 * exactly the meeting that produced nothing until it ended. The cadence timer
 * is the ceiling on that: it starts when the first unwritten sentence settles
 * and is NOT reset by speech, so no finished sentence waits longer than
 * `cadenceMs` to reach the doc. The two clocks are additive and whichever
 * expires first fires the tick.
 *
 * WHY A CADENCE TICK CARRIES ONLY SETTLED TURNS. The words still in flight
 * are a partial, and this engine's partials are UNFORMATTED — no punctuation,
 * no sentence casing, which arrive only when the turn settles (see
 * `format_turns` in the architecture summary). So there is no such thing as a
 * finished sentence inside a partial to cut at: a settled turn IS the unit of
 * finished speech, and the turn being spoken waits for the next tick rather
 * than being written mid-clause.
 *
 * WHY THE COMPOSER IS A SEAM WITH NO DEFAULT. The real composer is an LLM
 * call; same rule as `transcribe.ts` and the summarizer — `createServer` must
 * be constructible without anything that can reach the network. Only the
 * caller that starts the real server wires a real composer; tests wire the
 *
 * deterministic stub below.
 *
 * WHY THE COMPOSER RETURNS SCOPED EDITS, NOT THE WHOLE NOTES. It used to
 * return the whole section every tick, which made three things true at once:
 * the reply grew with the MEETING rather than with the tick (so late ticks
 * were refused for length), every tick rewrote lines nobody had said anything
 * about, and the merge that landed the result had to work out which of its
 * own bullets these were. Blocks carry ids now (`prose-outline.ts`), so a
 * tick reads the doc's OUTLINE and answers with a handful of edits addressed
 * to it. Revising is still possible — `replace_block` is one of the four ops
 * — and it costs one bullet rather than a section.
 *
 * THERE IS NO SESSION MIRROR OF THE NOTES. `previous` used to be this
 * module's own copy of what it had written, kept true through renames and
 * reattributions so the next compose could be handed it. The doc is the only
 * state now: every tick reads the outline back, so a person's edit, another
 * agent's edit and this session's own last write all arrive by the same door.
 *
 * NOTHING HERE RIDES SSE. A tick per pause is word-rate-adjacent; ticks and
 * composed notes go to the injected `onNotes` sink only, and the stage that
 * writes them into the doc decides delivery (the CRDT, not the event bus).
 */

import { normalizeSpeakerTags, speakerDisplayName } from '@claude-workspaces/core';
import type { prose } from '@claude-workspaces/core';
import { MEETING_NOTES_HEADING } from './notes-doc-access.ts';
import { type IdeaCoverage, createIdeaLedger } from './notes-idea-coverage.ts';
import { appendSuggestions, resolveNoteLinks, suggestionLabel } from './notes-link-intent.ts';
import { type NoteReference, matchReferences } from './notes-references.ts';
import {
  type NotesComposeMeasure,
  type NotesTickTiming,
  type NotesTimingLog,
  median,
} from './notes-timing.ts';
import {
  DEFAULT_NOTES_CADENCE_MS,
  DEFAULT_NOTES_ENDPOINT_CONFIRM_MS,
  DEFAULT_NOTES_QUIET_MS,
  type NotesTick,
  type TickScheduler,
  createPauseTicker,
} from './pause-ticker.ts';
import type { EngineTurn } from './transcribe.ts';

/**
 * The two clocks moved to `pause-ticker.ts`; every name they were read by
 * stays on this module's surface.
 */
export {
  type NotesTick,
  type NotesTickReason,
  type PauseTicker,
  type PauseTickerOpts,
  type TickScheduler,
  DEFAULT_NOTES_CADENCE_MS,
  DEFAULT_NOTES_ENDPOINT_CONFIRM_MS,
  DEFAULT_NOTES_QUIET_MS,
  createPauseTicker,
  realTickScheduler,
  wordsAfter,
  wordsOf,
} from './pause-ticker.ts';

export type { NoteReference } from './notes-references.ts';

/**
 * What a whole meeting's notes came to: how much of what was said reached
 * them, and how much did not.
 *
 * `turnsLost` is the number the report is about. It counts turns the engine
 * settled that no successful compose ever carried — words in the transcript
 * and in no note. Zero is the healthy state and the usual one; anything else
 * names how much of the meeting the notes are missing.
 */
export interface NotesMeetingSummary {
  docId: string;
  meetingId: string;
  /** Ticks that fired, the final pass included. */
  ticks: number;
  /** Distinct turns the engine settled during the meeting. */
  turnsSettled: number;
  /**
   * Distinct turns a successful compose carried. It can exceed
   * `turnsSettled` by one: the final pass carries the sentence that was
   * still being spoken, which by definition never settled.
   */
  turnsComposed: number;
  /** Settled turns no successful compose ever carried. The number the
   *  "the notes skipped chunks" report is about. */
  turnsLost: number;
  /**
   * What the NOTES kept, as opposed to what the composer was shown.
   *
   * `turnsLost` can be zero while a minute of conversation produced no note
   * at all — every turn reached a compose and the compose wrote nothing. That
   * is the failure a reader of the notes actually meets, so it is counted
   * separately: ideas seen in the settled speech, ideas the notes were found
   * to carry, ideas re-sent once because the first attempt produced no note,
   * and ideas still missing after that. See `notes-idea-coverage.ts` for what
   * an idea is and why the check is lexical.
   */
  ideas: IdeaCoverage;
  composeFailures: number;
  refusedTooLong: number;
  /**
   * THE LATENCY, when the meeting was measured: milliseconds from a
   * sentence settling to its note being in the doc, median and worst over
   * every tick that produced one. Absent when timing was off — which is the
   * default, and is why they are optional rather than zero.
   */
  latencyMedianMs?: number;
  latencyWorstMs?: number;
}

/** One settled turn as a tick's delta carries it. */
export interface NotesTurn {
  turn: number;
  text: string;
  /**
   * Who said it. Out of the ticker this is the engine's label (`"A"`); by
   * the time a composer sees it the session has turned it into what the
   * person calls that voice — their name, or "Speaker A" until named.
   */
  speaker?: string;
  /**
   * The engine's own label for that voice, kept beside the display name from
   * the moment the session maps one to the other.
   *
   * The name is what a reader recognises and the label is what survives
   * being renamed, so the notes need both: the tag the composer writes shows
   * the name and CARRIES the label (`[@Devi](speaker:B)`), which is what
   * lets a later rename find every mention of that voice without searching
   * for a string that two voices might share. Absent on the way out of the
   * ticker, where `speaker` IS the label.
   */
  speakerLabel?: string;
  /**
   * This turn was still being spoken when the meeting stopped.
   *
   * Set on the `end` tick and nowhere else. The text is the engine's last
   * partial: unformatted, unpunctuated, and possibly cut mid-word. It is
   * carried anyway because the alternative is losing the last thing said —
   * and it is FLAGGED so the composer is told what it is holding rather
   * than reading a fragment as a finished sentence.
   *
   * Set on a CEILING tick too, where it means the same thing for the same
   * reason: the words are the engine's own already-final tokens inside a
   * sentence nobody has finished saying.
   */
  partial?: boolean;
  /**
   * The words before these ones already went out on an earlier tick.
   *
   * A ceiling tick carries the finished part of a long turn, so what arrives
   * later is the REST of a sentence whose opening is already in the notes.
   * Saying so is what stops a reader of this seam — the timing report, a
   * future prompt — treating the fragment as the start of a new thought.
   */
  continued?: boolean;
}

/**
 * What the composer may know about the project the meeting belongs to, so
 * the notes are informed rather than generic. Filled in by the stage that
 * builds the real composer; the shape exists now so the seam carries it.
 */
export interface NotesProjectContext {
  /** Root of the repo the meeting's doc belongs to. */
  repoRoot?: string;
  /** Docs worth reading before summarizing this project's meetings. */
  docPaths?: readonly string[];
  /** The workspace whose board names the work being discussed. */
  workspaceId?: string;
  /** The meeting doc's own title — the closest thing to a meeting subject. */
  docTitle?: string;
  /** Open board task titles — the names of the work under discussion, so the
   *  composer can hear "the balloons ticket" and know what that is. */
  taskTitles?: readonly string[];
}

/** A board task captured from this tick's speech — found or freshly filed —
 *  offered to the composer as a markdown link it may weave into the notes.
 *  Shaped here because this seam carries it; the capture pipeline that
 *  produces them lives in `meeting-task-capture.ts`. */
export interface NoteTaskLink {
  title: string;
  url: string;
  status: string;
}

/**
 * Material this tick's speech asked to have pulled in — a doc, or the notes
 * of an earlier meeting — already found, and offered to the composer as a
 * link it may cite. Resolution lives in `meeting-lookup.ts`.
 */
export interface NoteDocLink {
  title: string;
  url: string;
  /** When the meeting behind it was, in the speaker's own frame ("last
   *  week") or as a date. Absent for a doc that carried no meeting: dating
   *  one would invent a meeting that never happened. */
  when?: string;
}

/**
 * "No, I said Thursday" — a correction of a note ALREADY WRITTEN, heard in
 * the speech rather than typed into the doc.
 *
 * Two phrases and nothing else, deliberately: the mistaken words as the notes
 * carry them, and what they should say instead. Which note it lands on is not
 * decided here — it is resolved against the doc, where the notes actually
 * are, by `meeting-notes-correction.ts`.
 */
export interface SpokenCorrection {
  /** The mistaken words, as a note would spell them. */
  wrong: string;
  /** What they should say, in the words just spoken. */
  right: string;
}

export interface NotesComposeInput {
  docId: string;
  meetingId: string;
  tick: NotesTick;
  /**
   * The doc as it CURRENTLY READS, block by block, each with the id an edit
   * comes back with and a note of who wrote it. This replaces the old
   * `previous` string: a composer that saw only its own last output would keep
   * re-proposing words a person has already fixed, and one handed the whole
   * section as prose had no way to name a single bullet.
   *
   * Capped from the END of the doc (`recentBlocks`), so a tick's work scales
   * with what was just said rather than with the length of the meeting.
   * Headings are never dropped, so the model can always see where a point
   * belongs even when the bullets under a topic have scrolled out.
   */
  outline: readonly prose.OutlineEntry[];
  /**
   * Sentences said on an EARLIER tick that no note carries yet, offered for a
   * second look (`notes-idea-coverage.ts`).
   *
   * A separate field and not extra entries in `tick.turns`, which is what the
   * first version did. Two things go wrong when a retry is dressed as new
   * speech: the mention provenance a tick stamps on its notes gains a turn
   * nobody spoke in it, and the model is told a sentence it heard a minute ago
   * has just been said. Kept apart, it can be introduced as what it is —
   * "this went unrecorded, is it a note or not" — which is a different
   * question and gets a better answer.
   *
   * Absent on most ticks. Each sentence appears at most once in a meeting:
   * missed twice is counted lost rather than offered a third time.
   */
  missed?: readonly NotesTurn[];
  /**
   * The block id of the heading THIS meeting's notes sit under, when the
   * session has opened one. Absent on the first tick of a meeting, and again
   * if somebody deletes the heading — both of which mean "open a section".
   *
   * An id and not a heading TEXT, which is the whole point: a person renaming
   * the heading changes nothing here, so the next tick still writes into the
   * section they renamed instead of opening a second one below it.
   */
  notesHeadingId?: string;
  /**
   * The lines of the doc a PERSON wrote — every outline entry carrying no
   * author. They are theirs: an edit naming one of their blocks reaches them
   * as a suggestion rather than a rewrite, and the instructions ask the model
   * not to aim one there without cause.
   */
  humanNotes?: readonly string[];
  context?: NotesProjectContext;
  /** Tasks captured from THIS tick's speech. Absent when capture is off,
   *  found nothing, or failed — the notes compose either way. */
  taskLinks?: readonly NoteTaskLink[];
  /** Material THIS tick's speech asked to have pulled in, already resolved.
   *  Absent on the same terms as `taskLinks`, and for the same reason. */
  docLinks?: readonly NoteDocLink[];
  /**
   * Board rows and docs THIS tick's speech NAMED — found by searching the
   * meeting's catalogue for the titles the words contain
   * (`notes-references.ts`), so a note about work that has a ticket can cite
   * it. Distinct from `taskLinks`, which are rows the capture pass FILED or
   * touched: these were merely mentioned, and most ticks name none.
   */
  references?: readonly NoteReference[];
  /**
   * Rows this tick's speech probably concerns, which nobody explicitly asked
   * to link — or the shortlist an ambiguous ask produced. NOT for the
   * composer to weave in: these are written into the composed notes
   * afterwards, deterministically, as the tappable question
   * `notes-link-intent.ts` spells. They ride the input so a composer that
   * wants them (the eval harness reads them to score the pass) can see what
   * the tick decided; the real prompt is not given them, because a question
   * whose marker has to be exact is not a thing to ask a model to spell.
   */
  suggestions?: readonly NoteReference[];
  /**
   * Where a composer reports what its own call cost — prompt and reply size,
   * the model it asked, time to first token if it streams. Optional on both
   * sides: a composer that does not call it leaves those columns null, and
   * the stub never calls it at all.
   *
   * SIZES, NEVER TEXT. The measurement seam must not become a second copy of
   * the prompt.
   */
  measure?: (m: NotesComposeMeasure) => void;
}

export interface NotesComposer {
  readonly name: string;
  /** The edits this tick's speech calls for, addressed to the ids in
   *  `input.outline`. An empty list is a legitimate answer — a tick of
   *  greetings changes nothing — but a composer that could not read its own
   *  model's reply throws, so the words carry into the next tick. */
  compose(input: NotesComposeInput): Promise<readonly prose.BlockEdit[]>;
}

/**
 * The deterministic composer the tests speak to: no network, no randomness —
 * one edit per tick, carrying a bullet per new settled turn. Its determinism
 * is asserted, because a stub that drifted would make every pipeline test
 * assert luck.
 *
 * With no notes heading yet it opens one, exactly as the real composer is
 * asked to; from then on it addresses that heading by id.
 */
export function createStubNotesComposer(): NotesComposer {
  return {
    name: 'stub',
    compose(input: NotesComposeInput): Promise<readonly prose.BlockEdit[]> {
      const bullets = input.tick.turns
        .map((t) => `- ${t.speaker ? `${t.speaker}: ` : ''}${t.text}`)
        .join('\n');
      if (bullets.length === 0) return Promise.resolve([]);
      const headingId = input.notesHeadingId;
      return Promise.resolve(
        headingId === undefined
          ? [
              {
                op: 'insert_at_end',
                markdown: `## ${MEETING_NOTES_HEADING}\n\n${bullets}`,
              } satisfies prose.BlockEdit,
            ]
          : [
              {
                op: 'insert_under_heading',
                headingId,
                markdown: bullets,
              } satisfies prose.BlockEdit,
            ],
      );
    },
  };
}

/**
 * One tick's worth of changes, as handed to the sink.
 *
 * THERE IS NO `basedOn` AND THERE DOES NOT NEED TO BE. It used to carry the
 * section's items as the compose read them, so the sink could withhold a
 * change to a line that had moved underneath it. Block ids do that job
 * structurally: an edit naming a block a person has since deleted reports
 * `unknown-block` and the rest of the batch still lands, and one naming a
 * block a person has since EDITED becomes a suggestion on their words rather
 * than a rewrite of them. Nothing in this list can overwrite a newer edit.
 */
export interface NotesUpdate {
  docId: string;
  meetingId: string;
  /** The tick as composed — includes any words carried from a failed tick. */
  tick: NotesTick;
  edits: readonly prose.BlockEdit[];
}

/**
 * "Every place the notes say `from`, they should say `to`" — a rename
 * reaching notes already written.
 *
 * A SEPARATE SINK FROM `onNotes` ON PURPOSE. An update carries the blocks a
 * tick decided to write; a relabel carries two words and asks for those two
 * words wherever they already appear. Sent down the update path it would have
 * to re-emit every block that mentions the voice, which costs a bullet's marks
 * and anchors to change a name inside it.
 */
export interface NotesRelabel {
  docId: string;
  meetingId: string;
  /**
   * The engine label being renamed. This is the precise half: every inline
   * speaker tag in the notes carries it in its href, so a rename keyed on it
   * reaches exactly that voice's mentions and no others.
   */
  label: string;
  /** The display name as already written — "Speaker B". */
  from: string;
  /** What that voice is called now. */
  to: string;
  /**
   * Whether prose that merely READS as `from` may be rewritten too.
   *
   * False when another voice answers to the same display name. A tagged
   * mention is unaffected either way — the label says which voice it is —
   * but the words "Alex" in a sentence do not, and rewriting them would
   * silently reattribute the other Alex. Notes composed before tags existed
   * are all untagged, which is why this path survives at all.
   */
  rewriteUntagged: boolean;
}

/**
 * A spoken correction on its way to the doc that holds the note it fixes.
 *
 * A SEPARATE SINK FROM `onNotes`, for the reason {@link NotesRelabel} is one:
 * an update carries the blocks a tick decided to write; a correction carries
 * two phrases and asks for two phrases. Routed through the update path it
 * would have to re-emit the whole bullet, which is exactly the cost this
 * intent exists to avoid.
 *
 * It answers, where a relabel does not: the session cannot tell whether the
 * phrase resolved to one note, to somebody's note, or to nothing at all —
 * only the doc knows — and the answer is what the session reports.
 */
export interface NotesCorrection extends SpokenCorrection {
  docId: string;
  meetingId: string;
}

/**
 * What the doc did with a correction. `revised` means an agent note now reads
 * differently; `suggested` means a person's note carries the phrase and the
 * change was proposed on it rather than made; `none` means the correction
 * resolved to nothing it could act on, which is the ordinary answer for a
 * phrase the notes do not carry.
 */
export type NotesCorrectionResult = 'revised' | 'suggested' | 'none';

/**
 * "The engine now says turn 12 was someone else" — a correction reaching
 * notes that were already written.
 *
 * A THIRD SINK, beside `onNotes` and `onRelabel`, because it is a third kind
 * of change. An update carries the blocks a tick decided to write; a relabel
 * says a voice is called something new and rewrites two
 * words wherever that voice appears; this says nothing about any name — it
 * moves a MENTION from one voice to another, and which mentions move is
 * decided per site from the turns each was composed from.
 *
 * Sent as a batch, because the engine sends one: a `SpeakerRevision` names
 * every turn the whole-session pass changed its mind about, and applying
 * them one at a time would rewrite the same mention repeatedly and reach the
 * unsure state through doors it should never have opened.
 */
export interface NotesReattribution {
  docId: string;
  meetingId: string;
  /**
   * Turn id → the label the engine now gives it, `null` for "nobody". Only
   * turns whose words are ALREADY in the notes: a turn still waiting on a
   * tick composes under the new label without any of this.
   */
  revisions: ReadonlyMap<number, string | null>;
  /** The name map as it stands, so the doc writes the display name the
   *  moved-to voice actually answers to. */
  names: Readonly<Record<string, string>>;
}

/**
 * Where a tick is in its life, for the surface showing provisional text: the
 * words split off to compose, they landed in the doc, or the compose failed
 * and they are carried into the next tick. `turns` are engine turn ids — the
 * identity the strip already tracks — so a client can move exactly those
 * turns from its provisional block into "being written" and out again.
 */
export interface NotesTickLifecycle {
  docId: string;
  meetingId: string;
  tick: number;
  phase: 'composing' | 'written' | 'failed';
  turns: readonly number[];
}

export interface MeetingNotesDeps {
  composer: NotesComposer;
  /** Quiet threshold; defaults to {@link DEFAULT_NOTES_QUIET_MS}. */
  quietMs?: number;
  /**
   * Ceiling on how long a settled turn waits for a note while people keep
   * talking; defaults to {@link DEFAULT_NOTES_CADENCE_MS}. Pass `Infinity`
   * for pause-only behaviour — the latency harness uses that to measure the
   * two cadences against one script.
   */
  cadenceMs?: number;
  /**
   * How long an engine endpoint stands unanswered before it counts as a
   * pause; defaults to {@link DEFAULT_NOTES_ENDPOINT_CONFIRM_MS}. Pass
   * `Infinity` to leave `quietMs` as the only pause clock — the latency
   * harness uses that to measure the endpoint window's contribution on its
   * own.
   */
  endpointConfirmMs?: number;
  schedule?: TickScheduler;
  /**
   * Open the timing log for ONE meeting — a factory, not a log, because
   * these deps are wired once per server while the file sits beside the
   * meeting's own transcript. Absent, or returning undefined, measures
   * nothing and costs nothing.
   */
  openTiming?: (ids: { docId: string; meetingId: string }) => NotesTimingLog | undefined;
  /** The wall clock the timings are read from. Tests inject one. */
  now?: () => number;
  context?: NotesProjectContext;
  /**
   * Resolve the context for THIS meeting's doc, read once at session start —
   * the doc title and board tasks vary per doc, while these deps are wired
   * once per server. Wins over the static `context` when both are present.
   */
  resolveContext?: (docId: string) => NotesProjectContext | undefined;
  /**
   * Everything on this meeting's board a note could link to — every open row
   * and every doc, with its URL — read ONCE at session start and searched per
   * tick for the titles that tick's speech contains.
   *
   * Deliberately not part of `context`: context is prompt text, and this is a
   * board-sized list that must never become prompt text. What reaches the
   * compose is the handful of entries the words actually named.
   */
  resolveReferences?: (docId: string) => readonly NoteReference[];
  /**
   * The capture pass, run per tick BEFORE the compose so the links it
   * returns can ride the same compose input. Its failure costs the tick its
   * links, never its notes — capture is an enhancement on the same terms as
   * context. Sees the tick's settled turns, carried words included, plus the
   * previous tick's for the sake of asks that span the boundary.
   *
   * ONE seam for every intent, not one per intent: the pass behind it is one
   * LLM call carrying all four (decisions.md, 2026-08-30), and a second seam
   * here would be a standing invitation to make it a second call.
   */
  captureIntents?: (input: {
    docId: string;
    meetingId: string;
    turns: readonly NotesTurn[];
    /**
     * The turns the PREVIOUS tick's capture saw, so an ask that straddles the
     * boundary between them still files the right row. Marked as already read
     * downstream; the capture pass decides how much of it to use.
     */
    priorTurns: readonly NotesTurn[];
  }) => Promise<{
    tasks: readonly NoteTaskLink[];
    docs: readonly NoteDocLink[];
    /**
     * Corrections of notes already written, heard on this tick. Optional so
     * a caller wiring its own capture seam need not answer a question it
     * does not extract; absent reads as none.
     */
    corrections?: readonly SpokenCorrection[];
  }>;
  /**
   * Read the doc's outline at the START of each compose, so the composer sees
   * the doc as it currently reads — a person's edits included — rather than
   * only what it last wrote. Absent in tests that wire no doc; then the
   * composer is handed an empty outline and can only append.
   */
  readOutline?: (input: { docId: string; meetingId: string }) => readonly prose.OutlineEntry[];
  /**
   * Which block id, in that outline, is THIS meeting's notes heading.
   *
   * Answered by the stage that holds the doc (`meeting-notes-doc.ts`), because
   * remembering the heading a meeting opened is a fact about the doc rather
   * than about the ticker. Absent, or answering `undefined`, tells the
   * composer to open a section.
   */
  notesHeadingId?: (input: {
    docId: string;
    meetingId: string;
    outline: readonly prose.OutlineEntry[];
  }) => string | undefined;
  /**
   * Where composed notes go. The doc-writing stage plugs in here.
   *
   * RETURNING `false` MEANS NOTHING REACHED THE DOC, and it is not the same
   * as throwing: a throw is a broken sink, this is a write the doc refused —
   * every edit in the batch named a block that is no longer there, say. The
   * session treats it as a failed tick: the words are carried into the next
   * one, and the surface showing them is told `failed` rather than `written`,
   * so the live area keeps a chunk on screen until its note is actually in
   * the doc. It used to report `written` on the strength of having CALLED
   * this sink, so a skipped write took the words off the screen and out of
   * the notes at the same time, silently.
   *
   * `void` and `true` both mean written — a sink with nothing to report is
   * the ordinary case and must not have to say so.
   */
  // A sink with nothing to report returns nothing; only an explicit `false`
  // means the write did not land. The union is the contract, not a slip.
  // biome-ignore lint/suspicious/noConfusingVoidType: deliberate optional-return sink
  onNotes: (update: NotesUpdate) => void | boolean;
  /**
   * Where a rename of a voice already written about goes. Optional: a
   * session with no sink for it composes under the new name from the next
   * tick on, because the name map is this module's; only the words already
   * in the doc go unrevised.
   */
  onRelabel?: (relabel: NotesRelabel) => void;
  /**
   * Where a spoken correction of a note already written goes. Optional: a
   * session with no sink for it extracts corrections and drops them, which
   * is the same state as a session with no doc — there is nothing written to
   * correct.
   */
  onCorrection?: (correction: NotesCorrection) => NotesCorrectionResult;
  /**
   * A board row somebody asked, out loud, to link this meeting to — the ref
   * side of the note's link.
   *
   * The NOTE carries the citation on its own; this is what gives the ROW its
   * backlink, so the work can be found from either end and so unlinking has
   * something to remove. Optional: a meeting on a doc with no board, and
   * every test that only reads the notes, wires nothing and loses nothing but
   * the backlink.
   */
  onTaskLinked?: (link: {
    docId: string;
    meetingId: string;
    taskId: string;
    title: string;
  }) => void;
  /**
   * Where the engine's late correction of who spoke goes. Optional on the
   * same terms as `onRelabel`: a session with no sink composes under the
   * corrected labels from the next tick on, and leaves the doc as it was.
   */
  onReattribute?: (reattribution: NotesReattribution) => void;
  onError?: (message: string) => void;
  /**
   * One line about the whole meeting, at `end()`.
   *
   * WHY THIS EXISTS. When a meeting is reported as having "skipped chunks",
   * the only way to answer it is to know how many of the meeting's turns
   * reached a note — and nothing on this path logged anything per tick, so
   * the question was unanswerable after the fact. It is a summary rather
   * than a tick log on purpose: a line per tick would be hundreds per
   * meeting for a number nobody reads while the meeting is healthy.
   */
  onMeetingSummary?: (summary: NotesMeetingSummary) => void;
  /**
   * A new session is beginning on this doc — called synchronously from
   * `beginNotesSession`, before any tick can fire. The server sink releases
   * the ownership ledger's claims here, so a stop-and-restart can never
   * replace the notes the previous recording wrote.
   */
  onSessionStart?: (ids: { docId: string; meetingId: string }) => void;
  /**
   * Tick progress for the surface showing provisional text. Per SESSION, not
   * per server: the relay spreads the shared deps and adds this per socket,
   * so the frames reach the one client whose meeting it is.
   */
  onTickLifecycle?: (event: NotesTickLifecycle) => void;
}

/**
 * What a CALLER hands `createServer`: the same deps, except the notes sink is
 * optional because the server supplies the real one — the write into the
 * meeting doc itself (see `meeting-notes-doc.ts`). A caller-supplied
 * `onNotes` observes in addition to that write, never instead of it.
 *
 * `taskExtractor` is the capture analogue of `composer`: the caller supplies
 * the LLM seam and the server assembles the board access around it
 * (`withServerNotesSinks`), the way it already supplies the doc sink. A
 * caller-supplied `captureIntents` wins over that assembly.
 */
export type MeetingNotesOptions = Omit<MeetingNotesDeps, 'onNotes'> & {
  // A sink with nothing to report returns nothing; only an explicit `false`
  // means the write did not land. The union is the contract, not a slip.
  // biome-ignore lint/suspicious/noConfusingVoidType: deliberate optional-return sink
  onNotes?: (update: NotesUpdate) => void | boolean;
  taskExtractor?: import('./meeting-task-capture.ts').TaskCaptureExtractor | null;
};

export interface MeetingNotesSession {
  onTurn(turn: EngineTurn): void;
  /**
   * "Label `speaker` is `name`" — backwards as well as forwards.
   *
   * Words still waiting on a tick pick the name up when that tick composes.
   * Notes ALREADY composed are rewritten: the name replaces the placeholder
   * in this session's memory of what it wrote, and a `NotesRelabel` goes to
   * the sink so the same two words change in the doc. The owner's call
   * (2026-08-29) is that a meeting must not read as "Speaker B" above the
   * rename and by name below it.
   *
   * The rewrite is QUEUED BEHIND whatever is composing, so a rename that
   * lands mid-compose corrects that compose's output rather than being
   * overwritten by it.
   */
  nameSpeaker(speaker: string, name: string): void;
  /** Flush the tail delta and wait for every compose in flight. */
  end(): Promise<void>;
  /**
   * What this meeting lost. Read after `end()` for the whole meeting, or
   * during it for what has happened so far.
   *
   * `refusedTooLong` is the one worth watching: those ticks are the notes
   * falling behind the room, they cluster in the second half of a long
   * meeting, and nothing about them is visible in the doc — the words carry
   * forward and the notes just stop growing.
   */
  stats(): {
    composeFailures: number;
    refusedTooLong: number;
    turnsSettled: number;
    turnsComposed: number;
    /** What the NOTES kept — see `NotesMeetingSummary.ideas`. Mid-meeting it
     *  lags the speech by a tick, because an idea is judged against the
     *  outline the next tick reads. */
    ideas: IdeaCoverage;
  };
}

/**
 * True when `ch` would make text adjacent to a match part of a longer word.
 *
 * Exported because the rename rewrites the same token in two places — this
 * module's memory of the notes, and the doc itself — and a boundary rule the
 * two disagreed about would leave one of them stale. Engine labels are single
 * letters, so "Speaker A" is a prefix of "Speaker AB".
 */
export function extendsWord(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9]/.test(ch);
}

/**
 * Replace every whole-token occurrence of `from` with `to`. A plain scan, not
 * a RegExp: a speaker's name is arbitrary text a person typed, and escaping
 * it for a pattern is a bug waiting for the first name with a dot in it.
 */
/**
 * Which turns of this tick belong to which voice — the provenance every
 * mention the tick composes is stamped with.
 *
 * Keyed on the RAW engine label rather than the display name: the label is
 * what the tag's href carries, and two voices a person has given the same
 * name must not pool their turns into one bucket.
 */
function turnsByLabel(turns: readonly NotesTurn[]): Record<string, number[]> {
  const byLabel: Record<string, number[]> = {};
  for (const turn of turns) {
    if (turn.speakerLabel === undefined) continue;
    (byLabel[turn.speakerLabel] ??= []).push(turn.turn);
  }
  return byLabel;
}

export function replaceWholeToken(text: string, from: string, to: string): string {
  if (!from || from === to) return text;
  let out = '';
  let i = 0;
  while (true) {
    const at = text.indexOf(from, i);
    if (at < 0) break;
    const boundary = !extendsWord(text[at - 1]) && !extendsWord(text[at + from.length]);
    out += text.slice(i, at) + (boundary ? to : from);
    i = at + from.length;
  }
  return out + text.slice(i);
}

/** Does this edit write at least one bullet? The tappable question hangs off
 *  a note, so an edit that only opens a heading is not somewhere to put one. */
function insertsABullet(edit: prose.BlockEdit): boolean {
  return 'markdown' in edit && /^\s*([-*+]|\d+[.)])\s+\S/m.test(edit.markdown);
}

/**
 * Hang this tick's tappable questions off the LAST edit that writes a bullet,
 * and when the batch has none, emit one edit that carries them.
 *
 * NEVER SILENTLY DROPPED. A tick whose speech asked "is that the retry
 * ticket?" and whose notes came out with no bullet used to lose the question
 * altogether — the appender had nowhere to hang it and said nothing. That is
 * the failure this path exists to remove, so the fallback writes a note of its
 * own rather than returning the batch unchanged.
 */
function withSuggestions(
  edits: readonly prose.BlockEdit[],
  suggested: readonly NoteReference[],
  humanNotes: readonly string[] | undefined,
  notesHeadingId: string | undefined,
): readonly prose.BlockEdit[] {
  if (suggested.length === 0) return edits;
  const opts = humanNotes ? { protect: humanNotes } : {};
  for (let i = edits.length - 1; i >= 0; i--) {
    const edit = edits[i];
    if (edit === undefined || !('markdown' in edit) || !insertsABullet(edit)) continue;
    const grown = appendSuggestions(edit.markdown, suggested, opts);
    if (grown === edit.markdown) return edits;
    const out = [...edits];
    out[i] = { ...edit, markdown: grown };
    return out;
  }
  const own = appendSuggestions('', suggested, opts).trim();
  if (own.length === 0) return edits;
  return [
    ...edits,
    notesHeadingId === undefined
      ? { op: 'insert_at_end', markdown: own }
      : { op: 'insert_under_heading', headingId: notesHeadingId, markdown: own },
  ];
}

/**
 * One meeting's notes pipeline: pause ticks in, composed notes out.
 *
 * Composes are SERIALIZED on one promise chain — the composer sees ticks in
 * order and each sees the notes the one before it produced. A failed compose
 * does not lose its words: they are carried into the next tick's input, and
 * a failure with no next tick gets one retry at `end()`. Words a composer
 * never manages to compose are still in the transcript file — the notes are
 * a view, the transcript is the record.
 */
export function beginNotesSession(
  deps: MeetingNotesDeps,
  ids: { docId: string; meetingId: string },
): MeetingNotesSession {
  // Before anything else: whatever a previous recording wrote on this doc is
  // finished writing, and this session must never replace it.
  deps.onSessionStart?.(ids);
  const timing = deps.openTiming?.(ids);
  const context = deps.resolveContext?.(ids.docId) ?? deps.context;
  /** The board as it stood when the meeting started. Not refreshed per tick:
   *  a row filed mid-meeting reaches the notes through the capture pass's
   *  `taskLinks`, which is the path that knows it was just created. */
  const catalogue = deps.resolveReferences?.(ids.docId) ?? [];
  /** Tappable questions this meeting has already written, by row URL. See
   *  where it is read for why the doc alone cannot answer this. */
  const offeredSuggestions = new Set<string>();
  /** Raw engine labels, never display names — a carried turn is re-mapped
   *  on its next attempt, and mapping a name a second time would wrap it. */
  let carry: NotesTurn[] = [];
  /**
   * The turns the last capture pass read, kept RAW for the same reason as
   * `carry`: a voice named since then must reach the next pass under its new
   * name, and a display name mapped twice would wrap ("Speaker Jordan").
   * One tick deep — the capture pass takes the tail it can afford.
   */
  let priorRaw: NotesTurn[] = [];
  let lastTickNo = 0;
  let chain: Promise<void> = Promise.resolve();
  const names: Record<string, string> = {};
  /**
   * Every engine label this meeting has carried. Kept so a rename can ask
   * whether the name it is replacing belongs to more than one voice — the
   * `names` map alone would miss a voice that is still unnamed and whose
   * "Speaker B" someone has just typed as another voice's name.
   */
  const seen = new Set<string>();
  const withNames = (turn: NotesTurn): NotesTurn =>
    turn.speaker === undefined
      ? turn
      : {
          ...turn,
          speaker: speakerDisplayName(turn.speaker, names),
          // The raw label rides along so the composer can TAG the mention
          // with it. Set here and nowhere else: this is the one place that
          // knows both halves of a voice's identity at once.
          speakerLabel: turn.speaker,
        };

  /**
   * Composes this meeting lost, and how many of them were refused for being
   * too long.
   *
   * A whole-notes reply grows with the MEETING, so the ticks that overrun the
   * composer's output ceiling are the late ones — and the failure is silent
   * by construction: the turns carry into the next tick, nothing is lost, and
   * the notes simply stop keeping up. `bun run notes:eval` measured about a
   * tenth of ticks refused this way across its corpus, all in the second half
   * of the longer meetings. Nothing in production could see that, because the
   * only report was an `onError` nobody supplied. Counted here so the meeting
   * can say it out loud when it ends.
   */
  let composeFailures = 0;
  let refusedTooLong = 0;
  /**
   * Which turns the engine settled, and which of them a compose actually
   * carried. Sets rather than counters because a turn can reach the composer
   * more than once — a failed tick carries its words into the next one — and
   * the question is coverage, not attempts.
   */
  const settledTurns = new Set<number>();
  const composedTurns = new Set<number>();
  /**
   * The other coverage question, and the one a reader of the notes asks: not
   * "was this turn shown to the composer" but "did any note come of it".
   * Settled one tick late by construction — an idea heard now is judged
   * against the outline the NEXT tick reads, which is the first moment the
   * notes it should have produced are in the doc.
   */
  const ideas = createIdeaLedger();

  const lifecycle = (phase: 'composing' | 'written' | 'failed', tick: number, turns: number[]) =>
    deps.onTickLifecycle?.({ docId: ids.docId, meetingId: ids.meetingId, tick, phase, turns });

  /**
   * The tick waiting behind a compose that is RUNNING, if one is.
   *
   * ONE, NOT A QUEUE. Ticks fire on a clock and a compose is a model call, so
   * a slow reply used to build a line of them: the fourth tick's words were
   * three composes from the doc, and every tick after it inherited that debt
   * for the rest of the meeting — the notes never caught up again, because
   * every tick after the slow one paid for it. Merged instead, so the next
   * compose sees everything said since the last one and the wait stops
   * compounding. The turns are simply concatenated — they are disjoint by
   * construction, each tick carrying the words that arrived after the one
   * before it.
   *
   * ONLY WHILE A COMPOSE IS IN FLIGHT. Ticks that arrive with the composer
   * idle still each get their own compose: merging those would fold two
   * separate moments of the meeting into one note for no gain, and the
   * ceiling exists precisely to produce notes as speech goes on.
   */
  let queued: NotesTick | null = null;
  /** A compose is running, so a new tick merges rather than starting one. */
  let composing = false;
  const clock = deps.now ?? (() => Date.now());
  /**
   * When each turn's words stopped changing — the moment Bryan finished the
   * sentence, as the pipeline first knew it. A final frame stamps it; a
   * partial stamps it only if the turn has none yet, so a turn that runs for
   * a minute is measured from when it STARTED being said rather than from
   * the last revision of it. That is the number the ceiling exists to bound.
   */
  const settledAtOf = new Map<number, number>();
  /** When each tick fired, and how many ticks' words it ended up carrying. */
  const firedAt = new WeakMap<NotesTick, number>();
  const mergedOf = new WeakMap<NotesTick, number>();
  /** The merged tick already has a step on the chain waiting to run it. */
  let drainScheduled = false;
  /**
   * A failed compose has already been given its immediate second attempt.
   * Reset by any success, so one bad tick retries at once while a composer
   * that is simply down does not spin.
   */
  let retriedFailure = false;

  const mergeTicks = (a: NotesTick, b: NotesTick): NotesTick => ({
    // The later number and the later reason: what the merged tick IS, is the
    // most recent moment that asked for notes. An `end` merged into a pause
    // must stay an `end` — it is the last chance the words have.
    tick: Math.max(a.tick, b.tick),
    reason: b.reason,
    turns: [...a.turns, ...b.turns],
  });

  /** How many ticks' worth of words a tick object carries. */
  const mergeCount = (t: NotesTick): number => mergedOf.get(t) ?? 1;

  const composeTick = (tick: NotesTick): void => {
    lastTickNo = Math.max(lastTickNo, tick.tick);
    if (!firedAt.has(tick)) firedAt.set(tick, clock());
    // Announced when the tick FIRES, not when the chain gets to it: this is
    // the moment the settled words split off from the provisional stream,
    // which is what the surface showing them wants to draw. Announced per
    // FIRING even when two ticks merge, because the split is what the client
    // is drawing and it happened twice.
    if (tick.turns.length > 0) {
      lifecycle(
        'composing',
        tick.tick,
        tick.turns.map((t) => t.turn),
      );
    }
    if (!composing && !drainScheduled) {
      // The composer is idle. This tick gets its own compose, exactly as
      // every tick did before merging existed — merging an idle moment would
      // fold two separate stretches of the meeting into one note for nothing.
      chain = chain.then(() => guarded(tick));
      return;
    }
    if (queued !== null) {
      const merged = mergeTicks(queued, tick);
      // The merged tick inherits the EARLIER fire time: its oldest words
      // have been waiting since then, and that wait is the thing being
      // measured.
      firedAt.set(merged, Math.min(firedAt.get(queued) ?? clock(), firedAt.get(tick) ?? clock()));
      mergedOf.set(merged, mergeCount(queued) + mergeCount(tick));
      queued = merged;
    } else {
      queued = tick;
    }
    if (drainScheduled) return;
    drainScheduled = true;
    // ONE step on the chain for the whole merge, appended NOW rather than
    // taken by the running compose when it finishes. The chain is what
    // orders composes against renames and reattributions, and a compose that
    // helped itself to the next tick would run ahead of a rename queued
    // between the two — which is the rename landing under the compose it was
    // supposed to correct.
    chain = chain.then(async () => {
      drainScheduled = false;
      const merged = queued;
      queued = null;
      if (merged !== null) await guarded(merged);
    });
  };

  /** Run one compose with the in-flight flag held, so ticks that fire during
   *  it merge instead of queueing behind each other. */
  const guarded = async (tick: NotesTick): Promise<void> => {
    composing = true;
    try {
      await runCompose(tick);
    } finally {
      composing = false;
    }
  };

  const runCompose = (tick: NotesTick): Promise<void> => {
    return (async () => {
      const raw = [...carry, ...tick.turns];
      carry = [];
      if (raw.length === 0) return;
      // --- timing: opened here so every exit below reports one row ---
      const startedAt = firedAt.get(tick) ?? clock();
      const composeStart = clock();
      const settled = raw
        .map((t) => settledAtOf.get(t.turn))
        .filter((v): v is number => v !== undefined);
      const settledAt = settled.length > 0 ? Math.min(...settled) : null;
      let measured: NotesComposeMeasure = {};
      let composeMs = 0;
      let applyMs = 0;
      const report = (outcome: NotesTickTiming['outcome'], edits: readonly prose.BlockEdit[]) => {
        if (timing === undefined) return;
        const end = clock();
        const blocks = new Set(
          edits.map((e) => ('blockId' in e ? e.blockId : 'headingId' in e ? e.headingId : '')),
        );
        blocks.delete('');
        timing.record({
          tick: tick.tick,
          reason: tick.reason,
          turns: raw.map((t) => t.turn),
          settledAt,
          startedAt,
          waitedMs: composeStart - startedAt,
          promptChars: measured.promptChars ?? null,
          replyChars: measured.replyChars ?? null,
          firstTokenMs: measured.firstTokenMs ?? null,
          composeMs,
          model: measured.model ?? null,
          applyMs,
          edits: edits.length,
          blocks: blocks.size,
          merged: mergeCount(tick),
          outcome,
          settledToWrittenMs: outcome === 'written' && settledAt !== null ? end - settledAt : null,
        });
      };
      // Speaker tags belong to multi-speaker sessions only (owner's call,
      // 2026-08-31: a solo huddle stamped with the speaker's own name on
      // every note is pure noise — and a `conversation` capture with one
      // person in the room is still solo). Until a second voice has been
      // heard, the composer never learns who spoke, so it has nothing to tag.
      const multi = seen.size >= 2;
      // The solo path drops the voice and keeps everything else — `partial`
      // included, because whether the last sentence finished is a fact about
      // the words, not about who said them.
      const bare = (t: NotesTurn): NotesTurn => ({
        turn: t.turn,
        text: t.text,
        ...(t.partial ? { partial: true } : {}),
        // `continued` survives the solo path for the same reason `partial`
        // does: whether these words finish a sentence already in the notes
        // is a fact about the WORDS, not about who said them.
        ...(t.continued ? { continued: true } : {}),
      });
      const turns = multi ? raw.map(withNames) : raw.map(bare);
      let taskLinks: readonly NoteTaskLink[] = [];
      let docLinks: readonly NoteDocLink[] = [];
      // Read before the pass, written after it: this tick's words are the
      // NEXT tick's overlap, never their own. Same multi gate as `turns`:
      // the capture pass must see exactly the window its guards see.
      const priorTurns = multi ? priorRaw.map(withNames) : priorRaw.map(bare);
      priorRaw = raw;
      if (deps.captureIntents) {
        try {
          const captured = await deps.captureIntents({
            docId: ids.docId,
            meetingId: ids.meetingId,
            turns,
            priorTurns,
          });
          taskLinks = captured.tasks;
          docLinks = captured.docs;
          // BEFORE the section is read and BEFORE the compose, not after.
          // The note a correction fixes was written on an earlier tick and is
          // already in the doc, so correcting it first means this tick's
          // compose reads the corrected words in the OUTLINE, and never
          // re-proposes the note in its old wording.
          for (const correction of captured.corrections ?? []) {
            try {
              deps.onCorrection?.({
                docId: ids.docId,
                meetingId: ids.meetingId,
                wrong: correction.wrong,
                right: correction.right,
              });
            } catch (err) {
              // A correction that cannot reach the doc leaves a stale note,
              // which is a blemish; letting it reach the compose chain as a
              // rejection would cost the meeting its notes, which is not.
              deps.onError?.(err instanceof Error ? err.message : 'notes correction failed');
            }
          }
        } catch (err) {
          // Unlike a failed compose, nothing is carried: the words still
          // compose below, and the transcript remains the durable record a
          // later capture could be rebuilt from.
          deps.onError?.(err instanceof Error ? err.message : 'task capture failed');
        }
      }
      // What this tick's words named on the board. A local scan of a list
      // read at session start — no store call, no network, nothing that can
      // fail a tick — so it sits outside the try blocks the fallible stages
      // need.
      const spokenText = turns.map((t) => t.text).join('\n');
      const references = matchReferences(spokenText, catalogue);
      // The loose half, run over the same words and the same catalogue: what
      // an explicit "link that to the existing task" points at, and what is
      // probably related whether or not anybody asked. Local and pure, like
      // the strict matcher above it — nothing here can fail a tick.
      const loose = resolveNoteLinks({ spokenText, catalogue, named: references });
      // A row somebody ASKED to link is cited like a named one; the ask is
      // what makes it a citation rather than a guess. Deduped by URL, because
      // an ask that also NAMED its row comes back from both matchers — the
      // strict one for the words, the loose one so the row gets its ref.
      const cited = [...new Map([...references, ...loose.linked].map((r) => [r.url, r])).values()];
      for (const link of loose.linked) {
        if (link.kind !== 'task' || !link.id) continue;
        try {
          deps.onTaskLinked?.({
            docId: ids.docId,
            meetingId: ids.meetingId,
            taskId: link.id,
            title: link.title,
          });
        } catch (err) {
          // The ref is what gives the row its backlink; the note carries the
          // link either way. A store that refuses costs the backlink, never
          // the tick.
          deps.onError?.(err instanceof Error ? err.message : 'notes task link failed');
        }
      }
      // Read INSIDE the chain, immediately before composing: the compose is
      // the thing that must not be written from a stale doc, and the chain is
      // what serializes it against the previous tick's write.
      let outline: readonly prose.OutlineEntry[] = [];
      try {
        outline = deps.readOutline?.({ docId: ids.docId, meetingId: ids.meetingId }) ?? [];
      } catch (err) {
        // The outline is an input to a better compose, never a dependency of
        // one — same rule as context and capture. With none, the composer
        // opens a section and appends, which is what tick one does anyway.
        deps.onError?.(err instanceof Error ? err.message : 'notes outline read failed');
      }
      let notesHeadingId: string | undefined;
      try {
        notesHeadingId = deps.notesHeadingId?.({
          docId: ids.docId,
          meetingId: ids.meetingId,
          outline,
        });
      } catch (err) {
        deps.onError?.(err instanceof Error ? err.message : 'notes heading lookup failed');
      }
      // DERIVED FROM THE OUTLINE, not from a section read: a block carrying no
      // author is one this agent did not write, or one a person has since
      // touched — `clearAuthorshipOnPersonEdit` makes those the same answer.
      // Headings are left out; the list is about lines, and the outline
      // already says which heading each line sits under.
      const humanNotes = outline
        .filter((e) => e.author === undefined && e.kind !== 'heading' && e.text.length > 0)
        .map((e) => e.text);
      // WHAT THE LAST TICK'S SPEECH SHOULD HAVE PRODUCED, judged now that the
      // notes it was meant to produce are in the outline. An idea no note
      // carries goes back into THIS tick's speech, once, in front of a
      // note-taker that can see what it has already written; a second miss is
      // counted lost rather than retried forever.
      const notesSoFar = outline.map((e) => e.text).join('\n');
      const alreadyHere = new Set(turns.map((t) => t.text.trim().toLowerCase()));
      const retries: NotesTurn[] = ideas
        .settle(notesSoFar)
        // A failed compose carries its own turns forward, so an idea from
        // that tick is already in `turns`. Sending it twice would spend
        // prompt on the same sentence and read to the model as repetition,
        // which is the one thing it is told to cut.
        .filter((idea) => !alreadyHere.has(idea.text.trim().toLowerCase()))
        .map((idea) => ({
          turn: idea.turn,
          text: idea.text,
          ...(idea.speaker !== undefined ? { speaker: idea.speaker } : {}),
          ...(idea.speakerLabel !== undefined ? { speakerLabel: idea.speakerLabel } : {}),
        }));
      // AFTER the settle and never before: an idea this tick just heard has
      // had no chance to reach a note yet, and settling it here would report
      // every one of them missing on the tick it arrived.
      ideas.see(turns);
      const input: NotesComposeInput = {
        docId: ids.docId,
        meetingId: ids.meetingId,
        tick: { ...tick, turns },
        ...(retries.length > 0 ? { missed: retries } : {}),
        outline,
        ...(notesHeadingId !== undefined ? { notesHeadingId } : {}),
        ...(humanNotes.length > 0 ? { humanNotes } : {}),
        ...(context ? { context } : {}),
        ...(taskLinks.length > 0 ? { taskLinks } : {}),
        ...(docLinks.length > 0 ? { docLinks } : {}),
        ...(cited.length > 0 ? { references: cited } : {}),
        ...(loose.suggested.length > 0 ? { suggestions: loose.suggested } : {}),
      };
      try {
        const composeCallStart = clock();
        const composed = await deps.composer.compose({
          ...input,
          measure: (m) => {
            measured = { ...measured, ...m };
          },
        });
        composeMs = clock() - composeCallStart;
        // The deterministic gate on a model-made claim: a tag naming a voice
        // this meeting never carried is unwrapped to plain words, and a tag
        // naming a real one is re-rendered from the name map rather than
        // trusted to spell it. Same law the capture pass holds `requester`
        // to — an attribution must name something the transcript contained.
        //
        // PER EDIT, not over one composed string: an edit's `markdown` is the
        // only text this tick writes, and running the pass over a joined
        // blob would need it split again afterwards on a boundary the pass is
        // free to move.
        const unknownTags: string[] = [];
        const checked = composed.map((edit) => {
          if (!('markdown' in edit)) return edit;
          const out = normalizeSpeakerTags(edit.markdown, {
            names,
            // While the session is effectively solo the composer was shown no
            // voices at all, so ANY tag it writes is invented — an empty
            // known set unwraps them all.
            known: multi ? seen : new Set<string>(),
            ...(input.humanNotes ? { protect: input.humanNotes } : {}),
            // What this tick actually carried, per voice. A mention the
            // composer has just written is stamped with it, so a later
            // revision of any of those turns can find the mention again.
            // Mentions this tick merely re-emitted keep the provenance they
            // already have — see `turnsByLabel` in core.
            turnsByLabel: turnsByLabel(turns),
          });
          unknownTags.push(...out.unknown);
          return { ...edit, markdown: out.markdown };
        });
        if (unknownTags.length > 0) {
          deps.onError?.(
            `notes: dropped speaker tag${unknownTags.length > 1 ? 's' : ''} for ` +
              `${[...new Set(unknownTags)].join(', ')} — no such voice in this meeting`,
          );
        }
        // The questions, written after the model rather than by it: a
        // suggestion is a decision this pipeline made deterministically, and
        // a marker the client has to recognise exactly. Human lines are
        // passed so none of them is appended to — a question added to
        // somebody's own sentence reaches the doc as a proposed rewrite of
        // it.
        // A question already asked is not asked again. It used to be deduped
        // against the notes markdown, where the row's URL was visible; an
        // outline carries a block's WORDS and not its links, so the memory is
        // this session's own, plus a look for the question's own label in the
        // doc — which catches one the notes carry from before this session.
        const unseen = loose.suggested.filter(
          (ref) =>
            !offeredSuggestions.has(ref.url) &&
            !outline.some((e) => e.text.includes(suggestionLabel(ref.title))),
        );
        const edits = withSuggestions(checked, unseen, input.humanNotes, notesHeadingId);
        const applyStart = clock();
        const written =
          deps.onNotes({
            docId: ids.docId,
            meetingId: ids.meetingId,
            tick: input.tick,
            edits,
          }) !== false;
        applyMs = clock() - applyStart;
        if (!written) {
          // The compose was fine and the DOC refused it. Same handling as a
          // failed compose — the words are still unwritten, so they carry —
          // and the same report to the surface, so the live area holds them.
          carry = [...raw, ...carry];
          lifecycle(
            'failed',
            tick.tick,
            raw.map((t) => t.turn),
          );
          composeFailures++;
          deps.onError?.(
            `${ids.docId} meeting ${ids.meetingId} tick ${tick.tick}: doc write skipped`,
          );
          report('failed', edits);
          retryAfterFailure(tick);
          return;
        }
        // A question is only asked once, and it is asked once it has LANDED.
        // Marking them offered before the write meant a refused write lost
        // the questions outright — the retry composed without them.
        for (const ref of unseen) offeredSuggestions.add(ref.url);
        retriedFailure = false;
        for (const t of raw) composedTurns.add(t.turn);
        lifecycle(
          'written',
          tick.tick,
          raw.map((t) => t.turn),
        );
        report(edits.length > 0 ? 'written' : 'empty', edits);
      } catch (err) {
        carry = [...raw, ...carry];
        lifecycle(
          'failed',
          tick.tick,
          raw.map((t) => t.turn),
        );
        const reason = err instanceof Error ? err.message : 'notes composer failed';
        composeFailures++;
        if (/max_tokens/.test(reason)) refusedTooLong++;
        // The ids and the tick, not just the reason. "notes compose hit
        // max_tokens" in a log with several meetings running says nothing
        // about which meeting stopped keeping up, or how far into it.
        deps.onError?.(`${ids.docId} meeting ${ids.meetingId} tick ${tick.tick}: ${reason}`);
        // Only a size refusal is worth trying again at once; see
        // `retryAfterFailure`.
        report('failed', []);
        if (/max_tokens/.test(reason)) retryAfterFailure(tick);
      }
    })();
  };

  /**
   * Try the carried words again NOW, rather than at whatever the next clock
   * says.
   *
   * A size refusal used to cost a whole tick: the words went into `carry` and
   * sat there until the next pause or ceiling, so a reply the model would
   * have managed on a second attempt reached the notes fifteen seconds late —
   * and the tick that finally carried them was twice the size, which is the
   * condition that produced the refusal in the first place. Same for a doc
   * write the store refused: the retry re-reads the outline, which is the
   * thing that changed.
   *
   * ONLY THOSE TWO. A composer that is down, out of quota or unreachable
   * fails again instantly, and the carry-to-the-next-tick path is the right
   * one for it — the words are safe, and the next tick is the next chance.
   * Retrying every failure would also close the window in which a late
   * speaker revision can re-label a carried turn instead of correcting words
   * that are already in the doc.
   *
   * ONE attempt, and only one: `retriedFailure` is cleared by a success, so
   * even a repeating refusal costs two composes per tick, never a spin.
   */
  const retryAfterFailure = (tick: NotesTick): void => {
    if (retriedFailure || carry.length === 0) return;
    retriedFailure = true;
    // The carried words ride ON the retry tick rather than being picked up
    // from `carry` by the compose, so the retry announces `composing` for
    // the turns it is about. A tick with no turns of its own announces
    // nothing, and the surface would have seen a second `failed` for words
    // it was never told were being tried again.
    const turns = carry;
    carry = [];
    composeTick({ tick: ++lastTickNo, reason: tick.reason, turns });
  };

  /**
   * Wait until the chain is quiet — nothing composing, nothing queued behind
   * it.
   *
   * One `await chain` is no longer enough, and that is the price of the two
   * things above it: a drain step can queue another (a tick that fired while
   * it ran), and a failure schedules its own retry. Bounded rather than
   * looped forever, because `end()` must return even if something upstream
   * is producing ticks in a loop; the bound is generous enough that no real
   * meeting reaches it.
   */
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 8; i++) {
      await chain;
      if (!composing && !drainScheduled && queued === null) return;
    }
    await chain;
  };

  /**
   * Turns the engine has changed its mind about since the last time this
   * session acted on a batch. Filled straight off the wire and drained on
   * the compose chain, because the whole point is to land AFTER whatever is
   * composing — that compose read the old labels and would otherwise write
   * them back over the correction.
   */
  const revisedTurns = new Map<number, string | null>();
  let reattributionQueued = false;

  const applyRevisions = (): void => {
    reattributionQueued = false;
    const revisions = new Map(revisedTurns);
    revisedTurns.clear();
    // A turn that has fallen back into `carry` since the revision arrived is
    // one whose compose FAILED: its words are not in the doc, and it will
    // compose under the new label by itself. Correcting words nobody has
    // read yet is nothing, so it leaves the batch here rather than becoming
    // a rewrite that finds no mention.
    for (const [turn, speaker] of [...revisions]) {
      const at = carry.findIndex((c) => c.turn === turn);
      if (at < 0) continue;
      const carried = carry[at]!;
      carry[at] = {
        turn: carried.turn,
        text: carried.text,
        ...(speaker !== null ? { speaker } : {}),
      };
      revisions.delete(turn);
    }
    if (revisions.size === 0) return;
    // The doc is the only copy of the notes now, so the rewrite happens there
    // and nowhere else — `applyNotesReattribution` on the sink side. This used
    // to run the same pass over a session-local mirror first, which is exactly
    // the second source of truth the rebuild removed.
    deps.onReattribute?.({
      docId: ids.docId,
      meetingId: ids.meetingId,
      revisions,
      names: { ...names },
    });
  };

  const ticker = createPauseTicker({
    quietMs: deps.quietMs ?? DEFAULT_NOTES_QUIET_MS,
    cadenceMs: deps.cadenceMs ?? DEFAULT_NOTES_CADENCE_MS,
    endpointConfirmMs: deps.endpointConfirmMs ?? DEFAULT_NOTES_ENDPOINT_CONFIRM_MS,
    ...(deps.schedule ? { schedule: deps.schedule } : {}),
    onTick: composeTick,
    onRevised: ({ turn, speaker }) => {
      revisedTurns.set(turn, speaker ?? null);
      // ONE chain step for the whole batch, however many turns it names. The
      // engine sends a `SpeakerRevision` as a single message and the adapter
      // re-emits it turn by turn in a synchronous loop, so every turn of the
      // batch is in the map before this step runs — and a mention whose
      // turns disagree is then seen disagreeing, rather than being moved by
      // the first revision and marked unsure by the second.
      if (reattributionQueued) return;
      reattributionQueued = true;
      chain = chain.then(applyRevisions);
    },
  });

  return {
    onTurn: (turn) => {
      if (turn.speaker !== undefined) seen.add(turn.speaker);
      if (turn.final) settledTurns.add(turn.turn);
      // Stamped on the FIRST frame of a turn, not the last. A ceiling tick
      // carries words out of a turn still being spoken, and the latency
      // those words are owed is counted from when they were said.
      if (!settledAtOf.has(turn.turn)) settledAtOf.set(turn.turn, clock());
      ticker.onTurn(turn);
    },
    nameSpeaker(speaker, name) {
      // Read the OLD display name before the map moves — that is the string
      // the composer actually wrote, whether it was "Speaker B" or an
      // earlier name being corrected.
      const from = speakerDisplayName(speaker, names);
      names[speaker] = name;
      const to = speakerDisplayName(speaker, names);
      if (from === to) return;
      // Two voices can be called the same thing — two people named Alex, or
      // a slip. Then the WORDS "Alex" in the notes do not say which of them,
      // and rewriting them would silently reattribute the other's speech.
      // A TAGGED mention is not in that position: it carries the label, so
      // it renames whatever the display names collide to. So ambiguity no
      // longer refuses the retroactive rewrite — it narrows it to the
      // mentions that can prove which voice they are.
      const ambiguous = [...seen, ...Object.keys(names)].some(
        (label) => label !== speaker && speakerDisplayName(label, names) === from,
      );
      if (ambiguous) {
        deps.onError?.(
          `notes: "${from}" is more than one voice, so only tagged mentions of ` +
            `${speaker} were renamed`,
        );
      }
      // On the chain, behind any compose in flight: that compose is still
      // going to return edits written with the old name (it read the outline
      // before the rename), and the rewrite has to land after it, not under
      // it. Every later tick then reads an outline that already says the new
      // name, so it never comes back.
      chain = chain.then(() => {
        deps.onRelabel?.({
          docId: ids.docId,
          meetingId: ids.meetingId,
          label: speaker,
          from,
          to,
          rewriteUntagged: !ambiguous,
        });
      });
    },
    async end(): Promise<void> {
      ticker.end();
      await settle();
      if (carry.length > 0) {
        // The last compose before the end failed and nothing after it could
        // retry. One more attempt; if this one fails too the words stay in
        // the transcript record and the notes go without them.
        composeTick({ tick: lastTickNo + 1, reason: 'end', turns: [] });
        await settle();
      }
      if (refusedTooLong > 0) {
        deps.onError?.(
          `${ids.docId} meeting ${ids.meetingId}: ${refusedTooLong} of this meeting's ` +
            'notes composes were refused as too long — the notes stopped keeping up',
        );
      }
      // The last settle of the meeting. Nothing follows it that could retry
      // an idea, so what the notes do not carry now is lost — including the
      // ideas of the final pass, which have never been judged before.
      let finalNotes = '';
      // Only when there is something to judge. A meeting that settled every
      // idea as it went would otherwise pay a doc read at the stop and, worse,
      // EMIT one — the outline read is an observable step that two tests pin
      // the order of, and a spare one at the end is a behaviour change bought
      // for nothing.
      if (ideas.pending > 0) {
        try {
          finalNotes = (deps.readOutline?.({ docId: ids.docId, meetingId: ids.meetingId }) ?? [])
            .map((e) => e.text)
            .join('\n');
        } catch (err) {
          // Same rule as every other outline read: it informs, it never fails
          // the meeting. With none, every pending idea reads as lost, which is
          // the honest answer when nobody can say what the notes contain.
          deps.onError?.(err instanceof Error ? err.message : 'notes outline read failed');
        }
      }
      ideas.close(finalNotes);
      // NOT an `onError`. A lost idea is a measurement, not a stage that
      // threw: the deterministic check is a proxy (`notes-idea-coverage.ts`)
      // and every caller treats `onError` as "something in the pipeline
      // broke". It rides the summary line instead, where the meeting's other
      // coverage numbers are, and `meeting-notes-doc.ts` decides whether that
      // line is a warning.
      const turnsLost = [...settledTurns].filter((t) => !composedTurns.has(t)).length;
      // Written to the timing file as its last line, and carried into the
      // meeting summary so the one line everybody already reads names the
      // number the ticket is about.
      const latencies = (timing?.rows() ?? [])
        .map((r) => r.settledToWrittenMs)
        .filter((v): v is number => v !== null);
      timing?.summary();
      deps.onMeetingSummary?.({
        docId: ids.docId,
        meetingId: ids.meetingId,
        ticks: lastTickNo,
        turnsSettled: settledTurns.size,
        turnsComposed: composedTurns.size,
        turnsLost,
        ideas: { ...ideas.coverage },
        composeFailures,
        refusedTooLong,
        ...(latencies.length > 0
          ? {
              latencyMedianMs: median(latencies) ?? 0,
              latencyWorstMs: Math.max(...latencies),
            }
          : {}),
      });
    },
    stats: () => ({
      composeFailures,
      refusedTooLong,
      turnsSettled: settledTurns.size,
      turnsComposed: composedTurns.size,
      ideas: { ...ideas.coverage },
    }),
  };
}
