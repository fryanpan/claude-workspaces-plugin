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
    needs: 'action',
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
function storedRow(id: string, order: number): Record<string, unknown> {
  return {
    id,
    workspaceId: 'w-1',
    title: `Agent can read ${id} without paying for the whole board`,
    status: 'todo',
    assignee: 'Saltmarsh',
    goal: 'g-riverbend',
    order,
    after: [],
    links: [],
    body: body(`row ${id}`),
    transitions: [{ to: 'todo' }, { to: 'in-progress' }],
    createdAt: 1_000,
    updatedAt: 2_000,
  };
}

const STORED = [storedRow('t-1', 1), storedRow('t-2', 2), storedRow('t-3', 3)];

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
      'needs',
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
  });

  it('re-aims the advice at the call that brings the notes, keeping the done guard', () => {
    const drifting = rows[0]?.premise as Record<string, unknown>;
    const advice = String(drifting.advice);
    // The server's own advice says "read the N notes BELOW", and a row saying
    // that while carrying none points the caller at nothing.
    expect(advice).not.toContain('below');
    expect(advice).toContain('next_tasks(fields: ["id","premise"])');
    // The second sentence is the guard behind `decidePremiseDrift`'s first
    // silence and nothing else on the row carries it, so it survives verbatim.
    expect(advice).toContain('This says nothing about whether the task is done.');
    // And it counts what it is pointing at, so the caller knows the size.
    expect(advice).toContain('6 notes');
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
  // `w-empty` is the board with nothing on it — a queue where everything is
  // blocked, a task list filtered to nothing. It is what the refusal's
  // empty-result branch needs, and no fixture can stand in for it: the
  // branch fires on `rows.length === 0` at the handler.
  mcp = await startBundle((req: Recorded) => {
    const empty = req.path.includes('/w-empty/');
    if (req.path.includes('/next')) return empty ? { tasks: [] } : QUEUE;
    return { workspaceId: empty ? 'w-empty' : 'w-1', tasks: empty ? [] : STORED };
  });
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

  // AC 4 is "anything always returned is named in the tool description, so a
  // caller can predict the size before the call". The two cases below read
  // the LIST out of each description and compare it to the keys the verb
  // actually returns, rather than asking whether a word appears somewhere in
  // a paragraph: `expect(description).toContain('id')` passed on any
  // description with the word "id" in it, which is nearly all of them, and it
  // would have gone on passing if the default had grown a key.
  it('the keys next_tasks names are exactly the ones its default returns', () => {
    const description = mcp.tool('next_tasks')?.description ?? '';
    const listed = /carries exactly these keys: ([^—]+)—/.exec(description);
    // A description that stopped naming them at all must fail here rather
    // than compare an empty list against an empty list.
    expect(listed).not.toBeNull();
    const named = (listed?.[1] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    // The non-drifting row: every key the default ever returns unconditionally.
    const always = Object.keys(projectQueueRows(QUEUE.tasks)[1] ?? {});
    expect([...named].sort()).toEqual([...always].sort());
  });

  it('next_tasks names premise as the conditional key, and the body as absent', () => {
    const description = mcp.tool('next_tasks')?.description ?? '';
    const drifting = Object.keys(projectQueueRows(QUEUE.tasks)[0] ?? {});
    const always = Object.keys(projectQueueRows(QUEUE.tasks)[1] ?? {});
    // Whatever a drifting row carries beyond the unconditional set is what
    // the description has to call out separately.
    expect(drifting.filter((k) => !always.includes(k))).toEqual(['premise']);
    expect(description).toContain('`premise`');
    expect(description).toMatch(/does NOT carry the task body/);
  });

  it('list_tasks names the three keys its default does not pass through whole', async () => {
    const description = mcp.tool('list_tasks')?.description ?? '';
    const res = await mcp.call('list_tasks', { workspaceId: 'w-1' });
    const out = res.json as { tasks: Array<Record<string, unknown>> };
    const returned = Object.keys(out.tasks[0] ?? {});
    const stored = Object.keys(STORED[0] ?? {});
    expect(stored.filter((k) => !returned.includes(k)).sort()).toEqual(['body', 'transitions']);
    expect(returned.filter((k) => !stored.includes(k))).toEqual(['transitionCount']);
    // Named as code spans: "the task body" in prose is not a claim about the
    // `body` key, and the old /body/ match could not tell them apart.
    for (const key of ['body', 'transitions', 'transitionCount']) {
      expect(description).toContain(`\`${key}\``);
    }
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

describe('an empty result narrows what the refusal can mean, and it says so', () => {
  // The row scan that lets a server-added key through has nothing to scan on
  // a board with no rows, so a real but unrecognised name IS refused there.
  // The hole is documented in `unsatisfiableFields`; these two cases are what
  // keep the documentation and the message from drifting apart.
  it('a key some row carries is accepted — and the same key is refused when no row came back', async () => {
    const accepted = await mcp.call('next_tasks', {
      workspaceId: 'w-1',
      fields: ['claimedBy'],
    });
    expect(accepted.isError).toBe(false);

    const refused = await mcp.call('next_tasks', {
      workspaceId: 'w-empty',
      fields: ['somethingTheServerAddedToday'],
    });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('somethingTheServerAddedToday');
    expect(refused.text).toContain('no rows to check it against');
  });

  it('with rows to check against, the refusal does not blame the empty result', async () => {
    const res = await mcp.call('next_tasks', {
      workspaceId: 'w-1',
      fields: ['somethingTheServerAddedToday'],
    });
    expect(res.isError).toBe(true);
    expect(res.text).not.toContain('no rows to check it against');
    expect(res.text).toContain('no row returned carries it');
  });

  it('list_tasks says the same thing on an empty board', async () => {
    const res = await mcp.call('list_tasks', {
      workspaceId: 'w-empty',
      fields: ['somethingTheServerAddedToday'],
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('no rows to check it against');
  });
});

describe('list_tasks reads one named row, which is what makes the small queue row usable', () => {
  it('gives the description of the row next_tasks handed back without a body', async () => {
    const res = await mcp.call('list_tasks', {
      workspaceId: 'w-1',
      taskIds: ['t-2'],
      fields: ['id', 'body'],
    });
    expect(res.isError).toBe(false);
    const out = res.json as { tasks: Array<Record<string, unknown>> };
    expect(out.tasks).toHaveLength(1);
    expect(out.tasks[0]).toEqual({ id: 't-2', body: body('row t-2') });
  });

  it('takes several ids at once, in board order rather than the order asked', async () => {
    const res = await mcp.call('list_tasks', {
      workspaceId: 'w-1',
      taskIds: ['t-3', 't-1'],
      fields: ['id'],
    });
    const out = res.json as { tasks: Array<Record<string, unknown>> };
    expect(out.tasks.map((t) => t.id)).toEqual(['t-1', 't-3']);
  });

  it('refuses an id that matches nothing, naming it and the archived case', async () => {
    const res = await mcp.call('list_tasks', {
      workspaceId: 'w-1',
      taskIds: ['t-1', 't-gone'],
      fields: ['id'],
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('t-gone');
    // A short list that reads like a correct answer is the defect; the
    // recovery has to name the reason an id can be real and still absent.
    expect(res.text).toContain('includeArchived');
    expect(res.text).not.toContain('t-1`');
  });

  it('filters handler-side — the route is asked for the board, not for the ids', async () => {
    const res = await mcp.call('list_tasks', { workspaceId: 'w-1', taskIds: ['t-2'] });
    const get = res.sent.find((r) => r.path.endsWith('/tasks'));
    expect(get?.query.get('taskIds')).toBeNull();
    expect(get?.query.get('format')).toBe('json');
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
