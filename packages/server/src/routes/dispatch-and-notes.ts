import { classifyActor } from '../actor-identity.ts';
import {
  AGENT_NOTE_RING_CAP,
  type AgentNoteInput,
  parseAgentNote,
  resolveNoteTarget,
} from '../agent-notes.ts';
import { SHARED_IDENTITY_ERROR, SHARED_IDENTITY_MESSAGE } from '../agent-watches.ts';
import { isSharedAgentName } from '../chat-audit.ts';
import { isValidDispatchTaskId } from '../dispatch-registry.ts';
import { recordDispatchRequested } from '../dispatch-request-event.ts';
/**
 * Builder dispatches, and the notes a session writes onto the row it holds.
 *
 * Lifted verbatim out of `createServer`'s request closure; the handlers
 * read their collaborators off `TaskRoutesContext` instead of the scope.
 */
import { matchRest, restIs } from '../middleware/workspace-scope.ts';
import { filingStateFor } from '../unfiled-ask-filing.ts';
import { judgeTurnNote } from '../unfiled-ask.ts';
import type { TaskRouteRequest, TaskRoutesContext } from './task-routes-context.ts';

/**
 * The window a turn note's "filed nothing this turn" is measured over when
 * the ring has no previous turn note for this agent — a restarted server, or
 * a session's first turn. Long enough to cover a slow turn, short enough that
 * yesterday's filing does not excuse today's ask.
 */
const FIRST_TURN_WINDOW_MS = 2 * 60 * 60_000;

/**
 * Judge a turn note as it arrives, and record the verdict.
 *
 * Runs for `kind: 'turn'` only — a denial or an explicit status is not a
 * message to the owner. The nudge it returns rides back on the 202 the hook
 * already reads; NOTHING is filed on the board, by the owner's instruction
 * (2026-09-10: build the count and the wake first, hold the filing until the
 * false-positive rate is known). The rate is in `docs/architecture/unfiled-ask.md`.
 *
 * It cannot fail the POST it runs inside. This whole judgement is an addition
 * to a route that worked without it — a full disk, a read-only data volume or
 * a board shape it has never seen must cost the caller its nudge and nothing
 * else. The note is already appended by the time this returns; losing the
 * activity note to a counter's write error would be a bad trade.
 */
function judgeAndRecord(
  ctx: TaskRoutesContext,
  workspaceId: string,
  note: AgentNoteInput,
): string | undefined {
  if (note.kind !== 'turn') return undefined;
  try {
    // The ring first (it has this board's placed notes too), then the
    // unplaced-note log, then the bounded window. The log is what makes the
    // boundary survive a restart: without it a restarted server measured
    // "filed nothing this turn" over two hours and could nudge an agent for
    // an ask it had filed inside them.
    const since =
      ctx.agentNotes.lastTurnAt(note.agent, workspaceId) ??
      ctx.agentNoteLog.lastTurnAt(workspaceId, note.agent) ??
      note.at - FIRST_TURN_WINDOW_MS;
    const filing = filingStateFor(ctx.taskStore, workspaceId, note.agent, since);
    const verdict = judgeTurnNote(note.text, filing, filing.owners);
    if (!verdict.ask) return undefined;
    ctx.chatAudit.recordLive({
      agent: note.agent,
      unfiled: verdict.nudge !== undefined,
      note: verdict.signals.map((sig) => sig.phrase).join(', '),
      workspaceId,
      ...(note.sessionId !== undefined ? { sessionId: note.sessionId } : {}),
    });
    return verdict.nudge;
  } catch (err) {
    console.error(`[unfiled-ask] judging a turn note failed: ${String(err)}`);
    return undefined;
  }
}

