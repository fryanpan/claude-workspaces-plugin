/**
 * The two measurement rows a review item causes — `review_item.viewed` when
 * somebody's client puts the ask on screen, `review_item.answered` when an
 * answer lands on it — read back off the log the reporting agent reads.
 *
 * WHY THE LOG AND NOT THE RESPONSE. The point of the pair is that a reader
 * with nothing but `<dataDir>/workspaces/<ws>.events.jsonl` can subtract one
 * timestamp from the other. A 200 from the route proves the request was
 * accepted, never that a row landed where that reader looks — this repo has
 * shipped "accepted it, returned 200, discarded it" more than once.
 *
 * The third test is a CONTROL, not an inspection: the item's words and the
 * answer's words are planted as distinctive strings, and each is proved to
 * travel into the same log on some OTHER row before being asserted absent
 * from these two. Absence with no positive control is indistinguishable from
 * a typo in the needle.
 *
 * All fixtures are synthetic — invented ids, invented people. The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { threadReviewItemId } from '@claude-workspaces/core';
import {
  REVIEW_ITEM_MEASUREMENT_EVENTS,
  isReviewItemMeasurementEvent,
  reviewItemAnsweredEvent,
  reviewItemViewedEvent,
} from '../src/review-items/analytics.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { LEGACY_REVIEW_ITEM_ID, type Task, eventsLogPath } from '../src/tasks.ts';
import { seedBoard } from './workspace-seed.ts';

const AGENT = { id: 'agent-ledger-keeper', name: 'Ledger Keeper', kind: 'known', color: '#888888' };
const PERSON = { id: 'known-harborlight', name: 'Harborlight', kind: 'known', color: '#2e7dd7' };

/** Planted strings. Nothing else in the fixture says these words, so finding
 *  one in a row is proof that row carried the text it came from. */
const ASK_NEEDLE = 'saltmarsh-tideline-question';
const ANSWER_NEEDLE = 'saltmarsh-tideline-verdict';

/** Every key either row is allowed to carry. `device` and `location` are
 *  added to browser-caused rows by `stampEventOrigin` at the log's own
 *  writer; they are ids-and-place, not content, and they are on every board
 *  event this log holds. `filedById` rides the `answered` row alone: it is a
 *  fourth id, it carries no words, and the MCP child addresses the wake at
 *  the agent it names instead of broadcasting the answer to the board. The
 *  set is what stops a caller spreading an item into the constructor, so a
 *  new key here is a decision, which is why the rule is still one id at a
 *  time rather than a shape. */
const ALLOWED_KEYS = new Set([
  'event',
  'workspaceId',
  'reviewItemId',
  'taskId',
  'actorId',
  'filedById',
  'isOwner',
  'ts',
  'device',
  'location',
]);

interface LoggedRow {
  event: string;
  workspaceId?: string;
  reviewItemId?: string;
  taskId?: string;
  actorId?: string;
  filedById?: string;
  isOwner?: boolean;
  ts?: number;
}

describe('the constructors are the only shape either row can have', () => {
  const ids = {
    workspaceId: 'w-ledger',
    reviewItemId: 'r-tideline',
    taskId: 't-tideline',
    actorId: 'known-harborlight',
    isOwner: true,
    ts: 1_700_000_000_000,
  };

  it('builds a viewed row of exactly the six fields', () => {
    const row = reviewItemViewedEvent(ids);
    expect(row.type).toBe('review_item.viewed');
    expect(Object.keys(row).sort()).toEqual(
      ['actorId', 'isOwner', 'reviewItemId', 'taskId', 'ts', 'type', 'workspaceId'].sort(),
    );
  });

  it('builds an answered row with the same ids, so the two subtract', () => {
    const viewed = reviewItemViewedEvent(ids);
    const answered = reviewItemAnsweredEvent({ ...ids, ts: ids.ts + 90_000 });
    expect(answered.type).toBe('review_item.answered');
    expect(answered.reviewItemId).toBe(viewed.reviewItemId);
    expect(answered.taskId).toBe(viewed.taskId);
    expect(answered.ts - viewed.ts).toBe(90_000);
  });

  it('drops a taskId that names nothing rather than writing an empty one', () => {
    expect('taskId' in reviewItemViewedEvent({ ...ids, taskId: '' })).toBe(false);
    const { taskId: _dropped, ...withoutTask } = ids;
    expect('taskId' in reviewItemViewedEvent(withoutTask)).toBe(false);
  });

  it('names the two events for the agent that reads them', () => {
    expect(REVIEW_ITEM_MEASUREMENT_EVENTS).toEqual(['review_item.viewed', 'review_item.answered']);
    expect(isReviewItemMeasurementEvent('review_item.viewed')).toBe(true);
    expect(isReviewItemMeasurementEvent('review_item.answered')).toBe(true);
    // A board event a person reads is not one of these — the Activity view
    // strips measurement rows by this answer, so a `true` here would empty
    // somebody's feed.
    expect(isReviewItemMeasurementEvent('decision.answered')).toBe(false);
    expect(isReviewItemMeasurementEvent(undefined)).toBe(false);
  });
});

