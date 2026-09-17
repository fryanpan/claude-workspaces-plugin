/**
 * `next_tasks` answers the projection it is asked for, and says so when it
 * cannot.
 *
 * Two defects, one shape. The verb returned `res.tasks` verbatim — every
 * body, and every note of every drifting row's discussion — and it accepted
 * a `fields` argument it never declared, so a caller that asked for three
 * keys received the whole board with nothing said. `list_tasks` did project,
 * but copied a key only `if (key in t)`, so a name it had no key for came
 * back as a missing field rather than as a refusal. Each produces an answer
 * the caller cannot tell from a correct one.
 *
 * So: a default that is the picker's shape, a declared `fields`, and an
 * error naming any entry the verb cannot satisfy. The byte counts below are
 * of the text a session actually receives from the committed bundle, over
 * rows the size of a real board's.
 *
 * All fixtures are synthetic — the house fixture names.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LIST_TASK_FIELDS,
  NEXT_TASK_FIELDS,
  projectQueueRows,
  unsatisfiableFields,
} from '../src/task-projection.ts';
import { type BundleHarness, type Recorded, startBundle } from './harness/mcp-bundle.ts';

/** A description the size this repo's tasks actually run to. */
function body(topic: string): string {
  return `**Goal:** ${topic}. ${'The measured shape of the failure, the evidence behind it, and what changes. '.repeat(
    24,
  )}`;
}

/** One note on the task's body doc, as the queue flattens it. */
function note(by: string, ts: number, text: string): { ts: number; by: string; text: string } {
  return { ts, by, text };
}

/** The premise-drift block the server arms on a row whose description stood
 *  still while the task was discussed — headline, advice, and the notes
 *  verbatim and uncapped. */
function premise(noteCount: number) {
  return {
    bodyWrittenAt: 1_000,
    discussedAt: 500_000,
    agedMs: 499_000,
    headline: 'This description has not changed in the 5 days since the newest note on this task.',
    advice:
      `Read the ${noteCount} notes below before you reproduce what the description claims — ` +
      'they postdate it and may already have corrected it. ' +
      'This says nothing about whether the task is done.',
    notes: Array.from({ length: noteCount }, (_, i) =>
      note(
        'Harborlight',
        2_000 + i,
        `Correction ${i + 1}: ${'the premise moved under this row and here is what replaced it. '.repeat(8)}`,
      ),
    ),
  };
}

/** A queue row in the shape `/workspaces/<id>/next` returns. */
function queueRow(id: string, opts: { drifting?: boolean } = {}): Record<string, unknown> {
  return {
    id,
    title: `Agent can read ${id} without paying for the whole board`,
    body: body(`row ${id}`),
    goal: 'g-riverbend',
    goalTitle: '1.1 Riverbend',
    inGoalBand: true,
    goalInTriage: false,
    status: 'todo',
    assignee: 'Saltmarsh',
    assigneeId: 'agent-saltmarsh',
    blockedBy: [],
    ready: true,
    blocked: false,
    bodyWrittenAt: 1_000,
    ownerSession: { state: 'active', name: 'Saltmarsh' },
    claimedBy: { state: 'away', name: 'Harborlight' },
    ...(opts.drifting ? { premise: premise(6) } : {}),
  };
}

const QUEUE = {
  tasks: [
    queueRow('t-1', { drifting: true }),
    queueRow('t-2'),
    queueRow('t-3', { drifting: true }),
    queueRow('t-4'),
    queueRow('t-5'),
  ],
  capacity: { cap: 2, inUse: 0, free: 2, heldForCapacity: 3 },
};

/** Stored tasks, as `/workspaces/<id>/tasks?format=json` returns them. The
 *  queue row's keys — `goalTitle`, `ready` — are deliberately absent. */
const STORED = [
  {
    id: 't-1',
    workspaceId: 'w-1',
    title: 'Agent can read t-1 without paying for the whole board',
    status: 'todo',
    assignee: 'Saltmarsh',
    goal: 'g-riverbend',
    order: 1,
    after: [],
    links: [],
    body: body('row t-1'),
    transitions: [{ to: 'todo' }, { to: 'in-progress' }],
    createdAt: 1_000,
    updatedAt: 2_000,
  },
];

