/**
 * What a doc's readers and writers did, written to the activity log, and the
 * thread summaries that ride the same stream. Out of `doc-store.ts`: the
 * comment-family events the thread verbs emit, the browser's reading events,
 * the closed edit sessions, the one-shot summary backfill and the on-demand
 * summary write.
 *
 * It holds no docs. It reaches the store through `DocActivityHost`, so a doc
 * evicted between two calls is resolved again rather than written into dead.
 */
import {
  type DocMeta,
  type Thread,
  type User,
  listThreads,
  setThreadSummary,
} from '@claude-workspaces/core';
import { type StoredSummary, needsCall } from '@claude-workspaces/core/summary-prompt';
import { wordCount } from '@claude-workspaces/core/word-count';
import {
  type ActivityType,
  type Event,
  appendActivity,
  buildEventDoc,
  clampReadPayload,
  eventId,
  payloadDigest,
  toUtcIso,
} from './activity.ts';
import { classifyActor, isOwnerActor } from './actor-identity.ts';
import type { LiveDoc } from './doc-store.ts';
import { type ClosedEditSession, editSessionEvent } from './edit-sessions.ts';
import type { ScheduleArgs, ThreadSummarizer } from './summarize.ts';

/** The store, seen through what recording activity needs from it. */
export interface DocActivityHost {
  dataDir(): string;
  summarizer(): ThreadSummarizer | undefined;
  /** Resolve (hydrating if needed) a doc to write into. */
  doc(docId: string): LiveDoc | undefined;
  /** A doc's meta from memory, else from the index, without loading it. */
  metaOf(docId: string): DocMeta | undefined;
  /** Every doc id the server knows, resident or not. */
  allDocIds(): Iterable<string>;
  isResident(docId: string): boolean;
  threadTotal(docId: string): number;
  thread(docId: string, threadId: string): Thread | null;
  schedulePersist(doc: LiveDoc): void;
  evict(docId: string): void;
}

export type ReadEventResult = { ok: boolean; error?: 'no-doc' | 'bad-type' | 'append-failed' };

export class DocActivityRecorder {
  constructor(private readonly host: DocActivityHost) {}

  /**
   * Append a comment-family activity event (comment / reply / resolve /
   * reopen) for a successful thread action. Both person and agent actions are
   * recorded — agent events carry actor:'agent' so the Weekly Review agent can
   * filter them, but person events are never dropped. Best-effort: any failure
   * is swallowed so activity capture can't break the action it observes.
   */
  recordActivity(
    doc: LiveDoc,
    type: ActivityType,
    author: User,
    threadId: string,
    opts: { text?: string; tsMs: number },
  ): void {
    try {
      const actor = classifyActor(author);
      const ts = toUtcIso(opts.tsMs);
      const payload: Event['payload'] =
        opts.text !== undefined ? { text: opts.text, wordCount: wordCount(opts.text) } : {};
      const id = eventId({
        ts,
        actor,
        docId: doc.docId,
        type,
        threadId,
        payloadDigest: payloadDigest(opts.text),
      });
      const event: Event = {
        eventId: id,
        ts,
        type,
        actor,
        actorId: author.id,
        actorName: author.name,
        isOwner: isOwnerActor(author),
        threadId,
        doc: buildEventDoc(doc.meta),
        payload,
      };
      appendActivity(this.host.dataDir(), event);
    } catch (err) {
      console.error('[doc-store] recordActivity failed:', err);
    }
  }

  /**
   * Append a browser-originated reading event (read_session / doc_open). The
   * client posts the interaction-bounded payload; the server resolves the doc
   * / repo / producedBy and stamps actor=person, ts=now. Unknown `type`s are
   * rejected so a malformed POST can't poison the stream.
   */
  recordReadEvent(
    docId: string,
    type: 'read_session' | 'doc_open',
    payload: Event['payload'],
    author: User,
  ): ReadEventResult {
    if (type !== 'read_session' && type !== 'doc_open') {
      return { ok: false, error: 'bad-type' };
    }
    const doc = this.host.doc(docId);
    if (!doc) return { ok: false, error: 'no-doc' };
    try {
      // Re-clamp the browser-supplied duration/scroll fields server-side so a
      // spoofed or buggy POST can't write an inflated read time.
      clampReadPayload(payload);
      const ts = toUtcIso(Date.now());
      const sessionId = payload.sessionId;
      const id = eventId({
        ts,
        actor: 'person',
        docId,
        type,
        threadId: null,
        payloadDigest: payloadDigest(sessionId),
      });
      const event: Event = {
        eventId: id,
        ts,
        type,
        actor: 'person',
        actorId: author.id,
        actorName: author.name,
        isOwner: isOwnerActor(author),
        doc: buildEventDoc(doc.meta),
        payload,
      };
      appendActivity(this.host.dataDir(), event);
      return { ok: true };
    } catch (err) {
      console.error('[doc-store] recordReadEvent failed:', err);
      return { ok: false, error: 'append-failed' };
    }
  }

