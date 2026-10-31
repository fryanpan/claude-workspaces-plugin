import type { DocMeta, TaskReviewItem, User } from '@claude-workspaces/core';
import { classifyActor } from '../actor-identity.ts';
import type { AgentNoteLog } from '../agent-note-log.ts';
import type { AgentNoteInput, AgentNoteRing } from '../agent-notes.ts';
import type { AnswerCoverage } from '../answer-coverage.ts';
import type { ChatAudit } from '../chat-audit.ts';
import type { DispatchRegistry } from '../dispatch-registry.ts';
import type { DispatchReportStore } from '../dispatch-reports.ts';
import type { DocStore } from '../doc-store.ts';
import { taskDeepLink } from '../home-brief.ts';
import type { IdentityRecord } from '../identities.ts';
import type { LeadChat } from '../lead-chat/lead-chat.ts';
import type { LeadSessionMirror } from '../lead-chat/mirror.ts';
import type { ShareTarget } from '../middleware/host-guard.ts';
import type { WorkspaceScope } from '../middleware/workspace-scope.ts';
import { writeViaOf } from '../mockup-frame.ts';
import type { PermissionGrants } from '../permission-grants.ts';
import type { ReadyWorkNudger } from '../ready-nudge.ts';
import type { GateRunOpts, ReviewGate } from '../review-gate-types.ts';
import type { AnswerProofInputs } from '../review-items/answer-proof.ts';
import type { SecretWriter } from '../secret-store.ts';
import type { AccessProposals } from '../share/access-proposals.ts';
import { type BoardRole, refuseOwnerOnlyWrite } from '../share/board-role.ts';
import type { TaskProjection } from '../task-projection.ts';
import type { BoardWorkspace, ParallelismCapChange, Task, TaskStore } from '../tasks.ts';

/**
 * The review-item quality gate's verdict on one item — held, or through.
 *
 * Re-exported rather than declared: the gate that PRODUCES it is
 * `review-gate.ts`, a service, and a service may not import a type out of
 * `routes/`. It is re-exported here so a route still reads its vocabulary off
 * the context module it already imports. `heldFields` below is deliberately
 * typed to the narrower of the two verdict shapes, so a task route cannot
 * come to depend on the comment-borne `ThreadReviewGate`.
 */
export type { ReviewGate };

/** The parallelism cap as a route reads it — the number, who is holding it,
 *  and who last moved it. `undefined` for a workspace that has none. */
export interface ParallelismCapView {
  cap: number;
  isDefault: boolean;
  default: number;
  inUse: number;
  free: number;
  holders: Array<{ taskId: string; title?: string; agentName?: string }>;
  lastChange?: ParallelismCapChange;
}

/** The long-lived collaborators, built once per server. */
export interface TaskRoutesContext {
  /** The board task store — workspaces, tasks, review items, the gate. */
  taskStore: TaskStore;
  /** The ydoc projection of the store; refreshed by hand after the writes
   *  that emit no store event (links, goal placement, archive-in-place). */
  taskProjection: TaskProjection;
  /** Doc store — read for a batch's source doc and written when an ask-back
   *  turns a question into a thread. */
  docStore: DocStore;
  /** Open builder dispatches and their worktree watchers. */
  dispatches: DispatchRegistry;
  /** The closing reports builders file on the builds they finished. Separate
   *  from `dispatches` because it outlives one: a report is read after the
   *  lane it describes has been released. */
  dispatchReports: DispatchReportStore;
  /** The per-agent ring of turn / denial / status notes. */
  agentNotes: AgentNoteRing;
  /** The durable, per-board record of notes no row would take. The ring is
   *  in-process and bounded; this is what survives a restart. */
  agentNoteLog: AgentNoteLog;
  /** The unfiled-ask counters. The hook route is the only writer of the live
   *  rows; the chat-audit routes read them and take the daily audit's. */
  chatAudit: ChatAudit;
  /** The coach session, which the coaching skill forbids review items, is
   *  never nudged to file one (`coach/wiring.ts`). */
  isCoachSession: (workspaceId: string, agentName: string) => boolean;
  /** A turn note counted as the owner's Claude Code time in the coach's
   *  digest (`coach/session-minutes.ts`), its text summarised there. */
  coachSessionTurn: (workspaceId: string, note: AgentNoteInput, cwd: unknown) => void;
  /** A prompt mark (typed or injected; a typed one's text; whether it came
   *  through Remote Control) for the same digest. */
  coachSessionPrompt: (
    workspaceId: string,
    mark: {
      agent: string;
      typed: boolean;
      at: number;
      sessionId?: string;
      text?: string;
      remote?: boolean;
    },
    cwd: unknown,
  ) => void;
  /** The board's lead chat, which mirrors the lead's own session: the
   *  prompts it took and the message each turn ended on. */
  leadChatMirror: Pick<LeadChat, 'mirrorPrompt' | 'mirrorTurnEnd' | 'isLead'>;
  /** The same chat's view of the text the lead's session writes mid-turn
   *  and the tools it calls (`routes/lead-mirror.ts`). */
  leadSessionMirror: Pick<LeadSessionMirror, 'text' | 'tools'>;
  /** Wakes the lead when a row it owns becomes ready. */
  readyNudger: ReadyWorkNudger;

