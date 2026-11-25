/**
 * The activity recorder, driven directly through the host it is built on —
 * no server and no DocStore. What it writes to `activity.jsonl`, what it
 * refuses, and that a backfill sweep puts back the docs it loaded and did
 * not need.
 *
 * All fixtures are invented. Temp data dir.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type DocMeta,
  type Thread,
  createThread,
  getThreads,
  initDocMeta,
  listThreads,
  readDocMeta,
} from '@claude-workspaces/core';
import { SUMMARY_PROMPT_VERSION } from '@claude-workspaces/core/summary-prompt';
import * as Y from 'yjs';
import { summaryHash } from '../../core/src/thread-summary.ts';
import { type Event, MAX_READ_SESSION_MS, activityLogPath } from '../src/activity.ts';
import { type DocActivityHost, DocActivityRecorder } from '../src/doc-activity-recorder.ts';
import type { LiveDoc } from '../src/doc-store.ts';
import type { ScheduleArgs, ThreadSummarizer } from '../src/summarize.ts';

const ALICE = { id: 'u-alice', name: 'Alice', kind: 'known' as const, color: '#123456' };

function liveDoc(docId: string): LiveDoc {
  const ydoc = new Y.Doc();
  initDocMeta(ydoc, { docId, type: 'markdown', createdAt: 1 } as DocMeta);
  // The recorder reads only these three fields of a live doc.
  return { docId, ydoc, meta: readDocMeta(ydoc) } as unknown as LiveDoc;
}

function addThread(doc: LiveDoc, threadId: string): void {
  createThread(doc.ydoc, {
    threadId,
    anchor: {
      kind: 'element',
      fingerprint: {
        tag: 'P',
        stableAttrs: {},
        classes: [],
        text: `fp-${threadId}`,
        path: 'P[0]',
        dataAttrs: {},
      },
      snippet: { text: 'x' },
    },
    createdBy: ALICE,
    firstComment: { id: `c-${threadId}`, text: 'Harborlight tide tables' },
  });
}

function rows(dataDir: string): Event[] {
  const path = activityLogPath(dataDir);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Event);
}

describe('DocActivityRecorder', () => {
  let dataDir: string;
  let resident: Map<string, LiveDoc>;
  let onDisk: Map<string, LiveDoc>;
  let persisted: string[];
  let evicted: string[];
  let resolved: string[];
  let summarizer: ThreadSummarizer | undefined;

  const host = (): DocActivityHost => ({
    dataDir: () => dataDir,
    summarizer: () => summarizer,
    doc: (docId) => {
      resolved.push(docId);
      const d = resident.get(docId) ?? onDisk.get(docId);
      if (d) resident.set(docId, d);
      return d;
    },
    metaOf: (docId) => (resident.get(docId) ?? onDisk.get(docId))?.meta,
    allDocIds: () => new Set([...onDisk.keys(), ...resident.keys()]),
    isResident: (docId) => resident.has(docId),
    threadTotal: (docId) => {
      const d = resident.get(docId) ?? onDisk.get(docId);
      return d ? getThreads(d.ydoc).size : 0;
    },
    thread: (docId, threadId) => {
      const d = resident.get(docId) ?? onDisk.get(docId);
      return d ? (listThreads(d.ydoc).find((t) => t.id === threadId) ?? null) : null;
    },
    schedulePersist: (doc) => {
      persisted.push(doc.docId);
    },
    evict: (docId) => {
      evicted.push(docId);
      resident.delete(docId);
    },
  });

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'doc-activity-recorder-'));
    resident = new Map();
    onDisk = new Map();
    persisted = [];
    evicted = [];
    resolved = [];
    summarizer = undefined;
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('refuses an unknown read type before it looks the doc up', () => {
    const rec = new DocActivityRecorder(host());
    const res = rec.recordReadEvent('doc-b', 'scroll' as 'doc_open', {}, ALICE);
    expect(res).toEqual({ ok: false, error: 'bad-type' });
    expect(resolved).toEqual([]);
    expect(rows(dataDir)).toEqual([]);
  });

  it('answers no-doc for a doc it cannot resolve', () => {
    const rec = new DocActivityRecorder(host());
    expect(rec.recordReadEvent('doc-x', 'doc_open', {}, ALICE)).toEqual({
      ok: false,
      error: 'no-doc',
    });
    expect(rows(dataDir)).toEqual([]);
  });

  it('writes a read session as a person row with its duration clamped', () => {
    resident.set('doc-b', liveDoc('doc-b'));
    const rec = new DocActivityRecorder(host());
    const res = rec.recordReadEvent(
      'doc-b',
      'read_session',
      { sessionId: 's1', durationMs: MAX_READ_SESSION_MS * 10 },
      ALICE,
    );
    expect(res).toEqual({ ok: true });
    const [row] = rows(dataDir);
    expect(row?.type).toBe('read_session');
    expect(row?.actor).toBe('person');
    expect(row?.actorName).toBe('Alice');
    expect(row?.doc.docId).toBe('doc-b');
    expect(row?.payload.durationMs).toBe(MAX_READ_SESSION_MS);
  });

  it('records a comment with its word count, and never throws on a bad doc', () => {
    const doc = liveDoc('doc-a');
    const rec = new DocActivityRecorder(host());
    rec.recordActivity(doc, 'comment', ALICE, 't1', { text: 'two words', tsMs: 1_000 });
    const [row] = rows(dataDir);
    expect(row?.type).toBe('comment');
    expect(row?.threadId).toBe('t1');
    expect(row?.payload.wordCount).toBe(2);
    // A doc with no meta makes buildEventDoc throw; the action it observes
    // must not see that.
    const broken = { docId: 'doc-y', ydoc: new Y.Doc() } as unknown as LiveDoc;
    expect(() => rec.recordActivity(broken, 'reply', ALICE, 't2', { tsMs: 2_000 })).not.toThrow();
  });

  it('skips an edit session whose doc it has no meta for', () => {
    const rec = new DocActivityRecorder(host());
    rec.recordEditSession({ docId: 'doc-z' } as Parameters<typeof rec.recordEditSession>[0]);
    expect(rows(dataDir)).toEqual([]);
  });

  it('stores an on-demand summary and persists the doc it wrote to', () => {
    const doc = liveDoc('doc-c');
    addThread(doc, 't1');
    resident.set(doc.docId, doc);
    const rec = new DocActivityRecorder(host());
    const summary = { topic: 'tides', discussion: 'none yet', hash: 'h', promptVersion: 1 };
    const t: Thread | null = rec.applyThreadSummary('doc-c', 't1', summary);
    expect(t?.id).toBe('t1');
    expect(persisted).toEqual(['doc-c']);
    expect(rec.applyThreadSummary('doc-x', 't1', summary)).toBeNull();
    expect(persisted).toEqual(['doc-c']);
  });

  it('backfills only with a live summarizer, and evicts the docs it loaded for nothing', async () => {
    const rec = new DocActivityRecorder(host());
    expect(rec.backfillSummaries()).toEqual({ queued: 0, open: 0, resolved: 0 });

    let handed: ScheduleArgs[] = [];
    summarizer = {
      enabled: true,
      backfill: async (tasks: ScheduleArgs[]) => {
        handed = tasks;
        return { attempted: tasks.length, stored: 0 };
      },
    } as unknown as ThreadSummarizer;

    const withWork = liveDoc('doc-a');
    addThread(withWork, 't1');
    onDisk.set(withWork.docId, withWork);
    const noThreads = liveDoc('doc-b');
    onDisk.set(noThreads.docId, noThreads);

    expect(rec.backfillSummaries({ windowMs: 0 })).toEqual({ queued: 1, open: 1, resolved: 0 });
    // A doc with no threads is never loaded; the one with work stays resident.
    expect(resolved).toEqual(['doc-a']);
    expect(evicted).toEqual([]);
    expect(handed.map((t) => t.threadId)).toEqual(['t1']);

    // Store a current summary, as the summarizer would, and sweep again from
    // cold: the doc is loaded, found to need nothing, and put back.
    const task = handed[0];
    const thread = task?.getThread();
    if (!task || !thread) throw new Error('no task handed to the summarizer');
    task.apply({
      topic: 'tides',
      discussion: 'none yet',
      hash: summaryHash(thread),
      promptVersion: SUMMARY_PROMPT_VERSION,
    });
    expect(persisted).toEqual(['doc-a']);
    resident.clear();
    resolved = [];
    expect(rec.backfillSummaries({ windowMs: 0 })).toEqual({ queued: 0, open: 0, resolved: 0 });
    expect(resolved).toEqual(['doc-a']);
    expect(evicted).toEqual(['doc-a']);
  });
});