describe('what a viewed and an answered item write to the board log', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let wsId = '';

  const jj = async <T>(res: Response): Promise<T> => {
    expect(res.ok, `${res.status} ${await res.clone().text()}`).toBe(true);
    return res.json() as Promise<T>;
  };
  const post = (path: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  /** The raw lines of the board's log, as written. */
  const lines = (): string[] => {
    const path = eventsLogPath(dataDir, wsId);
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0);
  };
  /** The same read, against a board other than the fixture's own. */
  const rowsOfBoard = (board: string, event: string): LoggedRow[] => {
    const path = eventsLogPath(dataDir, board);
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as LoggedRow)
      .filter((r) => r.event === event);
  };
  const rowsOf = (event: string): LoggedRow[] =>
    lines()
      .map((l) => JSON.parse(l) as LoggedRow)
      .filter((r) => r.event === event);

  const seedTask = async (title: string): Promise<Task> => {
    const { task } = await jj<{ task: Task }>(
      await post(`/workspaces/${wsId}/tasks`, { title, assignee: 'Ledger Keeper', author: AGENT }),
    );
    return task;
  };
  const seedItem = async (taskId: string): Promise<{ id: string }> => {
    const { item } = await jj<{ item: { id: string } }>(
      await post(`/workspaces/${wsId}/tasks/${taskId}/review-items`, {
        review: {
          shape: 'decision',
          review_type: 'decision',
          headline: `Hold the ${ASK_NEEDLE} open for another week?`,
          detail: `The ${ASK_NEEDLE} is the only reader left on the old path.`,
          options: [
            { id: 'o-hold', label: 'Hold it' },
            { id: 'o-close', label: 'Close it' },
          ],
        },
        author: AGENT,
      }),
    );
    return item;
  };
  /** A doc on this board carrying one declared review item on a thread. */
  const seedThreadItem = async (): Promise<{
    docId: string;
    threadId: string;
    commentId: string;
  }> => {
    const slug = `tideline-${Math.random().toString(36).slice(2)}`;
    const file = join(dataDir, `${slug}.md`);
    writeFileSync(file, '# Tideline notes\n\nThe old path still has one reader.\n');
    const created = await jj<{ docId: string }>(
      await post(`/workspaces/${wsId}/docs`, { docId: slug, type: 'markdown', sourceUrl: file }),
    );
    await jj(await post(`/workspaces/${wsId}/docs:attach`, { docId: created.docId }));
    const opened = await jj<{ thread: { id: string; comments: Array<{ id: string }> } }>(
      await post(`/workspaces/${wsId}/docs/${created.docId}/threads/by_find`, {
        find: 'The old path still has one reader.',
        text: 'Raising this before the freeze.',
        author: AGENT,
        review: {
          shape: 'review',
          review_type: 'question',
          headline: `Does the ${ASK_NEEDLE} need a second reader?`,
          detail: 'One reader is a single point of failure.',
        },
      }),
    );
    return {
      docId: created.docId,
      threadId: opened.thread.id,
      commentId: opened.thread.comments[0].id,
    };
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'review-item-measurement-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://127.0.0.1:${handle.port}`;
    wsId = await seedBoard(base, { name: 'tideline' });
  });
  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('records one viewed row carrying all six fields and nothing else', async () => {
    const task = await seedTask('Retire the old read path');
    const item = await seedItem(task.id);
    const before = rowsOf('review_item.viewed').length;

    const at = Date.now();
    const res = await post(`/workspaces/${wsId}/review-items/viewed`, {
      reviewItemId: item.id,
      author: PERSON,
    });
    expect(res.status).toBe(200);

    const written = rowsOf('review_item.viewed').slice(before);
    expect(written).toHaveLength(1);
    const row = written[0];
    expect(row.workspaceId).toBe(wsId);
    expect(row.reviewItemId).toBe(item.id);
    // The ticket comes from the SERVER's own index, not from the request: a
    // client that names the item names enough.
    expect(row.taskId).toBe(task.id);
    expect(row.actorId).toBe(PERSON.id);
    // Resolved by the admission gate. A local request is the board's owner.
    expect(row.isOwner).toBe(true);
    expect(typeof row.ts).toBe('number');
    expect(row.ts).toBeGreaterThanOrEqual(at);
    for (const key of Object.keys(row)) {
      expect(ALLOWED_KEYS.has(key), `unexpected key on a measurement row: ${key}`).toBe(true);
    }
  });

  it('refuses an item this board does not hold, and writes nothing for it', async () => {
    const before = rowsOf('review_item.viewed').length;
    const unknown = await post(`/workspaces/${wsId}/review-items/viewed`, {
      reviewItemId: 'r-nothing-here',
      author: PERSON,
    });
    expect(unknown.status).toBe(404);
    const noId = await post(`/workspaces/${wsId}/review-items/viewed`, { author: PERSON });
    expect(noId.status).toBe(400);
    expect(rowsOf('review_item.viewed')).toHaveLength(before);
  });

  it('refuses the legacy id on a ticket that is asking nobody for a decision', async () => {
    // The legacy id is derived by EVERY decision ticket, so it names an item
    // only together with a task — and a task that never asked for a decision
    // derives no such item. A stale tab, or a hand-written POST, must not be
    // able to bank reading time against an ask that does not exist.
    const ordinary = await seedTask('Sweep the old read path');
    const before = rowsOf('review_item.viewed').length;
    const res = await post(`/workspaces/${wsId}/review-items/viewed`, {
      reviewItemId: LEGACY_REVIEW_ITEM_ID,
      taskId: ordinary.id,
      author: PERSON,
    });
    expect(res.status).toBe(404);
    expect(rowsOf('review_item.viewed')).toHaveLength(before);

    // Positive control: the same request against a ticket that IS waiting on
    // a decision is the shape this route exists for, and it records a row.
    const { task: deciding } = await jj<{ task: Task }>(
      await post(`/workspaces/${wsId}/tasks`, {
        title: 'Hold the old path open another week?',
        // A decision-shaped body: the create door refuses `needs: 'decision'`
        // without one, and that gate is not the one under test here.
        body: 'Should the old read path stay open another week? At stake: one reader still uses it, and closing it early costs them a rewrite. Blocked until answered: the freeze.',
        options: [{ label: 'Hold it' }, { label: 'Close it' }],
        assignee: PERSON.name,
        needs: 'decision',
        author: AGENT,
      }),
    );
    const ok = await post(`/workspaces/${wsId}/review-items/viewed`, {
      reviewItemId: LEGACY_REVIEW_ITEM_ID,
      taskId: deciding.id,
      author: PERSON,
    });
    expect(ok.status).toBe(200);
    const written = rowsOf('review_item.viewed').slice(before);
    expect(written).toHaveLength(1);
    expect(written[0].reviewItemId).toBe(LEGACY_REVIEW_ITEM_ID);
    expect(written[0].taskId).toBe(deciding.id);
  });

  it('records the answer under the same ids, on the same clock', async () => {
    const task = await seedTask('Move the last reader across');
    const item = await seedItem(task.id);
    await post(`/workspaces/${wsId}/review-items/viewed`, {
      reviewItemId: item.id,
      author: PERSON,
    });
    const viewed = rowsOf('review_item.viewed').filter((r) => r.reviewItemId === item.id);
    expect(viewed).toHaveLength(1);

    const answered = await post(
      `/workspaces/${wsId}/tasks/${task.id}/review-items/${item.id}/answer`,
      {
        text: `Close it — the ${ANSWER_NEEDLE} lands first.`,
        answeredWith: 'o-close',
        author: PERSON,
      },
    );
    expect(answered.status).toBe(200);

    const rows = rowsOf('review_item.answered').filter((r) => r.reviewItemId === item.id);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.taskId).toBe(task.id);
    expect(row.actorId).toBe(PERSON.id);
    expect(row.isOwner).toBe(true);
    // Who the answer is FOR. `seedItem` files as AGENT and this answers as
    // PERSON, so the two ids on the row are different agents and the
    // assertion cannot pass by accident.
    expect(row.filedById).toBe(AGENT.id);
    // One log, one clock: the reading time is a subtraction and nothing else.
    expect(row.ts).toBeGreaterThanOrEqual(viewed[0].ts as number);
    for (const key of Object.keys(row)) {
      expect(ALLOWED_KEYS.has(key), `unexpected key on a measurement row: ${key}`).toBe(true);
    }
    // THE CONTROL on the widened key set: `viewed` is written far more often
    // and nobody addresses anything off it, so it does not take the field.
    expect(viewed[0].filedById).toBeUndefined();
  });

  it('measures a doc-thread item under its derived id, at both ends', async () => {
    const address = await seedThreadItem();
    const derived = threadReviewItemId(address.docId, address.threadId, address.commentId);

    const seen = await post(`/workspaces/${wsId}/review-items/viewed`, {
      reviewItemId: derived,
      author: PERSON,
    });
    expect(seen.status).toBe(200);
    expect(rowsOf('review_item.viewed').filter((r) => r.reviewItemId === derived)).toHaveLength(1);

    const answered = await post(
      `/workspaces/${wsId}/docs/${address.docId}/threads/${address.threadId}/answer`,
      {
        text: `A second reader, once the ${ANSWER_NEEDLE} is in.`,
        commentId: address.commentId,
        author: PERSON,
      },
    );
    expect(answered.status).toBe(200);
    const rows = rowsOf('review_item.answered').filter((r) => r.reviewItemId === derived);
    expect(rows).toHaveLength(1);
    // A doc that is not a ticket's body has no ticket, and the row says so by
    // omission rather than by an empty string.
    expect('taskId' in rows[0]).toBe(false);
    expect(rows[0].actorId).toBe(PERSON.id);
  });

  it('measures the board the reader was standing on, when two boards hold the doc', async () => {
    // A doc can be held by more than one board, and the single-answer
    // resolver names only the first. Both ends have to follow the board the
    // REQUEST named, or the pair lands in two different logs and the minutes
    // between them cannot be subtracted.
    const address = await seedThreadItem();
    const derived = threadReviewItemId(address.docId, address.threadId, address.commentId);
    const second = await seedBoard(base, { name: 'harbour' });
    await jj(await post(`/workspaces/${second}/docs:attach`, { docId: address.docId }));

    const seen = await post(`/workspaces/${second}/review-items/viewed`, {
      reviewItemId: derived,
      author: PERSON,
    });
    expect(seen.status).toBe(200);
    const viewed = rowsOfBoard(second, 'review_item.viewed');
    expect(viewed).toHaveLength(1);
    expect(viewed[0].workspaceId).toBe(second);

    // A PLAIN REPLY, not the Answer composer: a person's reply folds into the
    // answer, and that branch has its own emit to get the board right.
    const answered = await post(
      `/workspaces/${second}/docs/${address.docId}/threads/${address.threadId}/comments`,
      {
        text: `A second reader, once the ${ANSWER_NEEDLE} is in.`,
        author: PERSON,
      },
    );
    expect(answered.status).toBe(200);
    const rows = rowsOfBoard(second, 'review_item.answered');
    expect(rows).toHaveLength(1);
    // The pair: same board, same item, one log to subtract them in.
    expect(rows[0].reviewItemId).toBe(derived);
    expect(rows[0].workspaceId).toBe(second);
  });

  it('carries neither the item text nor the answer text — control', () => {
    const all = lines();
    const measurement = all.filter((l) => {
      const row = JSON.parse(l) as LoggedRow;
      return isReviewItemMeasurementEvent(row.event);
    });
    // The control is only a control if there is something to find.
    expect(measurement.length).toBeGreaterThan(0);

    // POSITIVE CONTROL: both needles DO reach this log on other rows, so an
    // absence below is the constructor's doing and not a mistyped needle.
    const elsewhere = all.filter((l) => !measurement.includes(l));
    expect(
      elsewhere.some((l) => l.includes(ASK_NEEDLE)),
      'the ask never reached the log',
    ).toBe(true);
    expect(
      elsewhere.some((l) => l.includes(ANSWER_NEEDLE)),
      'the answer never reached the log',
    ).toBe(true);

    for (const line of measurement) {
      expect(line).not.toContain(ASK_NEEDLE);
      expect(line).not.toContain(ANSWER_NEEDLE);
    }
  });
});
