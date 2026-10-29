/**
 * The coach, composed against the server's own stores: one call from
 * `server.ts`, so the router carries a handle and nothing else.
 *
 * What it reaches, and why each is enough:
 *  - the doc store, to make, read and append to the learning-goals doc and
 *    to make the memory doc;
 *  - the task store, to make the coach's board and to name a doc's board;
 *  - the activity record's live feed (`onActivity`), for this data dir only;
 *  - the Coach board's lead, and an addressed frame to it: the coach's
 *    Claude Code session, which hears every event (`session-feed.ts`);
 *  - each attached session's prompt marks and turn notes, for his Claude
 *    Code time and what he asked (`session-minutes.ts`, `summary.ts`);
 *  - a backlog file, where windows wait while the session is away
 *    (`backlog.ts`);
 *  - a timer to the next morning in his zone, for the session's one wake-up
 *    a day (`morning.ts`);
 *  - a counts file of what he did and what reached the coach, per hour
 *    (`coverage.ts`).
 */
import { agentIdForName } from '@claude-workspaces/core';
import { type Event, onActivity } from '../activity.ts';
import { CoachBacklog } from './backlog.ts';
import { CoachCoverage, sessionSource } from './coverage.ts';
import { type DocBoards, placeIsOff } from './exclusion.ts';
import { type GoalsDocReading, readGoalsDoc } from './goals-doc.ts';
import { CoachHub } from './hub.ts';
import { coachSectionFor } from './landing.ts';
import { type Coach, type DocLabel, createCoach } from './moment.ts';
import { MorningWake } from './morning.ts';
import { SessionFeed, type SessionFrame } from './session-feed.ts';
import { repoOfCwd } from './session-minutes.ts';
import { type CoachSetupDeps, ensureMemoryDoc } from './setup.ts';
import { CoachStore } from './store.ts';
import { CoachStream } from './stream.ts';
import type { CoachSummarizer } from './summary.ts';
import type { PlanBoardReading } from './week-plan.ts';

export interface CoachWiringDeps {
  dataDir: string;
  docStore: {
    prewarmHydration(docId: string): Promise<unknown>;
    createForCaller(
      docId: string,
      init: { type: 'markdown'; sourceUrl: string; title: string; workspaceId: string },
    ): { ok: true; doc: { docId: string } } | { ok: false };
    attachFileAsync(docId: string, path: string): Promise<{ ok: boolean }>;
    docExists(docId: string): boolean;
    readMarkdownBody(docId: string): string | null;
  };
  createBoard: (name: string) => string;
  fileUnderBoard: (docId: string, workspaceId: string) => void;
  label: (docId: string) => DocLabel;
  boardName: (workspaceId: string) => string | undefined;
  workspaceOf: (docId: string) => string | undefined;
  /** The boards holding a doc, so a doc on a board he turned off is off
   *  too (`coach/exclusion.ts`). */
  docBoards: DocBoards;
  /** The board's lead agent, if one is seated. */
  leadOf: (workspaceId: string) => string | undefined;
  sendToAgent: (workspaceId: string, agentId: string, frame: SessionFrame) => number;
  /** Whether that agent holds a stream on the board right now. */
  agentConnected: (workspaceId: string, agentId: string) => boolean;
  /** Team Lead's plan board, its name and goals in order (`review-plan.ts`). */
  planBoard: () => PlanBoardReading | undefined;
  now?: () => number;
  /** Where the coach lead's connect and disconnect lines go; console.log by
   *  default. */
  log?: (line: string) => void;
  /** The digest window's timer (`SessionFeedDeps.schedule`). */
  schedule?: (fn: () => void, ms: number) => () => void;
  /** The digest window's length; `DIGEST_WINDOW_MS` by default. */
  digestWindowMs?: number;
  /** Says each prompt and turn in a few words (`coach/summary.ts`). */
  summarizer?: CoachSummarizer | null;
  /** The morning wake-up's timer and hour (`coach/morning.ts`); default an
   *  unref'd timer and `MORNING_HOUR`. */
  morningSchedule?: (fn: () => void, ms: number) => () => void;
  morningHour?: number;
}

