/**
 * ── The meetings, wired ──
 *
 * Every meeting-shaped thing this server runs, built in one place: the
 * meeting store and its raw companion, voice feedback on a page, the
 * planning meeting's ears, the microphone relay with its notes pipeline, the
 * Recall bot relay and the "Claude, …" it answers to, and calendar join.
 *
 * Moved whole out of `createServer`, which calls it from the position the
 * block held: BEFORE the doc store, because the doc store asks the meeting
 * store whether a doc is recording (`isRecording`). Everything the block
 * reached that is built later — the stores, the projection, the board
 * membership verbs, the ready-work nudger, the spoken board, the plan
 * minutes — it reached through a thunk or a closure that runs only once a
 * meeting starts, long after `createServer` has returned. `late` is those
 * same reads, named; each getter reads its one value when called, never at
 * wiring time, so the order constraint is exactly the one the inline block
 * had.
 *
 * `dispose` is the teardown `stop()` ran inline, in the same order, and is
 * awaited from the same place: after the sockets close (their handlers write
 * the last sentence into the doc) and before the doc store flushes.
 *
 * The moved lines are unchanged except for those reads: `docStore.x` is
 * `late.docStore().x`, `landingChanges.notify` is `notifyLanding`, and the
 * anonymous actor's colour arrives as a value.
 */
import { hashToColor } from '@claude-workspaces/core';
import type { User } from '@claude-workspaces/core';
import { ownerIdentityIds } from './actor-identity.ts';
import type { BoardMembership } from './board-membership.ts';
import { parseDocKey } from './doc-key.ts';
import type { DocStore } from './doc-store.ts';
import { spokenReviewComment } from './huddle.ts';
import type { LandingPart } from './landing-changes.ts';
import { createMeetingClaude } from './meeting-claude.ts';
import { meetingFilingFor } from './meeting-home.ts';
import type { LookupDoc } from './meeting-lookup.ts';
import { withServerNotesSinks } from './meeting-notes-doc.ts';
import { createServerNotesDocMint } from './meeting-notes-target.ts';
import { MeetingRelay } from './meeting-protocol.ts';
import { MEETING_CAPTURE_ACTOR } from './meeting-task-capture.ts';
import { MeetingStore } from './meetings.ts';
import type { MountStore } from './mount-store.ts';
import { spokenLinkRef } from './notes-link-intent.ts';
import { writeNotesMethod } from './notes-method-store.ts';
import { fileOnMeetingDoc } from './notes-quality-review.ts';
import type { ReadyWorkNudger } from './ready-nudge.ts';
import { CalendarConnectionStore, CalendarSyncConsumer } from './recall-calendar.ts';
import { RecallMeetingRelay } from './recall-meeting.ts';
import { unreachableCallbackReason } from './recall.ts';
import type { ServerOptions } from './server-options.ts';
import type { SpokenBoard } from './spoken-reply/answer.ts';
import { LeadAnswers } from './spoken-reply/lead-answer.ts';
import { MeetingEars } from './spoken-reply/meeting-ears.ts';
import type { PlanMinutes } from './spoken-reply/plan-minutes.ts';
import type { SseBus } from './sse.ts';
import type { TaskProjection } from './task-projection.ts';
import type { TaskStore } from './tasks.ts';
import type { TranscriptionEngine } from './transcribe.ts';
import { VoiceFeedbackRelay } from './voice-feedback-relay.ts';

/** The reads of values `createServer` builds after this runs. Each is
 *  called only once a meeting, a page or a bot is live. */
export interface MeetingLateDeps {
  docStore: () => DocStore;
  taskStore: () => TaskStore;
  taskProjection: () => TaskProjection;
  mountStore: () => MountStore;
  readyNudger: () => Pick<ReadyWorkNudger, 'taskReady'>;
  spokenBoard: () => SpokenBoard;
  planMinutes: () => Pick<PlanMinutes, 'place'>;
  fileUnderBoardWorkspace: BoardMembership['fileUnderBoardWorkspace'];
  backTargetFor: (docId: string) => { id: string } | null | undefined;
  /** The Review ask, filed (`fileReviewRequest` in `createServer`). */
  fileReviewRequest: (
    docId: string,
    author: User,
    text: string,
  ) => Promise<{ threadId: string; requestedAt?: number } | null>;
  /** The board's docs as a lookup ask sees them. */
  lookupDocs: (workspaceId: string, exceptDocId: string) => LookupDoc[];
}

export interface MeetingWiringDeps {
  dataDir: string;
  opts: ServerOptions;
  sse: SseBus;
  notifyLanding: (part: LandingPart) => void;
  /** The hostname Recall's callbacks are addressed to, if any. */
  recallCallbackHost: string | null;
  /** The effective Access-fronted hostnames, after the verifier. */
  proxiedTrustedHosts: readonly string[];
  /** The colour an unattributed or server-filed author is drawn in. */
  anonymousColor: string;
  late: MeetingLateDeps;
}

