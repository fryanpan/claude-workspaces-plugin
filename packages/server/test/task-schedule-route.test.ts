/**
 * `POST /workspaces/:ws/tasks/:id/schedule` (`routes/task-fields.ts`) stores
 * what the phrase said. The route hand-copies the parsed fields onto the rule
 * and nothing type-checks that it forwarded each one: for a release the
 * missed-run policy was parsed and then dropped, so "skip if missed" saved as
 * catch-up. Asserted on the row read back over HTTP, not on the response,
 * which echoes whatever the route thought it stored. An on-change rule goes
 * through the same door. Fixtures are invented; the repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { User } from '@claude-workspaces/core';
import { type ServerHandle, createServer } from '../src/server.ts';
import type { Task } from '../src/tasks.ts';
import { seedGoalsOverHttp } from './goal-seed.ts';

const PERSON: User = {
  id: 'known-harbour',
  name: 'Harbourmaster',
  kind: 'known',
  color: '#2e7dd7',
};

describe('POST /workspaces/:ws/tasks/:id/schedule', () => {
  let dataDir: string;
  let handle: ServerHandle;
  let base: string;
  let wsId: string;
  let taskId: string;

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const stored = async (): Promise<Task | undefined> => {
    const { tasks } = (await (
      await fetch(`${base}/workspaces/${wsId}/tasks?format=json`)
    ).json()) as { tasks: Task[] };
    return tasks.find((t) => t.id === taskId);
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'task-schedule-route-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
    const { workspace } = (await (
      await post('/workspaces', { name: 'Harbour Lights', goal: 'Keep the lamps lit.' })
    ).json()) as { workspace: { id: string } };
    wsId = workspace.id;
    const G = await seedGoalsOverHttp(base, wsId, [{ key: 'g1', title: '1. Lamps' }], PERSON);
    const { task } = (await (
      await post(`/workspaces/${wsId}/tasks`, {
        author: PERSON,
        title: 'Sweep the lamp doc',
        goal: G.g1,
      })
    ).json()) as { task: Task };
    taskId = task.id;
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('stores the missed-run policy the phrase carried, and the default when it carried none', async () => {
    const skip = await post(`/workspaces/${wsId}/tasks/${taskId}/schedule`, {
      author: PERSON,
      rule: { kind: 'every', everyMs: 3_600_000 },
      onMissed: 'skip',
    });
    expect(skip.status).toBe(200);
    expect((await stored())?.schedule?.onMissed).toBe('skip');
    // Control: the same rule with no clause stores no policy.
    const plain = await post(`/workspaces/${wsId}/tasks/${taskId}/schedule`, {
      author: PERSON,
      rule: { kind: 'every', everyMs: 3_600_000 },
    });
    expect(plain.status).toBe(200);
    expect((await stored())?.schedule?.onMissed).toBeUndefined();
  });

  it('stores an on-change rule with its source and quiet window, and refuses a bad id', async () => {
    const res = await post(`/workspaces/${wsId}/tasks/${taskId}/schedule`, {
      author: PERSON,
      rule: { kind: 'on-change', source: { kind: 'doc', docId: 'd-lamp' }, debounceMs: 300_000 },
    });
    expect(res.status).toBe(200);
    expect((await stored())?.schedule?.rule).toEqual({
      kind: 'on-change',
      source: { kind: 'doc', docId: 'd-lamp' },
      debounceMs: 300_000,
    });
    const bad = await post(`/workspaces/${wsId}/tasks/${taskId}/schedule`, {
      author: PERSON,
      rule: { kind: 'on-change', source: { kind: 'doc', docId: '../etc' } },
    });
    expect(bad.status).toBe(400);
    // The bad write changed nothing.
    expect((await stored())?.schedule?.rule.kind).toBe('on-change');
    expect((await stored())?.schedule?.rule).toMatchObject({ source: { docId: 'd-lamp' } });
  });
});