  /**
   * Store one value the board's owner handed over, under one name.
   *
   * **No default**, the same seam rule the summarizer and the review judge
   * follow, and here it is doing more work than either: the real writer talks
   * to the machine's Keychain, so a default would mean the server suite
   * writing entries into a developer's own store on the way past. Omitted,
   * the secrets door answers 503 and no command runs. `bin.ts` — the entry
   * point that starts a real server, staging included — is what wires it.
   *
   * Injected as a function rather than reached for directly so a test can
   * assert WHERE the value went, which is the one property that matters
   * about this whole path.
   */
  secretWriter?: SecretWriter;
  /**
   * The ledger and writer behind a grant card's Approve. **No default**, the
   * secret writer's seam rule for the same reason: the real one edits the
   * owner's user settings file, so only `bin.ts` constructs it. Omitted, the
   * grant door answers 503 to an approval and nothing is written.
   */
  permissionGrants?: PermissionGrants;
  /** Applies an access item the owner approved (`routes/task-access.ts`).
   *  Omitted, the access door answers 503 and nothing changes. */
  accessProposals?: AccessProposals;
  /**
   * Whether an answer covered every question an item asks. **No default**,
   * the judge's seam rule; omitted, every answer closes its item as before.
   */
  answerCoverage?: AnswerCoverage;

  /** JSON response helper — status plus body, no CORS (the per-request
   *  wrapper in createServer adds that, because it knows the Origin). */
  j: (status: number, body: unknown) => Response;
  /** Parse a request body, answering null rather than throwing. */
  safeJson: (req: Request) => Promise<Record<string, unknown> | null>;
  /** Attribution for a write that arrived with no author at all. */
  ANONYMOUS_ACTOR: User;