export function wireMeetings(deps: MeetingWiringDeps) {
  const { dataDir, opts, sse, notifyLanding, recallCallbackHost, proxiedTrustedHosts } = deps;
  const { anonymousColor, late } = deps;
  // Same opt-in seam: no engine here means no socket can start a billed
  // streaming session. See ServerOptions.transcription.
  const meetingStore: MeetingStore = new MeetingStore(dataDir, {
    // The raw companion's tie back to the doc: bound path and title as they
    // are at meeting start and stop. A thunk over `docStore`, which is
    // constructed below; a meeting can only start long after it exists.
    docInfo: (docId) => {
      const path = late.docStore().boundPathOf(docId);
      const title = late.docStore().peekMeta(docId)?.title;
      return { ...(path ? { path } : {}), ...(title ? { title } : {}) };
    },
    /**
     * What the doc's project keeps, asked once as each meeting starts.
     *
     * The PROJECT's answer, found two ways because a meeting reaches its
     * project by two roads: the filing record names it for a meeting this
     * server opened, and the doc's own identity key names it for a recording
     * made over an ordinary bound project file. Neither, and the meeting
     * keeps everything — the default a project that has never been asked has
     * always had.
     *
     * The project's CURRENT choice rather than the one stamped on the filing:
     * a project that turned transcripts off means the meeting starting now,
     * and a snapshot taken the day the doc was created would keep writing
     * words it has since said it does not want.
     */
    retention: (docId) => {
      const filed = meetingFilingFor(dataDir, docId)?.repoKey;
      const own = late.docStore().repos.primaryKeyFor(docId);
      const repoKey = filed ?? (own ? parseDocKey(own)?.repoKey : undefined);
      return (
        (repoKey ? late.mountStore().meetingsOf(repoKey)?.retention : undefined) ??
        'transcripts-and-audio'
      );
    },
  });
  /**
   * Voice feedback on a page: the same engines a meeting opens, and a tidier
   * that turns what was said into comments. Both seams default to nothing,
   * for the reason `transcription` does — see server-options.ts.
   */
  const voiceRelay = new VoiceFeedbackRelay({
    engines: Array.isArray(opts.transcription)
      ? opts.transcription
      : opts.transcription
        ? [opts.transcription as TranscriptionEngine]
        : [],
    tidy: opts.voiceFeedbackTidy ?? null,
    // A clarifying question is said in the board reply's setup-1 voice.
    voice: opts.spokenReply?.voices[1] ?? null,
    dataDir,
    // Read when a page has gone, long after `docStore` below exists.
    keep: {
      listThreads: (docId) => late.docStore().listThreads(docId),
      postComment: (docId, threadId, author, text, anchor, o) =>
        late.docStore().postComment(docId, threadId, author, text, anchor, o),
      editCommentText: (docId, threadId, commentId, text, o) =>
        late.docStore().editCommentText(docId, threadId, commentId, text, o),
    },
    ...(opts.voiceKeepGraceMs !== undefined ? { keepGraceMs: opts.voiceKeepGraceMs } : {}),
    log: (line) => console.log(line),
  });
  // A planning meeting's transcript, lent to the planning voice on its doc.
  const meetingEars = new MeetingEars();
  const meetingRelay = new MeetingRelay({
    store: meetingStore,
    engines: Array.isArray(opts.transcription)
      ? opts.transcription
      : opts.transcription
        ? [opts.transcription as TranscriptionEngine]
        : [],
    // The server supplies the notes sink — the write into the meeting doc —
    // and the context resolver (doc title, board task titles). Thunks, not
    // references: the doc store and the task store are constructed below, and both
    // exist long before any meeting can start.
    notes: opts.meetingNotes
      ? withServerNotesSinks(opts.meetingNotes, {
          docStore: late.docStore,
          tasks: late.taskStore,
          // The meeting namer's reads and its guarded title write.
          titleStore: late.docStore,
          // A meeting on a person's own doc writes its notes into a doc of
          // its own, linked from the original in one line
          // (`meeting-notes-target.ts`). Thunks for the reason above.
          mintNotesDoc: createServerNotesDocMint(
            {
              createForCaller: (requested, init) =>
                late.docStore().createForCaller(requested, init),
              attachFile: (docId, file) => late.docStore().attachFile(docId, file),
              fileUnderBoard: (docId, requested) => late.fileUnderBoardWorkspace(docId, requested),
              boardOf: (docId) => late.backTargetFor(docId)?.id,
            },
            dataDir,
          ),
          // One reader: the legacy-transcript removal, which must not take a
          // `Raw transcript` heading out of a doc bound into somebody's
          // working tree, where the old note-taker never wrote one.
          dataDir,
          // The capture pipeline's board writes, and the "go do it" wake —
          // the same immediate addressed delivery an answered review item
          // gets. Both close over consts declared below; a meeting can only
          // start long after createServer has returned.
          captureBoard: late.taskStore,
          // Where a meeting whose notes came out badly is reported: a review
          // item on the row the meeting's doc is linked to, or on the doc
          // itself when no row links it. Same stores, same thunk reason as
          // `captureBoard`.
          qualityBoard: () => ({
            backlinksFor: (ref) => late.taskStore().backlinksFor(ref),
            addReviewItem: (taskId, review, o) => late.taskStore().addReviewItem(taskId, review, o),
            fileOnDoc: (docId, review, actor) =>
              fileOnMeetingDoc(late.docStore(), docId, review, actor),
            // A meeting that crosses another bar after its item exists
            // rewrites those words rather than raising a second ask. The
            // same two revise paths every other server-filed item uses.
            reviseReviewItem: (taskId, itemId, patch, o) =>
              late.taskStore().reviseReviewItem(taskId, itemId, patch, o),
            reviseOnDoc: (docId, threadId, commentId, patch, actor) =>
              late.docStore().reviseCommentReview(docId, threadId, commentId, patch, {
                // Only the NAME reaches the revision stamp; the rest is the
                // `User` shape the doc side takes.
                actor: {
                  id: actor.id,
                  name: actor.name,
                  kind: 'known',
                  color: hashToColor(actor.name),
                },
              }),
            // And a meeting that ends past no bar takes its item back, so a
            // reading one recording leg produced cannot stand as a claim
            // about a meeting that went on to read clean. The asker's own
            // exit on both surfaces — soft, reversible, and the words a
            // person replied with are untouched.
            withdrawReviewItem: (taskId, itemId, o) =>
              late.taskStore().withdrawReviewItem(taskId, itemId, o),
            withdrawOnDoc: (docId, threadId, commentId, reason, actor) =>
              late.docStore().withdrawCommentReview(docId, threadId, commentId, {
                actor: {
                  id: actor.id,
                  name: actor.name,
                  kind: 'known',
                  color: hashToColor(actor.name),
                },
                reason,
              }),
          }),
          // Where "pull up last week's notes" looks. Board docs and when
          // each last carried a meeting; the meeting's own doc is dropped
          // by the caller, since "the last meeting" means the one before.
          lookup: { docs: (workspaceId, exceptDocId) => late.lookupDocs(workspaceId, exceptDocId) },
          onTaskReady: (wake) =>
            late.readyNudger().taskReady({
              workspaceId: wake.workspaceId,
              taskId: wake.taskId,
              taskTitle: wake.title,
            }),
          // "Link that to the existing task", heard: the row gains the same
          // ref `link_refs` writes, so the meeting is findable from the row
          // and unlinking has something to remove. Link changes emit no store
          // event, so the projection is refreshed by hand — the same pattern
          // the link-refs route uses.
          linkTaskToDoc: (taskId, docId) => {
            const linked = late.taskStore().linkRef(taskId, spokenLinkRef(docId));
            if (!linked.ok) {
              console.error(`[meeting-tasks] spoken link refused for ${taskId}: ${linked.error}`);
              return;
            }
            if (linked.changed) late.taskProjection().refreshTask(linked.task);
          },
          // A huddle doc is HELD by a board workspace rather than owned by one
          // (no `setId`), which is where "create a task" said aloud used to
          // go quiet: the capture had no board. The doc's back-target is the
          // same answer the doc page's back arrow gives.
          boardOf: (docId) => late.backTargetFor(docId)?.id,
          // "Ask the team whether…" — filed exactly as the Review float's
          // press is, with the question attached, by the meeting assistant.
          onReviewAsk: async ({ docId, question, requester }) => {
            const filed = await late.fileReviewRequest(
              docId,
              {
                id: MEETING_CAPTURE_ACTOR.id,
                name: MEETING_CAPTURE_ACTOR.name,
                kind: 'known',
                color: anonymousColor,
              },
              spokenReviewComment(question, requester),
            );
            if (!filed) console.error(`[meeting-tasks] review ask on ${docId}: doc not found`);
          },
        })
      : null,
    // Lifecycle only. The words never touch this bus — see meeting-protocol.
    broadcast: (docId, payload) => sse.broadcast(docId, payload),
    // Which note-taker this doc uses, changed while it is recording. The
    // same write the at-rest route makes, so the two halves of one choice
    // cannot disagree about where the answer is kept.
    setNotesMethod: (change) => {
      try {
        writeNotesMethod(dataDir, change.docId, {
          method: change.method,
          at: Date.now(),
          ...(change.by ? { by: change.by } : {}),
          ...(change.meetingId ? { meetingId: change.meetingId } : {}),
        });
        return true;
      } catch (err) {
        // The method is a preference, never a dependency of taking notes: a
        // record that cannot be written leaves the doc on the method it had
        // and the meeting composing. Answering `false` is what keeps the
        // notes from claiming the switch anyway.
        console.error(`[meeting-notes] notes method not recorded for ${change.docId}:`, err);
        return false;
      }
    },
    ears: meetingEars,
  });
  /**
   * The bot path into the SAME pipeline. It gets the relay's own notes deps
   * rather than a second set built from the same options: two sets would be
   * two ownership ledgers over one doc's notes section, and the ledger is
   * what stops a tick from eating what a person typed.
   */
  /**
   * Is the address we would hand Recall one this server itself refuses?
   *
   * Computed here rather than in bin.ts because the effective host lists are
   * here — `proxiedTrustedHosts` above is already the post-verifier one — and
   * because a server spun up any other way (staging, a test) deserves the
   * same answer. Null means nothing known says the callbacks are unreachable.
   */
  const recallUnreachable = unreachableCallbackReason({
    wsBase: opts.meetingBot?.config.publicWsBase ?? null,
    callbackHost: recallCallbackHost,
    accessGatedHosts: [...proxiedTrustedHosts, ...(opts.accessTunnelHosts ?? [])],
  });
  if (recallUnreachable) console.error(`[meetings] bots are OFF: ${recallUnreachable}`);
  // Who waits for which lead answer: a spoken-reply socket or a bot meeting.
  const leadAnswers = new LeadAnswers();
  const recallRelay = new RecallMeetingRelay({
    store: meetingStore,
    notes: meetingRelay.notesDeps,
    client: opts.meetingBot ?? null,
    unreachable: recallUnreachable,
    broadcast: (docId, payload) => sse.broadcast(docId, payload),
    // The bot's words DO touch this bus — unlike the microphone's — because a
    // bot has no socket to any browser. Transient: live fan-out, no buffer,
    // no id, so the replay window stays the doc's (see SseBus).
    broadcastTransient: (docId, payload) => sse.broadcastTransient(docId, payload),
    // "Claude, …" from the owner in a bot meeting. The board it answers from
    // is the spoken reply's, built further down, so it is read when asked.
    claude: createMeetingClaude({
      enabled: opts.meetingClaude === true,
      ownerEmail: opts.ownerEmail,
      client: opts.meetingBot ?? null,
      voice: opts.spokenReply?.meetingVoice ?? null,
      board: late.spokenBoard,
      boardOf: (docId) => late.backTargetFor(docId)?.id,
      ownerId: () => ownerIdentityIds()[0] ?? 'owner',
      notesOf: (docId) => late.docStore().readMarkdownBody(docId),
      leads: leadAnswers,
      planMinute: (docId, markdown, about) => late.planMinutes().place(docId, markdown, about),
    }),
  });
  /**
   * Calendar meeting-join, beside the relay whose invite path a join click
   * takes. The store survives restarts because the webhook consumer must
   * recognise the connected calendar after one, and a join that lasted only
   * until the next deploy would orphan the doc it opened.
   */
  const calendarStore = opts.calendarBot ? new CalendarConnectionStore(dataDir) : null;
  const calendarSync =
    opts.calendarBot && calendarStore
      ? new CalendarSyncConsumer({
          client: opts.calendarBot.client,
          store: calendarStore,
          // A cancelled meeting somebody joined: the bot goes home through
          // the same leave the doc's own button uses.
          onCancelledJoin: async (_eventId, docId) => {
            await recallRelay.leave(docId);
          },
          onSynced: () => notifyLanding('meeting'),
        })
      : null;
  // A meeting joined or left, from any device: the banner on `/` re-reads.
  if (calendarStore) calendarStore.onChange = () => notifyLanding('meeting');
  /**
   * CSRF states for the Google connect flow, minted at /connect and spent at
   * /callback. In memory on purpose: a state that did not survive a restart
   * only costs the person one more click on Connect.
   */
  const calendarOauthStates = new Map<string, number>();

  return {
    meetingStore,
    voiceRelay,
    meetingEars,
    meetingRelay,
    leadAnswers,
    recallRelay,
    calendarStore,
    calendarSync,
    calendarOauthStates,
    /** The three relays' teardown, in the order `stop()` ran it. */
    dispose: async (): Promise<void> => {
      await meetingRelay.dispose();
      await voiceRelay.dispose();
      // And the bots. A bot left in a call after this process is gone bills
      // two vendors and delivers nothing — see RecallMeetingRelay.dispose.
      await recallRelay.dispose();
    },
  };
}

export type MeetingWiring = ReturnType<typeof wireMeetings>;