/** Answers the routes below, or `undefined` when the path is none of them. */
export async function handleDispatchAndNoteRoutes(
  ctx: TaskRoutesContext,
  rq: TaskRouteRequest,
): Promise<Response | undefined> {
  const {
    taskStore,
    dispatches,
    dispatchReports,
    agentNotes,
    agentNoteLog,
    j,
    safeJson,
    holdersClause,
    parallelismCapView,
    proposeAllowRule,
  } = ctx;
  const { req, scope, visitor, authorFor } = rq;
  // --- REST: builder dispatches ---
  // The lead's statement that a builder is working a task in a private
  // worktree, so the stall loop can read worktree churn as the row
  // moving. POST registers {taskId, worktreePath} (re-POST replaces);
  // DELETE /workspaces/<ws>/dispatches/<taskId> closes on terminal. The registry
  // validates paths and prunes dispatches whose worktree is gone. See
  // dispatch-registry.ts.
  if (restIs(scope, 'dispatches')) {
    // Same defense-in-depth posture as the agent-watches route: no
    // share host reaches here today, and this keeps a later
    // allowlisting from exposing host filesystem paths to an external
    // reviewer.
    if (visitor) return j(403, { error: 'not available to share visitors' });
    if (req.method === 'GET') {
      return j(200, { dispatches: dispatches.list() });
    }
    if (req.method === 'POST') {
      const body = await safeJson(req);
      const taskId = body?.taskId;
      const worktreePath = body?.worktreePath;
      const agentName = typeof body?.agentName === 'string' ? body.agentName.trim() : '';
      if (!isValidDispatchTaskId(taskId)) return j(400, { error: 'bad-task-id' });
      if (typeof worktreePath !== 'string' || worktreePath.length === 0) {
        return j(400, { error: 'path-not-absolute' });
      }
      // The workspace's parallelism cap (Bryan, 2026-08-31), checked before
      // the registry ever sees the call. Re-registering the SAME task
      // replaces its own slot rather than taking a second one, so it is
      // excluded from the count it is being checked against — otherwise
      // a builder's own re-dispatch (a worktree replaced after a crash)
      // would be refused for the slot it already holds.
      //
      // A task this store has no record of (soft-deleted, or a stray
      // id) cannot be attributed to a board, so the cap cannot be
      // evaluated — the same "cannot look, so cannot enforce" posture
      // the ready-gate takes with an unreadable row, applied here to a
      // dispatch instead of a wake.
      const task = taskStore.getTask(taskId);
      const view = task ? parallelismCapView(task.workspaceId, taskId) : undefined;
      // The moment the lead decided to run this row, recorded whichever way
      // the request goes. Deferred and error-swallowing (see
      // `dispatch-request-event.ts`), so nothing below waits on it and a
      // failed write cannot turn a dispatch into an error. The board is the
      // row's own when the store knows the row, and the board the path named
      // when it does not — the same "cannot look, so cannot enforce" case the
      // cap check just handled.
      const author = authorFor(body?.author);
      const noteRequest = (outcome: 'registered' | 'cap-reached' | 'refused'): void => {
        recordDispatchRequested(taskStore, {
          workspaceId: task?.workspaceId ?? scope.workspaceId,
          taskId,
          outcome,
          reason: body?.reason,
          ...(agentName ? { agentName } : {}),
          ...(author ? { actor: author } : {}),
          ts: Date.now(),
        });
      };
      if (view && view.free === 0) {
        // The row this whole event exists for: a lane asked for while every
        // slot was held. Nothing else on the board records that the ask came
        // before the slot did.
        noteRequest('cap-reached');
        return j(409, {
          error: 'parallelism-cap-reached',
          message: `parallelism cap (${view.cap}) reached — held by: ${holdersClause(view.holders)}`,
          cap: view.cap,
          holders: view.holders,
        });
      }
      const res = dispatches.register(taskId, worktreePath, agentName || undefined);
      if (!res.ok) {
        noteRequest('refused');
        return j(400, { error: res.error });
      }
      noteRequest('registered');
      return j(200, res);
    }
    return j(405, { error: 'method not allowed' });
  }
  const dispatchCloseMatch = matchRest(scope, /^dispatches\/([^/]+)$/);
  if (dispatchCloseMatch) {
    if (visitor) return j(403, { error: 'not available to share visitors' });
    if (req.method === 'DELETE') {
      const taskId = decodeURIComponent(dispatchCloseMatch[1] ?? '');
      return j(200, dispatches.close(taskId));
    }
    return j(405, { error: 'method not allowed' });
  }
  // --- REST: the builder's ONE closing report on a build ---
  //
  // POST files it; GET reads back every report on the row, newest first, which
  // is what the lead reads instead of parsing a closing message. The store
  // validates and refuses naming the missing part, and emits the wake for a
  // FIRST report only — see dispatch-reports.ts.
  //
  // Under `dispatches/<taskId>/…` on purpose rather than under `tasks/`: the
  // `dispatches` collection is in `SCOPED_COLLECTIONS`, so the middleware has
  // already refused a task id this board does not hold before anything here
  // runs. It does NOT require an open dispatch — a builder whose row the board
  // moved to done had its dispatch closed by that very move, and it still has
  // to be able to report.
  //
  // Off `rq.scope` rather than the destructured `scope`, for the reason the
  // agent-notes block below gives: `restIs` above is a type predicate, and its
  // false branch has narrowed `scope` to `undefined`.
  const reportScope = rq.scope;
  const dispatchReportMatch = matchRest(reportScope, /^dispatches\/([^/]+)\/report$/);
  if (dispatchReportMatch && reportScope) {
    // The same defense-in-depth posture the dispatch routes above take: a
    // report names a PR, a commit and a builder, none of which belongs to an
    // external reviewer.
    if (visitor) return j(403, { error: 'not available to share visitors' });
    const taskId = decodeURIComponent(dispatchReportMatch[1] ?? '');
    if (req.method === 'GET') {
      return j(200, { taskId, reports: dispatchReports.forTask(taskId) });
    }
    if (req.method !== 'POST') return j(405, { error: 'method not allowed' });
    const body = await safeJson(req);
    const author = authorFor(body?.author);
    const res = dispatchReports.submit({
      workspaceId: reportScope.workspaceId,
      // The URL names the row. A body `taskId` is ignored rather than
      // compared: the path is the argument, and it is the spelling the
      // middleware checked.
      taskId,
      prNumber: body?.prNumber,
      headCommit: body?.headCommit,
      checks: body?.checks,
      doneWhen: body?.doneWhen,
      agentName: body?.agentName,
      // `classifyActor` rather than the author's own `kind`: a `User`'s kind
      // says how the identity was PROVEN (`known` / `anon`), not whether a
      // person typed it. Same resolver `markPersonRelease` reads, so the two
      // cannot disagree about who is an agent.
      ...(author
        ? { actor: { id: author.id, name: author.name, kind: classifyActor(author) } }
        : {}),
    });
    if (!res.ok) return j(400, { error: res.error, message: res.message });
    return j(200, { ok: true, repeat: res.repeat, report: res.report });
  }
  // --- REST: a status note on a NAMED row ---
  // The MCP verb's route: the agent knows which row it is reporting on
  // and says so, where the hook route below has to resolve the current
  // claim (and finds nothing for a row the agent never claimed). Same
  // body rules as the hook route — `parseAgentNote`, so a shared agent
  // name is refused identically — same append, same per-agent ring.
  // 202 to match: a status is fire-and-forget for the poster too.
  const taskNotesMatch = matchRest(scope, /^tasks\/([^/]+)\/notes$/);
  if (taskNotesMatch) {
    if (visitor) return j(403, { error: 'not available to share visitors' });
    if (req.method !== 'POST') return j(405, { error: 'method not allowed' });
    const taskId = decodeURIComponent(taskNotesMatch[1] ?? '');
    const raw = await safeJson(req);
    // The URL names the row; a body `taskId` is ignored here rather
    // than validated — this route accepted unknown fields before the
    // hook route learned the field, and must keep doing so.
    if (raw !== null && typeof raw === 'object') {
      (raw as Record<string, unknown>).taskId = undefined;
    }
    const parsed = parseAgentNote(raw);
    if (!parsed.ok) return j(400, { error: parsed.error, message: parsed.message });
    const { note } = parsed;
    const res = taskStore.appendNote(taskId, {
      kind: note.kind,
      text: note.text,
      agent: note.agent,
      ts: note.at,
      ...(note.sessionId !== undefined ? { sessionId: note.sessionId } : {}),
    });
    if (!res.ok) return j(404, { error: res.error });
    proposeAllowRule(res.task, note);
    agentNotes.record({ ...note, taskId: res.task.id, workspaceId: res.task.workspaceId });
    return j(202, { ok: true, taskId: res.task.id, workspaceId: res.task.workspaceId });
  }
  // --- REST: agent turn / denial / status notes on the CURRENT row ---
  // The plugin's Stop and PermissionDenied hooks post once per turn to
  // `/workspaces/<ws>/agents/<name>/notes`; the server pins it to the
  // agent's current row ON THAT BOARD, only when that is unambiguous —
  // exactly one in-progress claim held there. An agent holding several
  // rows on the board gets the note marked `needsFiling` rather than
  // guessed onto the newest claim (the guess measured wrong ~3 in 4 — see
  // agent-notes.ts), and that note is APPENDED TO THE BOARD'S UNPLACED-NOTE
  // LOG (agent-note-log.ts) as well as kept in the ring. The ring alone was
  // in-process, 20 deep and read by nothing, so on a board where one session
  // held many rows every end-of-turn message was written to a buffer and
  // dropped. A body `taskId` is an explicit address and always wins. 202
  // rather than 200: the hook fires with the turn already over and never
  // reads the answer.
  //
  // This was `POST /api/agent-notes`, the one board-owned route the
  // canonical-routes cutover left top-level because a hook has no board
  // in hand. The owner chose to move it anyway (2026-09-06, "Still move
  // it"): the hook now reads the board from its launch environment, and
  // the URL names the agent so the middleware's one guard covers it.
  const agentNotesMatch = matchRest(scope, /^agents\/([^/]+)\/notes$/);
  // Off `rq` rather than the destructured `scope`: `restIs` above is a type
  // predicate, and its false branch has narrowed `scope` to undefined.
  const boardId = rq.scope?.workspaceId;
  if (agentNotesMatch && boardId !== undefined) {
    // Same defense-in-depth posture as the agent-watches route: no
    // share host reaches here today, and this keeps a later
    // allowlisting from letting an external reviewer write a session's
    // words onto a board row, or read them off one.
    if (visitor) return j(403, { error: 'not available to share visitors' });
    const agent = decodeURIComponent(agentNotesMatch[1] ?? '').trim();
    if (agent.length === 0 || agent.length > 200) return j(400, { error: 'bad agent' });
    if (isSharedAgentName(agent)) {
      return j(400, { error: SHARED_IDENTITY_ERROR, message: SHARED_IDENTITY_MESSAGE });
    }
    if (req.method === 'GET') {
      // Display fields only — sessionId stays in the store, like the
      // task-projection read (projectNotes) already keeps it out. The
      // ring is per agent across boards; the address names one board, so
      // the read is what that board can see of the agent.
      //
      // Merged with the board's unplaced-note log so a restart does not
      // empty this list. The ring is authoritative where both have a note
      // (it carries the resolved `taskId`); the log supplies what the ring
      // lost. Keyed on `at` + kind + text because that triple is what a
      // logged line and its ring entry share — the log deliberately does
      // not store a taskId, having none.
      // `\u0000` as an ESCAPE, never the character. A literal NUL in the
      // source makes the whole file binary: `grep` skips it silently without
      // `-a`, `file` calls it data, and a scanner that sorts text from binary
      // by content stops reading it as code. It was a raw byte here for two
      // commits and no search for anything in this file matched.
      const seen = new Set<string>();
      const key = (n: { at: number; kind: string; text: string }) =>
        `${n.at}\u0000${n.kind}\u0000${n.text}`;
      const notes = agentNotes
        .list(agent)
        .filter((n) => n.workspaceId === boardId)
        .map((n) => ({
          at: n.at,
          kind: n.kind,
          text: n.text,
          agent: n.agent,
          ...(n.taskId !== undefined ? { taskId: n.taskId } : {}),
          ...(n.workspaceId !== undefined ? { workspaceId: n.workspaceId } : {}),
          ...(n.needsFiling ? { needsFiling: true } : {}),
        }));
      for (const n of notes) seen.add(key(n));
      for (const logged of agentNoteLog.readFor(boardId, agent)) {
        if (seen.has(key(logged))) continue;
        seen.add(key(logged));
        notes.push({
          at: logged.at,
          kind: logged.kind,
          text: logged.text,
          agent: logged.agent,
          workspaceId: logged.workspaceId,
          ...(logged.ambiguous ? { needsFiling: true } : {}),
        });
      }
      notes.sort((a, b) => b.at - a.at);
      return j(200, { agent, notes: notes.slice(0, AGENT_NOTE_RING_CAP) });
    }
    if (req.method !== 'POST') return j(405, { error: 'method not allowed' });
    const raw = await safeJson(req);
    // The URL names the agent; a body `agent` is overwritten rather than
    // compared — the hook route accepted the name in the body before the
    // address carried it, and a stale hook must not be refused for
    // saying the same thing twice.
    if (raw !== null && typeof raw === 'object') {
      (raw as Record<string, unknown>).agent = agent;
    }
    const parsed = parseAgentNote(raw);
    if (!parsed.ok) return j(400, { error: parsed.error, message: parsed.message });
    const { note } = parsed;
    if (note.taskId !== undefined) {
      // The caller named its row; a bad address is its error to hear,
      // not a silent ring drop — and a row on some other board is a bad
      // address under this one.
      const named = taskStore.getTask(note.taskId);
      if (!named || named.workspaceId !== boardId) return j(404, { error: 'not found' });
      const res = taskStore.appendNote(note.taskId, {
        kind: note.kind,
        text: note.text,
        agent: note.agent,
        ts: note.at,
        ...(note.sessionId !== undefined ? { sessionId: note.sessionId } : {}),
      });
      if (!res.ok) return j(404, { error: res.error });
      proposeAllowRule(res.task, note);
      // Judged BEFORE the ring records this note, so `lastTurnAt` still
      // answers with the PREVIOUS turn rather than with this one.
      const nudge = judgeAndRecord(ctx, boardId, note);
      agentNotes.record({ ...note, taskId: res.task.id, workspaceId: res.task.workspaceId });
      return j(202, {
        ok: true,
        taskId: res.task.id,
        workspaceId: res.task.workspaceId,
        ...(nudge ? { unfiledAsk: nudge } : {}),
      });
    }
    const target = resolveNoteTarget(taskStore, note.agent, boardId);
    const task = target.task;
    if (task) {
      const res = taskStore.appendNote(task.id, {
        kind: note.kind,
        text: note.text,
        agent: note.agent,
        ts: note.at,
        ...(note.sessionId !== undefined ? { sessionId: note.sessionId } : {}),
      });
      if (!res.ok) return j(500, { error: res.error });
      proposeAllowRule(res.task, note);
    }
    const nudge = judgeAndRecord(ctx, boardId, note);
    // A note no row took is written to the board's unplaced-note log BEFORE
    // the ring, so the durable record exists whatever happens next. `logged`
    // rides back on the 202 so a hook — or a person reading the response —
    // can tell "kept" from "kept nowhere": a full disk is the one case where
    // this note still vanishes, and it now says so.
    //
    // ORDER IS LOAD-BEARING, and it is the reason this sits AFTER
    // `judgeAndRecord` rather than beside the `appendNote` above. The judge
    // reads the log for the PREVIOUS turn note; appending first would make
    // this note its own predecessor, and an ask filed during this very turn
    // would be measured from a boundary it cannot be on the right side of.
    // Pinned by "measures 'filed nothing this turn' from the PREVIOUS turn
    // note" in `turn-note-many-rows.test.ts`, which fails on either half.
    let logged: boolean | undefined;
    if (!task) {
      logged = agentNoteLog.append({
        agent: note.agent,
        kind: note.kind,
        text: note.text,
        at: note.at,
        workspaceId: boardId,
        ambiguous: target.ambiguous,
        ...(note.sessionId !== undefined ? { sessionId: note.sessionId } : {}),
      });
    }
    agentNotes.record({
      ...note,
      workspaceId: boardId,
      ...(task ? { taskId: task.id } : {}),
      ...(target.ambiguous ? { needsFiling: true } : {}),
    });
    return j(202, {
      ok: true,
      workspaceId: boardId,
      ...(task ? { taskId: task.id } : {}),
      ...(target.ambiguous ? { needsFiling: true } : {}),
      ...(logged !== undefined ? { logged } : {}),
      ...(nudge ? { unfiledAsk: nudge } : {}),
    });
  }
  return undefined;
}