export interface CoachWiring {
  store: CoachStore;
  coverage: CoachCoverage;
  coach: Coach;
  hub: CoachHub;
  feed: SessionFeed;
  morning: MorningWake;
  setup: CoachSetupDeps;
  /** The front page's section, for the owner. */
  landing: () => string;
  /** True when this agent, by name, is the coach session: the lead seated
   *  on the board that holds the learning-goals doc. */
  isCoachSession: (workspaceId: string, agentName: string) => boolean;
  /** A session's turn note on a board, from the notes route. Counted only
   *  after a prompt he typed, never for the coach, and never on a board the
   *  coach is off for; true when it joined a digest window. */
  sessionTurn: (workspaceId: string, note: SessionNote, cwd?: unknown) => boolean;
  /** A session's prompt mark, from the prompts route: typed or injected. */
  sessionPrompt: (workspaceId: string, mark: PromptMark, cwd?: unknown) => boolean;
  /** An agent's stream on `workspaceId` came or went: a waiting digest may
   *  go now, and the coach lead's connect or disconnect is logged. */
  agentStreamsChanged: (workspaceId: string, agentId?: string) => void;
  stop: () => void;
}

/** What the prompts route hands on. A typed prompt's text, as the hook
 *  reduced it, is summarised for the digest and never sent whole. */
export interface PromptMark {
  agent: string;
  typed: boolean;
  at: number;
  sessionId?: string;
  text?: string;
  /** The hook ran under Remote Control. */
  remote?: boolean;
}

/** What `sessionTurn` reads off a note: its closing message is summarised
 *  for the digest the same way. */
export interface SessionNote {
  agent: string;
  kind: string;
  at: number;
  sessionId?: string;
  text?: string;
}

/** The most of a prompt or closing message held for its summary. */
const MARK_TEXT_CHARS = 2_000;

