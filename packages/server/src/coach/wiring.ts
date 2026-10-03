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
 *    Claude Code session, which hears every event (`session-feed.ts`).
 */
import { type Event, onActivity } from '../activity.ts';
import { type GoalsDocReading, readGoalsDoc } from './goals-doc.ts';
import { CoachHub } from './hub.ts';
import { coachSectionFor } from './landing.ts';
import { type Coach, type DocLabel, createCoach } from './moment.ts';
import { SessionFeed, type SessionFrame } from './session-feed.ts';
import { type CoachSetupDeps, ensureMemoryDoc } from './setup.ts';
import { CoachStore } from './store.ts';
import { CoachStream } from './stream.ts';

/** The coach's edits to the goals doc are signed as the coach. */
export const COACH_AUTHOR = { author: 'coach', authorName: 'Coach', authorColor: '#5b7f4e' };

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
    applyBlockEdits(
      docId: string,
      edits: { op: 'insert_at_end'; markdown: string }[],
      who: typeof COACH_AUTHOR,
    ): { ok: boolean };
  };
  createBoard: (name: string) => string;
  fileUnderBoard: (docId: string, workspaceId: string) => void;
  label: (docId: string) => DocLabel;
  boardName: (workspaceId: string) => string | undefined;
  workspaceOf: (docId: string) => string | undefined;
  /** The board's lead agent, if one is seated. */
  leadOf: (workspaceId: string) => string | undefined;
  sendToAgent: (workspaceId: string, agentId: string, frame: SessionFrame) => number;
  /** Whether that agent holds a stream on the board right now. */
  agentConnected: (workspaceId: string, agentId: string) => boolean;
  now?: () => number;
}

export interface CoachWiring {
  store: CoachStore;
  coach: Coach;
  hub: CoachHub;
  feed: SessionFeed;
  setup: CoachSetupDeps;
  /** The front page's section, for the owner. */
  landing: () => string;
  stop: () => void;
}

export function wireCoach(deps: CoachWiringDeps): CoachWiring {
  const store = new CoachStore(deps.dataDir);
  const hub = new CoachHub();
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
  });
  const coach = createCoach({
    store,
    stream: new CoachStream(),
    readGoals,
    label: deps.label,
    boardName: deps.boardName,
    workspaceOf: deps.workspaceOf,
    tell: (news, at) => feed.send(news, at),
    publish: (frame) => hub.publish(frame),
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
    readMarkdown: (docId) => deps.docStore.readMarkdownBody(docId),
    appendMarkdown: (docId, markdown) =>
      deps.docStore.applyBlockEdits(docId, [{ op: 'insert_at_end', markdown }], COACH_AUTHOR).ok,
  };
  // A board set up before the memory doc existed gets one now.
  void ensureMemoryDoc(store, setup, (deps.now ?? Date.now)()).catch((err) =>
    console.warn(`[coach] memory doc not made: ${String(err)}`),
  );
  return {
    store,
    coach,
    hub,
    feed,
    setup,
    landing: () => coachSectionFor(store, readGoals, feed.reachable(), (deps.now ?? Date.now)()),
    stop: () => {
      unsubscribe();
      store.flush();
      hub.close();
    },
  };
}