  /** Parse a revise route's optional `revisedRange`. */
  parseRevisedRange: (
    raw: unknown,
  ) => { ok: true; range?: { start: number; end: number } } | { ok: false; error: string };
  /** Tell the addressee a review item is waiting on them. */
  announceTaskReview: (task: Task, item: TaskReviewItem, author: User) => void;
  /** Turn a question typed where an answer goes into a thread on the item. */
  askBackOnItem: (
    task: Task,
    item: TaskReviewItem,
    text: string,
    author: User,
    visitor: boolean,
  ) => Promise<Response>;
  /** doc id → the boards holding it, built once per request that needs it. */
  boardIndexForListing: () => Map<string, string[]>;
  /**
   * Every workspace an id belongs to — `shareWorkspacesOf`, the same resolver
   * the host guard scopes paths with.
   *
   * Here it answers the question the guard cannot: a cross-reference names
   * its target in the BODY, so no path check ever saw it. See
   * `share/ref-scope.ts`.
   */
  workspacesOfDoc: (id: string) => string[];
  /** The response fields a filing route adds when the gate held the item. */
  heldFields: (gate: ReviewGate | undefined) => Record<string, unknown>;
  /** "alice on \"Ship the thing\", bob on t-2" — the cap refusal's sentence. */
  holdersClause: (
    holders: ReadonlyArray<{ taskId: string; title?: string; agentName?: string }>,
  ) => string;
  /** Which boards hold a doc, answered off a prebuilt index. */
  boardsForDocIndexed: (index: Map<string, string[]>, meta: DocMeta) => Set<string>;
  /**
   * The base every link this server hands a reader is built on. Optional so a
   * test context can leave it out; a done-when proof's board path is then
   * refused rather than made absolute.
   */
  externalBaseUrl?: () => string;
  /** Put a filed or revised review item through the quality gate. */
  judgeReviewItem: (
    task: Task,
    item: TaskReviewItem,
    author: { id: string; name: string; kind?: string },
    /** `lessSpecific`: the filer's own reason why the honest answer is less
     *  specific than a standing hold asked for. Acted on only when the item
     *  is held. */
    runOpts?: GateRunOpts,
  ) => Promise<ReviewGate>;
  /** The same gate for a ticket that IS a decision; `undefined` when the
   *  ticket is not one, so a caller cannot report a judgement never made. */
  judgeTaskDecision: (
    task: Task,
    author: { id: string; name: string; kind?: string },
    runOpts?: GateRunOpts,
  ) => Promise<ReviewGate | undefined>;
  /** One hold out of a filed item's and the ticket decision's. */
  mergedHold: (
    filed: ReviewGate | undefined,
    decision: ReviewGate | undefined,
  ) => ReviewGate | undefined;
  /** How many builders the board may run, and who is holding the slots. */
  parallelismCapView: (
    workspaceId: string,
    excludeTaskId?: string,
  ) => ParallelismCapView | undefined;
  /** File an allow-rule proposal off a denial note. */
  proposeAllowRule: (
    task: Task,
    note: { kind: string; text: string; agent: string; at: number },
  ) => void;
  /** Re-judge a ticket's own decision after its words moved. */
  regateDecisionWords: (taskId: string, author: User) => Promise<void>;
  /** Replace a task's body markdown through the body doc. */
  rewriteTaskBody: (
    task: Task,
    markdown: string,
    opts: {
      actor?: { id: string; name: string; kind?: string };
      title?: string;
      reason?: string;
    },
  ) => { ok: true } | { ok: false; error: string };
}

/** What only this request knows. */
export interface TaskRouteRequest {
  /**
   * The board this canonical path named, and the remainder under it —
   * resolved once by `middleware/workspace-scope.ts`, which has already
   * refused an unknown board and a member filed on a different one.
   *
   * `undefined` when the path is not under `/workspaces/<id>/…` at all, and
   * that is what makes the resolution structural rather than remembered: a
   * resource route matches through `matchRest`, so with no scope it has no
   * remainder to match and cannot answer. Read `scope.workspaceId` for the
   * board rather than a body field — the path is the argument now.
   */
  scope?: WorkspaceScope<BoardWorkspace>;

  req: Request;
  pathname: string;
  url: URL;
  /** The share target this request resolved to, or null for a member. Every
   *  route that refuses share visitors reads this and nothing else. */
  visitor: ShareTarget | null;
  /** The author this request is allowed to claim, from its body's `author`
   *  plus whatever the session, widget token or roster proves. */
  authorFor: (claimed: unknown) => User | undefined;
  /** The 400 for an author that names a category rather than a person. */
  refuseCategoryAuthor: () => Response;
  /** What this caller may DO on a board: `owner` or `member`. Resolved once
   *  by the admission gate; see `roleFor` there. */
  roleFor: (workspaceId: string) => BoardRole;
  /** The owner gate: `null` for the board's owner, the 403 for anyone else.
   *  Read by the owner-only review item — see `handleTaskReviewItems`. */
  requireOwner: (workspaceId: string) => Response | null;
  /** The board this request is that board's lead on (the admission gate's
   *  `leadBoard`, `middleware/lead-scope.ts`), or null/absent. */
  leadBoard?: string | null;
  /**
   * The PERSON this request proved — the Access email or the signed session
   * cookie — or null. Never a body's claim, a widget token or an agent
   * token. Read by the grant door, which `requireOwner` alone cannot guard:
   * that passes every loopback caller, agents included. Optional so a caller
   * that does not pass it fails closed.
   */
  provenIdentityFor?: () => IdentityRecord | null;
  /**
   * The origin this request was served on, scheme included — the origin
   * policy's `requestOrigin`. The grant door requires the browser's `Origin`
   * to equal it. A thunk, because only that door reads it. Optional so a
   * caller that does not pass it fails closed.
   */
  requestOriginFor?: () => string;
  /** What this request proved about a person, read by every door that
   *  records an answer (`review-items/answer-proof.ts`). Undefined refuses
   *  every person's answer. */
  answerProof?: AnswerProofInputs;
}