export function wireCoach(deps: CoachWiringDeps): CoachWiring {
  const store = new CoachStore(deps.dataDir);
  // An unreadable state file means the boards he turned off are unknown.
  // Every other board counts, local-only, locked and shared alike (the
  // owner, 2026-10-28: "All boards."), and nothing here reads anyone else's
  // rows.
  const isOff = (place: { workspaceId: string; docId?: string }) =>
    store.readFailed || placeIsOff(place, deps.docBoards, store.offBoards);
  const hub = new CoachHub({ offAt: isOff });
  const coverage = new CoachCoverage(deps.dataDir);
  const readGoals = (): GoalsDocReading | null => {
    const doc = store.goalsDoc;
    const md = doc ? deps.docStore.readMarkdownBody(doc.docId) : null;
    return md === null ? null : readGoalsDoc(md);
  };
  const feed = new SessionFeed({
    lead: () => {
      const ws = store.goalsDoc?.workspaceId;
      const agentId = ws ? deps.leadOf(ws) : undefined;
      return ws && agentId ? { workspaceId: ws, agentId } : null;
    },
    send: deps.sendToAgent,
    connected: deps.agentConnected,
    eventsOn: (at) => store.eventsOn(at),
    countTurn: (at) => store.countEvent(at),
    planBoard: deps.planBoard,
    timeZone: () => store.timeZone,
    backlog: new CoachBacklog(deps.dataDir),
    summarizer: deps.summarizer ?? null,
    coverage,
    ...(deps.digestWindowMs === undefined ? {} : { windowMs: deps.digestWindowMs }),
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.schedule ? { schedule: deps.schedule } : {}),
  });
  const morning = new MorningWake({
    timeZone: () => store.timeZone,
    lastDay: () => store.morningDay,
    setLastDay: (day) => store.setMorningDay(day),
    wake: (news, at) => feed.wake(news, at),
    ...(deps.morningHour === undefined ? {} : { hour: deps.morningHour }),
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.morningSchedule ? { schedule: deps.morningSchedule } : {}),
  });
  morning.start();
  const coach = createCoach({
    store,
    stream: new CoachStream(),
    readGoals,
    label: deps.label,
    boardName: deps.boardName,
    workspaceOf: deps.workspaceOf,
    isOff,
    coverage,
    tell: (news, at) => feed.send(news, at),
    publish: (frame) => hub.publish(frame),
    reshow: (frame) => hub.reshow(frame),
    ...(deps.now ? { now: deps.now } : {}),
  });
  const unsubscribe = onActivity((dataDir: string, event: Event) => {
    if (dataDir === deps.dataDir) coach.activity(event);
  });
  const setup: CoachSetupDeps = {
    dataDir: deps.dataDir,
    createBoard: deps.createBoard,
    createDoc: async (docId, path, title, workspaceId) => {
      await deps.docStore.prewarmHydration(docId);
      const created = deps.docStore.createForCaller(docId, {
        type: 'markdown',
        sourceUrl: path,
        title,
        workspaceId,
      });
      if (!created.ok) return null;
      const id = created.doc.docId;
      deps.fileUnderBoard(id, workspaceId);
      const attached = await deps.docStore.attachFileAsync(id, path);
      return attached.ok ? id : null;
    },
    docExists: (docId) => deps.docStore.docExists(docId),
  };
  // A board set up before the memory doc existed gets one now.
  void ensureMemoryDoc(store, setup, (deps.now ?? Date.now)()).catch((err) =>
    console.warn(`[coach] memory doc not made: ${String(err)}`),
  );
  const isCoachSession = (workspaceId: string, agentName: string): boolean => {
    if (store.goalsDoc?.workspaceId !== workspaceId) return false;
    const lead = deps.leadOf(workspaceId);
    return lead !== undefined && lead === agentIdForName(agentName);
  };
  /** Where a mark came from, or null when it must not reach the coach. */
  const sessionOf = (
    workspaceId: string,
    mark: { agent: string; at: number; sessionId?: string; text?: string },
    cwd: unknown,
  ) => {
    if (isOff({ workspaceId })) {
      coverage.dropped(mark.at, 'off-board');
      return null;
    }
    if (isCoachSession(workspaceId, mark.agent)) {
      coverage.dropped(mark.at, 'coach-session');
      return null;
    }
    const board = deps.boardName(workspaceId);
    const said = mark.text?.trim();
    return {
      at: mark.at,
      boardId: workspaceId,
      ...(board ? { board } : {}),
      session: mark.sessionId ?? mark.agent,
      repo: repoOfCwd(cwd) ?? 'unknown repo',
      ...(said ? { text: said.slice(0, MARK_TEXT_CHARS) } : {}),
    };
  };
  const sessionTurn = (workspaceId: string, note: SessionNote, cwd?: unknown): boolean => {
    if (note.kind !== 'turn') return false;
    const session = note.sessionId ?? note.agent;
    coverage.received(note.at, feed.sessionSource(session) ?? 'other', 'turn-end');
    const news = sessionOf(workspaceId, note, cwd);
    return news !== null && feed.turn(news);
  };
  const sessionPrompt = (workspaceId: string, mark: PromptMark, cwd?: unknown): boolean => {
    const source = sessionSource(mark.remote);
    coverage.received(mark.at, source, mark.typed ? 'typed-prompt' : 'injected-prompt');
    const { text, ...rest } = mark;
    const news = sessionOf(workspaceId, mark.typed && text ? { ...rest, text } : rest, cwd);
    return news !== null && feed.prompt({ ...news, source }, mark.typed);
  };
  // One line per change in whether the coach lead holds a stream, with the
  // time and nothing else, so a gap in the digests can be told apart from a
  // session that was away.
  const log = deps.log ?? ((line: string) => console.log(line));
  let leadWasConnected: boolean | undefined;
  const agentStreamsChanged = (workspaceId: string, agentId?: string): void => {
    if (store.goalsDoc?.workspaceId !== workspaceId) return;
    const lead = deps.leadOf(workspaceId);
    if (lead && (agentId === undefined || agentId === lead)) {
      const connected = deps.agentConnected(workspaceId, lead);
      if (connected !== leadWasConnected) {
        leadWasConnected = connected;
        const at = new Date((deps.now ?? Date.now)()).toISOString();
        log(`[coach] session stream ${connected ? 'connected' : 'disconnected'} at ${at}`);
      }
    }
    void feed.reconnected();
  };
  return {
    store,
    coverage,
    coach,
    hub,
    feed,
    morning,
    setup,
    landing: () => {
      const t = (deps.now ?? Date.now)();
      return coachSectionFor(
        store,
        readGoals,
        { online: feed.reachable(), paused: feed.paused(t), boardName: deps.boardName },
        t,
      );
    },
    isCoachSession,
    sessionTurn,
    sessionPrompt,
    agentStreamsChanged,
    stop: () => {
      unsubscribe();
      morning.stop();
      feed.stop();
      store.flush();
      coverage.flush();
      hub.close();
    },
  };
}
