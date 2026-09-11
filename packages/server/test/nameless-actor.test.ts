/**
 * An actor that exists and carries NO name, over the two routes that ask what
 * kind of somebody owns a task.
 *
 * `declaredAssigneeKind` guarded `if (!author) return undefined` and then read
 * `author.name.trim()` on the next line. An actor object with no `name` walks
 * past that guard, so a real REST create from an agent whose author claim was
 * `{ id }` alone took the server to a 500 in production — caught by the Sentry
 * subscription minutes after it was turned on, 2026-09-10:
 *
 *   TypeError: undefined is not an object (evaluating 'author.name.trim')
 *     at declaredAssigneeKind (packages/server/src/task-owner.ts)
 *
 * The parameter type said `name: string`. The value arrives from a request
 * body, so that was a claim about the boundary rather than a fact about the
 * data — the same lesson `classifyActor` already carries in
 * classify-actor-malformed.test.ts, three lines away in the same call.
 *
 * The kind such a create records is `undefined`, NOT a guess. The only thing
 * that branch can say is "the author IS the assignee", and nothing carrying no
 * name matches a name — so falling through to `classifyActor` would file an
 * unrecorded kind as a confident one, which is the direction this repo treats
 * as worse than an absence.
 *
 * Both call sites are driven over real HTTP, because the store is not where
 * the malformed author comes from: the route is, and a fix asserted only on
 * the pure function would pass on a route that never reaches it.
 *
 * All fixtures are synthetic — invented names, invented agent ids.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { declaredAssigneeKind } from '../src/task-owner.ts';
import type { Task } from '../src/tasks.ts';
import { seedBoard } from './workspace-seed.ts';

/** The shape the wire actually delivered: an id, a declared kind, no name. */
const NAMELESS = { id: 'agent-surveyor', kind: 'agent' };
/** The same session once its launch environment names it — the control that
 *  keeps every assertion below from passing on a route that does nothing. */
const NAMED = { id: 'agent-surveyor', name: 'Surveyor', kind: 'agent' };

describe('declaredAssigneeKind over a nameless actor', () => {
  it('answers undefined instead of throwing', () => {
    expect(() => declaredAssigneeKind('Ada Fenwick', undefined, NAMELESS)).not.toThrow();
    expect(declaredAssigneeKind('Ada Fenwick', undefined, NAMELESS)).toBeUndefined();
    // …and unrecorded rather than guessed: the assignee is not the author, so
    // there is nothing to classify. `classifyActor(NAMELESS)` would say
    // 'agent', which is precisely the confident lie the absence replaces.
    expect(declaredAssigneeKind('agent-surveyor', undefined, NAMELESS)).toBeUndefined();
  });

  it('still honours an explicit declaration from a nameless caller', () => {
    // The caller who DID say what the owner is loses nothing: that branch
    // returns above the author read and must keep doing so.
    expect(declaredAssigneeKind('Ada Fenwick', 'person', NAMELESS)).toBe('person');
    expect(declaredAssigneeKind('Ada Fenwick', 'agent', NAMELESS)).toBe('agent');
  });

  it('leaves the named-author behaviour exactly as it was', () => {
    // POSITIVE CONTROL. A guard that also changed the well-formed answers
    // would pass every assertion above while breaking the feature.
    expect(declaredAssigneeKind('Surveyor', undefined, NAMED)).toBe('agent');
    expect(declaredAssigneeKind('  surveyor ', undefined, NAMED)).toBe('agent');
    expect(
      declaredAssigneeKind('Ada Fenwick', undefined, {
        id: 'known-ada',
        name: 'Ada Fenwick',
        kind: 'known',
      }),
    ).toBe('person');
    expect(declaredAssigneeKind('Ada Fenwick', undefined, NAMED)).toBeUndefined();
    expect(declaredAssigneeKind('Ada Fenwick', undefined, undefined)).toBeUndefined();
  });
});

describe('a nameless actor over the real routes', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let ws = '';

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  /** The head of a failure body. A 500 here answers with Bun's error PAGE,
   *  and printing the whole bundle buries the one line that says what threw. */
  const why = async (res: Response): Promise<string> =>
    `${res.status} ${(await res.clone().text()).slice(0, 300)}`;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-nameless-actor-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://127.0.0.1:${handle.port}`;
    ws = await seedBoard(base);
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('creates a task, recording the owner kind as unrecorded', async () => {
    const res = await post(`/workspaces/${ws}/tasks`, {
      title: 'chart the north shelf',
      assignee: 'Ada Fenwick',
      author: NAMELESS,
    });
    // The 500 this test exists for. Named in the failure so the next reader
    // does not have to guess which layer answered.
    expect(res.status, `POST tasks → ${await why(res)}`).toBe(200);
    const { task } = (await res.json()) as { task: Task };
    // Positive control: the row is real and holds the owner it was given.
    expect(task.assignee).toBe('Ada Fenwick');
    // A nameless author is not evidence that the author is the assignee.
    expect(task.assigneeKind).toBeUndefined();
  });

  it('hands a task over, recording the new owner kind as unrecorded', async () => {
    const made = await post(`/workspaces/${ws}/tasks`, {
      title: 'sound the channel',
      assignee: 'Surveyor',
      author: NAMED,
    });
    expect(made.status, `POST tasks → ${await why(made)}`).toBe(200);
    const { task } = (await made.json()) as { task: Task };
    // Positive control on the SAME field the assertion below reads: a named
    // author filing to itself does record a kind, so an undefined afterwards
    // is the hand-over's answer and not a field nothing ever populates.
    expect(task.assigneeKind).toBe('agent');

    const handed = await post(`/workspaces/${ws}/tasks/${task.id}/assignee`, {
      assignee: 'Ada Fenwick',
      author: NAMELESS,
    });
    expect(handed.status, `POST assignee → ${await why(handed)}`).toBe(200);
    const after = (await handed.json()) as { task: Task; ownerKind: string };
    expect(after.task.assignee).toBe('Ada Fenwick');
    expect(after.task.assigneeKind).toBeUndefined();
    expect(after.ownerKind).toBe('unknown');
  });
});