/**
 * Read the board's dispatchable rows BEFORE a person's write, and hand back
 * the call that says afterwards which rows that write FREED — see
 * `personFreedWork`. Call the returned function only once the write succeeded.
 *
 * A person makes work dispatchable without transitioning the work in more
 * ways than one, and every one of them is its own route: agreeing a goal band
 * or closing a blocker (the transition is on the goal row or the blocker),
 * removing an `after` edge, archiving a blocker, handing an unowned row to an
 * agent, moving a backlog row into a band. None is a transition on the row
 * that became ready, so without this each fell silent until the fifteen-minute
 * idle window. One helper rather than a copy per route, because the diff it
 * feeds is the board's own gate on both sides — a route only has to say where
 * its write is.
 *
 * Only for a person; an agent's move returns a call that does nothing, and
 * takes no reading at all. `classifyActor` resolves an undeclared author to
 * `agent`, the safe direction here, where a misread would wake the lead on
 * every builder's own edit. The mark is taken against the row's OWN board —
 * a task or a goal row, which share one id space — because that is the board
 * the release will be judged on.
 */
export function markPersonRelease(
  ctx: Pick<TaskRoutesContext, 'taskStore' | 'readyNudger'>,
  author: User,
  rowId: string,
): (except?: string) => void {
  if (classifyActor(author) !== 'person') return () => {};
  const workspaceId =
    ctx.taskStore.getTask(rowId)?.workspaceId ?? ctx.taskStore.getGoalRow(rowId)?.workspaceId;
  if (workspaceId === undefined) return () => {};
  const before = ctx.readyNudger.markReady(workspaceId);
  return (except) =>
    ctx.readyNudger.personFreedWork({
      workspaceId,
      before,
      ...(except !== undefined ? { except } : {}),
    });
}

/**
 * The absolute link that opens a task, for a make-or-attach answer's `url`.
 * Undefined for a share visitor, as a thread's `threadUrl` is, and for a
 * context built without a base (a test's).
 */
export function taskUrlFor(
  ctx: Pick<TaskRoutesContext, 'externalBaseUrl'>,
  workspaceId: string,
  taskId: string,
  isVisitor: boolean,
): string | undefined {
  const base = isVisitor ? undefined : ctx.externalBaseUrl?.();
  return base === undefined ? undefined : `${base}${taskDeepLink(workspaceId, taskId)}`;
}

/**
 * OWNER-ONLY ITEMS. An ask whose answer the owner's own machine then acts
 * on — running a command, handing over a credential — carries
 * `review.ownerOnly`, and every write onto it is the owner's: answering it,
 * rewording it, taking it off their queue, asking a question where the
 * answer goes. `refuseOwnerOnlyWrite` is the one reading of that rule, and
 * the doc-thread family calls the same function.
 *
 * The board comes off the SCOPE, not off the task record: the path is the
 * argument, and `middleware/workspace-scope.ts` has already refused a task
 * filed on a different board. Every caller matched through
 * `matchRest(scope, …)`, which matches nothing without a scope, so the
 * `?? ''` is a narrowing the compiler cannot see — and it fails CLOSED if
 * that ever stops being true (see `refuseOwnerOnlyWrite`).
 */
export function ownerOnlyDenial(
  ctx: Pick<TaskRoutesContext, 'taskStore'>,
  rq: Pick<TaskRouteRequest, 'scope' | 'req' | 'requireOwner'>,
  taskId: string,
  reviewItemId: string,
): Response | null {
  const review = ctx.taskStore.listReviewItems(taskId).find((r) => r.id === reviewItemId)?.review;
  // The host never relays one out of a mock (`mockup-linked-items.ts`);
  // `writeViaOf` holds if it ever does.
  return refuseOwnerOnlyWrite(
    review,
    rq.scope?.workspaceId ?? '',
    rq.requireOwner,
    writeViaOf(rq.req),
  );
}