describe('projectQueueRows — the default is the picker shape', () => {
  const rows = projectQueueRows(QUEUE.tasks);

  it('keeps every key a picker decides on', () => {
    expect(Object.keys(rows[1] ?? {}).sort()).toEqual([
      'assignee',
      'assigneeId',
      'blocked',
      'blockedBy',
      'bodyWrittenAt',
      'claimedBy',
      'goal',
      'goalInTriage',
      'goalTitle',
      'id',
      'inGoalBand',
      'ownerSession',
      'ready',
      'status',
      'title',
    ]);
  });

  it('drops the body a picker does not read until it has chosen', () => {
    for (const row of rows) expect(row).not.toHaveProperty('body');
  });

  it('keeps the drift warning and drops its transcript, counting the notes instead', () => {
    const drifting = rows[0]?.premise as Record<string, unknown>;
    expect(drifting).toBeDefined();
    expect(drifting.headline).toBe(
      'This description has not changed in the 5 days since the newest note on this task.',
    );
    expect(drifting.noteCount).toBe(6);
    expect(drifting).not.toHaveProperty('notes');
    // Not merely trimmed: the advice says "read the notes below", so a row
    // carrying it without them would point the caller at nothing.
    expect(drifting).not.toHaveProperty('advice');
  });

  it('says nothing about a row that is not drifting', () => {
    expect(rows[1]).not.toHaveProperty('premise');
  });

  it('an empty fields list is the default, not an empty row', () => {
    expect(projectQueueRows(QUEUE.tasks, [])).toEqual(rows);
  });
});

describe('projectQueueRows — fields picks exactly those keys', () => {
  it('id rides along even when it was not asked for', () => {
    expect(Object.keys(projectQueueRows(QUEUE.tasks, ['title'])[0] ?? {}).sort()).toEqual([
      'id',
      'title',
    ]);
  });

  it('an explicit ask gets the heavy field verbatim — filtering is not censoring', () => {
    const picked = projectQueueRows(QUEUE.tasks, ['premise'])[0] as Record<string, unknown>;
    const notes = (picked.premise as { notes?: unknown[] }).notes;
    expect(notes).toHaveLength(6);
    expect(projectQueueRows(QUEUE.tasks, ['body'])[0]?.body).toBe(body('row t-1'));
  });

  it('a key this row lacks is omitted rather than null', () => {
    expect(projectQueueRows(QUEUE.tasks, ['premise'])[1]).toEqual({ id: 't-2' });
  });
});

describe('unsatisfiableFields — declared vocabulary OR a key some row carries', () => {
  it('names an entry no row has and no verb declares', () => {
    expect(unsatisfiableFields(['goalTitle', 'title'], LIST_TASK_FIELDS, STORED)).toEqual([
      'goalTitle',
    ]);
  });

  it('accepts a key the rows carry that the vocabulary never heard of', () => {
    expect(
      unsatisfiableFields(['somethingTheServerAddedToday'], NEXT_TASK_FIELDS, [
        { id: 't-1', somethingTheServerAddedToday: 1 },
      ]),
    ).toEqual([]);
  });

  it('accepts a declared key that no row on this board happens to hold', () => {
    expect(unsatisfiableFields(['archiveReason'], LIST_TASK_FIELDS, STORED)).toEqual([]);
  });

  it('reports each unknown entry once, in the order given', () => {
    expect(unsatisfiableFields(['zzz', 'aaa', 'zzz'], NEXT_TASK_FIELDS, [])).toEqual([
      'zzz',
      'aaa',
    ]);
  });
});

let mcp: BundleHarness;

beforeAll(async () => {
  mcp = await startBundle((req: Recorded) =>
    req.path.includes('/next') ? QUEUE : { workspaceId: 'w-1', tasks: STORED },
  );
}, 60_000);
afterAll(async () => {
  await mcp?.stop();
});

describe('next_tasks declares what it takes and what it always returns', () => {
  it('POSITIVE CONTROL: the running bundle serves the tool at all', () => {
    expect(mcp.tool('next_tasks')).toBeDefined();
  });

  it('declares the optional fields parameter it used to accept in silence', () => {
    const decl = mcp.tool('next_tasks');
    expect(decl?.inputSchema?.properties?.fields).toBeDefined();
    expect(decl?.inputSchema?.required).not.toContain('fields');
  });

  it('names every key the default returns, so a caller can predict the size', () => {
    const description = mcp.tool('next_tasks')?.description ?? '';
    for (const key of [
      'id',
      'title',
      'status',
      'assignee',
      'goalTitle',
      'ready',
      'blocked',
      'blockedBy',
      'bodyWrittenAt',
      'ownerSession',
      'claimedBy',
      'premise',
    ]) {
      expect(description).toContain(key);
    }
    expect(description).toMatch(/does NOT carry the task body/);
  });

  it('list_tasks names what it always returns too', () => {
    const description = mcp.tool('list_tasks')?.description ?? '';
    expect(description).toMatch(/transitionCount/);
    expect(description).toMatch(/body/);
  });
});

