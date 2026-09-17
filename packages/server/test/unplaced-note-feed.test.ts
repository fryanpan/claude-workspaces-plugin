/**
 * Does an end-of-turn note no row would take reach a reader?
 *
 * The note's own durability is `agent-note-log.test.ts` and its refusal to be
 * placed is `turn-note-many-rows.test.ts`. What is missing between the two is
 * a SURFACE: the record survived a restart and nothing showed it, so a
 * session holding several rows wrote every closing message into a file nobody
 * opened. These cases drive the whole path — two claimed rows, one posted
 * note, one `GET …/events` — and assert the note is in the answer the board's
 * Activity tab reads.
 *
 * The one-row post is the control from the other side: a note that DID land
 * on a row is not in this list, because it is already on that row's own tab
 * and a feed that showed it twice would be the noise `task.noted` was kept
 * out of the trail to avoid.
 *
 * All fixtures are synthetic — invented names. The repo is public.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { type AccessHarness, accessHarness, mintAccessShare } from './access-share.ts';

const PERSON = { id: 'known-jordan', name: 'Jordan', kind: 'person' };
const LEAD = { id: 'agent-harborlight', name: 'Harborlight', kind: 'agent' };

/** What the events read hands back for a note no row took. */
interface WireNote {
  agent: string;
  kind: string;
  text: string;
  at: number;
  ambiguous: boolean;
}

describe('an unplaced end-of-turn note on the board’s events read', () => {
  let handle: ServerHandle;
  let base: string;
  let dataDir: string;
  let access: AccessHarness;
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

  const turnNote = (text: string, at = Date.now()) =>
    post(`/workspaces/${WS}/agents/harborlight/notes`, {
      agent: 'harborlight',
      kind: 'turn',
      text,
      at,
    });

  /** The `unplacedNotes` field of the events read, as the board sees it. */
  const feedNotes = async (headers?: Record<string, string>): Promise<WireNote[]> => {
    const res = await fetch(`${base}/workspaces/${WS}/events`, headers ? { headers } : undefined);
    const body = await jj<{ unplacedNotes?: WireNote[] }>(res);
    return body.unplacedNotes ?? [];
  };

  /** A row held in-progress by the lead, the way a dispatch leaves it. */
  async function claimRow(title: string): Promise<string> {
    const { task } = await jj<{ task: { id: string } }>(
      await post(`/workspaces/${WS}/tasks`, {
        title,
        body: `Agent can ${title.toLowerCase()} so that the board keeps moving.`,
        assignee: LEAD.name,
        assigneeKind: 'agent',
        author: LEAD,
      }),
    );
    for (const to of ['todo', 'in-progress'] as const) {
      await jj(
        await post(`/workspaces/${WS}/tasks/${task.id}/transition`, {
          to,
          author: to === 'todo' ? PERSON : LEAD,
          workspaceId: WS,
        }),
      );
    }
    return task.id;
  }

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'unplaced-note-feed-'));
    access = await accessHarness();
    handle = createServer({ port: 0, dataDir, ...access.serverOptions });
    base = `http://127.0.0.1:${handle.port}`;
    const { workspace } = await jj<{ workspace: { id: string } }>(
      await post('/workspaces', { name: 'unplaced notes', leadAgentId: LEAD.id }),
    );
    WS = workspace.id;
    await jj(
      await post(`/workspaces/${WS}/agents`, { agentId: LEAD.id, runtime: 'claude-code-local' }),
    );
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('carries the note the board could not place, with its agent and its time', async () => {
    await claimRow('Wire the index');
    await claimRow('Rebuild the cache');
    const at = Date.now();
    const posted = await turnNote('Both arms are green; the second is still building.', at);
    expect(posted.status).toBe(202);
    expect(await posted.json()).toMatchObject({ needsFiling: true, logged: true });

    expect(await feedNotes()).toEqual([
      {
        agent: 'harborlight',
        kind: 'turn',
        text: 'Both arms are green; the second is still building.',
        at,
        ambiguous: true,
      },
    ]);
  });

  it('leaves a note that DID land on a row out of the list (control)', async () => {
    const only = await claimRow('Wire the index');
    const posted = await turnNote('Pushed the branch.');
    expect(await posted.json()).toMatchObject({ ok: true, taskId: only });
    // It reached the row, so the row's own tab has it and the feed does not.
    expect(handle.tasks.getTask(only)?.notes?.map((n) => n.text)).toEqual(['Pushed the branch.']);
    expect(await feedNotes()).toEqual([]);
  });

  it('orders several notes newest first, across agents', async () => {
    await claimRow('Wire the index');
    await claimRow('Rebuild the cache');
    await jj(
      await post(`/workspaces/${WS}/agents`, {
        agentId: 'agent-riverbend',
        runtime: 'claude-code-local',
      }),
    );
    // Offsets from the clock, not literals: the note parser replaces an `at`
    // outside its window with `now`, which would flatten every stamp here
    // into one and turn the ordering assertion into an assertion about the
    // order of three POSTs.
    const now = Date.now();
    await turnNote('first', now - 120_000);
    await turnNote('second', now - 30_000);
    await jj(
      await post(`/workspaces/${WS}/agents/riverbend/notes`, {
        agent: 'riverbend',
        kind: 'turn',
        text: 'from a peer',
        at: now - 60_000,
      }),
    );
    expect((await feedNotes()).map((n) => [n.agent, n.text])).toEqual([
      ['harborlight', 'second'],
      ['riverbend', 'from a peer'],
      ['harborlight', 'first'],
    ]);
  });

  it('is empty for a board that has placed everything', async () => {
    await claimRow('Wire the index');
    await turnNote('Pushed the branch.');
    expect(await feedNotes()).toEqual([]);
  });

  it('sends none of them to a share visitor, who still gets the audit rows', async () => {
    await claimRow('Wire the index');
    await claimRow('Rebuild the cache');
    await turnNote('A session’s own words about work in flight.');
    // Positive control first: the owner's read has the note.
    expect(await feedNotes()).toHaveLength(1);

    const share = await mintAccessShare(base, access, WS, { label: 'reviewer' });
    const res = await fetch(`${base}/workspaces/${WS}/events`, { headers: share.headers });
    const body = await jj<{ events: unknown[]; unplacedNotes?: WireNote[] }>(res);
    // The visitor reached the route — an empty list from a 403 would prove
    // nothing about the field.
    expect(body.events.length).toBeGreaterThan(0);
    expect(body.unplacedNotes).toEqual([]);
  });
});