  /** Append one closed edit session. The doc may have left memory by the
   *  time a session closes, so its meta comes from the index when it has. */
  recordEditSession(session: ClosedEditSession): void {
    const meta = this.host.metaOf(session.docId);
    if (!meta) return;
    appendActivity(this.host.dataDir(), editSessionEvent(session, meta));
  }

  /**
   * Summarize every already-existing thread that has no current summary.
   *
   * Generation is triggered by thread CHANGES, so nothing that was written
   * before this feature shipped would ever get a summary — the docs with the
   * worst deterministic topic lines are exactly the old ones. This walks the
   * hydrated docs once and hands the backlog to the summarizer, which paces
   * it over `windowMs`.
   *
   * Resolved threads are included: their cards still render both lines in the
   * all-threads panel and the outdated-comments flow, and a summary is the
   * whole point there too. They are counted separately so the operator sees
   * what they are agreeing to pay for rather than one opaque total.
   *
   * Returns immediately with the count queued; the drain runs in the
   * background. Never automatic — the caller (bin.ts) decides, because a
   * backfill spends real money and must not fire in a test or a short-lived
   * process.
   */
  backfillSummaries(opts: { windowMs?: number } = {}): {
    queued: number;
    open: number;
    resolved: number;
  } {
    const summarizer = this.host.summarizer();
    if (!summarizer?.enabled) return { queued: 0, open: 0, resolved: 0 };
    const tasks: ScheduleArgs[] = [];
    let open = 0;
    let resolved = 0;
    // Every doc on the server, not just the ones that happen to be in memory.
    // Under lazy hydration those are two very different sets, and the whole
    // point of this sweep is the OLD threads — which are exactly the ones in
    // docs nobody has opened.
    for (const docId of this.host.allDocIds()) {
      // The index says how many threads a doc has, so a doc with none is
      // skipped without loading it. On the measured corpus that is most of
      // them, and it is the difference between a sweep that reads a few
      // hundred docs and one that reads five thousand.
      if (this.host.threadTotal(docId) === 0) continue;
      const wasResident = this.host.isResident(docId);
      const doc = this.host.doc(docId);
      if (!doc) continue;
      let queuedHere = 0;
      for (const t of listThreads(doc.ydoc)) {
        // Ask the same question the live path asks, so a thread summarized a
        // second ago is not paid for twice.
        if (!needsCall(t, t.summary)) continue;
        if (t.status === 'open') open++;
        else resolved++;
        queuedHere++;
        tasks.push({
          docId,
          threadId: t.id,
          getThread: () => this.host.thread(docId, t.id),
          apply: (summary) => {
            // Resolved again HERE, not captured above: this runs minutes
            // later, spread over the pacing window, and the doc it was
            // collected from may have been evicted since — writing into a
            // destroyed Y.Doc would drop the summary silently.
            const live = this.host.doc(docId);
            if (!live) return;
            setThreadSummary(live.ydoc, t.id, summary);
            this.host.schedulePersist(live);
          },
        });
      }
      // Put back what this sweep pulled in and did not need. A doc that had
      // work queued stays for now — `apply` is about to write to it — and the
      // idle sweep takes it later on the ordinary clock.
      if (!wasResident && queuedHere === 0) this.host.evict(docId);
    }
    if (tasks.length > 0) {
      void summarizer
        .backfill(tasks, {
          ...(opts.windowMs !== undefined ? { windowMs: opts.windowMs } : {}),
        })
        .then(({ attempted, stored }) => {
          console.log(`[summarize] backfill done: ${stored} stored of ${attempted} attempted`);
        })
        // Nothing observes this promise. Every throw inside `backfill` is
        // caught today, so this cannot fire — but it is one refactor away
        // from being an unhandled rejection on a fire-and-forget path.
        .catch((err) => {
          console.error('[summarize] backfill failed:', err instanceof Error ? err.message : err);
        });
    }
    return { queued: tasks.length, open, resolved };
  }

  /**
   * Store a summary that was generated on demand (REST route / MCP tool).
   * Same write and same persistence as the scheduled path — one way in, so
   * an on-demand summary cannot end up in the doc but not on disk.
   */
  applyThreadSummary(docId: string, threadId: string, summary: StoredSummary): Thread | null {
    const doc = this.host.doc(docId);
    if (!doc) return null;
    const t = setThreadSummary(doc.ydoc, threadId, summary);
    if (t) this.host.schedulePersist(doc);
    return t;
  }
}