describe('next_tasks over the committed bundle', () => {
  it('hands back the picker shape, not the rows the server sent', async () => {
    const res = await mcp.call('next_tasks', { workspaceId: 'w-1' });
    expect(res.isError).toBe(false);
    const out = res.json as { tasks: Array<Record<string, unknown>> };
    expect(out.tasks.map((t) => t.id)).toEqual(['t-1', 't-2', 't-3', 't-4', 't-5']);
    for (const row of out.tasks) {
      expect(row).not.toHaveProperty('body');
      expect(row.premise ?? {}).not.toHaveProperty('notes');
    }
    expect((out.tasks[0]?.premise as { noteCount?: number })?.noteCount).toBe(6);
  });

  it('still carries capacity, which is not a row and must survive the trim', async () => {
    const res = await mcp.call('next_tasks', { workspaceId: 'w-1' });
    const out = res.json as { capacity?: Record<string, number> };
    expect(out.capacity).toEqual({ cap: 2, inUse: 0, free: 2, heldForCapacity: 3 });
  });

  it('gives the body of the one row the caller takes', async () => {
    const res = await mcp.call('next_tasks', { workspaceId: 'w-1', fields: ['body'] });
    expect(res.isError).toBe(false);
    const out = res.json as { tasks: Array<Record<string, unknown>> };
    expect(Object.keys(out.tasks[0] ?? {}).sort()).toEqual(['body', 'id']);
    expect(out.tasks[0]?.body).toBe(body('row t-1'));
  });

  it('refuses a field it has no key for, and names the entry', async () => {
    const res = await mcp.call('next_tasks', { workspaceId: 'w-1', fields: ['reviews', 'title'] });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('reviews');
    // The recovery: the message says what this verb does have.
    expect(res.text).toContain('goalTitle');
  });

  it('the fields it does have are not refused', async () => {
    const res = await mcp.call('next_tasks', {
      workspaceId: 'w-1',
      fields: ['goalTitle', 'ready'],
    });
    expect(res.isError).toBe(false);
    const out = res.json as { tasks: Array<Record<string, unknown>> };
    expect(out.tasks[0]).toEqual({ id: 't-1', goalTitle: '1.1 Riverbend', ready: true });
  });

  it('does not send fields to the route — the trim is handler-side', async () => {
    const res = await mcp.call('next_tasks', { workspaceId: 'w-1', fields: ['title'] });
    const get = res.sent.find((r) => r.path.endsWith('/next'));
    expect(get?.query.get('fields')).toBeNull();
  });
});

describe('list_tasks refuses a field name it cannot satisfy', () => {
  it('names the entry rather than returning bare ids', async () => {
    const res = await mcp.call('list_tasks', {
      workspaceId: 'w-1',
      fields: ['title', 'goalTitle', 'ready'],
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('goalTitle');
    expect(res.text).toContain('ready');
  });

  it('POSITIVE CONTROL: a projection of real keys still answers', async () => {
    const res = await mcp.call('list_tasks', { workspaceId: 'w-1', fields: ['title', 'status'] });
    expect(res.isError).toBe(false);
    const out = res.json as { tasks: Array<Record<string, unknown>> };
    expect(Object.keys(out.tasks[0] ?? {}).sort()).toEqual(['id', 'status', 'title']);
  });
});

describe('the reduction, in bytes of the text a session receives', () => {
  it('the default is a fraction of the unprojected rows', async () => {
    // "Without a projection" is what the verb used to return: every key of
    // every row. Asking for the whole vocabulary reproduces it through the
    // same code path, so both numbers are of one bundle over one board.
    const raw = await mcp.call('next_tasks', {
      workspaceId: 'w-1',
      fields: [...NEXT_TASK_FIELDS],
    });
    const projected = await mcp.call('next_tasks', { workspaceId: 'w-1' });
    expect(raw.isError).toBe(false);
    expect(projected.isError).toBe(false);
    const before = Buffer.byteLength(raw.text, 'utf8');
    const after = Buffer.byteLength(projected.text, 'utf8');
    // Five rows, two of them drifting: 12 notes and 5 bodies leave. The
    // ratio a real board produces is measured on a seeded server, not here —
    // a fixture can be made to prove any factor, so this asserts only that
    // the reduction is large, over rows sized like the real thing.
    expect(after).toBeLessThan(before / 4);
  });
});
