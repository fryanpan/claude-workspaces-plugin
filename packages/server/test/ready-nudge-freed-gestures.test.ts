/**
 * The four OTHER person gestures that free held work wake the lead too.
 *
 * `ready-nudge-person-freed.test.ts` covers the two releases that ride a
 * transition — agreeing a goal band, closing a blocker. A person frees work
 * just as often without transitioning anything, and each of these is its own
 * route:
 *
 *   1. removing an `after` edge          → POST tasks/:id/after
 *   2. archiving a blocker               → POST tasks/:id/archive
 *   3. handing an unowned row to an agent → POST tasks/:id/assignee
 *   4. moving a backlog row into a band  → POST tasks/:id/goal
 *
 * Measured on this branch before the fix, with these exact fixtures: each of
 * the four made its row dispatchable (a zero-window server's timed pass named
 * it with `readyCount` 1) and delivered ZERO frames under the production
 * window. The board fell back to the fifteen-minute idle wake for every one.
 *
 * Each gesture is tested three ways, and the shape is the point:
 *
 *  - a person's move that frees the row sends ONE wake naming it;
 *  - the same move by an agent sends nothing — followed IN THE SAME TEST by a
 *    person's identical move on a twin row, which does fire, so the silence is
 *    the actor and not a dead channel;
 *  - a person's move of the same kind that leaves the row held sends nothing,
 *    followed by a firing move for the same reason.
 *
 * All fixtures are synthetic — invented names, a public repo.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { READY_IDLE_EVENT } from '../src/ready-nudge.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { seedGoalsOverHttp } from './goal-seed.ts';
import { type Frame, listenFrames, waitForFrames } from './sse-frames.ts';

const PERSON = { id: 'known-owner', name: 'Riverbend', kind: 'person' };
const LEAD = { id: 'agent-harborlight', name: 'Harborlight', kind: 'agent' };
type Actor = typeof PERSON | typeof LEAD;

/** The production window. Nothing in this file may wait it out. */
const IDLE_MS = 15 * 60_000;

let handle: ServerHandle;
let dataDir: string;
let base: string;
let workspaceId: string;
/** `agreed` dispatches; `pending` is left in triage and holds its band. */
let goals: Record<string, string>;
let lead: ReturnType<typeof listenFrames>;

