/**
 * The board projection re-projects only the rows an edit named, and the board
 * it leaves behind is the board a full rebuild would have written.
 *
 * Both halves are driven through the real routes, because the claim that a
 * verb moved one row lives in two places — the store event it emits and the
 * `refreshTask` its route calls by hand — and a store-only test would check the
 * first and trust the second.
 *
 *  - **Equality.** Seeded random sequences of edits: create, retitle, assign,
 *    transition, archive and restore, goal moves, a goal archived with its
 *    rows and restored, new goals, dependency edges, review items filed,
 *    answered and withdrawn, comments, body rewrites, heartbeats and an agent
 *    attaching mid-sequence. After each sequence the `tasks` map is read, a
 *    full pass is forced, and the map is read again. Any difference is a row
 *    the incremental path left stale.
 *  - **Nothing to do costs nothing.** Heartbeats and tool calls change no row,
 *    so they project no row — read off the projection's own counter, with a
 *    retitle beside them as the control that the counter moves at all.
 *
 * All names are fictional.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { workspaceDocId } from '../src/task-projection.ts';
import { seedBoard } from './workspace-seed.ts';

const PERSON = { id: 'known-riverbend', name: 'Riverbend Reviewer', kind: 'known' };
const BUILDER = { id: 'agent-harborlight', name: 'Harborlight Builder', kind: 'agent' };
const SECOND = 'agent-saltmarsh';

/** mulberry32 — a seeded generator, so a failing sequence can be replayed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('the board projection refreshes only the rows an edit named', () => {
  let dataDir: string;
  let h: ServerHandle;
  let base: string;
  let ws: string;

  const post = (path: string, body: unknown, method = 'POST') =>
    fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;
  const boardRows = (): Record<string, unknown> =>
    h.docStore
      .getOrCreate(workspaceDocId(ws), { type: 'workspace' }, { authority: 'server' })
      .ydoc.getMap('tasks')
      .toJSON();

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'projection-incremental-'));
    h = createServer({ port: 0, dataDir });
    base = `http://127.0.0.1:${h.port}`;
    ws = await seedBoard(base, { name: 'Riverbend' });
    const attached = await post(`/workspaces/${ws}/agents`, {
      agentId: BUILDER.id,
      agentName: BUILDER.name,
      runtime: 'claude-code-local',
    });
    expect(attached.status, await attached.clone().text()).toBe(200);
  });

  afterAll(async () => {
    await h.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('matches a full rebuild after every random sequence of edits', async () => {
    const goals: string[] = [];
    for (const title of ['Chart the estuary', 'Rebuild the tide tables']) {
      const res = await json<{ goal: { id: string } }>(
        await post(`/workspaces/${ws}/goals/add`, { title, author: PERSON }),
      );
      goals.push(res.goal.id);
    }
    const tasks: string[] = [];
    const items: Array<{ task: string; item: string }> = [];
    const landed: Record<string, number> = {};
    const pick = <T>(r: () => number, xs: readonly T[]): T | undefined =>
      xs.length === 0 ? undefined : xs[Math.floor(r() * xs.length)];

    const ops: Record<string, (r: () => number) => Promise<Response | null>> = {
      create: async (r) => {
        const goal = r() < 0.6 ? pick(r, goals) : undefined;
        const res = await post(`/workspaces/${ws}/tasks`, {
          title: `Harborlight can survey reach ${tasks.length} so that the chart is current`,
          assignee: BUILDER.name,
          author: PERSON,
          ...(goal ? { goal } : {}),
        });
        if (res.ok) tasks.push((await json<{ task: { id: string } }>(res.clone())).task.id);
        return res;
      },
      retitle: async (r) => {
        const t = pick(r, tasks);
        return t
          ? post(`/workspaces/${ws}/tasks/${t}/title`, {
              title: `Saltmarsh can read reach ${Math.floor(r() * 1000)} so that it moves`,
              author: PERSON,
            })
          : null;
      },
      assign: async (r) => {
        const t = pick(r, tasks);
        const who = pick(r, [BUILDER.name, 'Saltmarsh Agent', 'human', PERSON.name]);
        return t
          ? post(`/workspaces/${ws}/tasks/${t}/assignee`, { assignee: who, author: PERSON })
          : null;
      },
      transition: async (r) => {
        const t = pick(r, tasks);
        const to = pick(r, ['triage', 'todo', 'in-progress', 'done']);
        return t
          ? post(`/workspaces/${ws}/tasks/${t}/transition`, { to, author: PERSON, workspaceId: ws })
          : null;
      },
      archive: async (r) => {
        const t = pick(r, tasks);
        return t
          ? post(`/workspaces/${ws}/tasks/${t}/archive`, { author: PERSON, reason: 'done with' })
          : null;
      },
      restore: async (r) => {
        const t = pick(r, tasks);
        return t ? post(`/workspaces/${ws}/tasks/${t}/restore`, { author: PERSON }) : null;
      },
      moveGoal: async (r) => {
        const t = pick(r, tasks);
        const goal = pick(r, goals);
        return t && goal
          ? post(`/workspaces/${ws}/tasks/${t}/goal`, { goal, author: PERSON })
          : null;
      },
      archiveGoal: async (r) => {
        const g = pick(r, goals);
        return g ? post(`/workspaces/${ws}/goals/${g}/archive`, { author: PERSON }) : null;
      },
      restoreGoal: async (r) => {
        const g = pick(r, goals);
        return g ? post(`/workspaces/${ws}/goals/${g}/restore`, { author: PERSON }) : null;
      },
      addGoal: async () => {
        const res = await post(`/workspaces/${ws}/goals/add`, {
          title: `Survey channel ${goals.length}`,
          author: PERSON,
        });
        if (res.ok) goals.push((await json<{ goal: { id: string } }>(res.clone())).goal.id);
        return res;
      },
      depend: async (r) => {
        const t = pick(r, tasks);
        const others = tasks.filter((x) => x !== t && r() < 0.3);
        return t
          ? post(`/workspaces/${ws}/tasks/${t}/after`, { after: others, author: PERSON })
          : null;
      },
      fileItem: async (r) => {
        const t = pick(r, tasks);
        if (!t) return null;
        const res = await post(`/workspaces/${ws}/tasks/${t}/review-items`, {
          review: {
            shape: 'review',
            headline: `Check the soundings for reach ${Math.floor(r() * 100)}`,
            detail: 'The depth readings disagree with the last survey by a metre.',
          },
          author: BUILDER,
        });
        if (res.ok)
          items.push({
            task: t,
            item: (await json<{ item: { id: string } }>(res.clone())).item.id,
          });
        return res;
      },
      answerItem: async (r) => {
        const it = pick(r, items);
        return it
          ? post(`/workspaces/${ws}/tasks/${it.task}/review-items/${it.item}/answer`, {
              text: 'The newer survey is right.',
              author: PERSON,
            })
          : null;
      },
      withdrawItem: async (r) => {
        const it = pick(r, items);
        return it
          ? post(`/workspaces/${ws}/tasks/${it.task}/review-items/${it.item}/withdraw`, {
              author: BUILDER,
            })
          : null;
      },
      comment: async (r) => {
        const t = pick(r, tasks);
        return t
          ? post(`/workspaces/${ws}/docs/task:${t}/threads`, {
              anchor: { kind: 'subject' },
              text: 'Is the channel marker still where the chart says?',
              author: PERSON,
            })
          : null;
      },
      body: async (r) => {
        const t = pick(r, tasks);
        return t
          ? post(`/workspaces/${ws}/tasks/${t}/body`, {
              markdown: `Harborlight can survey this reach so that ships clear it. Pass ${Math.floor(r() * 100)}.`,
              author: PERSON,
            })
          : null;
      },
      heartbeat: async (r) =>
        post(
          `/workspaces/${ws}/agents/${BUILDER.id}/heartbeat`,
          r() < 0.5 ? {} : { toolCallAt: Date.now() },
        ),
      attachSecond: async () =>
        post(`/workspaces/${ws}/agents`, {
          agentId: SECOND,
          agentName: 'Saltmarsh Agent',
          runtime: 'claude-code-local',
        }),
    };
    const names = Object.keys(ops);

    const before = { ...h.projection.rowStats };
    for (let seed = 1; seed <= 12; seed++) {
      const r = rng(seed);
      const trail: string[] = [];
      for (let step = 0; step < 18; step++) {
        const name = tasks.length < 3 ? 'create' : (pick(r, names) as string);
        const res = await ops[name]?.(r);
        if (res === null || res === undefined) continue;
        await res.arrayBuffer();
        trail.push(`${name}:${res.status}`);
        if (res.ok) landed[name] = (landed[name] ?? 0) + 1;
      }
      const incremental = boardRows();
      h.projection.refresh(ws);
      expect({ seed, trail, rows: incremental }).toEqual({ seed, trail, rows: boardRows() });
    }

    // Each kind of edit really landed somewhere in the run — an op every call
    // of which was refused would pass the equality above having tested nothing.
    for (const name of names)
      expect({ name, landed: landed[name] ?? 0 }).not.toEqual({ name, landed: 0 });
    // …and the passes that ran were the scoped ones, not full passes that
    // would make the equality true by construction.
    expect(h.projection.rowStats.scopedPasses - before.scopedPasses).toBeGreaterThan(100);
  }, 120_000);

  it('projects no row for heartbeats and tool calls, and one for a retitle', async () => {
    const created = await json<{ task: { id: string } }>(
      await post(`/workspaces/${ws}/tasks`, {
        title: 'Harborlight can log the tide so that the table is right',
        author: PERSON,
      }),
    );
    // Settle the roster: the first pass after an attach is a full one.
    await (await post(`/workspaces/${ws}/agents/${BUILDER.id}/heartbeat`, {})).arrayBuffer();
    const start = { ...h.projection.rowStats };

    for (let i = 0; i < 5; i++) {
      await (await post(`/workspaces/${ws}/agents/${BUILDER.id}/heartbeat`, {})).arrayBuffer();
      await (
        await post(`/workspaces/${ws}/agents/${BUILDER.id}/heartbeat`, { toolCallAt: Date.now() })
      ).arrayBuffer();
    }
    const quiet = { ...h.projection.rowStats };
    expect(quiet.rowsProjected - start.rowsProjected).toBe(0);
    expect(quiet.fullPasses - start.fullPasses).toBe(0);
    // The control: those ten events did reach the projection, as passes that
    // had nothing to write.
    expect(quiet.scopedPasses - start.scopedPasses).toBe(10);

    const renamed = await post(`/workspaces/${ws}/tasks/${created.task.id}/title`, {
      title: 'Harborlight can log the neap tide so that the table is right',
      author: PERSON,
    });
    expect(renamed.status).toBe(200);
    const moved = h.projection.rowStats;
    expect(moved.fullPasses - quiet.fullPasses).toBe(0);
    // The event and the route's own refresh each project the one row.
    expect(moved.rowsProjected - quiet.rowsProjected).toBe(2);
  });
});
