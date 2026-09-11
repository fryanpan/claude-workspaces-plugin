/**
 * The in-turn half of the unfiled-ask rule, over REST: a turn note that asks
 * the board's owner something with nothing filed comes back nudged, in the
 * 202 the Stop hook is already reading.
 *
 * The judgement itself is unit-tested in `unfiled-ask.test.ts` (the words) and
 * `unfiled-ask-filing.test.ts` (the board). What only a route can show is that
 * the two are joined on the live path, that the nudge rides the response the
 * hook already parses, and that the count behind Bryan's number moves once per
 * ask and not once per turn.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localDay } from '../src/chat-audit.ts';
import { type ServerHandle, createServer } from '../src/server.ts';

const PERSON = { id: 'known-jordan', name: 'Jordan', kind: 'person' };
const LEAD = { id: 'agent-cartographer', name: 'Cartographer', kind: 'agent' };

describe('the unfiled-ask nudge on the note route', () => {
  let handle: ServerHandle;
  let base: string;
  let dataDir: string;

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
  const note = (agent: string, text: string) =>
    post(`/workspaces/${WS}/agents/${encodeURIComponent(agent)}/notes`, {
      agent,
      kind: 'turn',
      text,
      at: Date.now(),
    });
  /** The window the board reads, for the day the server thinks it is. Hoisted
   *  out of every `expect` on purpose: a clock read inside one is what the
   *  test audit counts as a wall-clock assertion, and this is neither. */
  const counted = () => handle.chatAudit.window(7, localDay(Date.now()));

  /** The board this file's tasks are filed under. */
  let WS = '';

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'unfiled-ask-routes-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function boardWithLead(): Promise<string> {
    const { workspace } = await jj<{ workspace: { id: string } }>(
      await post('/workspaces', { name: 'ask-nudge', leadAgentId: LEAD.id }),
    );
    WS = workspace.id;
    await jj(
      await post(`/workspaces/${WS}/agents`, {
        agentId: LEAD.id,
        runtime: 'claude-code-local',
      }),
    );
    return WS;
  }

  async function inProgressRow(workspaceId: string, title: string): Promise<string> {
    const { task } = await jj<{ task: { id: string } }>(
      await post(`/workspaces/${workspaceId}/tasks`, {
        title,
        body: `Agent can ${title.toLowerCase()} so that the queue keeps moving.`,
        assignee: LEAD.name,
        assigneeKind: 'agent',
        author: LEAD,
      }),
    );
    for (const to of ['todo', 'in-progress'] as const) {
      await jj(
        await post(`/workspaces/${workspaceId}/tasks/${task.id}/transition`, {
          to,
          author: to === 'todo' ? PERSON : LEAD,
          workspaceId,
        }),
      );
    }
    return task.id;
  }

  it('tells the agent, in the 202, that it ended a turn asking with nothing filed', async () => {
    // The 202 body is the only channel back to the session that posted: the
    // hook turns a non-empty `unfiledAsk` into a Stop-hook block, which is
    // what "told within the turn" means.
    const wsId = await boardWithLead();
    await inProgressRow(wsId, 'Only claim');
    const r = await note('cartographer', 'Both arms are green. Want me to ship it tonight?');
    expect(r.status).toBe(202);
    const body = (await r.json()) as { unfiledAsk?: string };
    expect(body.unfiledAsk).toContain('want me to');

    // And the count behind the board's number moved by exactly one ask.
    expect(counted().agents).toMatchObject([{ unfiledAsks: 1, totalAsks: 1, days: 1 }]);
  });

  it('says nothing when the turn asked nothing', async () => {
    const wsId = await boardWithLead();
    await inProgressRow(wsId, 'Only claim');
    const r = await note('cartographer', 'Both arms are green. Pushed the branch.');
    expect(await r.json()).not.toHaveProperty('unfiledAsk');
    // A turn with no ask in it is not a row in the count either — otherwise
    // the denominator would be "turns", and the number would mean nothing.
    expect(counted().agents).toEqual([]);
  });

  it('says nothing when the same agent already has an open item on the board', async () => {
    const wsId = await boardWithLead();
    const taskId = await inProgressRow(wsId, 'Only claim');
    const added = handle.tasks.addReviewItem(
      taskId,
      {
        shape: 'decision',
        headline: 'Ship tonight or hold for the morning?',
        detail: 'Both arms are green; the only question is whether tonight is a good night.',
        options: [
          { id: 'o-1a2b', label: 'Tonight' },
          { id: 'o-3c4d', label: 'Morning' },
        ],
      },
      { actor: LEAD },
    );
    expect(added.ok).toBe(true);
    const r = await note('cartographer', 'Both arms are green. Want me to ship it tonight?');
    expect(await r.json()).not.toHaveProperty('unfiledAsk');
    // Still an ask — it is counted, and counted as a FILED one.
    expect(counted().agents).toMatchObject([{ unfiledAsks: 0, totalAsks: 1, days: 1 }]);
  });
});
