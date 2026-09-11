/**
 * "Waiting on a person" is declared, not inferred (stall-check rebuild,
 * step 2).
 *
 * A row is excused from the stall clock only by a filed ask the person can
 * see on their queue, and the row carries the ADDRESS of that ask — a ticket
 * item by id, or a comment-borne item by doc, thread and comment. A note on
 * the row saying "waiting on Bryan" declares nothing: it is activity like
 * any other note, and once it is older than the window the row is a plain
 * stall to the lead. Between 2026-09-04 and 2026-09-08 a prose reader tried
 * to recover such asks from the note; this file is what replaced it.
 *
 * The unit half drives the classifier and the gate directly; the wired half
 * runs a real server and reads the verdict, which is where the addresses
 * become visible. Fixtures are synthetic. The repo is public.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ReviewItemRow, TaskRow } from '../src/keep-moving.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { evaluateStalls } from '../src/stall-gate.ts';
import { seedBoard } from './workspace-seed.ts';

const MIN = 60_000;
const now = 1_000 * MIN;
const QUIET = 20 * MIN;
const bands = { dispatchable: new Set(['g1']), ownerBand: new Set(['decisions']) };

const WAITING_NOTE =
  'Waiting on Bryan: the four factual corrections sit in the doc as suggestions, and the voice items are his to make.';

function row(over: Partial<TaskRow> = {}): TaskRow {
  return {
    id: 't-1',
    title: 'Index the archive',
    status: 'in-progress',
    goal: 'g1',
    createdAt: now - 200 * MIN,
    transitions: [{ ts: now - 200 * MIN, to: 'in-progress' }],
    ownerKind: 'agent',
    ...over,
  };
}

function gate(tasks: TaskRow[], reviewItems: ReviewItemRow[] = []) {
  return evaluateStalls({ tasks, events: [], reviewItems, bands, now, quietMs: QUIET });
}

const ticketAsk = (askedAt: number, reviewItemId = 'r-1'): ReviewItemRow => ({
  taskId: 't-1',
  askedAt,
  address: { kind: 'task', taskId: 't-1', reviewItemId },
});
const threadAsk = (askedAt: number): ReviewItemRow => ({
  taskId: 't-1',
  askedAt,
  address: { kind: 'thread', docId: 'task:t-1', threadId: 'th-1', commentId: 'c-1' },
});

describe('a wait is what somebody filed, never what a note says', () => {
  it('a note saying "waiting on Bryan" with nothing filed is a plain stall once it is old', () => {
    const noted = row({ notes: [{ ts: now - 40 * MIN, kind: 'turn', text: WAITING_NOTE }] });
    const verdict = gate([noted]);
    expect(verdict.stalled.map((r) => [r.id, r.bucket])).toEqual([['t-1', 'in-progress']]);
    expect(verdict.unfiled).toEqual([]);
    expect(verdict.waiting).toEqual([]);
  });

  it('…and the same note two minutes old is activity, like any other note', () => {
    const noted = row({ notes: [{ ts: now - 2 * MIN, kind: 'turn', text: WAITING_NOTE }] });
    const verdict = gate([noted]);
    expect(verdict.stalled).toEqual([]);
    expect(verdict.waiting).toEqual([]);
  });

  it('a filed ticket item excuses the row, and the row names it by address', () => {
    const verdict = gate([row()], [ticketAsk(now - 10 * MIN)]);
    expect(verdict.stalled).toEqual([]);
    expect(verdict.unfiled).toEqual([]);
    expect(verdict.waiting).toEqual([
      {
        id: 't-1',
        title: 'Index the archive',
        waitingOn: [{ kind: 'task', taskId: 't-1', reviewItemId: 'r-1' }],
      },
    ]);
  });

  it('every open ask rides along, newest first, whichever surface it was filed on', () => {
    const verdict = gate([row()], [ticketAsk(now - 30 * MIN), threadAsk(now - 5 * MIN)]);
    expect(verdict.waiting[0]?.waitingOn.map((a) => a.kind)).toEqual(['thread', 'task']);
  });

  it('a row the board says waits on the owner, with nothing filed, is unfiled — not waiting', () => {
    const verdict = gate([row({ ownerKind: 'person' })]);
    expect(verdict.unfiled.map((r) => r.id)).toEqual(['t-1']);
    expect(verdict.waiting).toEqual([]);
    expect(verdict.stalled).toEqual([]);
  });
});

const PERSON = { id: 'known-jordan', name: 'Jordan', kind: 'person' };
const LEAD = { id: 'agent-cartographer', name: 'Cartographer', kind: 'agent' };

interface Verdict {
  latest: {
    verdict: string;
    stalled: string[];
    unfiled: string[];
    waiting: Array<{ id: string; waitingOn: Array<Record<string, string>> }>;
  } | null;
}

describe('on a real board the verdict names the ask every waiting row is excused by', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let WS = '';

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const jj = async <T>(res: Response): Promise<T> => {
    expect(res.ok, `${res.status} ${await res.clone().text()}`).toBe(true);
    return res.json() as Promise<T>;
  };
  const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'declared-waiting-'));
    // A zero quiet window: every row is quiet the moment it is read, so the
    // only thing deciding a row's fate is what is filed on it.
    handle = createServer({ port: 0, dataDir, stallNudgeQuietMs: 0 });
    base = `http://127.0.0.1:${handle.port}`;
    WS = await seedBoard(base, { name: 'search-revamp' });
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function inProgressRow(title: string): Promise<string> {
    const { task } = await jj<{ task: { id: string } }>(
      await post(`/workspaces/${WS}/tasks`, {
        title,
        body: `Agent can ${title.toLowerCase()} so that the queue keeps moving.`,
        assignee: LEAD.name,
        assigneeId: LEAD.id,
        assigneeKind: 'agent',
        author: LEAD,
      }),
    );
    for (const [to, author] of [
      ['todo', PERSON],
      ['in-progress', LEAD],
    ] as const) {
      await jj(
        await post(`/workspaces/${WS}/tasks/${task.id}/transition`, {
          to,
          author,
          workspaceId: WS,
        }),
      );
    }
    return task.id;
  }

  async function verdict(): Promise<Verdict['latest']> {
    handle.nudgeStalls();
    await settle();
    const res = await fetch(`${base}/workspaces/${WS}/keep-moving`, {
      headers: { host: `localhost:${handle.port}` },
    });
    const body = await jj<Verdict>(res);
    expect(body.latest, 'the tick recorded no verdict').not.toBeNull();
    return body.latest;
  }

  it('a ticket item: the row is excused and names the item', async () => {
    const taskId = await inProgressRow('Pick a retention window');
    const filed = await jj<{ item: { id: string } }>(
      await post(`/workspaces/${WS}/tasks/${taskId}/review-items`, {
        author: LEAD,
        workspaceId: WS,
        review: {
          shape: 'decision',
          headline: 'How long should search history be kept?',
          options: [
            { id: 'o-30', label: '30 days' },
            { id: 'o-forever', label: 'Forever' },
          ],
        },
      }),
    );
    await settle();

    const latest = await verdict();
    expect(latest?.stalled).toEqual([]);
    expect(latest?.unfiled).toEqual([]);
    expect(latest?.waiting).toEqual([
      { id: taskId, waitingOn: [{ kind: 'task', taskId, reviewItemId: filed.item.id }] },
    ]);
  });

  it('a comment-borne item on the ticket thread: the same, addressed by doc, thread and comment', async () => {
    const taskId = await inProgressRow('Rank results by recency');
    const docId = `task:${taskId}`;
    const { thread } = await jj<{ thread: { id: string; comments: Array<{ id: string }> } }>(
      await post(`/workspaces/${WS}/docs/${encodeURIComponent(docId)}/threads`, {
        text: 'Does this ranking read the way you wanted?',
        author: LEAD,
        anchor: { kind: 'subject' },
        review: { shape: 'question', headline: 'Does this ranking read the way you wanted?' },
      }),
    );
    await settle();

    const latest = await verdict();
    expect(latest?.stalled).toEqual([]);
    expect(latest?.waiting).toEqual([
      {
        id: taskId,
        waitingOn: [
          { kind: 'thread', docId, threadId: thread.id, commentId: thread.comments[0]?.id },
        ],
      },
    ]);
  });

  it('a note saying "waiting on Bryan" with nothing filed: a stall, on no list of waits', async () => {
    const taskId = await inProgressRow('Land the standard arm');
    expect(
      (
        await post(`/workspaces/${WS}/tasks/${taskId}/notes`, {
          agent: LEAD.name,
          kind: 'turn',
          text: WAITING_NOTE,
          sessionId: 'sess-1',
        })
      ).status,
    ).toBe(202);
    await settle();

    const latest = await verdict();
    expect(latest?.stalled).toEqual([taskId]);
    // The old reader put this row on `unfiled`; nothing reads the note now.
    expect(latest?.unfiled).toEqual([]);
    expect(latest?.waiting).toEqual([]);
  });
});