const post = (path: string, body: unknown) =>
  fetch(`${base}/workspaces/${workspaceId}/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspaceId, ...(body as object) }),
  });

/** Fail with the server's own words — a setup that quietly 400s is how a wake
 *  test passes by never having had a board to wake. */
const jj = async <T>(res: Response): Promise<T> => {
  expect(res.ok, `${res.status} ${await res.clone().text()}`).toBe(true);
  return res.json() as Promise<T>;
};

const nudges = (frames: readonly Frame[]) => frames.filter((f) => f.event === READY_IDLE_EVENT);

/**
 * A row the board's agent owns under the agreed band, queued by `queuedBy`.
 * `extra` overrides whichever of those the gesture needs to be false, and
 * `after` is wired while the row is still in triage — a row queued first and
 * blocked second would already have woken the lead on its own queueing.
 */
async function row(
  title: string,
  extra: Record<string, unknown> = {},
  opts: { queuedBy?: Actor; after?: string[] } = {},
): Promise<string> {
  const { task } = await jj<{ task: { id: string } }>(
    await post('tasks', {
      title,
      body: `Agent can ${title.toLowerCase()} so that the queue keeps moving.`,
      assignee: LEAD.name,
      assigneeKind: 'agent',
      goal: goals.agreed,
      triage: true,
      author: PERSON,
      ...extra,
    }),
  );
  if (opts.after) {
    const after = opts.after;
    await jj(await post(`tasks/${task.id}/after`, { after, afterEnforce: after, author: PERSON }));
  }
  const queuedBy = opts.queuedBy ?? PERSON;
  await jj(await post(`tasks/${task.id}/transition`, { to: 'todo', author: queuedBy }));
  return task.id;
}

/** A blocker the agent queued and is already working — so none of its own
 *  moves wakes anybody, and every frame below is the gesture's. */
async function blocker(title: string): Promise<string> {
  const id = await row(title, {}, { queuedBy: LEAD });
  await jj(await post(`tasks/${id}/transition`, { to: 'in-progress', author: LEAD }));
  return id;
}

const heldBehind = (title: string, after: string[]) => row(title, {}, { after });

/**
 * One gesture: build a held row, then make the move. `frees` builds the case
 * where the move releases it; `keepsHeld` the same kind of move that leaves it
 * held by something else. Each returns the row and the move, so the actor is
 * the only thing a test varies.
 */
interface Gesture {
  frees: (title: string) => Promise<{ id: string; act: (who: Actor) => Promise<Response> }>;
  keepsHeld: (title: string) => Promise<{ id: string; act: (who: Actor) => Promise<Response> }>;
}

const GESTURES: Record<string, Gesture> = {
  'removing an after edge': {
    frees: async (title) => {
      const b = await blocker(`${title} prerequisite`);
      const id = await heldBehind(title, [b]);
      return {
        id,
        act: (who) => post(`tasks/${id}/after`, { after: [], afterEnforce: [], author: who }),
      };
    },
    keepsHeld: async (title) => {
      const b1 = await blocker(`${title} first prerequisite`);
      const b2 = await blocker(`${title} second prerequisite`);
      const id = await heldBehind(title, [b1, b2]);
      return {
        id,
        act: (who) => post(`tasks/${id}/after`, { after: [b2], afterEnforce: [b2], author: who }),
      };
    },
  },
  'archiving a blocker': {
    frees: async (title) => {
      const b = await blocker(`${title} prerequisite`);
      const id = await heldBehind(title, [b]);
      return { id, act: (who) => post(`tasks/${b}/archive`, { author: who }) };
    },
    keepsHeld: async (title) => {
      const b1 = await blocker(`${title} first prerequisite`);
      const b2 = await blocker(`${title} second prerequisite`);
      const id = await heldBehind(title, [b1, b2]);
      return { id, act: (who) => post(`tasks/${b1}/archive`, { author: who }) };
    },
  },
  'handing an unowned row to an agent': {
    // An owner the board cannot name — no roster entry, no declared kind — is
    // `unowned`, and there is no session to wake about it.
    frees: async (title) => {
      const id = await row(title, { assignee: 'Saltmarsh', assigneeKind: undefined });
      return {
        id,
        act: (who) =>
          post(`tasks/${id}/assignee`, {
            assignee: LEAD.name,
            assigneeKind: 'agent',
            author: who,
          }),
      };
    },
    // Handed to a PERSON instead: owned now, and still nothing an agent can take.
    keepsHeld: async (title) => {
      const id = await row(title, { assignee: 'Saltmarsh', assigneeKind: undefined });
      return {
        id,
        act: (who) =>
          post(`tasks/${id}/assignee`, {
            assignee: PERSON.name,
            assigneeKind: 'person',
            author: who,
          }),
      };
    },
  },
  'moving a backlog row into a band': {
    frees: async (title) => {
      const id = await row(title, { goal: 'chores' });
      return { id, act: (who) => post(`tasks/${id}/goal`, { goal: goals.agreed, author: who }) };
    },
    // Into the band nobody has agreed yet: out of backlog, into goal triage.
    keepsHeld: async (title) => {
      const id = await row(title, { goal: 'chores' });
      return { id, act: (who) => post(`tasks/${id}/goal`, { goal: goals.pending, author: who }) };
    },
  },
};

/** The wake a firing move must produce, and nothing else on the stream. */
async function expectOneWakeNaming(id: string): Promise<void> {
  const got = await waitForFrames(lead.frames, READY_IDLE_EVENT, 1);
  expect(got).toHaveLength(1);
  expect(got[0]?.data?.taskId).toBe(id);
  const freed = got[0]?.data?.freed as { count: number; rows: { id: string }[] } | undefined;
  expect(freed?.count).toBe(1);
  expect(freed?.rows.map((r) => r.id)).toEqual([id]);
  // The discriminator against the timed pass, which always carries how long
  // the board stood still. This one never stood still.
  expect(got[0]?.data?.idleMs).toBeUndefined();
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'nudge-gestures-'));
  handle = createServer({ port: 0, dataDir, readyNudgeIdleMs: IDLE_MS });
  base = `http://127.0.0.1:${handle.port}`;
  const created = await fetch(`${base}/workspaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'search-revamp', leadAgentId: LEAD.id }),
  });
  workspaceId = (await jj<{ workspace: { id: string } }>(created)).workspace.id;
  await jj(await post('agents', { agentId: LEAD.id, runtime: 'claude-code-local' }));
  lead = listenFrames(
    await fetch(
      `${base}/workspaces/${workspaceId}/events:stream?agentId=${encodeURIComponent(LEAD.id)}`,
      { headers: { accept: 'text/event-stream' } },
    ),
  );
  goals = await seedGoalsOverHttp(
    base,
    workspaceId,
    [
      { key: 'agreed', title: 'Rank results' },
      { key: 'pending', title: 'Rewrite the crawler' },
    ],
    PERSON,
    { leaveInTriage: true },
  );
  await jj(await post(`tasks/${goals.agreed}/transition`, { to: 'todo', author: PERSON }));
});

afterEach(async () => {
  await lead.stop();
  await handle.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

for (const [name, gesture] of Object.entries(GESTURES)) {
  describe(`a person ${name}`, () => {
    it('sends ONE wake naming the row it freed', async () => {
      const { id, act } = await gesture.frees('Rank results by recency');
      // A timed pass over a board built seconds ago: the window is shut, so
      // any frame below came from the immediate path.
      handle.nudgeReadyWork();
      expect(nudges(lead.frames), 'the row is silent while held').toHaveLength(0);

      await jj(await act(PERSON));

      await expectOneWakeNaming(id);
    }, 60_000);

    it('wakes nobody when an AGENT makes the move, and does when a person repeats it', async () => {
      const byAgent = await gesture.frees('Cache the facet counts');
      const byPerson = await gesture.frees('Rank results by recency');

      await jj(await byAgent.act(LEAD));
      handle.nudgeReadyWork();
      await jj(await byPerson.act(PERSON));

      // Both moves ran on one stream and the first returned before the second
      // was sent, so a wake the agent's move owed is already on it by now.
      await expectOneWakeNaming(byPerson.id);
    }, 60_000);

    it('says nothing when the move leaves the row held, and fires for one that frees', async () => {
      const stillHeld = await gesture.keepsHeld('Cache the facet counts');
      const freed = await gesture.frees('Rank results by recency');

      await jj(await stillHeld.act(PERSON));
      handle.nudgeReadyWork();
      await jj(await freed.act(PERSON));

      await expectOneWakeNaming(freed.id);
    }, 60_000);
  });
}
